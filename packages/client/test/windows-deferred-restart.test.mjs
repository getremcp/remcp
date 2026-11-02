import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWindowsTaskRestart } from '../src/cli/windows-task-restart.mjs';

test('remote Windows God Mode defers a scoped task restart until after acknowledgement', async () => {
  const commands = [];
  const pause = async ms => { assert.equal(ms, 2500); commands.push(['PAUSE',ms]); };
  const invoke = (binary,args) => {
    assert.equal(binary,'schtasks.exe');
    commands.push(args);
    return { status:0 };
  };
  await executeWindowsTaskRestart({ pause, invoke });
  assert.deepEqual(commands, [
    ['PAUSE',2500],
    ['/End','/TN','ReMCP Agent'],
    ['/Run','/TN','ReMCP Agent'],
  ]);
});

test('Windows refuses duplicate restart when old managed task cannot be stopped', async () => {
  const calls = [];
  await assert.rejects(
    executeWindowsTaskRestart({
      pause: async () => {},
      invoke: (_binary,args) => { calls.push(args); return { status:5 }; },
    }),
    /could not be stopped safely/,
  );
  assert.deepEqual(calls, [['/End','/TN','ReMCP Agent']]);
});

test('Windows surfaces failure to re-run the stopped managed task', async () => {
  const calls = [];
  await assert.rejects(
    executeWindowsTaskRestart({
      pause: async () => {},
      invoke: (_binary,args) => {
        calls.push(args);
        return { status: calls.length === 2 ? 1 : 0 };
      },
    }),
    /could not be started after stop/,
  );
  assert.equal(calls.length,2);
});
