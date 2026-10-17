import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Runtime tests create disposable files, including oversized sparse archive
// fixtures. Without an exit cleanup hook, repeated CI runs leak workspaces.
const testWorkspaces = new Set();

process.once('exit', () => {
  for (const root of testWorkspaces) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
    } catch (error) {
      // Cleanup failure must not hide a meaningful test failure. The weekly
      // stale-cache guard remains a fallback for interrupted processes.
      process.stderr.write(`ReMCP test workspace cleanup failed: ${error.message}\n`);
    }
  }
  testWorkspaces.clear();
});

export function freshWorkspace(prefix) {
  const root = mkdtempSync(join(tmpdir(), `remcp-runtime-${prefix}-`));
  testWorkspaces.add(root);
  process.env.REMCP_RUNTIME_CONFIG_DIR = join(root, 'config');
  return root;
}

export function body(result) {
  return result.content.map(part => part.text).join('\n');
}

export function isError(result) {
  return result.isError === true;
}

export async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return false;
}
