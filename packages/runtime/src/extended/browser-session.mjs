import process from 'node:process';
import os from 'node:os';
import path from 'node:path';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { closeSync, constants as fsConstants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { resolveSafePath } from '../util.mjs';
import { preserveInterruptedBrowserSession } from './browser-session-backup.mjs';
import { clamp, commandExists, jsonResult, optionalString, requireEnum, spawnDetached, unavailable } from './common.mjs';


import { MAX_CDP_MESSAGE_BYTES, PRODUCTION_SESSION_IDLE_MS, assertResolvedBrowserUrl, assertResolvedPageUrl, chooseTarget, endpointUrl, ensureBrowserEndpoint, productionBrowserSessions, requestJson, validatedTargetWebSocketUrl } from './browser-endpoint.mjs';

export class CdpSession {
  constructor(url, timeoutMs) {
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = new Map();
    this.observers = new Map();
    this.closed = true;
  }

  async open() {
    if (typeof WebSocket !== 'function') throw new Error('This Node.js runtime does not provide WebSocket support');
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      const timer = setTimeout(() => {
        try { socket.close(); } catch {}
        reject(new Error('CDP websocket connection timed out'));
      }, this.timeoutMs);
      socket.addEventListener('open', () => { clearTimeout(timer); this.socket = socket; this.closed = false; resolve(); }, { once: true });
      socket.addEventListener('error', event => { clearTimeout(timer); try { socket.close(); } catch {}; reject(new Error(event?.message || 'CDP websocket error')); }, { once: true });
      socket.addEventListener('message', event => this.onMessage(event));
      socket.addEventListener('close', () => this.onClose());
    });
    return this;
  }

  onMessage(event) {
    const raw = String(event.data);
    if (Buffer.byteLength(raw, 'utf8') > MAX_CDP_MESSAGE_BYTES) {
      this.close();
      return;
    }
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    const sessionId = String(message.sessionId || '');
    const pendingKey = message.id ? `${sessionId}:${message.id}` : '';
    if (message.id && this.pending.has(pendingKey)) {
      const pending = this.pending.get(pendingKey);
      this.pending.delete(pendingKey);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(message.result || {});
      return;
    }
    const observers = this.observers.get(message.method);
    if (observers) {
      for (const observer of [...observers]) {
        try { observer(message.params || {}, sessionId); } catch {}
      }
    }
    const listeners = this.waiters.get(message.method);
    if (!listeners) return;
    this.waiters.delete(message.method);
    for (const listener of listeners) {
      clearTimeout(listener.timer);
      listener.resolve(message.params || {});
    }
  }

  onClose() {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('CDP websocket closed'));
    }
    this.pending.clear();
    for (const listeners of this.waiters.values()) {
      for (const listener of listeners) {
        clearTimeout(listener.timer);
        listener.reject(new Error('CDP websocket closed'));
      }
    }
    this.waiters.clear();
    this.observers.clear();
  }

  observe(method, callback) {
    const listeners = this.observers.get(method) || new Set();
    listeners.add(callback);
    this.observers.set(method, listeners);
    return () => {
      const current = this.observers.get(method);
      if (!current) return;
      current.delete(callback);
      if (!current.size) this.observers.delete(method);
    };
  }

  send(method, params = {}, sessionId = '', timeoutMs = this.timeoutMs) {
    if (this.closed || !this.socket || this.socket.readyState !== 1) {
      return Promise.reject(new Error('CDP websocket is not open'));
    }
    const id = this.nextId++;
    const key = `${sessionId}:${id}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(key, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  waitFor(method, timeoutMs = this.timeoutMs) {
    return new Promise((resolve, reject) => {
      const listeners = this.waiters.get(method) || [];
      const listener = { resolve, reject, timer: null };
      listener.timer = setTimeout(() => {
        const current = this.waiters.get(method) || [];
        const next = current.filter(item => item !== listener);
        if (next.length) this.waiters.set(method, next); else this.waiters.delete(method);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      listeners.push(listener);
      this.waiters.set(method, listeners);
    });
  }

  close() {
    if (this.closed) return;
    try { this.socket?.close(); } catch {}
    this.onClose();
  }
}

export async function installBrowserRequestGuard(session, { closeRootTarget = async () => {} } = {}) {
  const guardedSessions = new Set();
  const childSetup = new Map();
  const enableSession = async (sessionId, { autoAttach = false } = {}) => {
    if (guardedSessions.has(sessionId)) return;
    try {
      await session.send('Network.enable', {}, sessionId, 2000);
      await session.send('Network.setBlockedURLs', { urls:['ws://*', 'wss://*'] }, sessionId, 2000);
      await session.send('Fetch.enable', { patterns:[{ urlPattern:'*' }] }, sessionId, 2000);
      if (autoAttach) await session.send('Target.setAutoAttach', { autoAttach:true, waitForDebuggerOnStart:true, flatten:true }, sessionId, 2000);
      guardedSessions.add(sessionId);
    } catch (error) {
      await session.send('Fetch.disable', {}, sessionId, 1000).catch(() => {});
      throw error;
    }
  };
  const guardChild = params => {
    const childSessionId = String(params?.sessionId || '');
    if (!childSessionId) return Promise.resolve();
    if (childSetup.has(childSessionId)) return childSetup.get(childSessionId);
    const setup = (async () => {
      try {
        await enableSession(childSessionId, { autoAttach:process.env.NODE_ENV === 'production' });
        await session.send('Runtime.runIfWaitingForDebugger', {}, childSessionId, 2000);
      } catch (error) {
        const targetId = params?.targetInfo?.targetId;
        let closed = false;
        if (targetId) {
          try {
            await session.send('Target.closeTarget', { targetId }, '', 2000);
            closed = true;
          } catch {}
        }
        if (!closed) throw new Error(`Browser child guard failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
    childSetup.set(childSessionId, setup);
    return setup;
  };
  const removePaused = session.observe('Fetch.requestPaused', (params, eventSessionId) => {
    const requestId = params?.requestId;
    const requestUrl = params?.request?.url || '';
    void (async () => {
      let allowed = requestUrl === 'about:blank';
      if (!allowed) {
        try { await assertResolvedBrowserUrl(requestUrl, 'browser request'); allowed = true; }
        catch {}
      }
      if (!requestId) return;
      try {
        if (allowed) await session.send('Fetch.continueRequest', { requestId }, eventSessionId);
        else await session.send('Fetch.failRequest', { requestId, errorReason:'BlockedByClient' }, eventSessionId);
      } catch {}
    })();
  });
  const removeAttached = session.observe('Target.attachedToTarget', params => {
    void guardChild(params).catch(async () => {
      await closeRootTarget().catch(() => {});
      session.close();
    });
  });
  await enableSession('');
  if (process.env.NODE_ENV === 'production') {
    await session.send('Target.setAutoAttach', { autoAttach:true, waitForDebuggerOnStart:true, flatten:true }, '', 2000);
    let existing;
    try {
      existing = await session.send('Target.getTargets', {}, '', 2000);
    } catch (error) {
      throw new Error(`Could not enumerate browser child targets safely: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const targetInfo of existing.targetInfos || []) {
      if (!['worker', 'service_worker', 'shared_worker', 'iframe', 'webview'].includes(targetInfo.type)) continue;
      const attached = await session.send('Target.attachToTarget', { targetId:targetInfo.targetId, flatten:true }, '', 2000).catch(async error => {
        await session.send('Target.closeTarget', { targetId:targetInfo.targetId }, '', 2000).catch(() => {});
        throw new Error(`Could not attach browser child target safely: ${error instanceof Error ? error.message : String(error)}`);
      });
      if (attached?.sessionId) await guardChild({ sessionId:attached.sessionId, targetInfo });
      else {
        await session.send('Target.closeTarget', { targetId:targetInfo.targetId }, '', 2000).catch(() => {});
        throw new Error('Browser child target did not expose a guard session');
      }
    }
  }
  return () => {
    childSetup.clear();
    removePaused();
    removeAttached();
  };
}

export async function closeBrowserTarget(endpoint, targetId) {
  if (!targetId) return false;
  try {
    const base = endpoint instanceof URL ? endpoint.href : endpoint;
    await requestJson(`/json/close/${encodeURIComponent(String(targetId))}`, base, { timeout_ms:2000 });
    return true;
  } catch {
    return false;
  }
}

export function productionSessionKey(endpoint, target) {
  return `${endpoint.origin}|${String(target.id)}`;
}

// A target returned by browser_tabs is already bound to a validated CDP
// WebSocket. Reuse its guarded live session for subsequent exact-ID actions
// instead of rediscovering every unrelated Chrome tab on each keypress/click.
export function findGuardedCachedTarget(args, endpoint) {
  if (process.env.NODE_ENV !== 'production') return null;
  const id = optionalString(args?.target_id || args?.targetId);
  if (!id || args?.title || args?.url_contains || args?.urlContains) return null;
  const key = endpoint.origin + '|' + id;
  const record = productionBrowserSessions.get(key);
  if (!record?.guardInstalled || !record.target || record.targetId !== id
      || record.target.id !== id || record.session?.closed
      || record.session?.socket?.readyState !== 1) return null;
  try {
    if (validatedTargetWebSocketUrl(record.target, endpoint) !== record.session.url) return null;
  } catch { return null; }
  return { key, record, target:record.target };
}

export function closeProductionSession(key, record) {
  if (!record) return;
  if (record.timer) clearTimeout(record.timer);
  record.removeGuard();
  if (record.ownedTarget && record.targetId) {
    record.session.send('Target.closeTarget', { targetId:record.targetId }, '', 2000).catch(() => {});
    if (record.endpoint) void closeBrowserTarget(record.endpoint, record.targetId);
  }
  record.session.send('Fetch.disable').catch(() => {});
  record.session.close();
  if (productionBrowserSessions.get(key) === record) productionBrowserSessions.delete(key);
}

export function retainProductionSession(key, session, removeGuard, targetId, endpoint, ownedTarget = false, target = null) {
  const existing = productionBrowserSessions.get(key);
  if (existing) closeProductionSession(key, existing);
  const record = { session, removeGuard, targetId, endpoint, ownedTarget, target, guardInstalled:true, timer:null };
  productionBrowserSessions.set(key, record);
  const schedule = () => {
    if (record.timer) clearTimeout(record.timer);
    record.timer = setTimeout(() => closeProductionSession(key, record), PRODUCTION_SESSION_IDLE_MS);
    record.timer.unref?.();
  };
  record.schedule = schedule;
  schedule();
  return record;
}

export async function createGuardedNewTab(url, args) {
  await ensureBrowserEndpoint(args.endpoint);
  const created = await requestJson('/json/new', args.endpoint, { method:'PUT', timeout_ms:args.timeout_ms });
  if (!created?.id) throw new Error('Browser did not return a new page target');
  const endpoint = endpointUrl(args.endpoint);
  let target;
  try {
    target = { ...created, webSocketDebuggerUrl: validatedTargetWebSocketUrl(created, endpoint) };
  } catch (error) {
    await closeBrowserTarget(endpoint, created.id);
    throw error;
  }
  let session;
  try {
    session = await new CdpSession(target.webSocketDebuggerUrl, clamp(args.timeout_ms, 10_000, 100, 120_000)).open();
  } catch (error) {
    await closeBrowserTarget(endpoint, target.id);
    throw error;
  }
  let removeGuard = () => {};
  let productionRecord = null;
  let productionKey = '';
  let operationFailed = false;
  try {
    removeGuard = await installBrowserRequestGuard(session, { closeRootTarget:() => closeBrowserTarget(endpoint, target.id) });
    if (process.env.NODE_ENV === 'production') {
      productionKey = productionSessionKey(endpoint, target);
      productionRecord = retainProductionSession(productionKey, session, removeGuard, target.id, endpoint, true, target);
    }
    await session.send('Page.enable');
    const loaded = session.waitFor('Page.loadEventFired', clamp(args.timeout_ms, 15_000, 500, 120_000)).catch(() => null);
    const navigation = await session.send('Page.navigate', { url });
    if (loaded) await loaded;
    const finalUrl = await evaluate(session, 'location.href');
    await assertResolvedPageUrl(finalUrl);
    return { target, navigation, finalUrl };
  } catch (error) {
    operationFailed = true;
    if (!productionRecord) await closeBrowserTarget(endpoint, target.id);
    throw error;
  } finally {
    if (productionRecord) {
      if (operationFailed) closeProductionSession(productionKey, productionRecord);
      else productionRecord.schedule();
    }
    else {
      removeGuard();
      await session.send('Fetch.disable').catch(() => {});
      session.close();
    }
  }
}

export async function withTarget(args = {}, callback) {
  // chooseTarget already validated this exact discovered URL during this call.
  // The actual page URL is independently checked before and after the action.
  // Avoid a redundant DNS check for the same target metadata.
  const endpoint = endpointUrl(args.endpoint);
  const cached = findGuardedCachedTarget(args, endpoint);
  const target = cached?.target || await chooseTarget(args);
  const production = process.env.NODE_ENV === 'production';
  const key = production ? productionSessionKey(endpoint, target) : '';
  let record = cached?.record || (production ? productionBrowserSessions.get(key) : null);
  if (record?.session?.closed || (record?.session?.socket && record.session.socket.readyState !== 1)) {
    closeProductionSession(key, record);
    record = null;
  }
  let session = record?.session;
  let removeGuard = record?.removeGuard || (() => {});
  if (!session) {
    try {
      session = await new CdpSession(target.webSocketDebuggerUrl, clamp(args.timeout_ms, 10_000, 100, 120_000)).open();
      removeGuard = await installBrowserRequestGuard(session);
      if (production) record = retainProductionSession(key, session, removeGuard, target.id, endpoint, false, target);
    } catch (error) {
      removeGuard();
      if (session) {
        await session.send('Fetch.disable').catch(() => {});
        session.close();
      }
      throw error;
    }
  }
  let operationFailed = false;
  try {
    const currentUrl = await evaluate(session, 'location.href');
    await assertResolvedPageUrl(currentUrl);
    // A reused target's discovery metadata can be old after navigation.
    // Pass the just-verified live URL without an extra CDP round-trip.
    const result = await callback(session, { ...target, url:currentUrl });
    const finalUrl = await evaluate(session, 'location.href').catch(() => { throw new Error('Browser page URL could not be verified after the operation'); });
    await assertResolvedPageUrl(finalUrl);
    return result;
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    if (production && record) {
      if (operationFailed) closeProductionSession(key, record);
      else record.schedule();
    }
    else {
      removeGuard();
      await session.send('Fetch.disable').catch(() => {});
      session.close();
    }
  }
}

export async function evaluate(session, expression, awaitPromise = true) {
  const result = await session.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'JavaScript evaluation failed');
  }
  return result.result?.value;
}

export async function callPageFunction(session, functionDeclaration, args = [], awaitPromise = true) {
  // These declarations are trusted internal browser actions. JSON arguments
  // stay data, never raw page code. One CDP Runtime.evaluate call replaces
  // Runtime.evaluate(globalThis) + Runtime.callFunctionOn (two serial RTTs).
  const expression = '(' + functionDeclaration + ')(...' + JSON.stringify(args) + ')';
  return evaluate(session, expression, awaitPromise);
}
