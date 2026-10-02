import { fileToolHandlers } from './tools/files.mjs';
import { searchToolHandlers } from './tools/search.mjs';
import { terminalToolHandlers } from './tools/terminal.mjs';
import { systemToolHandlers } from './tools/system.mjs';
import { statsToolHandlers } from './tools/stats.mjs';
import { configToolHandlers } from './tools/config.mjs';

// Every tool answers with a text result (image tools add an image part as well), so the
// declared output schema is the same shape everywhere and clients can rely on it.
export const TEXT_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'Human-readable result of the tool call.' },
  },
  required: ['text'],
  additionalProperties: false,
};

const NULLABLE_NUMBER_SCHEMA = { anyOf:[{ type:'number' }, { type:'null' }] };
const NULLABLE_STRING_SCHEMA = { anyOf:[{ type:'string' }, { type:'null' }] };
const TERMINAL_SESSION_PROPERTIES = {
  pid:{ type:'number', description:'Process/session id used by follow-up terminal tools.' },
  status:{ type:'string', description:'running or exited, with an exit code/signal when known.' },
  runtimeMs:{ type:'number' },
  lines:{ type:'number', description:'Total output lines produced by the session.' },
  exited:{ type:'boolean' },
  exitCode:NULLABLE_NUMBER_SCHEMA,
  signal:NULLABLE_STRING_SCHEMA,
};
function terminalOutputSchema(extraProperties = {}, extraRequired = []) {
  return {
    type:'object',
    properties:{ ...TERMINAL_SESSION_PROPERTIES, ...extraProperties },
    required:['pid','status','runtimeMs','lines','exited','exitCode','signal', ...extraRequired],
    additionalProperties:false,
  };
}
const START_PROCESS_OUTPUT_SCHEMA = terminalOutputSchema({
  command:{ type:'string' },
  output:{ type:'string' },
  partial:{ type:'string' },
  warning:{ type:'string' },
}, ['command','output']);
const READ_PROCESS_OUTPUT_SCHEMA = terminalOutputSchema({
  range:{ type:'string' },
  output:{ type:'string' },
  explicitOffset:{ type:'boolean' },
}, ['range','output','explicitOffset']);
const WAIT_PROCESS_OUTPUT_SCHEMA = terminalOutputSchema({
  pattern:{ type:'string' },
  matched:{ type:'boolean' },
  bufferedMatch:{ type:'boolean' },
  timeoutMs:{ type:'number' },
  output:{ type:'string' },
}, ['pattern','matched','bufferedMatch','timeoutMs','output']);
const INTERACT_PROCESS_OUTPUT_SCHEMA = terminalOutputSchema({
  output:{ type:'string' },
}, ['output']);
const TERMINATE_PROCESS_OUTPUT_SCHEMA = terminalOutputSchema({
  terminated:{ type:'boolean' },
  alreadyExited:{ type:'boolean' },
  escalated:{ type:'boolean' },
}, ['terminated','alreadyExited','escalated']);
const LIST_SESSIONS_OUTPUT_SCHEMA = {
  type:'object',
  properties:{
    sessions:{
      type:'array',
      items:{
        type:'object',
        properties:{
          ...TERMINAL_SESSION_PROPERTIES,
          blocked:{ type:'string' },
          command:{ type:'string' },
        },
        required:['pid','status','runtimeMs','lines','exited','exitCode','signal','blocked','command'],
        additionalProperties:false,
      },
    },
  },
  required:['sessions'],
  additionalProperties:false,
};

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const readOnlyNonIdempotent = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const additive = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const mutating = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const command = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

export const toolDefinitions = [
  {
    name: 'read_file',
    title: 'Read file',
    description: 'Read a plain text or line-oriented file on this computer: source, config, Markdown, scripts or logs. Use read_document for PDF, DOCX, XLSX and other structured documents. Legacy .docx/.pdf extraction remains supported for compatibility. Use offset and length to page through large text files; a negative offset reads from the end.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the file to read. Relative paths resolve against the runtime working directory.' },
        offset: { type: 'number', description: 'Zero-based first line to read. Negative values read the last N lines.' },
        length: { type: 'number', description: 'Maximum number of lines to return.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: readOnly,
    handler: fileToolHandlers.read_file,
  },
  {
    name: 'read_files',
    title: 'Read files by glob',
    description: 'Read the contents of files discovered by one glob under a directory, each section prefixed with its path and line count. Use this when the matched file contents are the result you want. Use start_search instead to find filenames or text matches without reading every matched file. If you already know the exact paths, use read_multiple_files; for one known path use read_file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute directory (or single file) to start from.' },
        pattern: { type: 'string', description: 'Glob matched against the relative path and the file name, such as "src/**/*.ts" or "*.md". Default **/* .' },
        max_files: { type: 'number', description: 'Stop after this many files. Default 100, maximum 500.' },
        max_lines_per_file: { type: 'number', description: 'Lines kept per file. Default 2000.' },
        include_ignored: { type: 'boolean', description: 'Also descend into .git and node_modules. Default false.' },
      },
      additionalProperties: false,
    },
    annotations: readOnly,
    handler: fileToolHandlers.read_files,
  },
  {
    name: 'read_multiple_files',
    title: 'Read multiple files',
    description: 'Read several explicitly named text files in one call. Use this when the exact paths are already known; each file is returned separately and one failure does not stop the others. Do not use this for glob discovery: use read_files instead. For one path use read_file.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Absolute paths of the files to read, at most 50 per call.' },
      },
      required: ['paths'],
      additionalProperties: false,
    },
    annotations: readOnly,
    handler: fileToolHandlers.read_multiple_files,
  },
  {
    name: 'read_image',
    title: 'Read image',
    description: 'Return an image file (PNG, JPEG, GIF, WebP, BMP, AVIF, or SVG) as native MCP image content so screenshots, photos, and diagrams can be inspected or shown. Use read_binary only for byte-for-byte transfer, not merely to display an image. Fails above the inline size limit.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the image file.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: readOnly,
    handler: fileToolHandlers.read_image,
  },
  {
    name: 'read_binary',
    title: 'Read binary chunk',
    description: 'Read any file as base64 chunks for byte-for-byte transfer of binaries, archives, documents, or oversized media. For a normal image that should be inspected or shown, use read_image instead. Returns size, offset, and nextOffsetBytes; call again with offset_bytes set to nextOffsetBytes until complete is true.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the file to read.' },
        offset_bytes: { type: 'number', description: 'Byte offset to start at. Default 0.' },
        length_bytes: { type: 'number', description: 'Chunk size in bytes. Default and maximum 1048576 (1 MiB).' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: readOnly,
    handler: fileToolHandlers.read_binary,
  },
  {
    name: 'write_binary',
    title: 'Write binary chunk',
    description: 'Write base64 data to a file byte for byte, creating parent directories. Use mode "append" to send a large file as consecutive chunks. Replaces the file by default.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the file to write.' },
        data: { type: 'string', description: 'Base64-encoded content.' },
        mode: { type: 'string', enum: ['rewrite', 'append'], description: 'rewrite replaces the file, append adds to the end. Default rewrite.' },
      },
      required: ['path', 'data'],
      additionalProperties: false,
    },
    annotations: mutating,
    handler: fileToolHandlers.write_binary,
  },
  {
    name: 'hash_file',
    title: 'Hash file',
    description: 'Compute a checksum of a file without reading it into memory. Useful to verify a copy, compare two files, or confirm a download.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the file to hash.' },
        algorithm: { type: 'string', enum: ['sha256', 'sha1', 'md5'], description: 'Hash algorithm. Default sha256.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: readOnly,
    handler: fileToolHandlers.hash_file,
  },
  {
    name: 'list_directory',
    title: 'List directory',
    description: 'List the files and directories at a path. Entries are prefixed with [DIR], [FILE], [LINK], or [DENIED] when a subdirectory cannot be read. depth controls how many directory levels are included and pattern filters file names by glob.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the directory to list.' },
        depth: { type: 'number', description: 'Directory levels to list, from 1 to 5. Default 1.' },
        pattern: { type: 'string', description: 'Optional glob that filters file names, such as "*.log". Directories are always listed.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: readOnly,
    handler: fileToolHandlers.list_directory,
  },
  {
    name: 'get_file_info',
    title: 'Get file info',
    description: 'Return metadata for a file or directory: type, size, timestamps, permissions, and for small text files the line count.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to inspect.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: readOnly,
    handler: fileToolHandlers.get_file_info,
  },
  {
    name: 'write_file',
    title: 'Write file',
    description: 'Create or replace the complete contents of exactly one text file. Parent directories are created automatically; mode "append" adds to the end. For a small exact-block edit use edit_block, for a known line range use replace_lines, and when you already have a unified diff use apply_patch. Use write_files for two or more independent complete files, and write_binary for binary bytes.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the file to write.' },
        content: { type: 'string', description: 'Full file content, or the text to append.' },
        mode: { type: 'string', enum: ['rewrite', 'append'], description: 'rewrite replaces the file content, append adds to the end. Default rewrite.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    annotations: mutating,
    handler: fileToolHandlers.write_file,
  },
  {
    name: 'write_files',
    title: 'Write multiple files',
    description: 'Create or replace the complete contents of two or more text files in one batch, each with its own path, content, and optional mode. Use this for scaffolding or coherent multi-file writes; for one path use write_file. For partial edits use edit_block, replace_lines, replace_in_files, or apply_patch instead of rewriting whole files.',
    inputSchema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          description: 'Files to write, at most 200 per call.',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Absolute path of the file.' },
              content: { type: 'string', description: 'Full file content.' },
              mode: { type: 'string', enum: ['rewrite', 'append'], description: 'rewrite replaces the file (default), append adds to the end.' },
            },
            required: ['path', 'content'],
            additionalProperties: false,
          },
        },
      },
      required: ['files'],
      additionalProperties: false,
    },
    annotations: mutating,
    handler: fileToolHandlers.write_files,
  },
  {
    name: 'apply_patch',
    title: 'Apply patch',
    description: 'Apply an already-prepared unified diff to one file or several files, matching each hunk with a little fuzz so small offsets and whitespace differences still apply. Prefer this when the change is naturally patch-shaped; use edit_block for one exact text block and write_file only when replacing a complete file. Pass dry_run to see the result first.',
    inputSchema: {
      type: 'object',
      properties: {
        patch: { type: 'string', description: 'Unified diff, including ---/+++ headers and @@ hunks.' },
        path: { type: 'string', description: 'Apply every hunk to this file, ignoring the patch headers.' },
        dry_run: { type: 'boolean', description: 'Report the diff without writing. Default false.' },
      },
      required: ['patch'],
      additionalProperties: false,
    },
    annotations: mutating,
    handler: fileToolHandlers.apply_patch,
  },
  {
    name: 'set_permissions',
    title: 'Set permissions',
    description: 'Change the permission mode of a file or directory, optionally recursively and optionally with a numeric owner. Use this to make a script executable after writing it.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path whose permissions should change.' },
        mode: { type: 'string', description: 'Octal mode such as "755" or "0644".' },
        recursive: { type: 'boolean', description: 'Apply to a directory and everything inside it. Default false.' },
        uid: { type: 'number', description: 'Optional numeric user id to set as owner.' },
        gid: { type: 'number', description: 'Optional numeric group id to set as owner.' },
      },
      required: ['path', 'mode'],
      additionalProperties: false,
    },
    annotations: mutating,
    handler: fileToolHandlers.set_permissions,
  },
  {
    name: 'edit_block',
    title: 'Edit file',
    description: 'Replace one known text block in one file. Provide enough surrounding context to make old_string unique; the call fails unless the number of matches equals expected_replacements. Use write_file for a whole-file replacement and replace_lines for a known line range. When exact text is not found, a whitespace-tolerant match is attempted and reported. Pass dry_run to preview without writing.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path of the file to edit.' },
        old_string: { type: 'string', description: 'Exact existing text to replace.' },
        new_string: { type: 'string', description: 'Replacement text.' },
        expected_replacements: { type: 'number', description: 'Number of matches required for the edit to apply. Default 1.' },
        allow_fuzzy: { type: 'boolean', description: 'Allow a whitespace-tolerant fallback when the exact text is not found. Default true.' },
        dry_run: { type: 'boolean', description: 'Return the diff without changing the file. Default false.' },
      },
      required: ['file_path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
    annotations: mutating,
    handler: fileToolHandlers.edit_block,
  },
  {
    name: 'replace_lines',
    title: 'Replace lines',
    description: 'Replace an inclusive 1-based line range with new text. Use this when line numbers define the target; use edit_block when matching existing text and write_file for a complete rewrite. The rest of the file, including its line endings, is preserved. Pass dry_run to preview without writing.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the file to edit.' },
        start_line: { type: 'number', description: 'First line to replace, 1-based and inclusive.' },
        end_line: { type: 'number', description: 'Last line to replace, 1-based and inclusive.' },
        content: { type: 'string', description: 'Replacement text; an empty string deletes the range.' },
        dry_run: { type: 'boolean', description: 'Return the diff without changing the file. Default false.' },
      },
      required: ['path', 'start_line', 'end_line', 'content'],
      additionalProperties: false,
    },
    annotations: mutating,
    handler: fileToolHandlers.replace_lines,
  },
  {
    name: 'replace_in_files',
    title: 'Replace in files',
    description: 'Search and replace the same text or regular expression across multiple text files under a path and report what changed. Use edit_block for one known block in one file and write_file for one complete known file. Applies immediately; pass dry_run true to preview the affected files first.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of a file or directory to search.' },
        pattern: { type: 'string', description: 'Text or regular expression to find.' },
        replacement: { type: 'string', description: 'Replacement text. In regex mode, $1 and friends refer to capture groups.' },
        filePattern: { type: 'string', description: 'Optional glob limiting which file names are changed, such as "*.ts".' },
        regex: { type: 'boolean', description: 'Treat pattern as a regular expression. Default false (plain text).' },
        dry_run: { type: 'boolean', description: 'Only report the files that would change. Default false.' },
        maxFiles: { type: 'number', description: 'Stop after this many changed files. Default 100, maximum 500.' },
      },
      required: ['path', 'pattern', 'replacement'],
      additionalProperties: false,
    },
    annotations: mutating,
    handler: fileToolHandlers.replace_in_files,
  },
  {
    name: 'diff_files',
    title: 'Diff files',
    description: 'Show a unified diff between two local text files, with line counts. Useful to check what changed before reporting or reverting it.',
    inputSchema: {
      type: 'object',
      properties: {
        left: { type: 'string', description: 'Absolute path of the original file.' },
        right: { type: 'string', description: 'Absolute path of the file to compare against it.' },
        context_lines: { type: 'number', description: 'Lines of context around each change. Default 3, maximum 20.' },
      },
      required: ['left', 'right'],
      additionalProperties: false,
    },
    annotations: readOnly,
    handler: fileToolHandlers.diff_files,
  },
  {
    name: 'move_to_trash',
    title: 'Move to trash',
    description: 'Move a file or directory to the system trash instead of deleting it, so the change can be undone. When the trash is outside the device allowed roots, a .remcp-trash folder beside the file is used instead.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Absolute path to move to the trash.' },
      },
      required: ['source'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    handler: fileToolHandlers.move_to_trash,
  },
  {
    name: 'create_directory',
    title: 'Create directories',
    description: 'Create one directory or many in a single call, including any missing parent directories. Succeeds when a directory already exists.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the directory to create.' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Several directories to create at once, at most 200.' },
      },
      additionalProperties: false,
    },
    annotations: additive,
    handler: fileToolHandlers.create_directory,
  },
  {
    name: 'move_file',
    title: 'Move or rename',
    description: 'Move or rename exactly one file or directory from one source to one destination. Replaces an existing destination file by default; pass overwrite false to refuse instead. Use move_paths for two or more moves.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Absolute path to move.' },
        destination: { type: 'string', description: 'Absolute destination path.' },
        overwrite: { type: 'boolean', description: 'Replace an existing destination file. Default true.' },
      },
      required: ['source', 'destination'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    handler: fileToolHandlers.move_file,
  },
  {
    name: 'copy_file',
    title: 'Copy file',
    description: 'Copy exactly one regular file to a new path. Directories are not copied recursively. Use copy_paths for directories or two or more copy operations; pass overwrite false to refuse an existing destination.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Absolute path of the file to copy.' },
        destination: { type: 'string', description: 'Absolute destination path.' },
        overwrite: { type: 'boolean', description: 'Replace the destination when it already exists. Default true.' },
      },
      required: ['source', 'destination'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    handler: fileToolHandlers.copy_file,
  },
  {
    name: 'copy_paths',
    title: 'Copy paths',
    description: 'Copy two or more paths, or copy a directory recursively, in one call. Each item has its own source and destination. For exactly one regular file use copy_file.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          description: 'Pairs to copy, at most 200 per call.',
          items: {
            type: 'object',
            properties: {
              source: { type: 'string', description: 'Absolute path to copy.' },
              destination: { type: 'string', description: 'Absolute destination path.' },
            },
            required: ['source', 'destination'],
            additionalProperties: false,
          },
        },
        overwrite: { type: 'boolean', description: 'Replace an existing destination. Default true.' },
      },
      required: ['paths'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    handler: fileToolHandlers.copy_paths,
  },
  {
    name: 'move_paths',
    title: 'Move paths',
    description: 'Move or rename two or more files/directories in one batch, each with its own source and destination. Falls back to copy-and-delete across filesystems. For one source/destination pair use move_file.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          description: 'Pairs to move, at most 200 per call.',
          items: {
            type: 'object',
            properties: {
              source: { type: 'string', description: 'Absolute path to move.' },
              destination: { type: 'string', description: 'Absolute destination path.' },
            },
            required: ['source', 'destination'],
            additionalProperties: false,
          },
        },
        overwrite: { type: 'boolean', description: 'Replace an existing destination. Default true.' },
      },
      required: ['paths'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    handler: fileToolHandlers.move_paths,
  },
  {
    name: 'delete_path',
    title: 'Delete path',
    description: 'Delete exactly one file or directory. Directories are removed with their contents unless recursive is false; the filesystem root is refused. Use delete_paths for two or more targets, or move_to_trash when deletion should be reversible.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to delete.' },
        recursive: { type: 'boolean', description: 'Delete a non-empty directory with its contents. Default true.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    handler: fileToolHandlers.delete_path,
  },
  {
    name: 'delete_paths',
    title: 'Delete paths',
    description: 'Delete two or more files/directories in one batch and report each result. For one target use delete_path. Use move_to_trash instead when deletion should be reversible.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Absolute paths to delete, at most 500 per call.' },
        recursive: { type: 'boolean', description: 'Delete non-empty directories with their contents. Default true.' },
      },
      required: ['paths'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    handler: fileToolHandlers.delete_paths,
  },
  {
    name: 'create_archive',
    title: 'Create archive',
    description: 'Pack files and directories into a tar, tar.gz, or zip archive on the device, so a whole tree can be transferred or backed up in one call.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Absolute paths of the files and directories to include.' },
        destination: { type: 'string', description: 'Absolute path of the archive to create.' },
        format: { type: 'string', enum: ['tar', 'tar.gz', 'zip'], description: 'Archive format. Default tar.gz, or zip when the destination ends in .zip.' },
      },
      required: ['paths', 'destination'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    handler: fileToolHandlers.create_archive,
  },
  {
    name: 'extract_archive',
    title: 'Extract archive',
    description: 'Extract a tar, tar.gz, tar.bz2, tar.xz, or zip archive on the device into a directory, creating it when needed.',
    inputSchema: {
      type: 'object',
      properties: {
        archive: { type: 'string', description: 'Absolute path of the archive to extract.' },
        destination: { type: 'string', description: 'Absolute directory to extract into. Defaults to the archive directory.' },
      },
      required: ['archive'],
      additionalProperties: false,
    },
    annotations: mutating,
    handler: fileToolHandlers.extract_archive,
  },
  {
    name: 'take_screenshot',
    title: 'Take screenshot',
    description: 'Capture the entire desktop only when full-screen pixels are actually needed. Prefer ui_snapshot or browser_snapshot for semantic inspection, and screenshot_region for one window, monitor, or rectangle. This tool uses the platform screenshot portal/utility and returns an image.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Absolute directory to write the temporary PNG into. Defaults to the system temp directory.' },
        keep: { type: 'boolean', description: 'Keep the PNG on disk instead of deleting it after it is returned. Default false.' },
      },
      additionalProperties: false,
    },
    // keep=true and oversized fallbacks persist a timestamped PNG, so a repeated call can add files.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    handler: fileToolHandlers.take_screenshot,
  },
  {
    name: 'start_search',
    title: 'Start search',
    description: 'Start a filename or content search on this computer and return the first matches without reading every matched file in full. Use read_files instead when a glob is already known and the contents of all matching files are the desired result. Content searches return "path:line: text" rows. Use get_more_search_results to page and stop_search to stop a long search.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the directory or file to search.' },
        pattern: { type: 'string', description: 'Regular expression for content searches, or a glob such as "*.ts" when searchType is files.' },
        searchType: { type: 'string', enum: ['content', 'files'], description: 'Search file contents (default) or file names.' },
        filePattern: { type: 'string', description: 'Optional relative glob that limits which files are searched, such as "*.ts".' },
        ignoreCase: { type: 'boolean', description: 'Case-insensitive content matching.' },
        maxResults: { type: 'number', description: 'Stop the search after this many results. Default 200.' },
        includeHidden: { type: 'boolean', description: 'Include hidden files and directories.' },
        includeIgnored: { type: 'boolean', description: 'Also search directories normally skipped, such as node_modules, dist, build, and virtualenvs.' },
        contextLines: { type: 'number', description: 'Number of context lines to return around each content match, up to 10.' },
        literalSearch: { type: 'boolean', description: 'Treat the pattern as literal text instead of a regular expression.' },
      },
      required: ['path', 'pattern'],
      additionalProperties: false,
    },
    annotations: readOnlyNonIdempotent,
    handler: searchToolHandlers.start_search,
  },
  {
    name: 'get_more_search_results',
    title: 'Get more search results',
    description: 'Read more results from a search started with start_search. Offset is zero-based; a negative offset returns the last N results.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Search id returned by start_search.' },
        offset: { type: 'number', description: 'Zero-based first result to return. Negative values read from the end.' },
        length: { type: 'number', description: 'Maximum number of results to return. Default 100.' },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
    annotations: readOnly,
    handler: searchToolHandlers.get_more_search_results,
  },
  {
    name: 'stop_search',
    title: 'Stop search',
    description: 'Stop a running search. Results collected so far stay readable until the search is cleaned up.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Search id returned by start_search.' },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
    annotations: additive,
    handler: searchToolHandlers.stop_search,
  },
  {
    name: 'list_searches',
    title: 'List searches',
    description: 'List active and recent searches on this computer with their status and result counts.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: readOnly,
    handler: searchToolHandlers.list_searches,
  },
  {
    name: 'start_process',
    title: 'Start process',
    description: 'Run a shell command, script, build, test suite, or terminal server and return its initial output. Prefer dedicated semantic tools for jobs they already cover: launch_app for GUI apps, service for service-manager operations, power_action for lock/sleep/restart/shutdown, network for routine network inspection/tests, event_log for OS logs, installed_apps for software inventory, environment for environment facts, and open_path/reveal_path for opening or revealing files. The process keeps running so read_process_output or interact_with_process can be used later.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run.' },
        timeout_ms: { type: 'number', description: 'How long to wait for initial output before returning, in milliseconds. Default 1000.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    annotations: command,
    outputSchema: START_PROCESS_OUTPUT_SCHEMA,
    handler: terminalToolHandlers.start_process,
  },
  {
    name: 'read_process_output',
    title: 'Read process output',
    description: 'Read buffered output from a session started with start_process. Without an offset it returns output produced since the previous read.',
    inputSchema: {
      type: 'object',
      properties: {
        pid: { type: 'number', description: 'Session pid returned by start_process.' },
        offset: { type: 'number', description: 'Zero-based line number to start from, counted across everything the session has produced; a negative value reads the last N lines. Omit for new output. Lines evicted by the buffer cap are no longer available.' },
        length: { type: 'number', description: 'Maximum number of lines to return.' },
        timeout_ms: { type: 'number', description: 'How long to wait for new output when no offset is given, in milliseconds.' },
      },
      required: ['pid'],
      additionalProperties: false,
    },
    // Reading without an explicit offset advances the session cursor, so retries can return
    // different output even after the process exits. It never modifies user files.
    annotations: readOnlyNonIdempotent,
    outputSchema: READ_PROCESS_OUTPUT_SCHEMA,
    handler: terminalToolHandlers.read_process_output,
  },
  {
    name: 'interact_with_process',
    title: 'Interact with process',
    description: 'Send one line of input to a running session and return the output it produces. Use this for REPLs and other interactive commands.',
    inputSchema: {
      type: 'object',
      properties: {
        pid: { type: 'number', description: 'Session pid returned by start_process.' },
        input: { type: 'string', description: 'Line of input to send; a newline is appended.' },
        timeout_ms: { type: 'number', description: 'How long to wait for the response, in milliseconds. Default 1000.' },
      },
      required: ['pid', 'input'],
      additionalProperties: false,
    },
    annotations: command,
    outputSchema: INTERACT_PROCESS_OUTPUT_SCHEMA,
    handler: terminalToolHandlers.interact_with_process,
  },
  {
    name: 'wait_for_process_output',
    title: 'Wait for process output',
    description: 'Wait until output from a running session matches a regular expression or literal string, then return the output collected since the previous read. Use this instead of polling read_process_output in a loop.',
    inputSchema: {
      type: 'object',
      properties: {
        pid: { type: 'number', description: 'Session pid returned by start_process.' },
        pattern: { type: 'string', description: 'Regular expression or literal text to wait for.' },
        timeout_ms: { type: 'number', description: 'How long to wait before returning the output collected so far, in milliseconds. Default 10000.' },
      },
      required: ['pid', 'pattern'],
      additionalProperties: false,
    },
    annotations: readOnlyNonIdempotent,
    outputSchema: WAIT_PROCESS_OUTPUT_SCHEMA,
    handler: terminalToolHandlers.wait_for_process_output,
  },
  {
    name: 'force_terminate',
    title: 'Stop session',
    description: 'Stop a ReMCP terminal session started with start_process, escalating from SIGTERM to SIGKILL when it does not exit. Use kill_process for an arbitrary operating-system PID that is not a ReMCP terminal session.',
    inputSchema: {
      type: 'object',
      properties: {
        pid: { type: 'number', description: 'Session pid returned by start_process.' },
      },
      required: ['pid'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    outputSchema: TERMINATE_PROCESS_OUTPUT_SCHEMA,
    handler: terminalToolHandlers.force_terminate,
  },
  {
    name: 'list_sessions',
    title: 'List sessions',
    description: 'List only terminal sessions started through ReMCP start_process, with status and runtime. Use list_processes for the computer-wide operating-system process list.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: readOnly,
    outputSchema: LIST_SESSIONS_OUTPUT_SCHEMA,
    handler: terminalToolHandlers.list_sessions,
  },
  {
    name: 'get_system_info',
    title: 'Get system info',
    description: 'Report machine health and host facts for the paired computer: operating system and kernel, CPU model/load, memory pressure, free disk space, uptime, and default shell. Use environment for PATH/shell/runtime environment variables and get_runtime_info for ReMCP-specific version, policy, roots, and limits.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: readOnly,
    handler: systemToolHandlers.get_system_info,
  },
  {
    name: 'list_processes',
    title: 'List processes',
    description: 'List the computer-wide operating-system processes, highest CPU first, with pid, parent pid, CPU/memory usage, and command. Use list_sessions when the question is only about commands started through ReMCP start_process. Values that look like secrets are masked.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum number of processes to return. Default 100, maximum 1000.' },
      },
      additionalProperties: false,
    },
    annotations: readOnly,
    handler: systemToolHandlers.list_processes,
  },
  {
    name: 'kill_process',
    title: 'Kill process',
    description: 'Terminate an arbitrary operating-system process by pid. If the pid belongs to a ReMCP terminal session created by start_process, prefer force_terminate so ReMCP updates the session consistently and handles its process tree. Terminates the process and its children on Windows.',
    inputSchema: {
      type: 'object',
      properties: {
        pid: { type: 'number', description: 'Process id to terminate.' },
      },
      required: ['pid'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    handler: systemToolHandlers.kill_process,
  },
  {
    name: 'get_runtime_info',
    title: 'Get runtime info',
    description: 'Report this computer\'s local ReMCP runtime: version, allowed roots, command policy, output limits, settable preferences, and usage-metric setting. Use get_system_info for OS/CPU/memory/disk facts and hosted get_configuration for deployment/account configuration. Read-only; use set_config_value only for telemetryEnabled, maxReadLines, maxBufferedLines, or maxOutputBytes. Access roots and command security stay local to the computer.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: readOnly,
    handler: statsToolHandlers.get_runtime_info,
  },
  {
    name: 'get_runtime_stats',
    title: 'Get runtime stats',
    description: 'Report counters from the current local runtime session on this machine: tool calls/failures, blocked commands, active terminal/search sessions, and usage-metric queue state. Use hosted get_usage_statistics for account-level historical usage aggregated across devices and days.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: readOnly,
    handler: statsToolHandlers.get_runtime_stats,
  },
  {
    name: 'set_config_value',
    title: 'Change runtime setting',
    description: 'Change one of this local runtime’s own preferences on the selected computer: telemetryEnabled, maxReadLines, maxBufferedLines or maxOutputBytes. This is not account-level device administration; use hosted device_action for ping, rename, enable/disable or removal. Access roots, blocked commands, shell/guardrails and the write limit remain local-only.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'telemetryEnabled (true/false), maxReadLines, maxBufferedLines or maxOutputBytes.' },
        value: { description: 'New value: a boolean for telemetryEnabled, a number for the limits.' },
      },
      required: ['key', 'value'],
      additionalProperties: false,
    },
    // Preference only, and the same call twice leaves the same state.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: configToolHandlers.set_config_value,
  },
];

export function coreToolSupported(definition, { platform = process.platform } = {}) {
  return !['create_archive', 'extract_archive'].includes(definition.name) || ['linux', 'darwin'].includes(platform);
}

export function supportedCoreTools() {
  return toolDefinitions.filter(coreToolSupported);
}

export function advertisedTools() {
  return toolDefinitions.map(({ name, title, description, inputSchema, annotations, outputSchema }) => ({
    name,
    title,
    description,
    inputSchema,
    annotations,
    outputSchema: outputSchema || TEXT_OUTPUT_SCHEMA,
  }));
}

export const toolHandlers = new Map(toolDefinitions.map(definition => [definition.name, definition]));
