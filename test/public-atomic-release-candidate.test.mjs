import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, symlinkSync, chmodSync, rmSync, readFileSync, linkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { verifyAtomicCandidate } from '../scripts/verify-public-atomic-release-candidate.mjs';
import { payloadNames, provenanceName } from '../scripts/release-assets-allowlist.mjs';

const TAG = 'v0.2.265';
const SHA = 'a'.repeat(40);
const REPO = 'getremcp/remcp';
const digest = data => createHash('sha256').update(data).digest('hex');
const checksums = directory =>
  [...payloadNames].sort().map(name => digest(readFileSync(join(directory, name))) +
    '  ' + name + '\n').join('');

function candidate(t) {
  const root = mkdtempSync(join(tmpdir(), 'remcp-signed-public-candidate-'));
  t.after(() => rmSync(root, { recursive:true, force:true }));
  chmodSync(root, 0o700);
  for (const name of payloadNames) {
    writeFileSync(join(root, name), Buffer.from('fixture artifact ' + name));
  }
  writeFileSync(join(root, provenanceName), JSON.stringify({
    dsseEnvelope:{payloadType:'application/vnd.in-toto+json'},
    verificationMaterial:{certificate:{}},
  }) + '\n');
  writeFileSync(join(root, 'SHA256SUMS'), checksums(root));
  writeFileSync(join(root, 'SHA256SUMS.sigstore.json'), JSON.stringify({
    messageSignature:{signature:'fixture-only'},
    verificationMaterial:{certificate:{}},
  }) + '\n');
  const requests = [];
  const check = (options={}) => verifyAtomicCandidate({
    directory:root, repository:REPO, tag:TAG, sourceSha:SHA,
    verifyCryptography:data => {
      requests.push(data);
      options.onVerify?.(data);
    },
    ...options,
  });
  return { root, requests, check };
}

test('valid seven-file candidate checks all four payload checksums and cryptography', t => {
  const { check, requests } = candidate(t);
  const out = check();
  assert.equal(out.tag, TAG);
  assert.equal(out.sourceSha, SHA);
  assert.equal(out.payloadCount, 4);
  assert.equal(out.releasePublished, false);
  assert.equal(out.productionDeploymentAuthorized, false);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].tag, TAG);
  assert.equal(requests[0].sha, SHA);
  assert.equal(requests[0].paths.size, 7);
});

test('rejects mutated asset while checksum manifest remains unchanged', t => {
  const { root, check } = candidate(t);
  writeFileSync(join(root, payloadNames[0]), 'attacker-changed-content');
  assert.throws(() => check(), /checksums differ/);
});

test('rejects fabricated checksum even with matching payload bytes', t => {
  const { root, check } = candidate(t);
  writeFileSync(join(root, 'SHA256SUMS'), '0'.repeat(64) + '  x.zip\n');
  assert.throws(() => check(), /checksums differ/);
});

test('rejects extra assets before calling signature verification', t => {
  const { root, check, requests } = candidate(t);
  writeFileSync(join(root, 'unreviewed.zip'), 'unreviewed');
  assert.throws(() => check(), /exactly seven/);
  assert.equal(requests.length, 0);
});

test('rejects absent or empty required attestation and signatures', t => {
  const { root, check } = candidate(t);
  unlinkSync(join(root, provenanceName));
  assert.throws(() => check(), /exactly seven/);
  writeFileSync(join(root, provenanceName), '');
  assert.throws(() => check(), /invalid staged/);
});

test('rejects malformed provenance and non-Sigstore envelope', t => {
  const { root, check } = candidate(t);
  writeFileSync(join(root, provenanceName), '{bad-json');
  assert.throws(() => check());
  writeFileSync(join(root, provenanceName), JSON.stringify({claimed:true}));
  assert.throws(() => check(), /unexpected structure/);
});

test('rejects malformed and structurally incomplete Sigstore bundles', t => {
  const { root, check } = candidate(t);
  writeFileSync(join(root, 'SHA256SUMS.sigstore.json'), '{}');
  assert.throws(() => check(), /unexpected structure/);
  writeFileSync(join(root, 'SHA256SUMS.sigstore.json'), '{broken-json');
  assert.throws(() => check());
});

test('rejects symlinked asset even with exactly seven release names', t => {
  const { root, check } = candidate(t);
  const path = join(root, 'SHA256SUMS');
  const original = readFileSync(path);
  unlinkSync(path);
  const outside = mkdtempSync(join(tmpdir(), 'remcp-signed-symlink-'));
  t.after(() => rmSync(outside, { recursive:true, force:true }));
  const target = join(outside, 'real-checksums');
  writeFileSync(target, original);
  symlinkSync(target, path);
  assert.throws(() => check(), /invalid staged release asset/);
});

test('rejects externally linked or writable staged files', t => {
  const {root,check} = candidate(t);
  const target = join(root,payloadNames[0]);
  const outside = mkdtempSync(join(tmpdir(),'remcp-linked-asset-'));
  t.after(() => rmSync(outside,{recursive:true,force:true}));
  linkSync(target,join(outside,'linked'));
  assert.throws(() => check(),/invalid staged release asset/);
  unlinkSync(join(outside,'linked'));
  chmodSync(target,0o666);
  assert.throws(() => check(),/invalid staged release asset/);
});

test('rejects same-byte inode replacement while verifying', t => {
  const {root,check} = candidate(t);
  const target = join(root,payloadNames[0]);
  assert.throws(() => check({onVerify:() => {
    const replacement = join(root,'replacement');
    writeFileSync(replacement,readFileSync(target));
    renameSync(replacement,target);
  }}),/changed during verification/);
});

test('rejects a FIFO without blocking on a writer', {skip:process.platform==='win32'}, t => {
  const {root} = candidate(t);
  const target = join(root,payloadNames[0]);
  unlinkSync(target);
  assert.equal(spawnSync('mkfifo',[target]).status,0);
  const script = resolve('scripts/verify-public-atomic-release-candidate.mjs');
  const env = {...process.env,GITHUB_REPOSITORY:REPO,GITHUB_REF:'refs/tags/'+TAG,
    GITHUB_SHA:SHA,GITHUB_EVENT_NAME:'push'};
  const result = spawnSync(process.execPath,[script,'--directory',root,'--tag',TAG,'--source-sha',SHA],{env,encoding:'utf8',timeout:5000});
  assert.equal(result.status,2);
  assert.equal(result.stderr.trim(),'public_signed_candidate=blocked');
});

test('rejects checksum line reordering and duplicate entries', t => {
  const { root, check } = candidate(t);
  const manifest = join(root, 'SHA256SUMS');
  writeFileSync(manifest, readFileSync(manifest, 'utf8')
    .trimEnd().split('\n').reverse().join('\n') + '\n');
  assert.throws(() => check(), /checksums differ/);
  writeFileSync(manifest, checksums(root) + checksums(root));
  assert.throws(() => check(), /checksums differ/);
});

test('rejects group-writable staging directory', t => {
  const { root, check } = candidate(t);
  chmodSync(root, 0o770);
  assert.throws(() => check(), /unsafe release staging/);
});

test('rejects noncanonical repository, tag and source SHA identities', t => {
  const { check } = candidate(t);
  for (const params of [
    {repository:'antonbaider/remcp-full'},
    {repository:'getremcp/other'},
    {tag:'latest'}, {tag:'v0.2.265-rc1'}, {tag:'v0.2.265/../../'},
    {sourceSha:'0'.repeat(39)}, {sourceSha:'b'.repeat(41)},
  ]) {
    assert.throws(() => check(params), /identity invalid/);
  }
});

test('fails closed when cryptographic verifier is unavailable or rejects signature', t => {
  const { check } = candidate(t);
  assert.throws(() => check({verifyCryptography:null}), /mandatory/);
  assert.throws(() => check({verifyCryptography:() => {
    throw new Error('bad identity');
  }}), /bad identity/);
});

test('fails closed if candidate payload changes during cryptographic verification', t => {
  const { root, check } = candidate(t);
  assert.throws(() => check({onVerify:() => {
    writeFileSync(join(root, payloadNames[1]), 'changed after checks');
  }}), /changed during verification/);
});

test('rejects signature-bundle substitution during trust checks', t => {
  const { root, check } = candidate(t);
  assert.throws(() => check({onVerify:() => {
    writeFileSync(join(root, 'SHA256SUMS.sigstore.json'),
      JSON.stringify({messageSignature:{signature:'altered'},
        verificationMaterial:{certificate:{}}}));
  }}), /changed during verification/);
});

test('CLI blocks non-tag/manual contexts before invoking cosign or GitHub', t => {
  const { root } = candidate(t);
  const script = resolve('scripts/verify-public-atomic-release-candidate.mjs');
  const env = {...process.env, GITHUB_REPOSITORY:REPO,
    GITHUB_REF:'refs/heads/main', GITHUB_SHA:SHA,
    GITHUB_EVENT_NAME:'workflow_dispatch'};
  const result = spawnSync(process.execPath, [script,
    '--directory', root, '--tag', TAG, '--source-sha', SHA], {
    env, encoding:'utf8', timeout:10000,
  });
  assert.equal(result.status, 2);
  assert.equal(result.stderr.trim(), 'public_signed_candidate=blocked');
  assert.equal(result.stdout.trim(), '');
});
