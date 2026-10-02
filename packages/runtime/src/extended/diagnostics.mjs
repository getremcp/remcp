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

function durationSpec(value) {
  const raw = optionalString(value) || '10m';
  if (!/^\d+(?:s|m|h|d)$/.test(raw)) throw new Error('since must look like 30s, 10m, 2h, or 1d');
  return raw;
}

export function macosLaunchctlDomain(scope = 'user', uid = process.getuid?.() ?? 0) {
  const normalized = requireEnum(scope, 'scope', ['user','system']);
  return normalized === 'system' ? 'system' : `gui/${uid}`;
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
    const domain = macosLaunchctlDomain(scope);
    if (action === 'list') return text((await runFile('/bin/launchctl', ['print', domain], { label: `launchctl print ${domain}` })).stdout);
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

export function filterMacosTcpListeners(output) {
  const lines = String(output || '').split(/\r?\n/);
  const header = lines.filter(line => /^Proto\s+/i.test(line) || /^Active Internet connections/i.test(line));
  const listeners = lines.filter(line => /\bLISTEN\b/i.test(line));
  return [...header, ...listeners].join('\n').trim();
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

export function linuxListenerBackend({ commandExistsFn = commandExists } = {}) {
  if (commandExistsFn('ss')) return { command:'ss', args:['-lntup'] };
  if (commandExistsFn('netstat')) return { command:'netstat', args:['-lntu'] };
  return null;
}

const CONTAINER_INTERFACE_PATTERN = /^(?:veth|docker\d*$|br-[0-9a-f]{6,}$)/i;

export function compactNetworkSummary({
  hostname = os.hostname(),
  interfaces = os.networkInterfaces(),
  dnsServers = dns.getServers(),
  maxInterfaces = 8,
  maxAddressesPerInterface = 4,
} = {}) {
  const entries = Object.entries(interfaces || {}).map(([name, rows], index) => {
    const normalizedRows = Array.isArray(rows) ? rows.filter(Boolean) : [];
    const hasExternal = normalizedRows.some(row => row?.internal !== true);
    const rank = hasExternal
      ? (CONTAINER_INTERFACE_PATTERN.test(name) ? 1 : 0)
      : 2;
    return { name, rows:normalizedRows, index, rank };
  });
  entries.sort((left, right) => left.rank - right.rank || left.index - right.index);

  const interfaceLimit = clamp(maxInterfaces, 8, 1, 64);
  const addressLimit = clamp(maxAddressesPerInterface, 4, 1, 16);
  const selected = entries.slice(0, interfaceLimit);
  const compact = {};
  let addressCount = 0;
  let addressCountReturned = 0;
  let addressesTruncated = false;

  for (const entry of entries) addressCount += entry.rows.length;
  for (const entry of selected) {
    const rows = entry.rows.slice(0, addressLimit);
    compact[entry.name] = rows;
    addressCountReturned += rows.length;
    if (entry.rows.length > rows.length) addressesTruncated = true;
  }

  return {
    hostname,
    dns:Array.isArray(dnsServers) ? dnsServers : [],
    interfaces:compact,
    interface_count:entries.length,
    interface_count_returned:selected.length,
    address_count:addressCount,
    address_count_returned:addressCountReturned,
    interfaces_truncated:entries.length > selected.length,
    addresses_truncated:addressesTruncated,
  };
}

export async function networkTool(args) {
  const action = requireEnum(args.action || 'summary', 'action', ['summary','interfaces','dns','routes','listeners','test']);
  if (action === 'interfaces') return jsonResult(os.networkInterfaces());
  if (action === 'dns') return jsonResult({ servers:dns.getServers(), hostname:os.hostname() });
  if (action === 'summary') return jsonResult(compactNetworkSummary());
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
  if (process.platform === 'darwin' && action === 'listeners') {
    const { stdout } = await runFile('/usr/sbin/netstat', ['-an', '-p', 'tcp'], { label:'listeners' });
    return text(filterMacosTcpListeners(stdout));
  }
  if (action === 'routes') {
    if (commandExists('ip')) return text((await runFile('ip', ['route','show'], { label:'routes' })).stdout);
    if (commandExists('route')) return text((await runFile('route', ['-n'], { label:'routes' })).stdout);
    unavailable('Route inventory', 'ip or route is required');
  }
  const listenerBackend = linuxListenerBackend();
  if (listenerBackend) return text((await runFile(listenerBackend.command, listenerBackend.args, { label:'listeners', allowFailure:true })).stdout);
  unavailable('Listener inventory', 'ss or netstat is required');
}

function installedAppString(value) {
  const normalized = value == null ? '' : String(value).trim();
  return normalized || null;
}

export function normalizeInstalledApp(row = {}) {
  const name = installedAppString(row.name ?? row.DisplayName ?? row._name);
  if (!name) return null;
  const signedBy = installedAppString(row.signed_by);
  return {
    name,
    version:installedAppString(row.version ?? row.DisplayVersion),
    publisher:installedAppString(row.publisher ?? row.Publisher),
    path:installedAppString(row.path ?? row.InstallLocation),
    ...(signedBy ? { signed_by:signedBy } : {}),
  };
}

export function parseInstalledAppsTsv(output) {
  return String(output || '').split(/\r?\n/).filter(Boolean).map(line => {
    const [name = '', version = '', publisher = '', pathValue = ''] = line.split('\t');
    return normalizeInstalledApp({ name, version, publisher, path:pathValue });
  }).filter(Boolean);
}

export function installedAppsPayload(rows, { backend, filter = null, limit = 1000 } = {}) {
  const wanted = optionalString(filter)?.toLowerCase() || null;
  const boundedLimit = clamp(limit, 1000, 1, 10_000);
  const seen = new Set();
  const normalized = [];
  for (const raw of Array.isArray(rows) ? rows : (rows ? [rows] : [])) {
    const app = normalizeInstalledApp(raw);
    if (!app) continue;
    if (wanted && !app.name.toLowerCase().includes(wanted)) continue;
    const key = [app.name.toLowerCase(), app.version || '', app.path || ''].join('\u0000');
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(app);
  }
  normalized.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity:'base' })
    || String(left.version || '').localeCompare(String(right.version || ''), undefined, { sensitivity:'base' }));
  const data = normalized.slice(0, boundedLimit);
  return {
    data,
    backend:String(backend || 'unknown'),
    count:normalized.length,
    returned:data.length,
    truncated:normalized.length > data.length,
  };
}

export async function installedApps(args) {
  const limit = clamp(args.limit, 1000, 1, 10_000);
  const filter = optionalString(args.filter);
  if (process.platform === 'win32') {
    const script = "$paths=@('HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*');Get-ItemProperty $paths -ErrorAction SilentlyContinue|Where-Object{$_.DisplayName}|Select-Object DisplayName,DisplayVersion,Publisher,InstallLocation|Sort-Object DisplayName,DisplayVersion -Unique|ConvertTo-Json -Compress";
    const { stdout } = await runPowerShell(script, { label:'installed apps', timeout:30_000, maxBuffer:32*1024*1024 });
    let parsed;
    try {
      parsed = JSON.parse(stdout.trim() || '[]');
    } catch {
      throw new Error('Windows installed-app inventory returned invalid JSON');
    }
    return jsonResult(installedAppsPayload(parsed, { backend:'windows-registry', filter, limit }));
  }
  if (process.platform === 'darwin') {
    const parsed = JSON.parse((await runFile('/usr/sbin/system_profiler', ['SPApplicationsDataType','-json'], { label:'installed apps', timeout:60_000, maxBuffer:64*1024*1024 })).stdout);
    return jsonResult(installedAppsPayload(parsed.SPApplicationsDataType || [], { backend:'system_profiler', filter, limit }));
  }
  if (commandExists('dpkg-query')) {
    const { stdout } = await runFile('dpkg-query', ['-W','-f=${binary:Package}\t${Version}\t${Maintainer}\n'], { label:'installed apps', maxBuffer:32*1024*1024 });
    return jsonResult(installedAppsPayload(parseInstalledAppsTsv(stdout), { backend:'dpkg-query', filter, limit }));
  }
  if (commandExists('rpm')) {
    const { stdout } = await runFile('rpm', ['-qa','--qf','%{NAME}\t%{VERSION}-%{RELEASE}\t%{VENDOR}\n'], { label:'installed apps', maxBuffer:32*1024*1024 });
    return jsonResult(installedAppsPayload(parseInstalledAppsTsv(stdout), { backend:'rpm', filter, limit }));
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
