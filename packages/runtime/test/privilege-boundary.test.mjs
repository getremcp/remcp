import test from 'node:test';
import assert from 'node:assert/strict';
import { privilegeBoundary } from '../src/privilege-boundary.mjs';

test('Linux no-new-privileges is observed independently of God Mode', () => {
  const x = privilegeBoundary({ platform:'linux', effectiveUid:1000, procStatus:'Name:\tnode\nNoNewPrivs:\t1\n' });
  assert.equal(x.noNewPrivileges, true);
  assert.equal(x.elevation, 'blocked_by_no_new_privileges');
});
test('Linux with no-new-privileges off still requires OS authorization', () => {
  const x = privilegeBoundary({ platform:'linux', effectiveUid:1000, procStatus:'NoNewPrivs:\t0\n' });
  assert.equal(x.elevation, 'requires_os_authorization');
});
test('Linux root with no-new-privileges on is already root', () => {
  const x = privilegeBoundary({ platform:'linux', effectiveUid:0, procStatus:'NoNewPrivs:\t1\n' });
  assert.equal(x.elevation, 'already_root');
});
test('macOS accurately separates sudo and TCC', () => {
  assert.equal(privilegeBoundary({ platform:'darwin', effectiveUid:501 }).elevation, 'requires_os_authorization');
  assert.match(privilegeBoundary({ platform:'darwin', effectiveUid:501 }).note, /Full Disk Access/);
});
test('Windows detects high integrity from token SID without trusting task flags', () => {
  const x = privilegeBoundary({ platform:'win32', windowsGroupOutput:'BUILTIN\\Administrators S-1-5-32-544 Group used for deny only\nMandatory Label\\High Mandatory Level S-1-16-12288' });
  assert.equal(x.integrityLevel, 'high');
  assert.equal(x.elevation, 'elevated_token');
});
test('Windows medium integrity remains non-elevated even with Administrators SID', () => {
  const x = privilegeBoundary({ platform:'win32', windowsGroupOutput:'Administrators S-1-5-32-544\nS-1-16-8192' });
  assert.equal(x.elevation, 'not_elevated');
});
test('Windows unknown token does not claim privileges', () => {
  assert.equal(privilegeBoundary({ platform:'win32', windowsGroupOutput:'' }).elevation, 'unknown');
});
test('missing Linux process facts fail closed', () => {
  assert.equal(privilegeBoundary({ platform:'linux', effectiveUid:1000, procStatus:'' }).elevation, 'unknown');
});
