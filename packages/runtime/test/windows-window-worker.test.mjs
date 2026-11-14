import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {readFileSync} from 'node:fs';
import {WindowsWindowInventoryWorker,windowInventoryWorkerScript} from '../src/extended/desktop-windows-window-worker.mjs';
import {listWindows} from '../src/extended/desktop-windows-list.mjs';

function fakeChild(reply) {
  const child=new EventEmitter();
  child.stdin=new PassThrough();
  child.stdout=new PassThrough();
  child.stderr=new PassThrough();
  child.unref=()=>{};
  child.kill=()=>{child.emit('exit',0);return true;};
  let buffered='';
  child.stdin.setEncoding('utf8');
  child.stdin.on('data',data=>{
    buffered+=data;
    for(let i;(i=buffered.indexOf('\n'))>=0;){
      const line=buffered.slice(0,i);
      buffered=buffered.slice(i+1);
      reply(JSON.parse(line),child);
    }
  });
  return child;
}

test('persistent Windows inventory worker requires local opt-in',()=>{
  const source=readFileSync(new URL(
    '../src/extended/desktop-windows-list.mjs',import.meta.url),'utf8');
  assert.match(source,/REMCP_WINDOWS_WINDOW_IPC==='1'/);
  assert.doesNotMatch(source,/REMCP_WINDOWS_WINDOW_IPC!=='0'/);
});

test('window worker protocol allows only bounded read-only inventory',()=>{
  const script=windowInventoryWorkerScript();
  assert.match(script,/RemcpWindowInventory\]::Read\(\)/);
  assert.match(script,/windows_session_0|interactive user desktop/);
  assert.match(script,/request\.op -cne 'list_windows'/);
  assert.match(script,/GetProcessById/);
  assert.doesNotMatch(script,/Invoke-Expression|iex\s|SetForegroundWindow|MoveWindow|SendInput/i);
  assert.match(script,/REMCP_WINDOWS_SOURCE_BLOCKED/);
  assert.doesNotMatch(script,/Assembly\]::LoadFrom|\.dll\b/i);
  const js=readFileSync(new URL('../src/extended/desktop-windows-window-worker.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(js,/createServer\(|listen\(|execSync\(|shell:true/);
});

test('persistent worker reuses PowerShell across sequential inventory requests',async()=>{
  let starts=0;
  const child=fakeChild((request,process)=>{
    assert.equal(request.op,'list_windows');
    process.stdout.write(JSON.stringify({id:request.id,rows:[{id:'0x10',pid:42,app:'QA',title:'Window'}]})+'\n');
  });
  const worker=new WindowsWindowInventoryWorker({spawnFn:()=>{
    starts++;
    return child;
  }});
  const a=await worker.read();
  const b=await worker.read();
  assert.deepEqual(a,b);
  assert.equal(starts,1);
  assert.equal(worker.sequence,2);
  worker.abort('end test');
});

test('worker rejects malformed or unexpected responses; refuses further commands',async()=>{
  const child=fakeChild((_request,process)=>process.stdout.write('not-json\n'));
  const worker=new WindowsWindowInventoryWorker({spawnFn:()=>child});
  await assert.rejects(worker.read(),/Invalid Windows inventory response/);
  assert.equal(worker.closed,true);
  await assert.rejects(worker.read(),/unavailable/);
});

test('listWindows uses guarded read-only IPC and can fall back to legacy reader',async()=>{
  const mock=[{id:'0x2',pid:42,app:'QA',title:'secondary'}];
  const result=await listWindows({},{
    preferFast:true,
    fastReadFn:async()=>mock,
    runPowerShellFn:async()=>{throw new Error('Legacy reader should not run');}
  });
  assert.match(JSON.stringify(result),/secondary/);
  let fallbacks=0;
  const fallback=await listWindows({},{
    preferFast:true,
    fastReadFn:async()=>{throw new Error('Worker crashed');},
    runPowerShellFn:async()=>{fallbacks++;return {stdout:'[]'};}
  });
  assert.equal(fallbacks,1);
  assert.ok(fallback);
});

test('unexpected response identity terminates the private IPC stream',async()=>{
  const child=fakeChild((request,process)=>
    process.stdout.write(JSON.stringify({id:request.id+1,rows:[]})+'\n'));
  const worker=new WindowsWindowInventoryWorker({spawnFn:()=>child});
  await assert.rejects(worker.read(),/Unexpected Windows inventory response/);
  assert.equal(worker.closed,true);
});

test('strict IPC mode refuses fallback after a worker failure',async()=>{
  const previous=process.env.REMCP_WINDOWS_WINDOW_IPC_STRICT;
  process.env.REMCP_WINDOWS_WINDOW_IPC_STRICT='1';
  try {
    await assert.rejects(listWindows({},{
      preferFast:true,
      fastReadFn:async()=>{throw new Error('QA simulated IPC failure');},
      runPowerShellFn:async()=>{throw new Error('Unexpected fallback');},
    }),/QA simulated IPC failure/);
  } finally {
    if(previous===undefined)delete process.env.REMCP_WINDOWS_WINDOW_IPC_STRICT;
    else process.env.REMCP_WINDOWS_WINDOW_IPC_STRICT=previous;
  }
});


test('overlapping read-only inventory requests share one IPC request but do not cache later HWNDs',async()=>{
  let requests=0;
  const child=fakeChild((request,process)=>{
    requests++;
    queueMicrotask(()=>process.stdout.write(JSON.stringify({id:request.id,rows:[{id:'0x10',pid:42,app:'QA',title:'Window '+requests}]})+'\n'));
  });
  const worker=new WindowsWindowInventoryWorker({spawnFn:()=>child});
  try {
    const result=await Promise.all(Array.from({length:12},()=>worker.read()));
    assert.equal(requests,1);
    assert.equal(worker.sequence,1);
    assert.ok(result.every(rows=>rows[0].title==='Window 1'));
    assert.notStrictEqual(result[0],result[1]);
    assert.notStrictEqual(result[0][0],result[1][0]);
    result[0][0].title='Consumer-changed';
    assert.equal(result[1][0].title,'Window 1');
    assert.equal((await worker.read())[0].title,'Window 2');
    assert.equal(requests,2);
  } finally {
    worker.abort('QA complete');
  }
});

test('worker failure rejects all coalesced requests without an outdated successful result',async()=>{
  const child=fakeChild((_request,process)=>queueMicrotask(()=>process.stdout.write('invalid-json\n')));
  const worker=new WindowsWindowInventoryWorker({spawnFn:()=>child});
  const results=await Promise.allSettled(Array.from({length:12},()=>worker.read()));
  assert.equal(results.filter(r=>r.status==='rejected').length,12);
  assert.equal(worker.closed,true);
});
