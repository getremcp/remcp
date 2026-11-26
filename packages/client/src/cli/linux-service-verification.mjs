// Verify the loaded systemd service, not merely an active unit with the same name.
import {spawnSync} from 'node:child_process';
import {linuxServiceLauncherFile} from './env.mjs';
import {discoverOwnedLinuxUnits} from './service-linux.mjs';

const unitName='remcp-agent.service';
const unitObject='/org/freedesktop/systemd1/unit/remcp_2dagent_2eservice';
const properties=['LoadState','ActiveState','SubState','FragmentPath','NeedDaemonReload','MainPID'];

function output(runner, executable, args) {
  const result=runner(executable,args,{encoding:'utf8',timeout:5000,maxBuffer:65536});
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') {
    throw new Error('Cannot verify loaded ReMCP systemd service');
  }
  return result.stdout;
}

function serviceSnapshot(runner, option) {
  const text=output(runner,'systemctl',[...option,'show',unitName,'--no-pager',
    '--property='+properties.join(',')]);
  const fields=new Map();
  for (const line of text.trimEnd().split('\n')) {
    const index=line.indexOf('=');
    const key=line.slice(0,index);
    if (index <= 0 || !properties.includes(key) || fields.has(key)) {
      throw new Error('Ambiguous ReMCP systemd service properties');
    }
    fields.set(key,line.slice(index+1));
  }
  if (fields.size !== properties.length) throw new Error('Incomplete ReMCP systemd service properties');
  return Object.fromEntries(properties.map(key=>[key,fields.get(key)]));
}

export function verifyLinuxService({runner=spawnSync, launcher=linuxServiceLauncherFile,
  discover=discoverOwnedLinuxUnits}={}) {
  const units=discover({launcher});
  // Match the installer's selected scope: an existing owned system unit takes
  // precedence over a stale per-user unit for root installations.
  const unit=units.find(item=>item.scope==='system') || units.find(item=>item.scope==='user');
  if (!unit) throw new Error('No owned ReMCP systemd unit found');
  const option=unit.scope==='user' ? ['--user'] : [];
  const before=serviceSnapshot(runner,option);
  const pid=Number(before.MainPID);
  if (before.FragmentPath !== unit.file || before.LoadState !== 'loaded' ||
      before.ActiveState !== 'active' || before.SubState !== 'running' ||
      before.NeedDaemonReload !== 'no' || !Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error('Loaded ReMCP systemd unit is not the verified running service');
  }

  // Use the typed D-Bus property rather than parsing systemctl's human-oriented
  // ExecStart string (argv can contain spaces, dollar signs, and punctuation).
  // Benign drop-ins are allowed only if the effective command still matches.
  const raw=output(runner,'busctl',[...option,'--json=short','get-property',
    'org.freedesktop.systemd1',unitObject,'org.freedesktop.systemd1.Service','ExecStart']);
  const command=JSON.parse(raw);
  const entry=command?.data?.[0];
  if (command?.type !== 'a(sasbttttuii)' || !Array.isArray(command.data) || command.data.length !== 1 ||
      !Array.isArray(entry) || entry.length !== 10 || entry[0] !== launcher ||
      !Array.isArray(entry[1]) || entry[1].length !== 3 ||
      entry[1][0] !== launcher || entry[1][1] !== 'start' || entry[1][2] !== '--service' ||
      entry[2] !== false || entry[7] !== pid) {
    throw new Error('Effective systemd command is not the owned ReMCP agent');
  }
  const after=serviceSnapshot(runner,option);
  const current=discover({launcher}).find(item=>item.scope===unit.scope);
  if (properties.some(key=>before[key] !== after[key]) || !current ||
      current.file !== unit.file || current.dev !== unit.dev || current.ino !== unit.ino) {
    throw new Error('ReMCP systemd service changed during verification');
  }
  return unit.scope;
}
