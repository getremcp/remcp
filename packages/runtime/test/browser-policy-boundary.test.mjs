import assert from 'node:assert/strict';
import test from 'node:test';
import * as policy from '../src/extended/browser-policy.mjs';
import * as endpoint from '../src/extended/browser-endpoint.mjs';

const policyNames = [
  'DEFAULT_ENDPOINT', 'MAX_EVALUATION_BYTES', 'BROWSER_PROTOCOLS',
  'BLOCKED_BROWSER_SCHEME', 'BLOCKED_BROWSER_NETWORK_API',
  'boundedText', 'normalizedHost', 'isLoopbackHost', 'localBrowserNavigationAllowed',
  'isPrivateIpv4', 'isPrivateIpv6', 'isPrivateBrowserHost',
  'endpointUrl', 'endpointAuthority', 'safeBrowserUrl', 'safePageUrl',
  'configuredBrowserHosts', 'browserHostAllowlisted',
  'browserDnsRebindingExplicitlyAllowed', 'productionBrowserPolicyReady',
  'assertResolvedBrowserUrl', 'assertResolvedPageUrl',
  'expressionHasPrivateDestination', 'safeEvaluationExpression', 'assertSafeEvaluationExpression',
];

test('browser endpoint keeps the exact exported policy implementations', () => {
  for (const name of policyNames) {
    assert.ok(Object.hasOwn(policy, name), `missing policy export ${name}`);
    assert.strictEqual(endpoint[name], policy[name], `compatibility export ${name}`);
  }
});

test('browser navigation and CDP origin validation continue rejecting private destinations', async () => {
  assert.equal(policy.endpointUrl('http://127.0.0.1:9222').origin, 'http://127.0.0.1:9222');
  assert.throws(() => policy.endpointUrl('http://192.168.1.1:9222'), /loopback-only/);
  assert.throws(() => policy.endpointUrl('https://user:pass@127.0.0.1:9222'), /credentials/);
  for (const hostname of ['localhost', '192.168.0.1', '10.0.0.4', '169.254.169.254', '::1', 'fe80::1', 'a.internal']) {
    assert.equal(policy.isPrivateBrowserHost(hostname), true, hostname);
  }
  assert.throws(() => policy.safePageUrl('file:///etc/passwd'), /http or https/);
  assert.equal(policy.safePageUrl('about:blank'), 'about:blank');
  assert.throws(() => policy.safeBrowserUrl('https://user:token@public.example'), /credentials/);
});

test('production browser navigation fails closed without a public IP allowlist', async () => {
  const envNames = ['NODE_ENV','REMCP_BROWSER_ALLOWED_HOSTS','REMCP_BROWSER_ALLOW_DNS_REBIND',
    'REMCP_BROWSER_ALLOW_LOCAL_NAVIGATION','REMCP_BROWSER_ALLOW_LOCAL','REMCP_ALLOW_LOCAL_BROWSER_NAVIGATION'];
  const before = new Map(envNames.map(key => [key, process.env[key]]));
  try {
    process.env.NODE_ENV = 'production';
    process.env.REMCP_BROWSER_ALLOWED_HOSTS = '';
    for (const name of envNames.slice(2)) delete process.env[name];
    assert.equal(policy.productionBrowserPolicyReady(), false);
    await assert.rejects(policy.assertResolvedBrowserUrl('https://example.org'), /REMCP_BROWSER_ALLOWED_HOSTS/);
    process.env.REMCP_BROWSER_ALLOWED_HOSTS = '8.8.8.8';
    assert.equal(policy.productionBrowserPolicyReady(), true);
    assert.equal(await policy.assertResolvedBrowserUrl('https://8.8.8.8/path'), 'https://8.8.8.8/path');
    await assert.rejects(policy.assertResolvedBrowserUrl('https://169.254.169.254/latest/meta-data'), /private/);
    assert.throws(() => policy.safeEvaluationExpression('fetch("https://example.org")'), /blocked/);
  } finally {
    for (const [key,value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
