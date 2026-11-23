// Read-only, fail-closed preparation for a future public immutable release.
// Only verifies an already signed bundle; never publishes or modifies a release.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { payloadNames, provenanceName } from './release-assets-allowlist.mjs';

const sigName = 'SHA256SUMS.sigstore.json';
const sumName = 'SHA256SUMS';
const names = Object.freeze([...payloadNames, provenanceName, sumName, sigName]);
const maxBytes = Object.freeze(Object.fromEntries(names.map(name => [
  name, name === provenanceName ? 2_000_000 :
    name === sumName ? 2048 : name === sigName ? 500_000 : 200_000_000,
])));

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function inventory(directory) {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || (stat.mode & 0o022)) {
    throw new Error('unsafe release staging directory');
  }
  const existing = readdirSync(directory).sort();
  if (JSON.stringify(existing) !== JSON.stringify([...names].sort())) {
    throw new Error('release staging must contain exactly seven permitted assets');
  }
  const result = new Map();
  for (const name of names) {
    const path = join(directory, name);
    const item = lstatSync(path);
    if (!item.isFile() || item.size === 0 || item.size > maxBytes[name]) {
      throw new Error('invalid staged release asset: ' + name);
    }
    result.set(name, { path, size:item.size, digest:sha256(readFileSync(path)) });
  }
  return result;
}

function parseBundle(path, predicate) {
  const text = readFileSync(path, 'utf8');
  const record = JSON.parse(text);
  if (!record || typeof record !== 'object' || !predicate(record)) {
    throw new Error('staged signed release metadata has unexpected structure');
  }
}

export function expectedChecksums(files) {
  return [...payloadNames].sort().map(name =>
    files.get(name).digest + '  ' + name + '\n').join('');
}

export function verifyWithCli({ paths, tag, sha, repository }) {
  const exec = (binary, argumentsList) => execFileSync(binary, argumentsList, {
    stdio: ['ignore', 'ignore', 'pipe'], timeout:30000,
    env:{ ...process.env, LC_ALL:'C' },
  });
  const signer = 'https://github.com/' + repository +
    '/.github/workflows/ci.yml@refs/tags/' + tag;
  exec('cosign', [
    'verify-blob', paths.get(sumName).path,
    '--bundle', paths.get(sigName).path,
    '--certificate-identity', signer,
    '--certificate-oidc-issuer', 'https://token.actions.githubusercontent.com',
  ]);
  for (const name of payloadNames) {
    exec('gh', [
      'attestation', 'verify', paths.get(name).path, '--repo', repository,
      '--bundle', paths.get(provenanceName).path,
      '--source-ref', 'refs/tags/' + tag,
      '--source-digest', sha,
      '--signer-workflow', repository + '/.github/workflows/ci.yml',
    ]);
  }
}

export function verifyAtomicCandidate({
  directory, repository, tag, sourceSha, verifyCryptography=verifyWithCli,
}) {
  if (repository !== 'getremcp/remcp' ||
      !/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(tag) ||
      !/^[0-9a-f]{40}$/.test(sourceSha)) {
    throw new Error('release repository, tag or source identity invalid');
  }
  const root = resolve(directory);
  const paths = inventory(root);
  const expected = expectedChecksums(paths);
  if (readFileSync(paths.get(sumName).path, 'utf8') !== expected) {
    throw new Error('release payload checksums differ from the signed manifest');
  }
  parseBundle(paths.get(sigName).path, value =>
    !!value.verificationMaterial &&
    (!!value.messageSignature || !!value.dsseEnvelope));
  parseBundle(paths.get(provenanceName).path, value =>
    !!value.verificationMaterial && !!value.dsseEnvelope);
  if (typeof verifyCryptography !== 'function') {
    throw new Error('cryptographic verification is mandatory');
  }
  verifyCryptography({ paths, tag, sha:sourceSha, repository });
  // Re-hash after the trust checks, rejecting mutable stage files before any
  // caller may attempt a one-shot release upload.
  const current = inventory(root);
  for (const name of names) {
    if (current.get(name).digest !== paths.get(name).digest ||
        current.get(name).size !== paths.get(name).size) {
      throw new Error('signed release candidate changed during verification');
    }
  }
  return {
    tag, sourceSha, payloadCount:payloadNames.length,
    signedChecksumBundleVerified:true, releaseAttestationVerified:true,
    releasePublished:false, productionDeploymentAuthorized:false,
  };
}

function parseArgs(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i += 2) {
    if (i + 1 >= args.length ||
        !['--directory', '--tag', '--source-sha'].includes(args[i]) ||
        Object.hasOwn(parsed, args[i])) {
      throw new Error('expected --directory, --tag and --source-sha');
    }
    parsed[args[i]] = args[i + 1];
  }
  if (Object.keys(parsed).length !== 3) throw new Error('missing release parameter');
  return parsed;
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (process.env.GITHUB_REPOSITORY !== 'getremcp/remcp' ||
        process.env.GITHUB_REF !== 'refs/tags/' + args['--tag'] ||
        process.env.GITHUB_SHA !== args['--source-sha'] ||
        process.env.GITHUB_EVENT_NAME !== 'push') {
      throw new Error('not an exact public tagged release workflow');
    }
    const result = verifyAtomicCandidate({
      directory:args['--directory'], repository:process.env.GITHUB_REPOSITORY,
      tag:args['--tag'], sourceSha:args['--source-sha'],
    });
    console.log('public_signed_candidate_verified=' + result.tag +
      ' assets=7 release_published=false production_authorized=false');
  } catch {
    console.error('public_signed_candidate=blocked');
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
