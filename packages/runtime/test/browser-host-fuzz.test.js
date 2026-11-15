import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { normalizedHost, isPrivateBrowserHost, isLoopbackHost, endpointUrl, safeBrowserUrl } from '../src/extended/browser-policy.mjs';

// Security-focused property fuzzing with shrinking and replayable seeds.
const octet = fc.integer({ min: 0, max: 255 });
const address = (...parts) => fc.tuple(...parts).map(xs => xs.join('.'));
const sensitiveIpv4 = fc.oneof(
  address(fc.constant(0), octet, octet, octet),
  address(fc.constant(10), octet, octet, octet),
  address(fc.constant(100), fc.integer({ min: 64, max: 127 }), octet, octet),
  address(fc.constant(127), octet, octet, octet),
  address(fc.constant(169), fc.constant(254), octet, octet),
  address(fc.constant(172), fc.integer({ min: 16, max: 31 }), octet, octet),
  address(fc.constant(192), fc.constant(168), octet, octet),
  address(fc.constant(198), fc.integer({ min: 18, max: 19 }), octet, octet),
  address(fc.integer({ min: 224, max: 255 }), octet, octet, octet),
);
const suffixDots = fc.integer({ min: 0, max: 7 });
const domain = fc.constantFrom(
  'localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback',
  'edge.local', 'proxy.internal', 'example.home.arpa', 'office.lan',
);
const privateIpv6 = fc.constantFrom(
  '::1', '[::1]', 'fe80::1', '[fe80::1]', 'fd00::1', '[fd00::1]',
  '::ffff:7f00:1', '[::ffff:7f00:1]',
);

test('fuzz: generated private IPv4 ranges remain denied with arbitrary final DNS dots', () => {
  fc.assert(fc.property(sensitiveIpv4, suffixDots, (ip, dots) => {
    const hostname = ip + '.'.repeat(dots);
    assert.equal(isPrivateBrowserHost(hostname), true, 'private IPv4 bypass: ' + hostname);
    assert.equal(normalizedHost(normalizedHost(hostname)), normalizedHost(hostname));
    if (dots >= 2) {
      assert.throws(() => safeBrowserUrl('http://' + hostname + '/'), /malformed|invalid/, 'private navigation bypass: ' + hostname);
    }
  }), { seed: 0x5eed2026, numRuns: 2000 });
});

test('fuzz: reserved hostnames cannot bypass policy using case or terminal dots', () => {
  fc.assert(fc.property(domain, suffixDots, fc.boolean(), (host, dots, uppercase) => {
    const hostname = (uppercase ? host.toUpperCase() : host) + '.'.repeat(dots);
    assert.equal(isPrivateBrowserHost(hostname), true, 'reserved hostname bypass: ' + hostname);
  }), { seed: 0x5eed2027, numRuns: 2000 });
});

test('fuzz: bracketed/unbracketed private IPv6 remain blocked with terminal dots', () => {
  fc.assert(fc.property(privateIpv6, suffixDots, (ip, dots) => {
    const hostname = ip + '.'.repeat(dots);
    assert.equal(isPrivateBrowserHost(hostname), true, 'private IPv6 bypass: ' + hostname);
    assert.equal(normalizedHost(normalizedHost(hostname)), normalizedHost(hostname));
  }), { seed: 0x5eed2028, numRuns: 2000 });
});

test('fuzz: IPv4-compatible and IPv4-mapped IPv6 raw DNS addresses retain private-range denial', () => {
  fc.assert(fc.property(sensitiveIpv4, fc.boolean(), suffixDots, fc.boolean(),
    (ip, mapped, dots, bracketed) => {
      const literal = '::' + (mapped ? 'ffff:' : '') + ip;
      const host = (bracketed ? '[' + literal + ']' : literal) + '.'.repeat(dots);
      assert.equal(isPrivateBrowserHost(host), true, 'embedded IPv4 SSRF candidate: ' + host);
    }), { seed: 0x5eed2032, numRuns: 1400 });
  fc.assert(fc.property(fc.constantFrom('8.8.8.8', '1.1.1.1', '9.9.9.9'),
    ip => {
      assert.equal(isPrivateBrowserHost('::ffff:' + ip), false,
        'mapped public resolver should stay public');
      assert.equal(isPrivateBrowserHost('::' + ip), true,
        'deprecated IPv4-compatible ::/96 is reserved, not public');
    }), { seed: 0x5eed2033, numRuns: 300 });
});

test('IPv6 embedded address cases reject reserved/local navigation without DNS', () => {
  for (const host of [
    '::ffff:127.0.0.1', '::ffff:192.168.0.1',
    '::ffff:10.0.0.1', '::0.0.0.2', '::8.8.8.8',
    '::2', '::808:808', '::ffff:7f00:1',
  ]) {
    assert.equal(isPrivateBrowserHost(host), true, 'raw host classification: ' + host);
    assert.throws(() => safeBrowserUrl('https://[' + host + ']/'),
      /private|loopback|link-local/, 'navigation must reject: ' + host);
  }
  assert.equal(isPrivateBrowserHost('::ffff:8.8.8.8'), false);
  assert.doesNotThrow(() => safeBrowserUrl('https://[::ffff:8.8.8.8]/'));
});

test('fuzz: public resolver IPs remain public with terminal DNS dots', () => {
  fc.assert(fc.property(fc.constantFrom('8.8.8.8', '1.1.1.1', '9.9.9.9'), suffixDots,
    (host, dots) => {
      assert.equal(isPrivateBrowserHost(host + '.'.repeat(dots)), false);
    }), { seed: 0x5eed2029, numRuns: 300 });
});

test('fuzz: malformed DNS terminal dots cannot enter a trusted browser/CDP allowlist', () => {
  fc.assert(fc.property(fc.constantFrom('localhost', '127.0.0.1'), fc.integer({ min: 2, max: 7 }),
    (host, dots) => {
      const malformed = host + '.'.repeat(dots);
      assert.equal(isPrivateBrowserHost(malformed), true);
      assert.equal(isLoopbackHost(malformed), false, 'noncanonical CDP loopback accepted');
      assert.throws(() => endpointUrl('http://' + malformed + ':9222'), /loopback-only/);
    }), { seed: 0x5eed2030, numRuns: 300 });
  fc.assert(fc.property(fc.constantFrom('8.8.8.8', 'public.example'), fc.integer({ min: 2, max: 7 }),
    (host, dots) => {
      assert.throws(() => safeBrowserUrl('https://' + host + '.'.repeat(dots)),
        /malformed|invalid/);
    }), { seed: 0x5eed2031, numRuns: 300 });
});
