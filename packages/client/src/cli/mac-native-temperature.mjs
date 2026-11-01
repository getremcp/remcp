// The global ReMCP installer deliberately disables npm lifecycle scripts.
// Opt in only the reviewed, version-pinned Apple Silicon temperature addon,
// after verifying its installed manifest and on-disk path. No sudo or shell.
import fs from 'node:fs';
import path from 'node:path';

const SENSOR_NAME = 'macos-temperature-sensor';
const SENSOR_VERSION = '2.1.1';
const SCRIPT = 'node-gyp rebuild';
const BINARY = path.join('build', 'Release', 'mac_temp_native.node');

function checkedManifest(file) {
  const stats = fs.lstatSync(file);
  if (!stats.isFile() || stats.size > 16384) throw new Error('invalid manifest');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function checkedDirectory(directory) {
  const stats = fs.lstatSync(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('unsafe addon directory');
}

export function buildVettedMacTemperatureAddon({ runtimeRoot, resolved, runCommand, warn = console.error }) {
  try {
    checkedDirectory(runtimeRoot);
    const runtime = checkedManifest(path.join(runtimeRoot, 'package.json'));
    if (runtime.name !== '@remcp/runtime' ||
        runtime.optionalDependencies?.[SENSOR_NAME] !== SENSOR_VERSION) return false;

    const modules = path.join(runtimeRoot, 'node_modules');
    const addonRoot = path.join(modules, SENSOR_NAME);
    // The native module is optional; if npm omitted it, report unknown rather
    // than reinstalling or executing a different dependency.
    if (!fs.existsSync(addonRoot)) return false;
    checkedDirectory(modules);
    checkedDirectory(addonRoot);
    const canonicalRoot = fs.realpathSync(runtimeRoot);
    const canonicalAddon = fs.realpathSync(addonRoot);
    if (!canonicalAddon.startsWith(canonicalRoot + path.sep)) throw new Error('addon escaped runtime');
    const addon = checkedManifest(path.join(addonRoot, 'package.json'));
    if (addon.name !== SENSOR_NAME || addon.version !== SENSOR_VERSION ||
        addon.scripts?.install !== SCRIPT) throw new Error('unreviewed native addon');

    const nativeBinary = path.join(addonRoot, BINARY);
    for (const folder of [path.join(addonRoot, 'build'), path.join(addonRoot, 'build', 'Release')]) {
      if (fs.existsSync(folder)) checkedDirectory(folder);
    }
    if (fs.existsSync(nativeBinary)) {
      if (!fs.lstatSync(nativeBinary).isFile()) throw new Error('invalid native module');
      return true;
    }
    // Execute precisely this verified package's known node-gyp script. Do not
    // re-enable arbitrary transitive lifecycle scripts in global npm install.
    runCommand(resolved.command, [
      ...resolved.args, '--prefix', addonRoot, 'run', 'install',
      '--foreground-scripts', '--ignore-scripts=false', '--no-audit', '--no-fund',
    ], { timeout:90_000 });
    if (!fs.existsSync(nativeBinary) || !fs.lstatSync(nativeBinary).isFile())
      throw new Error('native build did not create its module');
    return true;
  } catch {
    // The sensor is optional; do not roll back working ReMCP access because
    // a Mac lacks Xcode Command Line Tools. Never leak npm command stderr.
    warn('ReMCP: optional macOS temperature sensor unavailable; other tools remain functional.');
    return false;
  }
}
