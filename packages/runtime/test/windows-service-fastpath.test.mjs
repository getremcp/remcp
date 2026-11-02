import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWindowsServiceStatus } from '../src/extended/windows-scm-status.mjs';

const query = `SERVICE_NAME: sshd\r
        TYPE : 10 WIN32_OWN_PROCESS\r
        STATE : 4 RUNNING\r
        WIN32_EXIT_CODE : 0\r
`;
const config = `SERVICE_NAME: sshd\r
        START_TYPE : 2 AUTO_START\r
        DISPLAY_NAME : OpenSSH SSH Server\r
`;

test('native Windows SCM output retains PowerShell Get-Service status shape', () => {
  assert.deepEqual(parseWindowsServiceStatus(query, config, 'sshd'), {
    Name: 'sshd', DisplayName: 'OpenSSH SSH Server', Status: 4, StartType: 2,
  });
});

test('Windows SCM stopped and disabled status use stable enum numbers', () => {
  assert.deepEqual(parseWindowsServiceStatus(
    query.replace('4 RUNNING', '1 STOPPED'),
    config.replace('2 AUTO_START', '4 DISABLED'), 'sshd',
  ), { Name: 'sshd', DisplayName: 'OpenSSH SSH Server', Status: 1, StartType: 4 });
});

test('Windows SCM parser fails closed to PowerShell on unknown formats', () => {
  assert.equal(parseWindowsServiceStatus('STAN: 4 URUCHOMIONA', config, 'sshd'), null);
  assert.equal(parseWindowsServiceStatus(query, 'START_TYPE: 999\nDISPLAY_NAME: test', 'sshd'), null);
  assert.equal(parseWindowsServiceStatus(query, 'START_TYPE: 2\nDISPLAY_NAME: test', 'other'), null);
  assert.equal(parseWindowsServiceStatus(query, config.replace('OpenSSH SSH Server', '\ufffdSSH'), 'sshd'), null);
});

test('Windows service_status returns the existing shape via fast native SCM', {
  skip: process.platform !== 'win32', timeout: 12000,
}, async () => {
  const { serviceTool } = await import('../src/extended/diagnostics-platform.mjs');
  const started = Date.now();
  const result = await serviceTool({ action: 'status', name: 'EventLog', scope: 'system' });
  const content = result.content?.find(entry => entry.type === 'text')?.text;
  const item = JSON.parse(content);
  assert.equal(item.Name.toLowerCase(), 'eventlog');
  assert.equal(item.Status, 4);
  assert.ok(Number.isInteger(item.StartType));
  assert.ok(Date.now() - started < 8000, 'service status should not require slow PowerShell startup');
});
