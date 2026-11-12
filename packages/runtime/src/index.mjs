#!/usr/bin/env node
import process from 'node:process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { advertisedTools as advertisedCoreTools, toolDefinitions as coreToolDefinitions } from './catalog.mjs';
import { allExtendedTools, extendedToolDefinitions } from './extended/catalog.mjs';
import { supportedRuntimeToolDefinitions } from './tool-availability.mjs';
import { describeConfig, configurationError, runtimeConfigDir } from './config.mjs';
import { shutdownSessions, startSessionSweeper } from './sessions.mjs';
import { flush, setTelemetrySink, shutdownTelemetry, telemetryEnabled } from './telemetry.mjs';
import { VERSION } from './version.mjs';
import { verifyWindowsInterop } from './native/windows/verify.mjs';

const args = process.argv.slice(2);
const allToolDefinitions = [...coreToolDefinitions, ...extendedToolDefinitions];

async function advertisedRuntimeTools() {
  verifyWindowsInterop();
  const { core, extended } = await supportedRuntimeToolDefinitions();
  return [...core, ...extended];
}

async function writeStdout(value) {
  await new Promise((resolve, reject) => {
    process.stdout.write(value, error => error ? reject(error) : resolve());
  });
}

if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write([
    'ReMCP local device runtime',
    '',
    'Usage: remcp-runtime [--print-tools] [--describe] [--version]',
    '',
    'The runtime is normally started by the ReMCP device agent and speaks MCP over stdio.',
    'It executes file, search, terminal, process, desktop UI, browser, diagnostics, and document tools locally on this computer.',
    '',
    'Desktop capabilities are detected from the operating system and available native helpers.',
    'The live MCP tool list changes when optional capabilities appear or disappear.',
    '',
    'Usage metrics are opt-out: only tool names, timings and outcomes are collected, and they',
    'travel to your own ReMCP account through the already-authenticated paired agent. Nothing is',
    'sent to a third party, there is no install ping, and there are no remote feature flags.',
    'Disable with `remcp telemetry off`, REMCP_RUNTIME_DISABLE_TELEMETRY=1, or',
    '"telemetryEnabled": false in runtime.json.',
    '',
  ].join('\n'));
  process.exit(0);
}

if (args.includes('--version')) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

if (args.includes('--print-tools')) {
  await writeStdout(`${JSON.stringify([...advertisedCoreTools(), ...allExtendedTools()], null, 2)}\n`);
  process.exit(0);
}

if (args.includes('--describe')) {
  const supportedTools = (await advertisedRuntimeTools()).length;
  await writeStdout(`${JSON.stringify({
    version: VERSION,
    tools: allToolDefinitions.length,
    supportedTools,
    extendedTools: extendedToolDefinitions.length,
    ...describeConfig(),
  }, null, 2)}\n`);
  process.exit(0);
}

verifyWindowsInterop();
const configProblem = configurationError();
if (configProblem) {
  console.error(`ReMCP runtime refuses to start: ${configProblem}`);
  process.exit(2);
}

function announceTelemetryOnce() {
  if (!telemetryEnabled()) return;
  const marker = path.join(runtimeConfigDir, '.telemetry-notice');
  try {
    mkdirSync(runtimeConfigDir, { recursive: true, mode: 0o700 });
    writeFileSync(marker, `${new Date().toISOString()}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (error?.code === 'EEXIST') return;
    return;
  }
  console.error('ReMCP runtime: anonymous usage metrics are on (tool names, timings, outcomes only - never file paths, commands or output). They go to your own ReMCP account through the paired agent. Disable with `remcp telemetry off`.');
}

const runtimeInstructions = [
  'This runtime executes file, search, terminal, process, desktop UI, browser, diagnostics, and document tools locally on a computer its owner paired with ReMCP.',
  'Inspect before changing: read, snapshot, list or find first; then write, edit, click, move, launch, or run commands only when the user asked for that side effect.',
  'Prefer accessibility or browser DOM targets over screen coordinates. Use screenshots as a visual fallback rather than the primary control plane.',
  'Browser CDP endpoints are loopback-only; local file uploads and document operations still obey the runtime filesystem allowlist.',
  'Paths are absolute or resolve against the runtime working directory; prefer absolute paths.',
  'Commands matching the configured catastrophic-command guardrail are handled by the same policy layer as terminal commands.',
].join(' ');

const { startRuntimeMcpServer } = await import('./mcp-v2.mjs');
const runtimeServer = await startRuntimeMcpServer({
  version: VERSION,
  instructions: runtimeInstructions,
  onError(error) {
    console.error(`ReMCP runtime MCP error: ${error instanceof Error ? error.message : String(error)}`);
  },
});

setTelemetrySink(async payload => {
  await runtimeServer.notification({ method: 'notifications/remcp/telemetry', params: payload });
});

const SHUTDOWN_BUDGET_MS = 1500;
let shutdownStarted = false;

async function shutdown(code = 0) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  const deadline = Date.now() + SHUTDOWN_BUDGET_MS;
  shutdownSessions();
  try {
    await Promise.race([flush(), new Promise(resolve => setTimeout(resolve, Math.max(0, deadline - Date.now())))]);
  } catch {}
  await shutdownTelemetry();
  try { await runtimeServer.close(); } catch {}
  process.exit(code);
}

process.stdout.on('error', error => {
  if (error?.code === 'EPIPE' || error?.code === 'ERR_STREAM_DESTROYED') void shutdown(0);
  else console.error(`ReMCP runtime stdout error: ${error instanceof Error ? error.message : String(error)}`);
});
process.on('uncaughtException', error => {
  console.error(`ReMCP runtime uncaught exception: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  void shutdown(1);
});
process.on('unhandledRejection', reason => {
  console.error(`ReMCP runtime unhandled rejection: ${reason instanceof Error ? reason.stack || reason.message : String(reason)}`);
});
process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
process.on('exit', () => { shutdownSessions(); });

startSessionSweeper();
announceTelemetryOnce();

const supportedCount = (await advertisedRuntimeTools()).length;
console.error(`ReMCP runtime ${VERSION} ready with ${supportedCount}/${allToolDefinitions.length} tools supported on this computer`);
