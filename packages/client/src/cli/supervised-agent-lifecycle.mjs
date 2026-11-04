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
