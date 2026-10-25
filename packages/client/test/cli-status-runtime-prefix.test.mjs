import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { VERSION } from '../src/version.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = pathToFileURL(path.join(root, 'src', 'cli.mjs')).href;

function statusWithMismatchedNpmPrefix({ runtimePresent }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'remcp-status-npm-prefix-'));
  try {
    const home = path.join(dir, 'home');
    const configDir = path.join(home, '.config', 'remcp');
    const cliPath = path.join(dir, 'global', 'lib', 'node_modules', '@remcp', 'remcp', 'bin', 'remcp.mjs');
    const runtimeDir = path.join(dir, 'global', 'lib', 'node_modules', '@remcp', 'runtime');
    mkdirSync(path.dirname(cliPath), { recursive:true });
    mkdirSync(runtimeDir, { recursive:true });
    mkdirSync(configDir, { recursive:true });
    writeFileSync(cliPath, `import { main } from ${JSON.stringify(source)}; await main();\n`);
    if (runtimePresent) {
      writeFileSync(path.join(runtimeDir, 'package.json'), JSON.stringify({ name:'@remcp/runtime', version:VERSION }));
    }
    writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
      configSchemaVersion:1,
      serverUrl:'http://127.0.0.1:9',
      deviceId:'fixture-device',
      deviceName:'isolated fixture',
      serviceInstalled:false,
      runtime:{ kind:'npm', packageName:'@remcp/runtime', packageSpec:`@remcp/runtime@${VERSION}`, entry:'src/index.mjs' },
    }));
    const result = spawnSync(process.execPath, [cliPath, 'status'], {
      encoding:'utf8',
      timeout:5000,
      env:{
        ...process.env, HOME:home, REMCP_CONFIG_DIR:configDir,
        REMCP_NPM:'', NPM_CONFIG_PREFIX:path.join(dir, 'empty-prefix'), NODE_ENV:'test',
        REMCP_TEST_PLATFORM:process.platform, INVOCATION_ID:'', XPC_SERVICE_NAME:'',
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  } finally {
    rmSync(dir, { recursive:true, force:true });
  }
}

test('status locates real runtime beside its CLI when npm uses another global prefix', () => {
  const status = statusWithMismatchedNpmPrefix({ runtimePresent:true });
  assert.equal(status.runtime.installed, VERSION);
  assert.equal(status.update.multipleInstallations, false);
});

test('status never invents a runtime when both CLI-adjacent and npm prefixes lack it', () => {
  const status = statusWithMismatchedNpmPrefix({ runtimePresent:false });
  assert.equal(status.runtime.installed, null);
});
