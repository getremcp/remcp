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

const WINDOWS_AUDIO_CORE_CSHARP = String.raw`
using System;
using System.Runtime.InteropServices;

namespace ReMCP {
  enum EDataFlow { eRender = 0, eCapture = 1, eAll = 2 }
  enum ERole { eConsole = 0, eMultimedia = 1, eCommunications = 2 }

  [ComImport]
  [Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  class MMDeviceEnumeratorComObject { }

  [ComImport]
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(EDataFlow dataFlow, uint stateMask, out IntPtr devices);
    [PreserveSig] int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice endpoint);
  }

  [ComImport]
  [Guid("D666063F-1587-4E43-81F1-B948E807363F")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, uint clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
  }

  [ComImport]
  [Guid("5CDF2C82-841E-4546-9722-0CF74078229A")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioEndpointVolume {
    [PreserveSig] int RegisterControlChangeNotify(IntPtr notify);
    [PreserveSig] int UnregisterControlChangeNotify(IntPtr notify);
    [PreserveSig] int GetChannelCount(out uint count);
    [PreserveSig] int SetMasterVolumeLevel(float levelDb, ref Guid eventContext);
    [PreserveSig] int SetMasterVolumeLevelScalar(float level, ref Guid eventContext);
    [PreserveSig] int GetMasterVolumeLevel(out float levelDb);
    [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
    [PreserveSig] int SetChannelVolumeLevel(uint channel, float levelDb, ref Guid eventContext);
    [PreserveSig] int SetChannelVolumeLevelScalar(uint channel, float level, ref Guid eventContext);
    [PreserveSig] int GetChannelVolumeLevel(uint channel, out float levelDb);
    [PreserveSig] int GetChannelVolumeLevelScalar(uint channel, out float level);
    [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool muted, ref Guid eventContext);
    [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool muted);
    [PreserveSig] int GetVolumeStepInfo(out uint step, out uint stepCount);
    [PreserveSig] int VolumeStepUp(ref Guid eventContext);
    [PreserveSig] int VolumeStepDown(ref Guid eventContext);
    [PreserveSig] int QueryHardwareSupport(out uint mask);
    [PreserveSig] int GetVolumeRange(out float minDb, out float maxDb, out float incrementDb);
  }

  public static class WindowsAudio {
    const uint CLSCTX_ALL = 23;

    static IAudioEndpointVolume Endpoint() {
      IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
      IMMDevice device;
      Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eMultimedia, out device));
      Guid iid = typeof(IAudioEndpointVolume).GUID;
      object endpoint;
      Marshal.ThrowExceptionForHR(device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out endpoint));
      return (IAudioEndpointVolume)endpoint;
    }

    public static string GetStateJson() {
      IAudioEndpointVolume endpoint = Endpoint();
      float scalar;
      bool muted;
      Marshal.ThrowExceptionForHR(endpoint.GetMasterVolumeLevelScalar(out scalar));
      Marshal.ThrowExceptionForHR(endpoint.GetMute(out muted));
      int volume = (int)Math.Round(Math.Max(0.0f, Math.Min(1.0f, scalar)) * 100.0f, MidpointRounding.AwayFromZero);
      return "{\"volume\":" + volume.ToString() + ",\"muted\":" + (muted ? "true" : "false") + "}";
    }

    public static void SetVolume(int volume) {
      if (volume < 0 || volume > 100) throw new ArgumentOutOfRangeException("volume");
      IAudioEndpointVolume endpoint = Endpoint();
      Guid context = Guid.Empty;
      Marshal.ThrowExceptionForHR(endpoint.SetMasterVolumeLevelScalar(volume / 100.0f, ref context));
    }

    public static void SetMuted(bool muted) {
      IAudioEndpointVolume endpoint = Endpoint();
      Guid context = Guid.Empty;
      Marshal.ThrowExceptionForHR(endpoint.SetMute(muted, ref context));
    }
  }
}
`;

export function windowsAudioPowerShell(action = 'status', volume = 50, { compileOnly = false } = {}) {
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
    "$source=@'",
    WINDOWS_AUDIO_CORE_CSHARP,
    "'@",
    'Add-Type -TypeDefinition $source -Language CSharp -ErrorAction Stop',
    compileOnly ? "Write-Output 'compiled'" : mutation,
    compileOnly ? '' : '[Console]::Out.WriteLine([ReMCP.WindowsAudio]::GetStateJson())',
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

export const POWER_ACTION_MAX_DELAY_SECONDS = 90;

export function normalizePowerActionDelay(value) {
  if (value === undefined || value === null || value === '') return 0;
  const delay = Number(value);
  if (!Number.isFinite(delay) || delay < 0 || delay > POWER_ACTION_MAX_DELAY_SECONDS) {
    throw new Error(`delay_seconds must be between 0 and ${POWER_ACTION_MAX_DELAY_SECONDS}`);
  }
  return delay;
}

export async function waitForPowerActionDelay(delaySeconds, signal) {
  throwIfCancelled(signal);
  if (delaySeconds <= 0) return;

  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      fn(value);
    };
    const onAbort = () => finish(reject, new ToolError('Cancelled by the client; power action was not executed.'));
    const timer = setTimeout(() => finish(resolve), delaySeconds * 1000);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.('abort', onAbort, { once:true });
  });

  throwIfCancelled(signal);
}

export async function powerAction(args, extra = {}) {
  const action = requireEnum(args.action, 'action', ['lock','sleep','restart','shutdown']);
  const policy = assertAllowedCommand(action === 'restart' ? 'reboot' : action === 'shutdown' ? 'shutdown' : action);
  const delay = normalizePowerActionDelay(args.delay_seconds);
  await waitForPowerActionDelay(delay, extra.signal);
  throwIfCancelled(extra.signal);
  if (process.platform === 'win32') {
    if (action === 'lock') await runPowerShell('rundll32.exe user32.dll,LockWorkStation', { label:'lock workstation' });
    else if (action === 'sleep') await runPowerShell('rundll32.exe powrprof.dll,SetSuspendState 0,1,0', { label:'sleep workstation' });
    else spawnDetached('shutdown.exe', [action === 'restart' ? '/r' : '/s','/t','0']);
  } else if (process.platform === 'darwin') {
    if (action === 'lock') spawnDetached('/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession', ['-suspend']);
    else if (action === 'sleep') await runFile('/usr/bin/pmset', ['sleepnow'], { label:'sleep' });
    else await runOsa(`tell application "System Events" to ${action === 'restart' ? 'restart' : 'shut down'}`, { label:action });
  } else {
    if (action === 'lock') {
      if (!commandExists('loginctl')) unavailable('Session lock', 'loginctl is required');
      await runFile('loginctl', ['lock-session'], { label:'lock session' });
    } else {
      if (!commandExists('systemctl')) unavailable('Power action', 'systemctl is required');
      await runFile('systemctl', [action === 'sleep' ? 'suspend' : action === 'restart' ? 'reboot' : 'poweroff'], { label:action });
    }
  }
  return text(`${policy.note ? `${policy.note}\n` : ''}Power action ${action} requested.`);
}
