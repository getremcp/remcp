import { agentUpdateInvocation, installedUpdateEntry } from './agent-recovery-invocation.mjs';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { PACKAGE_NAME, VERSION } from './version.mjs';
import { isRuntimeSpecFor } from './runtime.mjs';
import { recoveryTargetHeld, holdRecoveryTarget } from './windows-recovery-state.mjs';
import { fetchUpdateManifest } from './fetch-update-manifest.mjs';
import { updateRolloutEligibility } from './agent-update-rollout.mjs';
import { globalCliEntry, globalInstalledVersion, isNewer, restartToApplyUpdate, updateDecision } from './agent-update.mjs';

// Check on a stable per-device wall-clock phase so a short server rollout
// does not leave healthy connected clients waiting half an hour. The phase
// spreads checks over this window even after a simultaneous fleet restart.
export const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const UPDATE_CHECK_TIMEOUT_MS = 12000;
// A flapping relay must not trigger update discovery on every successful reconnect.
const UPDATE_CHECK_RECONNECT_GAP_MS = 30000;
// Fleet clients already have a per-device wall-clock polling phase. Avoid
// bursty reconnect-triggered rechecks; explicit short QA fixtures may opt in.
const POST_CONNECT_UPDATE_RECHECK_DELAYS_MS = Object.freeze([]);
const POST_CONNECT_UPDATE_RECHECK_JITTER_MS = 30_000;
const UPDATE_RETRY_COOLDOWN_MS = 30 * 60 * 1000;
const UPDATER_OUTPUT_DRAIN_MS = 5_000;

export function createAgentUpdateMonitor({ options, serverUrl, queueEvent, getRuntimeState, onStopRequested, restartRuntime, isStopping, stop, resolveCli = globalCliEntry, spawnUpdater = spawn, resolveInvocation = agentUpdateInvocation }) {
  const postConnectUpdateRecheckDelaysMs = (Array.isArray(options.updateRecheckDelaysMs)
    ? options.updateRecheckDelaysMs : POST_CONNECT_UPDATE_RECHECK_DELAYS_MS)
    .map(Number).filter(delay => Number.isFinite(delay) && delay >= 0 && delay < UPDATE_CHECK_INTERVAL_MS).slice(0, 3);
  const postConnectUpdateRecheckJitterMs = Number.isFinite(Number(options.updateRecheckJitterMs))
    ? Math.max(0, Math.min(60_000, Number(options.updateRecheckJitterMs)))
    : POST_CONNECT_UPDATE_RECHECK_JITTER_MS;
  let postConnectUpdateTimers = [];

  // Auto-update: the server publishes the versions an agent should be running. A newer
  // release is installed in the background and the service restart picks it up; a failed
  // or skipped update leaves the current version running, so an old agent keeps working.
  //
  // The update must be idempotent across reconnects: a flapping relay used to start one
  // `npm install -g` per reconnect, so a machine could run several installers (and service
  // restarts) at once. One attempt per advertised version, and never two at the same time.
  let updateInFlight = false;
  let lastAttemptedVersion = '';
  let lastAttemptAt = 0;
  let lastUpdateCheckError = '';
  let lastUpdateCheckErrorAt = 0;
  let lastDiscoveryAt = 0;
  let lastAnnouncedVersion = '';
  let lastAnnouncedAt = 0;
  let lastUnavailableKey = '';
  let lastUnavailableAt = 0;
  let heldTarget = '';

  function clearPostConnectUpdateChecks() {
    for (const timer of postConnectUpdateTimers) clearTimeout(timer);
    postConnectUpdateTimers = [];
  }

  function schedulePostConnectUpdateChecks() {
    clearPostConnectUpdateChecks();
    if (options.autoUpdate === false) return;
    for (const delay of postConnectUpdateRecheckDelaysMs) {
      const jitter = postConnectUpdateRecheckJitterMs > 0
        ? Math.floor(Math.random() * (postConnectUpdateRecheckJitterMs + 1))
        : 0;
      const timer = setTimeout(() => {
        postConnectUpdateTimers = postConnectUpdateTimers.filter(candidate => candidate !== timer);
        void checkForUpdate({ scheduled: true });
      }, delay + jitter);
      timer.unref?.();
      postConnectUpdateTimers.push(timer);
    }
  }

  async function checkForUpdate({ scheduled = false } = {}) {
    if (options.autoUpdate === false) return;
    if (updateInFlight) return;
    const minimumGap = Number.isFinite(Number(options.updateCheckMinGapMs))
      ? Math.max(0, Math.min(UPDATE_CHECK_RECONNECT_GAP_MS, Number(options.updateCheckMinGapMs)))
      : UPDATE_CHECK_RECONNECT_GAP_MS;
    const now = Date.now();
    // Scheduled bounded convergence polls are distinct from reconnect-triggered discovery.
    // Do not starve release-pause/Redis-recovery checks behind the reconnect storm cooldown.
    if (!scheduled && lastDiscoveryAt && now - lastDiscoveryAt < minimumGap) return;
    lastDiscoveryAt = now;
    try {
      // This request contains no local file payload; the config-derived URL is the explicitly paired relay.
      // codeql[js/file-access-to-http]
      // Bound both connection and JSON body parsing even if platform fetch ignores AbortSignal.
      const advertised = await fetchUpdateManifest(`${serverUrl}/api/agent/version`, {
        timeoutMs: UPDATE_CHECK_TIMEOUT_MS,
      });
      if (!advertised) return;
      const minimum = advertised.minimum;
      if (minimum && isNewer(minimum, VERSION)) {
        console.error(`ReMCP ${VERSION} is older than the minimum supported agent ${minimum}; update with: remcp update`);
      }
      const { runtimeVersion, runtimeDown } = getRuntimeState();
      const decision = updateDecision({ advertised, cliVersion: VERSION, runtimeVersion, runtimePackageName: options.runtime?.packageName, runtimeDown });
      if (!decision.needed) return;
      const target = decision.target;
      const availabilityKey = `${target}|${decision.runtime}`;
      if (process.platform === 'win32' && (heldTarget === availabilityKey || recoveryTargetHeld(availabilityKey))) return;
      const observedAt = Date.now();
      const announce = availabilityKey !== lastAnnouncedVersion ||
        observedAt - lastAnnouncedAt >= UPDATE_RETRY_COOLDOWN_MS;
      if (announce) {
        lastAnnouncedVersion = availabilityKey;
        lastAnnouncedAt = observedAt;
        // Version discovery is not installation success. The running version
        // proves convergence only after the replacement agent reconnects.
        queueEvent({ event: 'agent_update_available', at: observedAt, reason: decision.reason.slice(0, 32) });
      }
      const eligible = updateRolloutEligibility({
        deviceId: options.deviceId,
        target: availabilityKey,
        rollout: advertised.rollout,
        // An explicitly raised minimum version or broken local runtime needs
        // repair without the normal gradual fleet-release delay.
        urgent: decision.reason === 'runtime-repair' || Boolean(minimum && isNewer(minimum, VERSION)),
      }, observedAt);
      if (!eligible.ready) return;
      // Another manifest request may have completed while this request awaited HTTP.
      if (updateInFlight) return;
      const cli = resolveCli();
      const invocation = resolveInvocation({cli, decision, cliVersion:VERSION, trustRuntime:options.trustRuntime === true});
      if (!invocation) {
        if (availabilityKey !== lastUnavailableKey || observedAt - lastUnavailableAt >= UPDATE_RETRY_COOLDOWN_MS) {
          lastUnavailableKey = availabilityKey;
          lastUnavailableAt = observedAt;
          console.error(`ReMCP ${target} is available; run: remcp update`);
          queueEvent({event:'agent_update',at:observedAt,reason:'updater-unavailable',success:false});
        }
        return;
      }
      // A version that already failed to install is retried only after a cooldown, so a broken
      // release cannot turn into an install loop.
      const attemptKey = `${target}|${decision.runtime}`;
      if (attemptKey === lastAttemptedVersion && Date.now() - lastAttemptAt < UPDATE_RETRY_COOLDOWN_MS) return;
      lastAttemptedVersion = attemptKey;
      lastAttemptAt = Date.now();
      updateInFlight = true;
      console.log(`Updating ReMCP to ${target}${decision.runtime ? ` with ${decision.runtime}` : ''} (${decision.reason})…`);
      // Keep the updater pinned to the exact release pair this trusted server advertised. That
      // prevents a newer public npm tag from getting ahead of production during a public-first rollout.
      let child;
      try {
        child = spawnUpdater(invocation.command, invocation.args, {
          detached: true,
          windowsHide: true,
          // The updater's local output is piped back into the agent's log.
          // Only fixed stage codes are queued for account telemetry.
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env },
        });
      } catch (error) {
        updateInFlight = false;
        console.error(`remcp update could not start: ${error.message}`);
        queueEvent({event:'agent_update',at:Date.now(),reason:'updater-start-failed',success:false});
        return;
      }
      let settled = false;
      let drainTimer;
      let payloadBlocked = false;
      const blockedMarker = 'REMCP_WINDOWS_PAYLOAD_BLOCKED';
      // Each pipe is an independent stream. Scan the full incoming chunk
      // before retaining only enough overlap to detect a split marker.
      const forward = () => {
        let tail = '';
        return chunk => {
          const text = String(chunk);
          const combined = tail + text;
          if (combined.includes(blockedMarker)) payloadBlocked = true;
          tail = combined.slice(-(blockedMarker.length - 1));
          const line = text.trim();
          if (line) console.error(`remcp update: ${line}`);
        };
      };
      child.stdout?.on('data', forward());
      child.stderr?.on('data', forward());
      function settle() {
        if (settled) return false;
        settled = true;
        clearTimeout(drainTimer);
        updateInFlight = false;
        return true;
      }
      function holdBlockedPayload() {
        if (process.platform !== 'win32' || !payloadBlocked) return false;
        heldTarget = availabilityKey;
        try { holdRecoveryTarget(availabilityKey); } catch {}
        console.error('ReMCP replacement payload was blocked or incomplete; automatic retries for this exact release are held.');
        queueEvent({event:'agent_update',at:Date.now(),reason:'payload-blocked',success:false});
        return true;
      }
      // Node emits exit before stdout/stderr have necessarily drained. In
      // particular, do not hand off a Windows agent before reading the
      // installer's final blocked-payload marker. A descendant can inherit a
      // pipe indefinitely; in that case keep the live agent and retry later.
      child.on('exit', () => {
        if (settled) return;
        drainTimer = setTimeout(() => {
          if (!settle() || holdBlockedPayload()) return;
          console.error('ReMCP updater output did not close; keeping the live agent until the next eligible retry.');
          queueEvent({event:'agent_update',at:Date.now(),reason:'updater-output-incomplete',success:false});
        }, UPDATER_OUTPUT_DRAIN_MS);
        drainTimer.unref?.();
      });
      child.on('close', code => {
        if (!settle() || holdBlockedPayload()) return;
        // The updater installs the packages and then restarts the service this agent runs in, so it is
        // routinely killed by that restart and exits with a signal (`code` is null). That is success,
        // not failure: the installed version is the proof. Without this check the agent kept
        // reinstalling every few seconds — each cycle taking the device offline and making every tool
        // call in that window fail in 1-3 ms ("Device is offline").
        const targetVersion = String(target).split('@').pop();
        const installedNow = globalInstalledVersion();
        const installedTarget = isRuntimeSpecFor(PACKAGE_NAME, `${PACKAGE_NAME}@${installedNow}`) &&
          targetVersion && !isNewer(targetVersion, installedNow);
        if (code !== 0 && !installedTarget) {
          console.error(`remcp update exited with ${code}; keeping ${VERSION} and retrying after the cooldown.`);
          queueEvent({event:'agent_update',at:Date.now(),reason:'updater-install-failed',success:false});
          return;
        }
        if (code !== 0) {
          console.error(`remcp update was terminated (${code}) after installing ${installedNow}; applying it.`);
        }
        const installedCli = installedUpdateEntry(resolveCli());
        if (!installedCli) {
          console.error('ReMCP replacement CLI is unavailable after update; protection may have blocked it. Keeping the recovery beacon online.');
          queueEvent({event:'agent_update',at:Date.now(),reason:'replacement-unavailable',success:false});
          return;
        }
        // A successful exit alone does not prove the advertised client was installed.
        if (!installedTarget) {
          console.error('ReMCP updater exited without installing the advertised client version; keeping the live agent.');
          queueEvent({event:'agent_update',at:Date.now(),reason:'updater-install-failed',success:false});
          return;
        }
        void restartToApplyUpdate(installedCli, stop, onStopRequested, restartRuntime, isStopping);
      });
      child.on('error', error => {
        if (!settle()) return;
        console.error(`remcp update could not start: ${error.message}`);
        queueEvent({event:'agent_update',at:Date.now(),reason:'updater-start-failed',success:false});
      });
      child.unref();
    } catch (error) {
      // Update discovery must never take the agent offline, but swallowing the exception made FNM/
      // launchd failures impossible to diagnose. Log only when the reason changes or every 30 min.
      const message = error instanceof Error ? error.message : String(error);
      const now = Date.now();
      if (message !== lastUpdateCheckError || now - lastUpdateCheckErrorAt >= UPDATE_RETRY_COOLDOWN_MS) {
        console.error(`ReMCP auto-update check failed: ${message}`);
        lastUpdateCheckError = message;
        lastUpdateCheckErrorAt = now;
      }
      queueEvent({ event:'agent_update', at:now, reason:'check-failed', success:false, errorClass:error?.name || 'Error' });
    }
  }
  return { checkForUpdate, clearPostConnectUpdateChecks, schedulePostConnectUpdateChecks };
}
