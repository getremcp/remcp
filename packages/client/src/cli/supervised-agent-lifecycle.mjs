import process from 'node:process';

// Node IPC is present only for a spawn/fork with an 'ipc' stdio channel.
// Windows CreateProcessW under an owned Job Object has no Node IPC at all:
// a missing channel is expected, not evidence that the owner died.
export function guardSupervisorDisconnect(agent, childProcess = process) {
  if (typeof childProcess.send !== 'function') return false;
  let stopping = false;
  const stopOrphan = () => {
    if (stopping) return;
    stopping = true;
    void Promise.resolve().then(() => agent.stop()).then(
      () => childProcess.exit(0),
      () => childProcess.exit(1),
    );
  };
  childProcess.once('disconnect', stopOrphan);
  // A connected IPC channel may have closed while runAgent was starting.
  if (!childProcess.connected) stopOrphan();
  return true;
}


// A managed service may be configured to restart even after a clean exit.
// Once revoked, retain only an idle process; no runtime, relay, or update
// polling survives. Explicit re-pair restarts the service with new credentials.
export function parkRevokedService() {
  console.error('ReMCP managed service is inactive pending explicit re-pair.');
  return setInterval(() => {}, 60 * 60 * 1000);
}
