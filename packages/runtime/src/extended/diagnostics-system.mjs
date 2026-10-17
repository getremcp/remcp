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

export function windowsInstalledAppsPowerShell() {
  return [
    "$ErrorActionPreference='Stop'",
    "$paths=@('HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')",
    "$items=foreach($path in $paths){Get-ItemProperty -Path $path -ErrorAction SilentlyContinue}",
    "$items|Where-Object{$_.DisplayName}|ForEach-Object{[PSCustomObject]@{name=[string]$_.DisplayName;version=[string]$_.DisplayVersion;publisher=[string]$_.Publisher;path=[string]$_.InstallLocation}}|ConvertTo-Json -Compress",
  ].join(';');
}

export async function installedApps(args) {
  const limit = clamp(args.limit, 1000, 1, 10_000);
  const filter = optionalString(args.filter);
  if (process.platform === 'win32') {
    const { stdout } = await runPowerShell(windowsInstalledAppsPowerShell(), { label:'installed apps', timeout:30_000, maxBuffer:32*1024*1024 });
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
