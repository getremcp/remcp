import process from 'node:process';
import { describeConfig, liveConfig, runtimeConfig } from '../config.mjs';
import { dangerousPatternIds } from '../policy.mjs';
import { listProcessSessions, listSearchSessions } from '../sessions.mjs';
import { telemetryStatus } from '../telemetry.mjs';
import { VERSION } from '../version.mjs';
import { privilegeBoundary } from '../privilege-boundary.mjs';
import { text } from '../util.mjs';

// Read-only introspection. Mutating configuration is a separate, deliberately narrow tool:
// set_config_value can change only telemetry and context/output preferences; access roots,
// command security, the shell, write limit, name, and unrestricted mode remain local-only.
export async function getRuntimeInfoTool() {
  const telemetry = telemetryStatus();
  return text(JSON.stringify({
    version: VERSION,
    runtime: describeConfig(),
    osPrivilegeBoundary: privilegeBoundary(),
    policy: {
      // Reported first because it changes how everything below should be read.
      unrestricted: runtimeConfig.unrestricted,
      ...(runtimeConfig.unrestricted
        ? { unrestrictedNote: 'Unrestricted mode is on for this computer: any path and any command is allowed, and commands still run as the user the agent runs as, so sudo needs your own sudoers rules. Turn it off with `remcp godmode off` (or REMCP_RUNTIME_UNRESTRICTED=0) and restart the agent.' }
        : {}),
      allowedRoots: [...runtimeConfig.allowedRoots],
      blockedCommands: [...runtimeConfig.blockedCommands],
      dangerousCommands: runtimeConfig.dangerousCommands,
      builtinGuardrailIds: dangerousPatternIds,
      note: 'Guardrails reduce accidents and prompt-injected one-liners; they are not an operating-system sandbox.',
    },
    telemetry: {
      enabled: telemetry.enabled,
      transport: telemetry.transport,
      endpoint: telemetry.endpoint,
      thirdParty: telemetry.thirdParty,
      installPing: telemetry.installPing,
      remoteFeatureFlags: telemetry.remoteFeatureFlags,
    },
    limits: {
      maxOutputBytes: liveConfig('maxOutputBytes'),
      maxReadLines: liveConfig('maxReadLines'),
      maxBufferedLines: liveConfig('maxBufferedLines'),
      maxWriteBytes: runtimeConfig.maxWriteBytes,
      maxConcurrentConnections: 1,
    },
  }, null, 2));
}

export async function getRuntimeStatsTool() {
  const telemetry = telemetryStatus();
  const processes = listProcessSessions();
  const searches = listSearchSessions();
  const running = processes.filter(session => !session.exited).length;
  return text(JSON.stringify({
    runtimeVersion: VERSION,
    uptimeSeconds: telemetry.uptimeSeconds,
    counters: telemetry.counters,
    topTools: telemetry.topTools,
    sessions: {
      processSessions: processes.length,
      processSessionsRunning: running,
      searchSessions: searches.length,
      searchSessionsRunning: searches.filter(session => session.status === 'running').length,
    },
    telemetry: {
      enabled: telemetry.enabled,
      transport: telemetry.transport,
      endpoint: telemetry.endpoint,
      buffered: telemetry.buffered,
      sentEvents: telemetry.sentEvents,
      droppedEvents: telemetry.droppedEvents,
    },
  }, null, 2));
}

export const statsToolHandlers = {
  get_runtime_info: getRuntimeInfoTool,
  get_runtime_stats: getRuntimeStatsTool,
};
