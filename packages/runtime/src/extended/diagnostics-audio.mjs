import { windowsInteropLoad } from './windows-interop.mjs';
import dns from 'node:dns';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { lstat, mkdtemp, open, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { assertAllowedCommand } from '../policy.mjs';
import { isWaylandSession } from '../screenshot-portal.mjs';
import { openDirectoryPath } from '../tools/files.mjs';
import { resolveSafePath, text, throwIfCancelled, ToolError } from '../util.mjs';
import {
  clamp,
  commandExists,
  escapePowerShellSingle,
  jsonResult,
  optionalString,
  requireEnum,
  runFile,
  runFileHeadLines,
  runOsa,
  runPowerShell,
  safeEnvironment,
  spawnDetached,
  unavailable,
} from './common.mjs';

export async function environmentTool(args) {
  return jsonResult({
    platform:process.platform,
    arch:process.arch,
    node:process.versions.node,
    cwd:process.cwd(),
    home:os.homedir(),
    temp:os.tmpdir(),
    shell:process.platform === 'win32' ? process.env.ComSpec || null : process.env.SHELL || null,
    path_entries:String(process.env.PATH || '').split(path.delimiter).filter(Boolean),
    ...(args.include_env === true ? { environment:safeEnvironment() } : {}),
  });
}



export function windowsAudioPowerShell(action = 'status', volume = 50, { loadOnly = false } = {}) {
  const selected = requireEnum(action, 'action', ['status','set_volume','mute','unmute']);
  const normalizedVolume = clamp(volume, 50, 0, 100);
  const mutation = selected === 'set_volume'
    ? `[ReMCP.WindowsAudio]::SetVolume(${normalizedVolume})`
    : selected === 'mute'
      ? '[ReMCP.WindowsAudio]::SetMuted($true)'
      : selected === 'unmute'
        ? '[ReMCP.WindowsAudio]::SetMuted($false)'
        : '';
  return [
    "$ErrorActionPreference='Stop'",
    windowsInteropLoad('audio'),
    loadOnly ? "Write-Output 'loaded'" : mutation,
    loadOnly ? '' : '[Console]::Out.WriteLine([ReMCP.WindowsAudio]::GetStateJson())',
  ].filter(Boolean).join('\n');
}

export function parseWpctlAudioStatus(output) {
  const match = String(output || '').match(/\bVolume:\s*([0-9]+(?:\.[0-9]+)?)(?:\s+\[(MUTED)\])?/i);
  if (!match) throw new Error('wpctl returned an unrecognized volume status');
  const scalar = Number(match[1]);
  if (!Number.isFinite(scalar)) throw new Error('wpctl returned a non-numeric volume');
  return { volume:Math.round(Math.max(0, Math.min(1, scalar)) * 100), muted:Boolean(match[2]) };
}

export function parsePactlAudioStatus(volumeOutput, muteOutput) {
  const volumeMatch = String(volumeOutput || '').match(/\b(\d{1,3})%/);
  const muteMatch = String(muteOutput || '').match(/\bMute:\s*(yes|no)\b/i);
  if (!volumeMatch || !muteMatch) throw new Error('pactl returned an unrecognized volume/mute status');
  return {
    volume:Math.max(0, Math.min(100, Number(volumeMatch[1]))),
    muted:muteMatch[1].toLowerCase() === 'yes',
  };
}

export function parseAmixerAudioStatus(output) {
  const rendered = String(output || '');
  const volumeMatch = rendered.match(/\[(\d{1,3})%\]/);
  const states = [...rendered.matchAll(/\[(on|off)\]/gi)].map(match => match[1].toLowerCase());
  if (!volumeMatch || !states.length) throw new Error('amixer returned an unrecognized Master status');
  return {
    volume:Math.max(0, Math.min(100, Number(volumeMatch[1]))),
    muted:states.every(state => state === 'off'),
  };
}

async function linuxAudioStatus(backend) {
  if (backend === 'wpctl') {
    const { stdout } = await runFile('wpctl', ['get-volume','@DEFAULT_AUDIO_SINK@'], { label:'audio status' });
    return parseWpctlAudioStatus(stdout);
  }
  if (backend === 'pactl') {
    const volumeResult = await runFile('pactl', ['get-sink-volume','@DEFAULT_SINK@'], { label:'audio status' });
    const muteResult = await runFile('pactl', ['get-sink-mute','@DEFAULT_SINK@'], { label:'audio status' });
    return parsePactlAudioStatus(volumeResult.stdout, muteResult.stdout);
  }
  const { stdout } = await runFile('amixer', ['get','Master'], { label:'audio status' });
  return parseAmixerAudioStatus(stdout);
}

export async function audioTool(args) {
  const action = requireEnum(args.action || 'status', 'action', ['status','set_volume','mute','unmute']);
  const volume = clamp(args.volume, 50, 0, 100);
  if (process.platform === 'darwin') {
    const readState = async () => {
      const { stdout } = await runOsa('set v to output volume of (get volume settings)\nset m to output muted of (get volume settings)\nreturn (v as text) & tab & (m as text)', { label:'audio status' });
      const [v,m] = stdout.trim().split('\t');
      return { volume:Number(v), muted:m === 'true' };
    };
    if (action !== 'status') {
      await runOsa(action === 'set_volume' ? `set volume output volume ${volume}` : action === 'mute' ? 'set volume with output muted' : 'set volume without output muted', { label:'audio control' });
    }
    return jsonResult({ ...(await readState()), action, backend:'osascript' });
  }
  if (process.platform === 'win32') {
    if (!commandExists('powershell.exe') && !process.env.SystemRoot) unavailable('Windows audio control');
    const { stdout } = await runPowerShell(windowsAudioPowerShell(action, volume), { label:'Windows CoreAudio control', timeout:30_000 });
    const rendered = stdout.trim();
    try {
      return jsonResult({ ...JSON.parse(rendered), action, backend:'coreaudio' });
    } catch {
      throw new Error(`Windows CoreAudio returned an invalid state payload: ${rendered || '(empty)'}`);
    }
  }

  const backend = commandExists('wpctl') ? 'wpctl' : commandExists('pactl') ? 'pactl' : commandExists('amixer') ? 'amixer' : null;
  if (!backend) unavailable('Audio control', 'wpctl, pactl or amixer is required on Linux');

  if (action !== 'status') {
    if (backend === 'wpctl') {
      if (action === 'set_volume') await runFile('wpctl', ['set-volume','@DEFAULT_AUDIO_SINK@',`${volume}%`], { label:'audio control' });
      else await runFile('wpctl', ['set-mute','@DEFAULT_AUDIO_SINK@',action === 'mute' ? '1' : '0'], { label:'audio control' });
    } else if (backend === 'pactl') {
      if (action === 'set_volume') await runFile('pactl', ['set-sink-volume','@DEFAULT_SINK@',`${volume}%`], { label:'audio control' });
      else await runFile('pactl', ['set-sink-mute','@DEFAULT_SINK@',action === 'mute' ? '1' : '0'], { label:'audio control' });
    } else {
      await runFile('amixer', action === 'set_volume' ? ['set','Master',`${volume}%`] : ['set','Master',action === 'mute' ? 'mute' : 'unmute'], { label:'audio control' });
    }
  }
  return jsonResult({ ...(await linuxAudioStatus(backend)), action, backend });
}
