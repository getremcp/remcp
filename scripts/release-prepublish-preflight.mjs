// Fail closed before irreversible npm trusted publication if an existing
// GitHub Release already contains foreign or modified artifact bytes.
// The fetches are read-only. A missing release (HTTP 404) is allowed.
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {assertReleaseAssetInventory, provenanceName} from
  './release-assets-allowlist.mjs';

const paths = Object.freeze({
  'chatgpt-app-submission.json':'chatgpt-app-submission.json',
  'remcp-plugin.zip':'submission/remcp-plugin.zip',
  'remcp-openai-existing-plugin.zip':'submission/remcp-openai-existing-plugin.zip',
  'remcp-skills-only.zip':'submission/remcp-skills-only.zip',
});
const maxBytes = 8 * 1024 * 1024;
const sha256 = value => createHash('sha256').update(value).digest('hex');

async function boundedBytes(response, expectedLength) {
  if (!response.ok || !response.body || response.status !== 200) {
    throw new Error('Existing release artifact could not be downloaded');
  }
  const len = response.headers.get('content-length');
  if (len && (!/^\d+$/.test(len) || Number(len) !== expectedLength)) {
    throw new Error('Existing release asset HTTP length mismatch');
  }
  const stream = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const {done, value} = await stream.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes || total > expectedLength) {
        throw new Error('Existing release asset exceeds bounded size');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    stream.releaseLock();
  }
  if (total !== expectedLength) {
    throw new Error('Existing release asset truncated');
  }
  return Buffer.concat(chunks, total);
}

export async function preflightExistingRelease({
  repository, tag, token, fetchFn = fetch, readFileFn = readFile,
  requireAbsent = false,
} = {}) {
  if (!/^[a-z\d_.-]+\/[a-z\d_.-]+$/i.test(repository || '') ||
      !/^v\d+\.\d+\.\d+$/.test(tag || '') ||
      typeof token !== 'string' || !token.trim()) {
    throw new Error('Release preflight requires a valid GitHub repo, tag and token');
  }
  const endpoint = 'https://api.github.com/repos/' + repository +
    '/releases/tags/' + tag;
  let metadataResponse;
  try {
    metadataResponse = await fetchFn(endpoint, {
      headers:{
        Authorization:'Bearer ' + token,
        Accept:'application/vnd.github+json',
        'Cache-Control':'no-cache',
        'User-Agent':'remcp-release-prepublish-preflight',
      },
      signal:AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error('GitHub release preflight API unavailable');
  }
  if (metadataResponse.status === 404) {
    return {state:'absent', verified:0};
  }
  if (metadataResponse.status !== 200) {
    throw new Error('GitHub release preflight HTTP ' + metadataResponse.status);
  }
  // Atomic seven-asset publication must never mutate even an empty or
  // incomplete Release. Preserve legacy partial-repair readback separately.
  if (requireAbsent) {
    throw new Error('Atomic release already exists; refusing publication');
  }
  let release;
  try {
    release = await metadataResponse.json();
  } catch {
    throw new Error('GitHub release preflight returned malformed JSON');
  }
  if (release?.tag_name !== tag || release.draft !== false) {
    throw new Error('GitHub release tag mismatch or unexpected draft');
  }
  assertReleaseAssetInventory(release);
  if (release.assets.some(asset => asset.name === provenanceName ||
      asset.name === 'SHA256SUMS' ||
      asset.name === 'SHA256SUMS.sigstore.json')) {
    throw new Error('Existing attested/signed GitHub release is immutable');
  }
  for (const asset of release.assets) {
    const localPath = paths[asset.name];
    const expectedUrl = 'https://github.com/' + repository +
      '/releases/download/' + tag + '/' + asset.name;
    if (!localPath || asset.browser_download_url !== expectedUrl ||
        !Number.isSafeInteger(asset.size) || asset.size <= 0 ||
        asset.size > maxBytes) {
      throw new Error('Existing release asset metadata is unsafe: ' + asset.name);
    }
    const local = await readFileFn(localPath);
    if (local.byteLength !== asset.size) {
      throw new Error('Existing release asset size differs: ' + asset.name);
    }
    let response;
    try {
      response = await fetchFn(expectedUrl, {
        headers:{'Cache-Control':'no-cache'},
        signal:AbortSignal.timeout(20_000),
      });
    } catch {
      throw new Error('Existing release asset download unavailable: ' + asset.name);
    }
    const downloaded = await boundedBytes(response, asset.size);
    if (sha256(downloaded) !== sha256(local)) {
      throw new Error('Existing release asset differs from tagged bytes: ' + asset.name);
    }
  }
  return {state:'verified-partial', verified:release.assets.length};
}

if (process.argv[1] &&
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || args.some(arg => arg !== '--require-absent')) {
      throw new Error('Unsupported release preflight option');
    }
    const result = await preflightExistingRelease({
      repository:process.env.GITHUB_REPOSITORY,
      tag:process.env.GITHUB_REF_NAME,
      token:process.env.GH_TOKEN,
      requireAbsent:args.includes('--require-absent'),
    });
    console.log('release_prepublish_preflight=' + result.state +
      ' verified_assets=' + result.verified);
  } catch (error) {
    console.error('release_prepublish_blocked=' +
      String(error?.message || error));
    process.exitCode = 1;
  }
}
