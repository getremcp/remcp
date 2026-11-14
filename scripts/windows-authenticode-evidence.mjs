// Read-only native Windows publisher verification. This is never used to execute a DLL.
import {spawnSync} from 'node:child_process';
import path from 'node:path';

const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const validThumbprint = value => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);

// PowerShell single-quoted literals prevent paths or Unicode profile names from becoming code.
export function quotePowerShellLiteral(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) {
    throw new Error('Invalid native asset path');
  }
  return "'" + value.replaceAll("'", "''") + "'";
}

export function verifyNativeWindowsSignatureEvidence(item, observed, approvedThumbprints) {
  if (!validHash(item?.sha256) || item?.signatureStatus !== 'Valid' ||
      !validThumbprint(item?.signerThumbprint) || observed?.status !== 'Valid' ||
      !validHash(observed?.sha256) || !validThumbprint(observed?.thumbprint)) {
    throw new Error('Native Windows Authenticode verification failed');
  }
  const observedThumb = observed.thumbprint.toUpperCase();
  if (observed.sha256.toLowerCase() !== item.sha256.toLowerCase() ||
      observedThumb !== item.signerThumbprint.toUpperCase() ||
      !approvedThumbprints.includes(observedThumb)) {
    throw new Error('Windows native helper signature, publisher or bytes do not match approved release evidence');
  }
  return true;
}

function assertApprovedPublishers(approvedSha1) {
  if (!Array.isArray(approvedSha1) || !approvedSha1.length ||
      approvedSha1.some(value => !validThumbprint(value))) {
    throw new Error('A non-empty reviewed Windows publisher thumbprint allowlist is required');
  }
  const normalized = approvedSha1.map(x => x.toUpperCase());
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('Duplicate trusted Windows publisher thumbprint');
  }
  return normalized;
}

export function verifyWindowsNativeSignatures(entries, approvedSha1, {
  platform = process.platform, run = spawnSync,
} = {}) {
  // Signed-release assertions MUST run on actual Windows; manifests alone cannot prove trust.
  if (platform !== 'win32') {
    throw new Error('Windows Authenticode verification requires a Windows signing QA host');
  }
  const approved = assertApprovedPublishers(approvedSha1);
  const powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!Array.isArray(entries) || entries.length !== 10) {
    throw new Error('Expected all 10 reviewed Windows native helper binaries');
  }
  const seen = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry.path !== 'string' || seen.has(entry.path)) {
      throw new Error('Missing or duplicate Windows native helper');
    }
    seen.add(entry.path);
    const file = quotePowerShellLiteral(entry.path);
    const script = [
      "$ErrorActionPreference='Stop'",
      '$file=' + file,
      '$sig=Get-AuthenticodeSignature -LiteralPath $file -ErrorAction Stop',
      '$digest=(Get-FileHash -LiteralPath $file -Algorithm SHA256 -ErrorAction Stop).Hash',
      "$thumb=if($sig.SignerCertificate){$sig.SignerCertificate.Thumbprint}else{''}",
      '[PSCustomObject]@{status=[string]$sig.Status;thumbprint=[string]$thumb;sha256=[string]$digest} | ConvertTo-Json -Compress',
    ].join(';');
    const result = run(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: 15000, maxBuffer: 64 * 1024, windowsHide: true,
    });
    if (result.error || result.status !== 0 || !result.stdout ||
        (result.stderr && result.stderr.trim())) {
      throw new Error('Windows Authenticode command did not complete successfully');
    }
    let actual;
    try { actual = JSON.parse(result.stdout.trim().replace(/^\uFEFF/, '')); }
    catch { throw new Error('Windows Authenticode command returned invalid evidence'); }
    verifyNativeWindowsSignatureEvidence(entry.item, actual, approved);
  }
  return entries.length;
}
