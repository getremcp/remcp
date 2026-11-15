// Verify an existing GitHub Release's uploaded-asset inventory before any
// tag-publish retry or v0.2.258+ recovery can mutate it. No GitHub API access:
// pipe the raw JSON from `gh release view "$tag" --json assets` to this script.
// The synthetic source archives attached by GitHub are NOT uploaded assets.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const payloadNames = Object.freeze([
  'chatgpt-app-submission.json',
  'remcp-plugin.zip',
  'remcp-openai-existing-plugin.zip',
  'remcp-skills-only.zip',
]);
export const provenanceName = 'remcp-release.intoto.jsonl';
const checksumNames = Object.freeze(['SHA256SUMS', 'SHA256SUMS.sigstore.json']);
const expected = new Set([...payloadNames, provenanceName, ...checksumNames]);

export function assertReleaseAssetInventory(inventory, {requireAttestation=false}={}) {
  if (!inventory || !Array.isArray(inventory.assets) || inventory.assets.length > expected.size) {
    throw new Error('Invalid release asset inventory');
  }
  const names = [];
  const seen = new Set();
  for (const asset of inventory.assets) {
    const name = asset?.name;
    if (typeof name !== 'string' || !expected.has(name) || seen.has(name)) {
      throw new Error('Unexpected or duplicated release asset: ' + String(name));
    }
    names.push(name);
    seen.add(name);
  }

  const hasProvenance = seen.has(provenanceName);
  const hasChecksums = seen.has(checksumNames[0]);
  const hasSignature = seen.has(checksumNames[1]);
  if (hasChecksums !== hasSignature) {
    throw new Error('Incomplete signed release asset pair');
  }
  // A successful tag publisher first uploads the four actual artifacts,
  // then their attestation. A provenance file without its subjects, or
  // signatures without their provenance, is an incomplete/foreign release.
  if ((requireAttestation || hasProvenance) &&
      (!hasProvenance || payloadNames.some(name => !seen.has(name)))) {
    throw new Error('Attested release missing original payload or attestation');
  }
  if (hasChecksums && !hasProvenance) {
    throw new Error('Unexpected signed release without required attestation');
  }
  return names;
}

async function runCli() {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some(arg => arg !== '--require-attestation')) {
    throw new Error('Unsupported release asset check option');
  }
  let json = '';
  for await (const chunk of process.stdin) {
    json += chunk;
    if (json.length > 128 * 1024) throw new Error('Release asset inventory is too large');
  }
  const names = assertReleaseAssetInventory(JSON.parse(json), {
    requireAttestation:args.includes('--require-attestation'),
  });
  process.stdout.write('release_assets_verified=' + names.length + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await runCli();
  } catch (error) {
    console.error('release_assets_rejected=' + String(error?.message || error));
    process.exitCode = 1;
  }
}
