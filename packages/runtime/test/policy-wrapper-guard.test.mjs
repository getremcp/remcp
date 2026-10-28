import test from 'node:test';
import assert from 'node:assert/strict';

// Inspect the policy verdict only. Never invoke the terminal with destructive inputs.
process.env.REMCP_RUNTIME_UNRESTRICTED = 'false';
process.env.REMCP_RUNTIME_DANGEROUS_COMMANDS = 'block';
process.env.REMCP_RUNTIME_BLOCKED_COMMANDS = '';
const { checkCommand } = await import('../src/policy.mjs');

test('catastrophic commands stay blocked through shell utility wrappers', () => {
  for (const command of [
    'rm -rf /',
    'sudo -u root rm -rf /',
    'sudo --user=root rm -rf /',
    'doas -u root rm -rf /',
    'nice -n 10 rm -rf /',
    'ionice -c 2 rm -rf /',
    'ionice --class 2 rm -rf /',
    'stdbuf -o L rm -rf /',
    'timeout --signal TERM 10 rm -rf /',
    'env -u PATH rm -rf /',
    'env -S "rm -rf /"',
    'env --split-string "rm -rf /"',
    'env --split-string="rm -rf /"',
    'sudo -u root env -S "rm -rf /"',
  ]) {
    const decision = checkCommand(command);
    assert.equal(decision.blocked, true, `guardrail bypass: ${command}`);
  }
});

test('the guardrail does not reject ordinary commands behind wrappers', () => {
  for (const command of [
    'sudo -u nobody echo ok',
    'nice -n 10 echo ok',
    'ionice -c 2 echo ok',
    'stdbuf -o L grep pattern file',
    'timeout --signal TERM 5 echo ok',
    'env -u HOME grep pattern README.md',
  ]) {
    assert.notEqual(checkCommand(command).blocked, true, command);
  }
});
