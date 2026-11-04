import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pyAtSpiPrelude } from '../src/extended/desktop-linux-ui.mjs';

// Execute the actual generated Python against an instrumented desktop. Unrelated
// applications may be stalled; only their PID is needed for a PID-scoped request.
function enumerate(scope, source) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'remcp-atspi-scope-'));
  writeFileSync(path.join(root, 'pyatspi.py'), `import atexit,json,os
events=[]
@atexit.register
def save_events():
 with open(os.environ['REMCP_ATSPI_TEST_LOG'],'a') as f: f.write(json.dumps(events)+'\\n')
STATE_ACTIVE=1
class State:
 def contains(self,state): return True
class App:
 def __init__(self,pid,name): self.pid=pid;self._name=name
 def getProcessId(self):
  events.append([self.pid,'pid']);return self.pid
 @property
 def name(self):
  events.append([self.pid,'name']);return self._name
 @property
 def childCount(self):
  events.append([self.pid,'children']);return 0
 def getState(self):
  events.append([self.pid,'state']);return State()
 def getRoleName(self): return 'application'
 def queryAction(self): return self
 def doAction(self,i): return True
class Registry:
 @staticmethod
 def getDesktop(i): return [App(11,'Other'),App(42,'Target App')]
`);
  try {
    const log = path.join(root, 'events.jsonl');
    const command = source ? process.execPath : 'python3';
    const args = source ? ['--input-type=module','-e',source] : ['-c', pyAtSpiPrelude(scope) + '\nprint(json.dumps({"pids":[r[2] for r in q],"events":pyatspi.events}))'];
    const result = spawnSync(command, args, {
      encoding:'utf8', timeout:5000, env:{ ...process.env, PYTHONPATH:root, REMCP_ATSPI_TEST_LOG:log },
    });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    if (source) return readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    return JSON.parse(result.stdout);
  } finally {
    rmSync(root, { recursive:true, force:true });
  }
}

test('PID scope rejects unrelated apps before reading names, state or children', { skip:process.platform !== 'linux' }, () => {
  const result = enumerate({ pid:42 });
  assert.deepEqual(result.pids, [42]);
  assert.deepEqual(result.events.filter(([pid]) => pid === 11), [[11,'pid']]);
  assert.ok(result.events.some(([pid,field]) => pid === 42 && field === 'state'));
});

test('app scope is case-insensitive and skips state/children of nonmatches', { skip:process.platform !== 'linux' }, () => {
  const result = enumerate({ app:'tArGeT' });
  assert.deepEqual(result.pids, [42]);
  assert.ok(result.events.filter(([pid]) => pid === 11).every(([,field]) => ['pid','name'].includes(field)));
});

test('unscoped enumeration preserves both applications', { skip:process.platform !== 'linux' }, () => {
  assert.deepEqual(enumerate().pids, [11,42]);
});

test('snapshot and stable-ID actions pass their PID to root enumeration', { skip:process.platform !== 'linux' }, () => {
  const url = new URL('../src/extended/desktop-linux-ui.mjs', import.meta.url).href;
  const traces = enumerate(null, `import {uiSnapshot,uiAction} from ${JSON.stringify(url)};
    await uiSnapshot({pid:42,max_depth:1});
    await uiAction({action:'invoke',id:'linux:42:r'});`);
  assert.equal(traces.length, 2);
  for (const trace of traces) {
    assert.deepEqual(trace.filter(([pid]) => pid === 11), [[11,'pid']]);
  }
});
