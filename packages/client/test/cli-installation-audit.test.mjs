import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { auditKnownInstallations } from '../src/cli/installation-audit.mjs';

function packageCli(root, version='0.2.209') {
  const pkg = path.join(root, 'node_modules', '@remcp', 'remcp');
  const cli = path.join(pkg, 'bin', 'remcp.mjs');
  fs.mkdirSync(path.dirname(cli), { recursive:true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name:'@remcp/remcp', version }));
  fs.writeFileSync(cli, 'console.log("fixture")');
  const runtime = path.join(root, 'node_modules', '@remcp', 'runtime');
  fs.mkdirSync(runtime, { recursive:true });
  fs.writeFileSync(path.join(runtime, 'package.json'), JSON.stringify({ name:'@remcp/runtime', version }));
  return cli;
}
function usingFixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remcp-package-inventory-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive:true, force:true }); }
}
test('aliases to one managed package are not phantom additional installations', () => usingFixture(dir => {
  const canonical = packageCli(path.join(dir, 'managed'));
  const alias = path.join(dir, 'bin', 'remcp');
  fs.mkdirSync(path.dirname(alias), { recursive:true });
  fs.symlinkSync(canonical, alias);
  const result = auditKnownInstallations(
    { installations:[{ cliPath:alias }, { cliPath:canonical }] },
    { currentCliPath:alias, serviceCliPath:canonical },
  );
  assert.equal(result.packageCopyCount, 1);
  assert.equal(result.otherCopyCount, 0);
  assert.equal(result.copies[0].isManagedService, true);
  assert.equal(result.copies[0].isInvoked, true);
  assert.equal(result.aliases.length, 1);
  assert.equal(result.processConcurrency, 'not_measured');
}));
test('recognizes real dormant NVM and npx copies without changing them or Node.js', () => usingFixture(dir => {
  const canonical = packageCli(path.join(dir, 'managed'), '0.2.209');
  const oldNvm = packageCli(path.join(dir, '.nvm', 'versions', 'node', 'v22', 'lib'), '0.2.100');
  const oldNpx = packageCli(path.join(dir, '.npm', '_npx', 'cache-id'), '0.2.99');
  const nodePath = path.join(dir, '.nvm', 'versions', 'node', 'v22', 'bin', 'node');
  fs.mkdirSync(path.dirname(nodePath), { recursive:true });
  fs.writeFileSync(nodePath, 'node fixture');
  const before = fs.readFileSync(nodePath, 'utf8');
  const report = auditKnownInstallations({ installations:[{ cliPath:oldNvm }, { cliPath:oldNpx }] },
    { currentCliPath:canonical, serviceCliPath:canonical });
  assert.equal(report.packageCopyCount, 3);
  assert.deepEqual(report.copies.map(item => item.runtimeVersion), ['0.2.209','0.2.100','0.2.99']);
  assert.equal(report.otherCopyCount, 2);
  assert.deepEqual(report.copies.filter(c => !c.isManagedService).map(c => c.kind).sort(), ['npm_package', 'npx_cache']);
  assert.equal(fs.readFileSync(nodePath, 'utf8'), before);
  assert.equal(fs.existsSync(oldNvm), true);
  assert.equal(fs.existsSync(oldNpx), true);
}));
test('ignores removed paths, forged package names and unrelated npm scripts', () => usingFixture(dir => {
  const canonical = packageCli(path.join(dir, 'managed'));
  const bogus = packageCli(path.join(dir, 'other'));
  const otherPackage = path.join(dir, 'other', 'node_modules', '@remcp', 'remcp', 'package.json');
  fs.writeFileSync(otherPackage, JSON.stringify({ name:'unrelated/npm', version:'1.0.0' }));
  const arbitrary = path.join(dir, 'anything.mjs');
  fs.writeFileSync(arbitrary, 'file exists but is not a ReMCP install');
  const result = auditKnownInstallations({
    installations:[{ cliPath:bogus }, { cliPath:arbitrary }, { cliPath:path.join(dir,'gone','remcp.mjs') }],
  }, { currentCliPath:canonical, serviceCliPath:canonical });
  assert.equal(result.packageCopyCount, 1);
  assert.equal(result.otherCopyCount, 0);
  assert.equal(result.ignoredUnverifiedPathCount, 2);
}));
test('recognizes npm Windows .cmd shim using manifest, never by filename alone', () => usingFixture(dir => {
  const prefix = path.join(dir, 'npm-prefix');
  const cli = path.join(prefix, 'remcp.cmd');
  fs.mkdirSync(prefix, { recursive:true });
  fs.writeFileSync(cli, '@echo off');
  assert.equal(auditKnownInstallations({ installations:[{ cliPath:cli }] }).packageCopyCount, 0);
  const pkg = path.join(prefix, 'node_modules', '@remcp', 'remcp');
  fs.mkdirSync(pkg, { recursive:true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name:'@remcp/remcp', version:'0.2.209' }));
  assert.equal(auditKnownInstallations({ installations:[{ cliPath:cli }] }).packageCopyCount, 1);
}));
