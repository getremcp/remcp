import { mkdtempSync as createTemporaryDirectory, realpathSync, rmSync } from 'node:fs';
import { after } from 'node:test';

// These fixtures are owned by the current test worker, never by a production process.
const ownedDirectories = new Set();
function cleanupOwnedDirectories() {
  for (const directory of ownedDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  ownedDirectories.clear();
}
after(cleanupOwnedDirectories);
// Preserve cleanup on normal exit and uncaught module-initialization errors.
process.once('exit', cleanupOwnedDirectories);
process.once('uncaughtExceptionMonitor', cleanupOwnedDirectories);

export function mkdtempSync(prefix) {
  const directory = createTemporaryDirectory(prefix);
  ownedDirectories.add(directory);
  // macOS /tmp aliases /private/tmp. Match the realpath-based CLI lookup
  // without weakening path equality or package ownership assertions.
  const canonical = realpathSync(directory);
  ownedDirectories.delete(directory);
  ownedDirectories.add(canonical);
  return canonical;
}
