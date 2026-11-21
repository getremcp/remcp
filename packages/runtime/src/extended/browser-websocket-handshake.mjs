// Keep CDP handshake listeners separate from lifetime listeners. An old socket
// must not revive a timed-out connection or affect a newer socket.
const activeSocketCleanup = new WeakMap();
export function disposeCdpWebSocket(socket) {
  if (socket) activeSocketCleanup.get(socket)?.();
}
export function connectCdpWebSocket({
  url, timeoutMs, signal, onConnected, onMessage, onLiveError, onClosed,
}) {
  if (typeof WebSocket !== 'function') {
    throw new Error('This Node.js runtime does not provide WebSocket support');
  }
  if (signal?.aborted) return Promise.reject(new Error('CDP websocket connection cancelled'));
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let pending = true;
    let timer;
    const onSocketMessage = event => onMessage(socket, event);
    const clearLifetime = () => {
      socket.removeEventListener('message', onSocketMessage);
      socket.removeEventListener('error', onSocketError);
      socket.removeEventListener('close', onSocketClose);
      activeSocketCleanup.delete(socket);
    };
    const onSocketError = () => {
      if (!pending) { clearLifetime(); onLiveError(socket); }
    };
    const onSocketClose = () => { clearLifetime(); onClosed(socket); };
    activeSocketCleanup.set(socket, clearLifetime);
    const clearHandshake = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
      socket.removeEventListener('close', onPreOpenClose);
    };
    const fail = error => {
      if (!pending) return;
      pending = false;
      clearHandshake();
      clearLifetime();
      try { socket.close(); } catch {}
      reject(error);
    };
    const onOpen = () => {
      if (!pending) return;
      pending = false;
      clearHandshake();
      onConnected(socket);
      resolve(socket);
    };
    const onError = event => fail(new Error(event?.message || 'CDP websocket error'));
    const onPreOpenClose = () => fail(new Error('CDP websocket closed before opening'));
    const onAbort = () => fail(new Error('CDP websocket connection cancelled'));
    timer = setTimeout(() => fail(new Error('CDP websocket connection timed out')), timeoutMs);
    socket.addEventListener('open', onOpen, { once:true });
    socket.addEventListener('error', onError, { once:true });
    socket.addEventListener('close', onPreOpenClose, { once:true });
    socket.addEventListener('message', onSocketMessage);
    socket.addEventListener('error', onSocketError);
    socket.addEventListener('close', onSocketClose);
    signal?.addEventListener('abort', onAbort, { once:true });
    if (signal?.aborted) onAbort();
  });
}
