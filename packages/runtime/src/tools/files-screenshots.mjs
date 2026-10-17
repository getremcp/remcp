import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, chmod, chown, copyFile, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { liveConfig, runtimeConfig } from '../config.mjs';
import { documentKind, readDocxText, readPdfText } from '../documents.mjs';
import { diffStats, unifiedDiff } from '../diff.mjs';
import { describeFilesystemFailure } from '../permissions.mjs';
import { capturePortalScreenshot, isWaylandSession } from '../screenshot-portal.mjs';
import { applyHunks, parseUnifiedDiff } from '../patch.mjs';
import { countEvent, recordEvent } from '../telemetry.mjs';
import { clampInteger, decodeText, displayPath, fail, fitsOutput, globToRegExp, image, isInsideRoot, looksBinary, multi, pageLines, resolveSafePath, splitLines, text, throwIfCancelled } from '../util.mjs';


import { MAX_BINARY_CHUNK_BYTES, MAX_IMAGE_BYTES, ensureDirectoryPath, openRegularFile, openWritableParent } from './files-secure-paths.mjs';
import { getFileInfoTool, hashFileTool, listDirectoryTool, readFileTool, readImageTool, readMultipleFilesTool } from './files-read-traversal.mjs';
import { diffFilesTool, editBlockTool, moveToTrashTool, readBinaryTool, replaceInFilesTool, replaceLinesTool, writeBinaryTool, writeFileTool } from './files-write-edit.mjs';
import { applyPatchTool, copyFileTool, copyPathsTool, createDirectoryTool, deletePathTool, deletePathsTool, moveFileTool, movePathsTool, pathExists, readFilesTool, setPermissionsTool, writeFilesTool } from './files-bulk-operations.mjs';
import { createArchiveTool, extractArchiveTool } from './files-archive-actions.mjs';

export const SCREENSHOT_COMMANDS = [
  { command: 'grim', args: file => [file] },
  { command: 'gnome-screenshot', args: file => ['-f', file] },
  { command: 'spectacle', args: file => ['-b', '-n', '-o', file] },
  { command: 'scrot', args: file => ['-o', file] },
  { command: 'import', args: file => ['-window', 'root', file] },
  { command: 'screencapture', args: file => ['-x', file] },
];

// What to tell the person when no capture worked. The general "install a screenshot tool" line was
// wrong on a Mac, where `screencapture` ships with the system and fails only because TCC has not
// granted Screen Recording — the exact failure behind "the screenshot returned an error" reports.
export function screenshotAdvice(attempts, { platform = process.platform, env = process.env, execPath = process.execPath } = {}) {
  if (platform === 'darwin') {
    return `macOS refused the screen capture (${attempts.join('; ') || 'no capture command ran'}). Grant Screen Recording to the binary that runs the tools — System Settings → Privacy & Security → Screen Recording → + → ${execPath} — then restart the agent with \`remcp start\`. macOS requires it for screencapture even when the file itself is writable.`;
  }
  if (platform === 'win32') {
    return `Windows refused the screen capture (${attempts.join('; ') || 'no capture command ran'}). Screen capture needs an interactive desktop session: a machine where nobody is signed in, or a locked session, cannot be captured. Sign in on that computer and try again.`;
  }
  const wayland = /wayland/i.test(String(env.XDG_SESSION_TYPE || '')) || Boolean(env.WAYLAND_DISPLAY);
  if (!env.DISPLAY && !wayland) {
    return `This computer has no graphical session (no DISPLAY and no Wayland display), so there is nothing to capture — servers and containers usually have none.`;
  }
  // GNOME on Wayland is its own case: Mutter does not expose wlr-screencopy, so grim cannot
  // capture it. ReMCP tries the compositor-supported XDG Desktop Portal first; local screenshot
  // commands remain fallbacks for environments where the portal is unavailable.
  if (wayland && /gnome/i.test(String(env.XDG_CURRENT_DESKTOP || ''))) {
    return `Could not capture the screen on GNOME Wayland (${attempts.join('; ') || 'no capture backend ran'}). ReMCP tried the XDG Desktop Portal first, which is GNOME's supported screenshot API. Make sure xdg-desktop-portal and xdg-desktop-portal-gnome are installed and the agent is running inside the signed-in user's graphical session; command-line capture helpers are only fallbacks.`;
  }
  if (wayland) {
    return `Could not capture the screen on Wayland (${attempts.join('; ') || 'no capture backend ran'}). ReMCP tried the XDG Desktop Portal first. Verify xdg-desktop-portal is running; on wlroots compositors, \`grim\` is also supported as a fallback.`;
  }
  return `Could not capture the screen. Install one of grim, gnome-screenshot, spectacle, scrot, or ImageMagick import (tried: ${attempts.join('; ') || 'none available'}).`;
}

export function windowsScreenshotScript(file) {
  return [
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
    '$b = [System.Windows.Forms.SystemInformation]::VirtualScreen',
    '$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height',
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)',
    `$bmp.Save('${file.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
  ].join('; ');
}

export async function takeScreenshotTool(args) {
  const requestedDirectory = args.directory ? await resolveSafePath(args.directory, 'directory') : '';
  const temporaryDirectory = requestedDirectory ? '' : await mkdtemp(path.join(os.tmpdir(), 'remcp-screenshot-'));
  const directory = requestedDirectory || temporaryDirectory;
  let outputDirectory = null;
  if (requestedDirectory) {
    await ensureDirectoryPath(directory);
    outputDirectory = await openWritableParent(directory);
  }
  const outputAnchor = outputDirectory
    ? outputDirectory.anchor.replace('/proc/self/fd/', `/proc/${process.pid}/fd/`)
    : directory;
  const fileName = `capture-${randomUUID()}.png`;
  const file = path.join(outputAnchor, fileName);
  const displayFile = path.join(directory, fileName);
  const attempts = [];
  let preserveCapture = false;
  try {
    if (process.platform === 'win32') {
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', windowsScreenshotScript(file)], { encoding: 'utf8', timeout: 30000 });
      attempts.push(`powershell: ${(result.stderr || '').trim() || ('exit ' + result.status)}`);
    } else {
      if (process.platform === 'linux' && isWaylandSession()) {
        try {
          await capturePortalScreenshot(file);
        } catch (error) {
          const message = error instanceof Error ? error.message : `xdg-desktop-portal: ${String(error)}`;
          attempts.push(message);
          if (error && typeof error === 'object' && error.code === 'PORTAL_CANCELLED') {
            fail(`Screen capture was cancelled in the desktop permission dialog (${message}).`);
          }
        }
      }
      if (!await pathExists(file)) {
        for (const candidate of SCREENSHOT_COMMANDS) {
          if (spawnSync('which', [candidate.command], { encoding: 'utf8' }).status !== 0) continue;
          const result = spawnSync(candidate.command, candidate.args(file), { encoding: 'utf8', timeout: 30000 });
          if (result.status === 0 && await pathExists(file)) break;
          attempts.push(`${candidate.command}: ${(result.stderr || '').trim() || ('exit ' + result.status)}`);
        }
      }
    }
    if (!await pathExists(file)) fail(screenshotAdvice(attempts));

    const opened = await openRegularFile(file);
    const { handle, info } = opened;
    try {
      if (info.size <= MAX_IMAGE_BYTES) {
        const buffer = await handle.readFile();
        preserveCapture = args.keep === true;
        return multi([
          { type: 'text', text: `Screenshot of ${os.hostname()} (${info.size} bytes)${preserveCapture ? (' saved at ' + displayPath(displayFile)) : ''}` },
          image(buffer.toString('base64'), 'image/png'),
        ]);
      }
      preserveCapture = true;
      return text(`Screenshot of ${os.hostname()} captured: ${info.size} bytes, above the ${MAX_IMAGE_BYTES}-byte inline limit, so it is saved at ${displayPath(displayFile)} instead of being returned as an image. Fetch it with read_binary using chunks of up to ${MAX_BINARY_CHUNK_BYTES} bytes (offset_bytes and length_bytes), or ask for a smaller region.`);
    } finally {
      await opened.close();
    }
  } finally {
    if (!preserveCapture) {
      if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
      else await rm(file, { force: true }).catch(() => {});
    }
    if (outputDirectory) await outputDirectory.close().catch(() => {});
  }
}
export const fileToolHandlers = {
  read_file: readFileTool,
  read_files: readFilesTool,
  read_multiple_files: readMultipleFilesTool,
  read_image: readImageTool,
  read_binary: readBinaryTool,
  hash_file: hashFileTool,
  list_directory: listDirectoryTool,
  get_file_info: getFileInfoTool,
  write_file: writeFileTool,
  write_files: writeFilesTool,
  write_binary: writeBinaryTool,
  edit_block: editBlockTool,
  replace_lines: replaceLinesTool,
  replace_in_files: replaceInFilesTool,
  diff_files: diffFilesTool,
  create_directory: createDirectoryTool,
  apply_patch: applyPatchTool,
  set_permissions: setPermissionsTool,
  delete_path: deletePathTool,
  delete_paths: deletePathsTool,
  move_file: moveFileTool,
  move_paths: movePathsTool,
  copy_file: copyFileTool,
  copy_paths: copyPathsTool,
  move_to_trash: moveToTrashTool,
  create_archive: createArchiveTool,
  extract_archive: extractArchiveTool,
  take_screenshot: takeScreenshotTool,
};
