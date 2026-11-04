import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { VERSION } from './version.mjs';
import { fetchUpdateManifest } from './fetch-update-manifest.mjs';
import { globalCliEntry, globalInstalledVersion, isNewer, restartToApplyUpdate, updateDecision, updateInvocationArgs } from './agent-update.mjs';

// Poll releases while connected too: relying on reconnect alone can leave a
// healthy long-lived agent stale for six hours after deployment.
export const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const UPDATE_CHECK_TIMEOUT_MS = 12000;
// A flapping relay must not trigger update discovery on every successful reconnect.
const UPDATE_CHECK_RECONNECT_GAP_MS = 30000;
const POST_CONNECT_UPDATE_RECHECK_DELAYS_MS = Object.freeze([60_000, 5 * 60_000, 15 * 60_000]);
const POST_CONNECT_UPDATE_RECHECK_JITTER_MS = 30_000;
const UPDATE_RETRY_COOLDOWN_MS = 30 * 60 * 1000;

export function createAgentUpdateMonitor({ options, serverUrl, queueEvent, getRuntimeState, onStopRequested, restartRuntime, isStopping, stop, resolveCli = globalCliEntry }) {
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
      const cli = resolveCli();
      if (!cli || !existsSync(cli)) {
        if (announce) console.error(`ReMCP ${target} is available; run: remcp update`);
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
      const updateArgs = updateInvocationArgs(decision, options.trustRuntime === true);
      const child = spawn(process.execPath, [cli, ...updateArgs], {
        detached: true,
        windowsHide: true,
        // The updater's own output is the only record of why an install failed, so it is piped back
        // into this agent's log instead of being discarded.
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });
      const forward = chunk => {
        const line = String(chunk).trim();
        if (line) console.error(`remcp update: ${line}`);
      };
      child.stdout?.on('data', forward);
      child.stderr?.on('data', forward);
      child.on('exit', code => {
        updateInFlight = false;
        // The updater installs the packages and then restarts the service this agent runs in, so it is
        // routinely killed by that restart and exits with a signal (`code` is null). That is success,
        // not failure: the installed version is the proof. Without this check the agent kept
        // reinstalling every few seconds — each cycle taking the device offline and making every tool
        // call in that window fail in 1-3 ms ("Device is offline").
        const targetVersion = String(target).split('@').pop();
        const installedNow = globalInstalledVersion();
        const installedTarget = installedNow && targetVersion && !isNewer(targetVersion, installedNow);
        if (code !== 0 && !installedTarget) {
          console.error(`remcp update exited with ${code}; keeping ${VERSION} and retrying after the cooldown.`);
          return;
        }
        if (code !== 0) {
          console.error(`remcp update was terminated (${code}) after installing ${installedNow}; applying it.`);
        }
        void restartToApplyUpdate(cli, stop, onStopRequested, restartRuntime, isStopping);
      });
      child.on('error', error => {
        updateInFlight = false;
        console.error(`remcp update could not start: ${error.message}`);
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
