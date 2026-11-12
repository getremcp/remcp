import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnWindowsOwnedJob } from '../src/cli/windows-owned-job.mjs';

const arm64Vm = process.platform === 'win32' && process.arch === 'arm64';

async function until(check, ms = arm64Vm ? 30000 : 10000) {
  const deadline=performance.now()+ms;
  while (performance.now()<deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve,50));
  }
  throw new Error('Owned-job fixture timed out');
}

for (const action of ['stop','helper-crash','root-exit']) test(`Windows job contains detached descendants on ${action}`, {
  skip:process.platform !== 'win32', timeout:arm64Vm ? 110000 : 65000,
}, async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'remcp job %!& Unicode-Ж-'));
  const stop=path.join(root,'stop'), pidFile=path.join(root,'descendant-pid');
  const child=path.join(root,'child.mjs'), cli=path.join(root,'root.mjs'), argsFile=path.join(root,'args');
  fs.writeFileSync(child, `import fs from 'node:fs';
    fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
    setInterval(()=>{if(fs.existsSync(${JSON.stringify(stop)}))process.exit(0);},50);`);
  fs.writeFileSync(cli, `import fs from 'node:fs';import {spawn} from 'node:child_process';
    fs.writeFileSync(${JSON.stringify(argsFile)},JSON.stringify(process.argv.slice(2)));
    spawn(process.execPath,[${JSON.stringify(child)}],{detached:true,stdio:'ignore'}).unref();
    setInterval(()=>{if(fs.existsSync(${JSON.stringify(stop)}) ||
      (${JSON.stringify(action)}==='root-exit' && fs.existsSync(${JSON.stringify(pidFile)})))process.exit(0);},50);`);
  const args=['literal " quote','trailing\\','Unicode Ж %!&'];
  const owner=spawnWindowsOwnedJob(process.execPath,[cli,...args],{cwd:root,log:path.join(root,'agent.log')});
  try {
    await owner.ownedJob.ready;
    await until(()=>fs.existsSync(pidFile) && /^\d+$/.test(fs.readFileSync(pidFile,'utf8')));
    assert.deepEqual(JSON.parse(fs.readFileSync(argsFile,'utf8')),args);
    const pid=Number(fs.readFileSync(pidFile,'utf8'));
    if (action==='helper-crash') {
      owner.kill('SIGKILL'); // The held ChildProcess is this fixture's helper only.
      await assert.rejects(owner.ownedJob.done,/owned job failed/i);
      assert.equal(owner.ownedJob.confirmedEmpty,false,'a killed helper cannot acknowledge empty');
    } else {
      if(action==='stop') await owner.ownedJob.stop();
      else await owner.ownedJob.done;
      assert.equal(owner.ownedJob.confirmedEmpty,true);
    }
    await until(()=>{try{process.kill(pid,0);return false;}catch(e){if(e.code==='ESRCH')return true;throw e;}});
    assert.match(fs.readFileSync(path.join(root,'agent.log'),'utf8'),/^$/);
  } finally {
    fs.writeFileSync(stop,'stop');
    if(owner.exitCode===null && owner.signalCode===null) owner.kill('SIGKILL');
    await new Promise(resolve=>setTimeout(resolve,500));
    fs.rmSync(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});
  }
});

test('Windows job fails closed when the executable cannot be created', {
  skip:process.platform !== 'win32', timeout:arm64Vm ? 90000 : 65000,
}, async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'remcp-job-denied-'));
  const helper=spawnWindowsOwnedJob(path.join(root,'missing.exe'),[],{cwd:root,log:path.join(root,'log')});
  try {
    await assert.rejects(helper.ownedJob.ready,/Windows owned job failed/);
    await assert.rejects(helper.ownedJob.stop(),/Windows owned job failed/);
    assert.equal(helper.ownedJob.confirmedEmpty,false);
  } finally { fs.rmSync(root,{recursive:true,force:true,maxRetries:20,retryDelay:100}); }
});

test('Windows job tolerates slow PowerShell initialization before its bounded handshake', {
  skip:process.platform !== 'win32', timeout:arm64Vm ? 105000 : 70000,
}, async () => {
  // A disposable helper copy delays readiness beyond the previous 15-second
  // watchdog. The test uses the real Windows Job Object implementation.
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'remcp-slow-owned-job-'));
  const sourceFile=path.resolve('src/cli/windows-owned-job-source.mjs');
  const source=fs.readFileSync(sourceFile,'utf8');
  const marker='$job = New-Object ReMcpOwnedJob';
  assert.equal(source.split(marker).length,2,'expected one owned-job construction boundary');
  fs.writeFileSync(path.join(root,'windows-owned-job-source.mjs'),
    source.replace(marker,'Start-Sleep -Milliseconds 17000\n'+marker));
  fs.copyFileSync(path.resolve('src/cli/windows-owned-job.mjs'),
    path.join(root,'windows-owned-job.mjs'));
  fs.copyFileSync(path.resolve('src/cli/windows-interop.mjs'), path.join(root,'windows-interop.mjs'));
  fs.cpSync(path.resolve('src/cli/native'),path.join(root,'native'),{recursive:true});
  const child=path.join(root,'child.mjs');
  fs.writeFileSync(child,'setTimeout(()=>process.exit(0),100);');
  let owner;
  try {
    const {spawnWindowsOwnedJob:spawnSlow}=await import(
      pathToFileURL(path.join(root,'windows-owned-job.mjs')).href);
    const began=performance.now();
    owner=spawnSlow(process.execPath,[child],{cwd:root,log:path.join(root,'agent.log')});
    await owner.ownedJob.ready;
    assert.ok(performance.now()-began>=16000,'helper unexpectedly skipped delayed readiness');
    await owner.ownedJob.done;
    assert.equal(owner.ownedJob.confirmedEmpty,true);
  } finally {
    if(owner?.exitCode===null && owner?.signalCode===null) owner.kill('SIGKILL');
    await new Promise(resolve=>setTimeout(resolve,200));
    fs.rmSync(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});
  }
});

test('loaded helper assets allow package promotion while the owned job is active', {
 skip:process.platform!=='win32',timeout:90000,
},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'remcp-loaded-helper-'));
 const pkg=path.join(root,'package');fs.mkdirSync(pkg);
 for(const name of ['windows-owned-job.mjs','windows-owned-job-source.mjs','windows-interop.mjs'])
  fs.copyFileSync(path.resolve('src/cli',name),path.join(pkg,name));
 fs.cpSync(path.resolve('src/cli/native'),path.join(pkg,'native'),{recursive:true});
 const child=path.join(root,'child.mjs');fs.writeFileSync(child,'setInterval(()=>{},100);');
 const {spawnWindowsOwnedJob:spawnLocal}=await import(pathToFileURL(path.join(pkg,'windows-owned-job.mjs')).href);
 const owner=spawnLocal(process.execPath,[child],{cwd:root,log:path.join(root,'log')});
 try{
  await owner.ownedJob.ready;
  fs.renameSync(pkg,pkg+'.old');
  await owner.ownedJob.stop();
  assert.equal(owner.ownedJob.confirmedEmpty,true);
 }finally{
  if(owner.exitCode===null&&owner.signalCode===null)owner.kill('SIGKILL');
  await new Promise(resolve=>setTimeout(resolve,200));
  fs.rmSync(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});
 }
});
