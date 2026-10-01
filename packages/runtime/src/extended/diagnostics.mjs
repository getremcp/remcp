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
import { resolveSafePath, text } from '../util.mjs';
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

function durationSpec(value) {
  const raw = optionalString(value) || '10m';
  if (!/^\d+(?:s|m|h|d)$/.test(raw)) throw new Error('since must look like 30s, 10m, 2h, or 1d');
  return raw;
}

export async function serviceTool(args) {
  const action = requireEnum(args.action || 'list', 'action', ['list','status','start','stop','restart']);
  const name = optionalString(args.name);
  if (!['list'].includes(action) && !name) throw new Error('name is required unless action=list');
  const scope = requireEnum(args.scope || 'user', 'scope', ['user','system']);
  const policy = ['list','status'].includes(action) ? null : assertAllowedCommand(`${process.platform === 'win32' ? `${action}-service` : process.platform === 'darwin' ? 'launchctl' : 'systemctl'} ${action} ${name}`);

  if (process.platform === 'win32') {
    if (action === 'list') {
      const { stdout } = await runPowerShell('Get-Service | Select-Object Name,DisplayName,Status,StartType | ConvertTo-Json -Compress', { label: 'list services' });
      return text(stdout.trim() || '[]');
    }
    const safe = escapePowerShellSingle(name);
    if (action === 'status') {
      const { stdout } = await runPowerShell(`Get-Service -Name '${safe}' | Select-Object Name,DisplayName,Status,StartType | ConvertTo-Json -Compress`, { label: 'service status' });
      return text(stdout.trim());
    }
    const verb = action === 'start' ? 'Start-Service' : action === 'stop' ? 'Stop-Service' : 'Restart-Service';
    await runPowerShell(`${verb} -Name '${safe}' -ErrorAction Stop`, { label: `${action} service`, timeout: 30_000 });
    return text(`${policy?.note ? `${policy.note}\n` : ''}${action} requested for service ${name}.`);
  }

  if (process.platform === 'darwin') {
    if (action === 'list') return text((await runFile('/bin/launchctl', ['list'], { label: 'launchctl list' })).stdout);
    const domain = scope === 'system' ? 'system' : `gui/${process.getuid?.() ?? 0}`;
    const target = `${domain}/${name}`;
    if (action === 'status') {
      const result = await runFile('/bin/launchctl', ['print', target], { label: 'launchctl print', allowFailure: true });
      if (result.code !== 0) throw new Error(result.stderr.trim() || `Service ${target} was not found`);
      return text(result.stdout);
    }
    if (action === 'restart') await runFile('/bin/launchctl', ['kickstart', '-k', target], { label: 'launchctl kickstart' });
    else if (action === 'start') await runFile('/bin/launchctl', ['kickstart', target], { label: 'launchctl kickstart' });
    else await runFile('/bin/launchctl', ['kill', 'SIGTERM', target], { label: 'launchctl stop' });
    return text(`${policy?.note ? `${policy.note}\n` : ''}${action} requested for ${target}.`);
  }

  if (!commandExists('systemctl')) unavailable('Service control', 'systemctl is required on Linux');
  const base = scope === 'user' ? ['--user'] : [];
  if (action === 'list') return text((await runFile('systemctl', [...base, 'list-units', '--type=service', '--all', '--no-pager', '--plain'], { label: 'systemctl list' })).stdout);
  if (action === 'status') {
    const result = await runFile('systemctl', [...base, 'status', name, '--no-pager', '--plain'], { label: 'systemctl status', allowFailure: true });
    const rendered = `${result.stdout}${result.stderr}`.trim();
    return text(rendered, result.code !== 0 && !result.stdout.trim());
  }
  await runFile('systemctl', [...base, action, name], { label: `systemctl ${action}`, timeout: 30_000 });
  return text(`${policy?.note ? `${policy.note}\n` : ''}${action} requested for service ${name}.`);
}

export async function eventLog(args) {
  const limit = clamp(args.limit, 200, 1, 5000);
  const since = durationSpec(args.since);
  const filter = optionalString(args.filter || args.query);
  if (process.platform === 'win32') {
    const log = escapePowerShellSingle(optionalString(args.log) || 'System');
    const n = Number.parseInt(since, 10), unit = since.at(-1);
    const seconds = n * ({ s:1, m:60, h:3600, d:86400 }[unit] || 60);
    const where = filter ? ` | Where-Object { $_.Message -like '*${escapePowerShellSingle(filter)}*' -or $_.ProviderName -like '*${escapePowerShellSingle(filter)}*' }` : '';
    const script = `Get-WinEvent -FilterHashtable @{LogName='${log}';StartTime=(Get-Date).AddSeconds(-${seconds})} -ErrorAction SilentlyContinue${where} | Select-Object -First ${limit} TimeCreated,Id,LevelDisplayName,ProviderName,Message | ConvertTo-Json -Compress -Depth 3`;
    return text((await runPowerShell(script, { label: 'event log', timeout: 30_000 })).stdout.trim() || '[]');
  }
  if (process.platform === 'darwin') {
    const argv = ['show','--last',since,'--style','ndjson'];
    if (filter) argv.push('--predicate', `eventMessage CONTAINS[c] ${JSON.stringify(filter)}`);
    const { stdout } = await runFileHeadLines('/usr/bin/log', argv, limit, { label: 'macOS unified log', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    return text(stdout);
  }
  if (!commandExists('journalctl')) unavailable('Event logs', 'journalctl is required on Linux');
  const n = Number.parseInt(since, 10), unit = since.at(-1);
  const argv = ['--no-pager','-n',String(limit),'--since',`${n} ${{s:'seconds',m:'minutes',h:'hours',d:'days'}[unit]} ago`,'-o','short-iso'];
  if (filter) argv.push('--grep', filter);
  const result = await runFile('journalctl', argv, { label: 'journalctl', timeout: 30_000, allowFailure: true });
  const rendered = `${result.stdout}${result.stderr}`.trim();
  return text(rendered, result.code !== 0 && !result.stdout.trim());
}

async function connectivityTest(host, port, timeoutMs) {
  return new Promise(resolve => {
    const started = performance.now();
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); resolve(value); };
    const timer = setTimeout(() => finish({ ok:false, host, port, error:'timeout', latency_ms:Math.round(performance.now()-started) }), timeoutMs);
    socket.once('connect', () => finish({ ok:true, host, port, latency_ms:Math.round(performance.now()-started) }));
    socket.once('error', error => finish({ ok:false, host, port, error:error.code || error.message, latency_ms:Math.round(performance.now()-started) }));
  });
}

export async function networkTool(args) {
  const action = requireEnum(args.action || 'summary', 'action', ['summary','interfaces','dns','routes','listeners','test']);
  if (action === 'interfaces') return jsonResult(os.networkInterfaces());
  if (action === 'dns') return jsonResult({ servers:dns.getServers(), hostname:os.hostname() });
  if (action === 'summary') return jsonResult({ hostname:os.hostname(), interfaces:os.networkInterfaces(), dns:dns.getServers() });
  if (action === 'test') {
    const host = optionalString(args.host); if (!host) throw new Error('host is required for action=test');
    return jsonResult(await connectivityTest(host, clamp(args.port, 443, 1, 65535), clamp(args.timeout_ms, 3000, 100, 30_000)));
  }
  if (process.platform === 'win32') {
    const script = action === 'routes'
      ? 'Get-NetRoute | Select-Object DestinationPrefix,NextHop,RouteMetric,InterfaceAlias,AddressFamily | ConvertTo-Json -Compress'
      : 'Get-NetTCPConnection -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess,State | Sort-Object LocalPort | ConvertTo-Json -Compress';
    return text((await runPowerShell(script, { label:`network ${action}` })).stdout.trim() || '[]');
  }
  if (process.platform === 'darwin' && action === 'routes') {
    return text((await runFile('/usr/sbin/netstat', ['-rn'], { label:'routes' })).stdout);
  }
  if (action === 'routes') {
    if (commandExists('ip')) return text((await runFile('ip', ['route','show'], { label:'routes' })).stdout);
    if (commandExists('route')) return text((await runFile('route', ['-n'], { label:'routes' })).stdout);
    unavailable('Route inventory', 'ip or route is required');
  }
  if (commandExists('ss')) return text((await runFile('ss', ['-lntup'], { label:'listeners', allowFailure:true })).stdout);
  if (commandExists('netstat')) return text((await runFile('netstat', ['-an'], { label:'listeners' })).stdout);
  unavailable('Listener inventory', 'ss or netstat is required');
}

export async function installedApps(args) {
  const limit = clamp(args.limit, 1000, 1, 10_000);
  const filter = optionalString(args.filter);
  if (process.platform === 'win32') {
    const where = filter ? ` | Where-Object { $_.DisplayName -like '*${escapePowerShellSingle(filter)}*' }` : '';
    const script = `$paths=@('HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*');Get-ItemProperty $paths -ErrorAction SilentlyContinue${where}|Where-Object{$_.DisplayName}|Select-Object -First ${limit} DisplayName,DisplayVersion,Publisher,InstallLocation|Sort-Object DisplayName -Unique|ConvertTo-Json -Compress`;
    return text((await runPowerShell(script, { label:'installed apps', timeout:30_000 })).stdout.trim() || '[]');
  }
  if (process.platform === 'darwin') {
    const parsed = JSON.parse((await runFile('/usr/sbin/system_profiler', ['SPApplicationsDataType','-json'], { label:'installed apps', timeout:60_000, maxBuffer:64*1024*1024 })).stdout);
    const apps = (parsed.SPApplicationsDataType || []).filter(app => !filter || String(app._name || '').toLowerCase().includes(filter.toLowerCase())).slice(0, limit);
    return jsonResult(apps.map(app => ({ name:app._name, version:app.version || null, path:app.path || null, signed_by:app.signed_by || null })));
  }
  if (commandExists('dpkg-query')) {
    const { stdout } = await runFile('dpkg-query', ['-W','-f=${binary:Package}\t${Version}\t${Maintainer}\n'], { label:'installed apps', maxBuffer:32*1024*1024 });
    return text(stdout.split('\n').filter(Boolean).filter(line => !filter || line.toLowerCase().includes(filter.toLowerCase())).slice(0, limit).join('\n'));
  }
  if (commandExists('rpm')) {
    const { stdout } = await runFile('rpm', ['-qa','--qf','%{NAME}\t%{VERSION}-%{RELEASE}\t%{VENDOR}\n'], { label:'installed apps', maxBuffer:32*1024*1024 });
    return text(stdout.split('\n').filter(Boolean).filter(line => !filter || line.toLowerCase().includes(filter.toLowerCase())).slice(0, limit).join('\n'));
  }
  unavailable('Installed application inventory', 'dpkg-query or rpm is required');
}

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

export async function audioTool(args) {
  const action = requireEnum(args.action || 'status', 'action', ['status','set_volume','mute','unmute']);
  const volume = clamp(args.volume, 50, 0, 100);
  if (process.platform === 'darwin') {
    if (action === 'status') {
      const { stdout } = await runOsa('set v to output volume of (get volume settings)\nset m to output muted of (get volume settings)\nreturn (v as text) & tab & (m as text)', { label:'audio status' });
      const [v,m] = stdout.trim().split('\t'); return jsonResult({ volume:Number(v), muted:m === 'true' });
    }
    await runOsa(action === 'set_volume' ? `set volume output volume ${volume}` : action === 'mute' ? 'set volume with output muted' : 'set volume without output muted', { label:'audio control' });
    return audioTool({ action:'status' });
  }
  if (process.platform === 'win32') {
    if (!commandExists('powershell.exe') && !process.env.SystemRoot) unavailable('Windows audio control');
    const { stdout } = await runPowerShell(windowsAudioPowerShell(action, volume), { label:'Windows CoreAudio control', timeout:30_000 });
    const rendered = stdout.trim();
    try {
      return jsonResult(JSON.parse(rendered));
    } catch {
      throw new Error(`Windows CoreAudio returned an invalid state payload: ${rendered || '(empty)'}`);
    }
  }
  if (commandExists('wpctl')) {
    if (action === 'status') return text((await runFile('wpctl', ['get-volume','@DEFAULT_AUDIO_SINK@'], { label:'audio status' })).stdout.trim());
    if (action === 'set_volume') await runFile('wpctl', ['set-volume','@DEFAULT_AUDIO_SINK@',`${volume}%`], { label:'audio control' });
    else await runFile('wpctl', ['set-mute','@DEFAULT_AUDIO_SINK@',action === 'mute' ? '1' : '0'], { label:'audio control' });
    return text(`Audio action ${action} completed.`);
  }
  if (commandExists('pactl')) {
    if (action === 'status') return text(`${(await runFile('pactl',['get-sink-volume','@DEFAULT_SINK@'],{label:'audio status'})).stdout}${(await runFile('pactl',['get-sink-mute','@DEFAULT_SINK@'],{label:'audio status'})).stdout}`.trim());
    if (action === 'set_volume') await runFile('pactl', ['set-sink-volume','@DEFAULT_SINK@',`${volume}%`], { label:'audio control' });
    else await runFile('pactl', ['set-sink-mute','@DEFAULT_SINK@',action === 'mute' ? '1' : '0'], { label:'audio control' });
    return text(`Audio action ${action} completed.`);
  }
  if (commandExists('amixer')) {
    if (action === 'status') return text((await runFile('amixer',['get','Master'],{label:'audio status'})).stdout);
    await runFile('amixer', action === 'set_volume' ? ['set','Master',`${volume}%`] : ['set','Master',action === 'mute' ? 'mute' : 'unmute'], { label:'audio control' });
    return text(`Audio action ${action} completed.`);
  }
  unavailable('Audio control', 'wpctl, pactl or amixer is required on Linux');
}

export async function powerAction(args) {
  const action = requireEnum(args.action, 'action', ['lock','sleep','restart','shutdown']);
  const policy = assertAllowedCommand(action === 'restart' ? 'reboot' : action === 'shutdown' ? 'shutdown' : action);
  const delay = clamp(args.delay_seconds, 0, 0, 3600);
  if (delay) await new Promise(resolve => setTimeout(resolve, delay * 1000));
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

export function resolveRecordScreenFfmpeg({
  platform = process.platform,
  commandExistsFn = commandExists,
  existsSyncFn = existsSync,
} = {}) {
  if (commandExistsFn('ffmpeg')) return 'ffmpeg';
  if (platform === 'darwin') {
    for (const candidate of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
      if (existsSyncFn(candidate)) return candidate;
    }
  }
  return null;
}

export function parseAvfoundationScreenInput(output) {
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.match(/\[(\d+)\]\s+Capture screen(?:\s+\d+)?\s*$/i);
    if (match) return match[1];
  }
  return null;
}

async function avfoundationScreenInput(ffmpeg) {
  const result = await runFile(ffmpeg, [
    '-hide_banner',
    '-f','avfoundation',
    '-list_devices','true',
    '-i','',
  ], { label:'AVFoundation device inventory', timeout:10_000, allowFailure:true });
  const index = parseAvfoundationScreenInput(`${result.stderr || ''}\n${result.stdout || ''}`);
  if (!index) unavailable('Screen recording', 'ffmpeg could not find an AVFoundation Capture screen input');
  return index;
}

export function gnomeScreencastCandidate({
  platform = process.platform,
  wayland = platform === 'linux' ? isWaylandSession() : false,
  desktop = process.env.XDG_CURRENT_DESKTOP || '',
  gnomeSessionMode = process.env.GNOME_SHELL_SESSION_MODE || '',
  sessionBus = process.env.DBUS_SESSION_BUS_ADDRESS || '',
  commandExistsFn = commandExists,
} = {}) {
  const gnomeSession = /gnome/i.test(String(desktop)) || Boolean(String(gnomeSessionMode).trim());
  return platform === 'linux'
    && wayland
    && gnomeSession
    && Boolean(String(sessionBus).trim())
    && commandExistsFn('gjs');
}

export function recordScreenBackend({
  platform = process.platform,
  wayland = platform === 'linux' ? isWaylandSession() : false,
  display = process.env.DISPLAY || '',
  desktop = process.env.XDG_CURRENT_DESKTOP || '',
  gnomeSessionMode = process.env.GNOME_SHELL_SESSION_MODE || '',
  sessionBus = process.env.DBUS_SESSION_BUS_ADDRESS || '',
  gnomeSupported = false,
  commandExistsFn = commandExists,
  existsSyncFn = existsSync,
} = {}) {
  if (platform === 'linux') {
    if (wayland) {
      if (gnomeSupported && gnomeScreencastCandidate({
        platform,
        wayland,
        desktop,
        gnomeSessionMode,
        sessionBus,
        commandExistsFn,
      })) return 'gnome-shell';
      if (commandExistsFn('wf-recorder') && commandExistsFn('timeout')) return 'wf-recorder';
      return null;
    }
    return Boolean(String(display).trim()) && commandExistsFn('ffmpeg') ? 'ffmpeg-x11' : null;
  }
  if (platform === 'darwin') {
    return resolveRecordScreenFfmpeg({ platform, commandExistsFn, existsSyncFn }) ? 'ffmpeg-avfoundation' : null;
  }
  if (platform === 'win32') {
    return resolveRecordScreenFfmpeg({ platform, commandExistsFn, existsSyncFn }) ? 'ffmpeg-gdigrab' : null;
  }
  return null;
}

export function recordScreenAvailable({
  platform = process.platform,
  wayland = platform === 'linux' ? isWaylandSession() : false,
  display = process.env.DISPLAY || '',
  desktop = process.env.XDG_CURRENT_DESKTOP || '',
  gnomeSessionMode = process.env.GNOME_SHELL_SESSION_MODE || '',
  sessionBus = process.env.DBUS_SESSION_BUS_ADDRESS || '',
  gnomeSupported = false,
  commandExistsFn = commandExists,
  existsSyncFn = existsSync,
} = {}) {
  return Boolean(recordScreenBackend({
    platform,
    wayland,
    display,
    desktop,
    gnomeSessionMode,
    sessionBus,
    gnomeSupported,
    commandExistsFn,
    existsSyncFn,
  }));
}

const GNOME_SCREENCAST_SUPPORT_HELPER = `const {Gio, GLib} = imports.gi;
const bus = Gio.bus_get_sync(Gio.BusType.SESSION, null);
const value = bus.call_sync(
  'org.gnome.Shell.Screencast',
  '/org/gnome/Shell/Screencast',
  'org.freedesktop.DBus.Properties',
  'Get',
  new GLib.Variant('(ss)', ['org.gnome.Shell.Screencast', 'ScreencastSupported']),
  new GLib.VariantType('(v)'),
  Gio.DBusCallFlags.NONE,
  3000,
  null
).deepUnpack();
print(value[0].deepUnpack() ? 'true' : 'false');
`;

let gnomeScreencastSupportCache = { key:'', value:false, expiresAt:0 };
let gnomeScreencastSupportProbe = { key:'', promise:null };

export async function gnomeScreencastSupported({
  platform = process.platform,
  wayland = platform === 'linux' ? isWaylandSession() : false,
  desktop = process.env.XDG_CURRENT_DESKTOP || '',
  gnomeSessionMode = process.env.GNOME_SHELL_SESSION_MODE || '',
  sessionBus = process.env.DBUS_SESSION_BUS_ADDRESS || '',
  commandExistsFn = commandExists,
  runFileFn = runFile,
  cacheMs = 15_000,
  nowFn = Date.now,
} = {}) {
  if (!gnomeScreencastCandidate({
    platform,
    wayland,
    desktop,
    gnomeSessionMode,
    sessionBus,
    commandExistsFn,
  })) return false;

  const key = [platform, wayland ? 'wayland' : '', desktop, gnomeSessionMode, sessionBus].join('|');
  const now = nowFn();
  if (cacheMs > 0 && gnomeScreencastSupportCache.key === key && gnomeScreencastSupportCache.expiresAt > now) {
    return gnomeScreencastSupportCache.value;
  }
  if (gnomeScreencastSupportProbe.key === key && gnomeScreencastSupportProbe.promise) {
    return gnomeScreencastSupportProbe.promise;
  }

  const promise = (async () => {
    let value = false;
    try {
      const result = await runFileFn('gjs', ['-c', GNOME_SCREENCAST_SUPPORT_HELPER], {
        label:'GNOME Shell screencast capability probe',
        timeout:5000,
        maxBuffer:64 * 1024,
        allowFailure:true,
      });
      value = Number(result.code) === 0 && String(result.stdout || '').trim() === 'true';
    } catch {
      value = false;
    }
    gnomeScreencastSupportCache = {
      key,
      value,
      expiresAt:nowFn() + Math.max(0, cacheMs),
    };
    return value;
  })();

  gnomeScreencastSupportProbe = { key, promise };
  try {
    return await promise;
  } finally {
    if (gnomeScreencastSupportProbe.key === key && gnomeScreencastSupportProbe.promise === promise) {
      gnomeScreencastSupportProbe = { key:'', promise:null };
    }
  }
}

const GNOME_SCREENCAST_HELPER = `const {Gio, GLib} = imports.gi;
const [destination, secondsRaw, fpsRaw] = ARGV;
const seconds = Number(secondsRaw);
const fps = Number(fpsRaw);
const bus = Gio.bus_get_sync(Gio.BusType.SESSION, null);
const destinationName = 'org.gnome.Shell.Screencast';
const objectPath = '/org/gnome/Shell/Screencast';
const interfaceName = 'org.gnome.Shell.Screencast';
const property = bus.call_sync(
  destinationName,
  objectPath,
  'org.freedesktop.DBus.Properties',
  'Get',
  new GLib.Variant('(ss)', [interfaceName, 'ScreencastSupported']),
  new GLib.VariantType('(v)'),
  Gio.DBusCallFlags.NONE,
  5000,
  null
).deepUnpack();
if (!property[0].deepUnpack()) throw new Error('GNOME Shell reports ScreencastSupported=false');
const options = {
  'draw-cursor': new GLib.Variant('b', true),
  'framerate': new GLib.Variant('i', fps),
};
const started = bus.call_sync(
  destinationName,
  objectPath,
  interfaceName,
  'Screencast',
  new GLib.Variant('(sa{sv})', [destination, options]),
  new GLib.VariantType('(bs)'),
  Gio.DBusCallFlags.NONE,
  10000,
  null
).deepUnpack();
if (!started[0]) throw new Error('GNOME Shell refused to start screencast');
GLib.usleep(Math.round(seconds * 1000000));
const stopped = bus.call_sync(
  destinationName,
  objectPath,
  interfaceName,
  'StopScreencast',
  null,
  new GLib.VariantType('(b)'),
  Gio.DBusCallFlags.NONE,
  10000,
  null
).deepUnpack();
if (!stopped[0]) throw new Error('GNOME Shell did not stop screencast cleanly');
print(JSON.stringify({ destination:started[1], stopped:stopped[0] }));
`;

async function recordGnomeShellScreen({ staged, stagingDirectory, seconds, fps }) {
  const helper = path.join(stagingDirectory, 'gnome-screencast.js');
  await writeFile(helper, GNOME_SCREENCAST_HELPER, { mode:0o600 });
  await runFile('gjs', [helper, staged, String(seconds), String(fps)], {
    label:'GNOME Shell screen recording',
    timeout:(seconds + 20) * 1000,
    maxBuffer:2 * 1024 * 1024,
  });
}

export function validateRecordingDestinationFormat(destination, format) {
  if (!destination) return;
  const extension = path.extname(destination).slice(1).toLowerCase();
  if (extension && extension !== format) {
    throw new Error(`Screen recording backend produces .${format}; destination must use .${format} or omit the extension`);
  }
}

async function openRecordingParent(destination) {
  return openDirectoryPath(path.dirname(destination));
}

async function copyRecordingFile(source, destination) {
  let input;
  let output;
  let parent;
  let temporary;
  try {
    input = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const sourceInfo = await input.stat();
    if (!sourceInfo.isFile()) throw new Error('Screen recording staging path is not a regular file');
    parent = await openRecordingParent(destination);
    const anchoredDestination = path.join(parent.anchor, path.basename(destination));
    const existing = await lstat(anchoredDestination).catch(() => null);
    if (existing?.isSymbolicLink()) throw new Error('Screen recording destination cannot be a symbolic link');
    if (existing && !existing.isFile()) throw new Error('Screen recording destination is not a regular file');
    temporary = path.join(parent.anchor, `.${path.basename(destination)}.${randomUUID()}.tmp`);
    output = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    for (;;) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      let written = 0;
      while (written < bytesRead) {
        const result = await output.write(buffer, written, bytesRead - written, offset + written);
        if (!result.bytesWritten) throw new Error('Could not finish writing the screen recording');
        written += result.bytesWritten;
      }
      offset += bytesRead;
    }
    await output.sync();
    await output.close();
    output = null;
    await rename(temporary, anchoredDestination);
    temporary = null;
  } finally {
    if (output) await output.close().catch(() => {});
    if (temporary) await unlink(temporary).catch(() => {});
    if (input) await input.close().catch(() => {});
    if (parent) await parent.close().catch(() => {});
  }
}

export async function recordScreen(args) {
  const seconds = clamp(args.duration_seconds, 5, 1, 120);
  const fps = clamp(args.fps, 15, 1, 60);
  const wayland = process.platform === 'linux' && isWaylandSession();
  const gnomeSupported = wayland ? await gnomeScreencastSupported() : false;
  const backend = recordScreenBackend({ platform:process.platform, wayland, gnomeSupported });
  if (!backend) {
    if (wayland) unavailable('Screen recording', 'GNOME Shell Screencast or wf-recorder with timeout is required on Wayland');
    if (process.platform === 'linux' && !String(process.env.DISPLAY || '').trim()) unavailable('Screen recording', 'an active X11 DISPLAY is required on Linux X11');
    if (process.platform === 'darwin') unavailable('Screen recording', 'ffmpeg is required on macOS');
    if (process.platform === 'win32') unavailable('Screen recording', 'ffmpeg is required on Windows');
    unavailable('Screen recording', 'ffmpeg is required on X11');
  }

  const format = backend === 'gnome-shell' ? 'webm' : 'mp4';
  const requestedDestination = args.destination ? await resolveSafePath(args.destination, 'destination') : '';
  if (requestedDestination) {
    validateRecordingDestinationFormat(requestedDestination, format);
    const existing = await lstat(requestedDestination).catch(() => null);
    if (existing?.isSymbolicLink()) throw new Error('Screen recording destination cannot be a symbolic link');
    if (existing && !existing.isFile()) throw new Error('Screen recording destination is not a regular file');
  }

  const stagingDirectory = await mkdtemp(path.join(os.tmpdir(), 'remcp-screen-'));
  const staged = path.join(stagingDirectory, `capture-${randomUUID()}.${format}`);
  let keepStaging = false;
  try {
    if (backend === 'gnome-shell') {
      await recordGnomeShellScreen({ staged, stagingDirectory, seconds, fps });
    } else if (backend === 'wf-recorder') {
      const result = await runFile('timeout', ['--signal=INT', `${seconds}s`, 'wf-recorder', '-f',staged,'-r',String(fps),'-c','libx264'], { label:'screen recording', timeout:(seconds+10)*1000, allowFailure:true });
      if (![0, 124, 130].includes(Number(result.code))) throw new Error(result.stderr.trim() || `wf-recorder exited ${result.code}`);
    } else {
      const ffmpeg = resolveRecordScreenFfmpeg();
      if (!ffmpeg) {
        if (process.platform === 'darwin') unavailable('Screen recording', 'ffmpeg is required on macOS');
        if (process.platform === 'win32') unavailable('Screen recording', 'ffmpeg is required on Windows');
        unavailable('Screen recording', 'ffmpeg is required on X11');
      }
      let argv;
      if (process.platform === 'win32') argv=['-y','-f','gdigrab','-framerate',String(fps),'-i','desktop','-t',String(seconds),'-pix_fmt','yuv420p',staged];
      else if (process.platform === 'darwin') {
        const input = await avfoundationScreenInput(ffmpeg);
        argv=['-y','-f','avfoundation','-framerate',String(fps),'-i',`${input}:none`,'-t',String(seconds),'-pix_fmt','yuv420p',staged];
      } else argv=['-y','-f','x11grab','-framerate',String(fps),'-i',process.env.DISPLAY,'-t',String(seconds),'-pix_fmt','yuv420p',staged];
      await runFile(ffmpeg, argv, { label:'screen recording', timeout:(seconds+20)*1000, maxBuffer:8*1024*1024 });
    }
    if (requestedDestination) {
      await copyRecordingFile(staged, requestedDestination);
      await rm(stagingDirectory, { recursive:true, force:true });
    }
    const output = requestedDestination || staged;
    const info = await stat(output);
    keepStaging = !requestedDestination;
    return jsonResult({ path:output, bytes:info.size, duration_seconds:seconds, format });
  } finally {
    if (!keepStaging) await rm(stagingDirectory, { recursive:true, force:true }).catch(() => {});
  }
}

export const diagnosticHandlers = {
  service:serviceTool,
  event_log:eventLog,
  network:networkTool,
  installed_apps:installedApps,
  environment:environmentTool,
  audio:audioTool,
  power_action:powerAction,
  record_screen:recordScreen,
};
