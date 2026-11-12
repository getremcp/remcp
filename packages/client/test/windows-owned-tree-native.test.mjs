import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

const arm64Vm = process.platform === 'win32' && process.arch === 'arm64';

async function until(check, milliseconds = arm64Vm ? 65000 : 20000) {
  const deadline = performance.now() + milliseconds;
  while (performance.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Owned process tree did not reach the expected state');
}

test('Windows supervisor death also terminates an agent ignoring IPC and its detached descendant', {
  skip: process.platform !== 'win32', timeout: arm64Vm ? 120000 : 65000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remcp-owned-tree-'));
  const cli = path.join(root, 'agent.mjs');
  const descendant = path.join(root, 'descendant.mjs');
  const heartbeat = path.join(root, 'heartbeat');
  const stop = path.join(root, 'fixture-stop');
  const pidFile = path.join(root, 'child-pid');
  fs.writeFileSync(descendant, `
    import fs from 'node:fs';
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    setInterval(() => {
      if (fs.existsSync(${JSON.stringify(stop)})) process.exit(0);
      fs.writeFileSync(${JSON.stringify(heartbeat)}, String(Date.now()));
    }, 50);
  `);
  fs.writeFileSync(cli, `
    import fs from 'node:fs';
    import {spawn} from 'node:child_process';
    spawn(process.execPath, [${JSON.stringify(descendant)}], {detached:true,stdio:'ignore'}).unref();
    setInterval(() => { if (fs.existsSync(${JSON.stringify(stop)})) process.exit(0); }, 50);
  `);
  const owner = spawn(process.execPath, [path.resolve('src/cli/windows-user-supervisor.mjs'), 'serve', cli], {
    env: {...process.env, REMCP_CONFIG_DIR:path.join(root, 'config')}, stdio:['ignore','ignore','pipe'],
  });
  let errors = '';
  owner.stderr.on('data', b => { errors += b; });
  try {
    await until(() => fs.existsSync(heartbeat));
    owner.kill('SIGKILL');
    if (owner.exitCode === null && owner.signalCode === null) await once(owner, 'exit');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    const gone = () => {
      try { process.kill(pid, 0); return false; }
      catch (e) { if (e.code === 'ESRCH') return true; throw e; }
    };
    await until(gone, arm64Vm ? 18000 : 7000);
    const value = fs.readFileSync(heartbeat, 'utf8');
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(fs.readFileSync(heartbeat, 'utf8'), value, errors);
  } finally {
    // Cooperative cleanup belongs only to this randomly named fixture. No PID tree scan.
    fs.writeFileSync(stop, 'stop');
    if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL');
    await new Promise(resolve => setTimeout(resolve, 500));
    fs.rmSync(root, {recursive:true,force:true,maxRetries:20,retryDelay:100});
  }
});

test('Windows supervisor refuses stop and restart after losing an unacknowledged job', {
  skip:process.platform !== 'win32',timeout:arm64Vm ? 160000 : 65000,
}, async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'remcp-job-failure-'));
  const cli=path.join(root,'agent.mjs'), marker=path.join(root,'ready'), launches=path.join(root,'launches');
  const stop=path.join(root,'stop');
  fs.writeFileSync(cli, `import fs from 'node:fs';
    fs.appendFileSync(${JSON.stringify(launches)},'started\\n');
    fs.writeFileSync(${JSON.stringify(marker)},'ready');
    setInterval(()=>{if(fs.existsSync(${JSON.stringify(stop)}))process.exit(0);},50);`);
  const env={...process.env,REMCP_CONFIG_DIR:path.join(root,'config')};
  const fixture=path.join(root,'fixture'); fs.mkdirSync(fixture);
  for(const name of ['windows-owned-job.mjs','windows-owned-job-source.mjs','windows-interop.mjs']) {
    fs.copyFileSync(path.resolve('src/cli',name),path.join(fixture,name));
  }
  fs.cpSync(path.resolve('src/cli/native'),path.join(fixture,'native'),{recursive:true});
  const supervisor=path.join(fixture,'windows-user-supervisor.mjs');
  const source=fs.readFileSync(path.resolve('src/cli/windows-user-supervisor.mjs'),'utf8');
  const injection=`const ownChild = child;
    if (ownChild.ownedJob) { const crash=setInterval(()=>{
      if(fs.existsSync(${JSON.stringify(marker)})){clearInterval(crash);ownChild.kill('SIGKILL');}
    },20); }`;
  assert.ok(source.includes('const ownChild = child;'));
  fs.writeFileSync(supervisor,source.replace('const ownChild = child;',injection));
  const owner=spawn(process.execPath,[supervisor,'serve',cli],{env,stdio:'ignore'});
  const control=action=>spawnSync(process.execPath,[supervisor,'control',action],{
    env,encoding:'utf8',timeout:arm64Vm ? 30000 : 16000,
  });
  try {
    // This disposable supervisor copy crashes its retained ChildProcess helper.
    await until(()=>fs.existsSync(marker));
    await until(()=>{const s=control('status');return s.status===0 && !JSON.parse(s.stdout).running;});
    assert.notEqual(control('stop').status,0,'missing empty acknowledgement must block uninstall');
    assert.notEqual(control('restart').status,0,'restart must preserve the failed ownership state');
    await new Promise(resolve=>setTimeout(resolve,3500));
    assert.equal(fs.readFileSync(launches,'utf8'),'started\n','failed job must not spawn a replacement');
  } finally {
    fs.writeFileSync(stop,'stop');
    if(owner.exitCode===null && owner.signalCode===null) owner.kill('SIGKILL');
    await new Promise(resolve=>setTimeout(resolve,500));
    fs.rmSync(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});
  }
});
