import test from 'node:test';
import assert from 'node:assert/strict';
import { body, freshWorkspace, isError, waitFor } from './helpers.mjs';

freshWorkspace('terminal');
const { invokeTool } = await import('../src/invoke.mjs');

function pidOf(result) {
  const structuredPid = Number(result?.structuredContent?.pid);
  if (Number.isInteger(structuredPid) && structuredPid > 0) return structuredPid;
  const match = body(result).match(/Process (\d+)/);
  assert.ok(match, `expected a pid in ${body(result)}`);
  return Number(match[1]);
}

test('start_process returns first output and the process eventually exits successfully', async () => {
  const result = await invokeTool('start_process', { command: 'printf "hello-from-runtime\\n"', timeout_ms: 3000 });
  assert.equal(isError(result), false);
  assert.match(body(result), /hello-from-runtime/);
  assert.equal(typeof result.structuredContent?.pid, 'number');
  assert.match(result.structuredContent?.output || '', /hello-from-runtime/);
  // start_process intentionally returns early when stdout is ready. Under CPU
  // contention the exit event may not have arrived yet; verify the final code
  // through the session API rather than requiring synchronous process exit.
  const final = result.structuredContent?.exited ? result : await waitFor(async () => {
    const page = await invokeTool('read_process_output', {
      pid: pidOf(result), offset: 0, length: 5, timeout_ms: 0,
    });
    return page.structuredContent?.exited ? page : null;
  }, 3000);
  assert.ok(final, 'short-lived process must eventually exit');
  assert.equal(final.structuredContent?.status, 'exited (code 0)');
  assert.equal(final.structuredContent?.exitCode, 0);
  assert.equal(final.structuredContent?.exited, true);
});

test('start_process returns early on initial output from a long-running command', async () => {
  const startedAt = Date.now();
  const result = await invokeTool('start_process', {
    command: 'printf "READY-EARLY\\n"; sleep 3',
    timeout_ms: 1600,
  });
  const elapsed = Date.now() - startedAt;
  const pid = pidOf(result);
  try {
    assert.equal(isError(result), false);
    assert.match(body(result), /READY-EARLY/);
    assert.equal(result.structuredContent?.exited, false);
    assert.ok(elapsed < 1200, `initial output returned after ${elapsed}ms instead of early`);
  } finally {
    await invokeTool('force_terminate', { pid });
  }
});

test('start_process returns buffered output without an unnecessary 175ms status grace', async () => {
  const samples = [];
  for (let i = 0; i < 3; i++) {
    const startedAt = performance.now();
    const result = await invokeTool('start_process', {
      command: 'printf "FIRST-CHUNK\\n"; sleep 2',
      timeout_ms: 500,
    });
    samples.push(performance.now() - startedAt);
    const pid = pidOf(result);
    try {
      assert.equal(isError(result), false);
      assert.match(body(result), /FIRST-CHUNK/);
      assert.equal(result.structuredContent?.exited, false);
    } finally {
      await invokeTool('force_terminate', { pid });
    }
  }
  samples.sort((a,b)=>a-b);
  assert.ok(samples[1] < 165,
    'early-output median '+Math.round(samples[1])+'ms should avoid old 175ms grace');
});

test('start_process returns after delayed output rather than waiting for process exit', async () => {
  const startedAt = Date.now();
  const result = await invokeTool('start_process', {
    command: 'sleep 0.3; printf "READY-DELAYED\\n"; sleep 3',
    timeout_ms: 1800,
  });
  const elapsed = Date.now() - startedAt;
  const pid = pidOf(result);
  try {
    assert.match(body(result), /READY-DELAYED/);
    assert.equal(result.structuredContent?.exited, false);
    assert.ok(elapsed < 1300, `delayed output returned after ${elapsed}ms`);
  } finally {
    await invokeTool('force_terminate', { pid });
  }
});

test('start_process still reports the final code for immediately exiting commands', async () => {
  const result = await invokeTool('start_process', {
    command: 'printf "FAST-EXIT\\n"; exit 3',
    timeout_ms: 1600,
  });
  assert.equal(result.structuredContent?.exited, true);
  assert.equal(result.structuredContent?.exitCode, 3);
  assert.match(body(result), /FAST-EXIT/);
});

test('read_process_output returns new output and supports tail offsets', async () => {
  const started = await invokeTool('start_process', { command: 'for i in 1 2 3; do echo line-$i; sleep 0.4; done', timeout_ms: 200 });
  const pid = pidOf(started);
  await waitFor(async () => body(await invokeTool('read_process_output', { pid })).includes('line-3'), 8000);
  const tailResult = await invokeTool('read_process_output', { pid, offset: -2 });
  const tail = body(tailResult);
  assert.match(tail, /line-2/);
  assert.match(tail, /line-3/);
  assert.equal(tailResult.structuredContent?.pid, pid);
  assert.equal(tailResult.structuredContent?.explicitOffset, true);
  assert.match(tailResult.structuredContent?.range || '', /of 3/);
  assert.match(tailResult.structuredContent?.output || '', /line-3/);
});

test('read_process_output pages buffered output without losing or duplicating lines', async () => {
  const { createProcessSession, appendProcessOutput, markProcessExited } = await import('../src/sessions.mjs');
  const pid = 987654321;
  const session = createProcessSession({pid,child:{},command:'synthetic',shell:'test'});
  appendProcessOutput(session, Array.from({length:257},(_,i)=>'row-'+String(i).padStart(3,'0')).join('\n')+'\n');
  markProcessExited(session,0,null);
  const rows=[];
  for(let page=0;page<30;page++) {
    const result=await invokeTool('read_process_output',{pid,length:13});
    const data=result.structuredContent;
    assert.equal(isError(result),false);
    const chunk=(data?.output||'').split('\n').filter(Boolean);
    assert.ok(chunk.length<=13,'length applies to cursor-consuming reads');
    rows.push(...chunk);
    assert.equal(data?.hasMore,rows.length<257);
    if(!data?.hasMore)break;
  }
  assert.deepEqual(rows,Array.from({length:257},(_,i)=>'row-'+String(i).padStart(3,'0')));
  const exhausted=await invokeTool('read_process_output',{pid,length:13});
  assert.equal(exhausted.structuredContent?.hasMore,false);
  assert.equal(exhausted.structuredContent?.output,'');
});

test('read_process_output wakes on new data without periodic polling', async () => {
  const { createProcessSession, appendProcessOutput } = await import('../src/sessions.mjs');
  const pid=987654322;
  const session=createProcessSession({pid,child:{},command:'synthetic',shell:'test'});
  const started=performance.now();
  const pending=invokeTool('read_process_output',{pid,timeout_ms:3000,length:10});
  await new Promise(resolve=>setTimeout(resolve,30));
  appendProcessOutput(session,'event-driven-ready\n');
  const reply=await pending;
  assert.match(reply.structuredContent?.output||'',/event-driven-ready/);
  assert.ok(performance.now()-started<750,'an append wakes the reader immediately');
  assert.equal(session.waiters.length,0,'event waiter is cleaned after output');
});

test('read_process_output does not replay partial output already shown by start_process', {skip: process.platform==='win32'}, async () => {
  const started=await invokeTool('start_process',{
    command: 'printf "START-PARTIAL"; sleep 0.35; printf -- "-AFTER\\n"; sleep 0.2',
    timeout_ms:140,
  });
  const pid=pidOf(started);
  assert.match(started.structuredContent?.partial||'',/START-PARTIAL/);
  const reply=await invokeTool('read_process_output',{pid,timeout_ms:1400});
  assert.equal(isError(reply),false);
  assert.equal(reply.structuredContent?.output,'-AFTER');
  assert.equal(reply.structuredContent?.hasMore,false);
});

test('read_process_output never consumes a long line past the size-bounded page', async () => {
  const {createProcessSession,appendProcessOutput,markProcessExited}=await import('../src/sessions.mjs');
  const pid=987654325;
  const session=createProcessSession({pid,child:{},command:'synthetic',shell:'test'});
  const source='X'.repeat(92000)+'🟩'.repeat(12000);
  appendProcessOutput(session,source+'\n');
  markProcessExited(session,0,null);
  let received='';
  let pages=0;
  do {
    const result=await invokeTool('read_process_output',{pid,length:1});
    assert.equal(isError(result),false);
    const page=result.structuredContent;
    assert.ok((page?.output||'').length<=32768,'page does not exceed the bounded text payload');
    received+=page?.output||'';
    pages++;
    if(!page?.hasMore)break;
  }while(pages<16);
  assert.ok(pages>=3,'large logical line is split into transport-friendly fragments');
  assert.equal(received,source,'every character arrives in order without truncation');
  assert.equal(session.waiters.length,0);
});

test('read_process_output does not reuse a partial-line offset after buffer eviction', async () => {
  const {createProcessSession,readNewOutput,hasNewOutput}=await import('../src/sessions.mjs');
  const session=createProcessSession({pid:987654326,child:{},command:'synthetic',shell:'test'});
  session.lines=['retained-fresh-line'];
  session.droppedLines=3;
  session.cursor=2;
  session.cursorColumn=12;
  session.lastPartialRead='old-prefix';
  session.lastPartialLineIndex=2;
  assert.equal(hasNewOutput(session),true);
  assert.deepEqual(readNewOutput(session,1,32768),['retained-fresh-line']);
  assert.equal(session.cursor,4);
  assert.equal(session.cursorColumn,0);
});

test('read_process_output streams partial lines without repeating already-read prefixes', async () => {
  const {createProcessSession,appendProcessOutput,markProcessExited}=await import('../src/sessions.mjs');
  const pid=987654324;
  const session=createProcessSession({pid,child:{},command:'synthetic',shell:'test'});
  appendProcessOutput(session,'prefix');
  const first=await invokeTool('read_process_output',{pid,length:2});
  assert.equal(first.structuredContent?.output,'prefix');
  appendProcessOutput(session,'-next');
  const second=await invokeTool('read_process_output',{pid,length:2});
  assert.equal(second.structuredContent?.output,'-next');
  appendProcessOutput(session,'-done\nother\n');
  const third=await invokeTool('read_process_output',{pid,length:1});
  assert.equal(third.structuredContent?.output,'-done');
  assert.equal(third.structuredContent?.hasMore,true);
  const fourth=await invokeTool('read_process_output',{pid,length:1});
  assert.equal(fourth.structuredContent?.output,'other');
  assert.equal(fourth.structuredContent?.hasMore,false);
  markProcessExited(session,0,null);
});

test('read_process_output cancellation promptly detaches its waiter', async () => {
  const { createProcessSession } = await import('../src/sessions.mjs');
  const { readProcessOutputTool } = await import('../src/tools/terminal.mjs');
  const pid=987654323;
  const session=createProcessSession({pid,child:{},command:'synthetic',shell:'test'});
  const controller=new AbortController();
  const started=performance.now();
  const pending=readProcessOutputTool({pid,timeout_ms:5000},{signal:controller.signal});
  await new Promise(resolve=>setTimeout(resolve,25));
  controller.abort();
  await assert.rejects(pending,/cancelled/i);
  assert.ok(performance.now()-started<750,'abort cancels without repeated 200ms ticks');
  assert.equal(session.waiters.length,0,'abort listener and process waiter are removed');
});

test('cursor-consuming output tools do not advertise idempotent retries', async () => {
  const { toolDefinitions } = await import('../src/catalog.mjs');
  for (const name of ['read_process_output', 'wait_for_process_output']) {
    const tool = toolDefinitions.find(tool => tool.name === name);
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.annotations.idempotentHint, false);
  }
  const started = await invokeTool('start_process', { command: 'sleep 0.3; echo cursor-marker', timeout_ms: 1 });
  const pid = pidOf(started);
  const first = body(await invokeTool('read_process_output', { pid, timeout_ms: 8000 }));
  assert.match(first, /cursor-marker/);
  const retry = body(await invokeTool('read_process_output', { pid }));
  assert.doesNotMatch(retry, /cursor-marker/, 'the same arguments cannot replay consumed output');
});

test('interact_with_process sends input and list_sessions reports the session', async () => {
  const started = await invokeTool('start_process', { command: 'node -e "process.stdin.on(\'data\', d => process.stdout.write(\'echo:\' + d.toString()))"', timeout_ms: 300 });
  const pid = pidOf(started);
  const responseResult = await invokeTool('interact_with_process', { pid, input: 'ping', timeout_ms: 2000 });
  const response = body(responseResult);
  assert.match(response, /echo:ping/);
  assert.equal(responseResult.structuredContent?.pid, pid);
  assert.match(responseResult.structuredContent?.output || '', /echo:ping/);
  const sessionsResult = await invokeTool('list_sessions', {});
  assert.match(body(sessionsResult), new RegExp(`pid ${pid}`));
  assert.equal(sessionsResult.structuredContent?.sessions?.some(session => session.pid === pid), true);
  assert.equal(isError(await invokeTool('force_terminate', { pid })), false);
});

test('unknown pids are rejected instead of starting new work', async () => {
  assert.equal(isError(await invokeTool('read_process_output', { pid: 999999 })), true);
  assert.equal(isError(await invokeTool('force_terminate', { pid: 999999 })), true);
  assert.equal(isError(await invokeTool('interact_with_process', { pid: 999999, input: 'x' })), true);
  assert.equal(isError(await invokeTool('wait_for_process_output', { pid: 999999, pattern: 'x' })), true);
});

test('read_process_output positive offsets are zero-based line numbers', async () => {
  const started = await invokeTool('start_process', { command: 'printf "l1\\nl2\\nl3\\nl4\\n"', timeout_ms: 3000 });
  const pid = pidOf(started);
  const page = body(await invokeTool('read_process_output', { pid, offset: 1, length: 2 }));
  assert.match(page, /l2/);
  assert.match(page, /l3/);
  assert.doesNotMatch(page, /l1/);
  assert.match(page, /of 4/);
  const first = body(await invokeTool('read_process_output', { pid, offset: 0, length: 1 }));
  assert.match(first, /l1/);
});

test('wait_for_process_output matches initial start output once from the retained buffer', async () => {
  const started = await invokeTool('start_process', { command: 'printf "BUFFERED-READY\\n"; sleep 5', timeout_ms: 300 });
  const pid = pidOf(started);
  assert.match(body(started), /BUFFERED-READY/);

  const before = Date.now();
  const first = await invokeTool('wait_for_process_output', { pid, pattern: 'BUFFERED-READY', timeout_ms: 2000 });
  assert.equal(isError(first), false);
  assert.equal(first.structuredContent?.matched, true);
  assert.equal(first.structuredContent?.bufferedMatch, true);
  assert.match(first.structuredContent?.output || '', /BUFFERED-READY/);
  assert.ok(Date.now() - before < 500, 'a buffered match should return without waiting for the timeout');

  const retry = await invokeTool('wait_for_process_output', { pid, pattern: 'BUFFERED-READY', timeout_ms: 100 });
  assert.equal(retry.structuredContent?.matched, false, 'the same retained match must not replay after the wait cursor advances');
  assert.equal(retry.structuredContent?.bufferedMatch, false);
  await invokeTool('force_terminate', { pid });
});

test('read_process_output consumption also advances the wait watermark', async () => {
  const started = await invokeTool('start_process', { command: 'printf "READ-CONSUMED\\n"; sleep 5', timeout_ms: 300 });
  const pid = pidOf(started);
  assert.match(body(started), /READ-CONSUMED/);
  await invokeTool('read_process_output', { pid, timeout_ms: 0 });
  const waited = await invokeTool('wait_for_process_output', { pid, pattern: 'READ-CONSUMED', timeout_ms: 100 });
  assert.equal(waited.structuredContent?.matched, false);
  assert.equal(waited.structuredContent?.bufferedMatch, false);
  await invokeTool('force_terminate', { pid });
});

test('wait_for_process_output returns as soon as the pattern appears', async () => {
  const started = await invokeTool('start_process', { command: 'sleep 0.6; echo READY-MARKER; sleep 5', timeout_ms: 100 });
  const pid = pidOf(started);
  const result = await invokeTool('wait_for_process_output', { pid, pattern: 'READY-MARKER', timeout_ms: 8000 });
  assert.equal(isError(result), false);
  assert.match(body(result), /pattern matched/);
  assert.match(body(result), /READY-MARKER/);
  assert.equal(result.structuredContent?.pid, pid);
  assert.equal(result.structuredContent?.matched, true);
  assert.match(result.structuredContent?.output || '', /READY-MARKER/);
  await invokeTool('force_terminate', { pid });
});

test('wait_for_process_output reports a timeout without failing the call', async () => {
  const started = await invokeTool('start_process', { command: 'sleep 3', timeout_ms: 100 });
  const pid = pidOf(started);
  const result = await invokeTool('wait_for_process_output', { pid, pattern: 'NEVER-APPEARS', timeout_ms: 300 });
  assert.equal(isError(result), false);
  assert.match(body(result), /pattern not matched/);
  await invokeTool('force_terminate', { pid });
});
