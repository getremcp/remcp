import { optionalString } from './common.mjs';

export const macWindowTargets = new Map();
export const MAC_WINDOW_TARGET_TTL_MS = 5 * 60 * 1000;

export function rememberMacWindowTarget(row) {
  macWindowTargets.set(row.id, {
    pid:row.pid,
    app:row.app,
    title:row.title,
    x:row.x,
    y:row.y,
    width:row.width,
    height:row.height,
    at:Date.now(),
  });
}

function cachedMacWindowTarget(id) {
  const cached = macWindowTargets.get(id);
  if (!cached) return null;
  if ((Date.now() - cached.at) > MAC_WINDOW_TARGET_TTL_MS) {
    macWindowTargets.delete(id);
    return null;
  }
  return cached;
}

export function macWindowId(pid, windowIndex, generation) {
  const numericPid = Number(pid);
  const numericIndex = Number(windowIndex);
  const numericGeneration = Number(generation);
  if (!Number.isInteger(numericPid) || numericPid <= 0
    || !Number.isInteger(numericIndex) || numericIndex < 0
    || !Number.isInteger(numericGeneration) || numericGeneration <= 0) {
    throw new Error('Could not construct a macOS window id from invalid PID/index/generation');
  }
  return `mac:${numericPid}:w${numericIndex}:g${numericGeneration}`;
}

export function normalizeMacWindowTarget(args = {}, { useWindowId = false } = {}) {
  const explicitPid = Number.isInteger(Number(args.pid)) && Number(args.pid) > 0 ? Number(args.pid) : 0;
  let idPid = 0;
  let windowIndex = null;
  const rawId = useWindowId ? optionalString(args.id) : '';
  let cached = null;
  if (rawId) {
    const match = /^mac:(\d+):w(\d+):g(\d+)$/.exec(rawId);
    if (!match) throw new Error('macOS window id is stale or unsupported; call list_windows again');
    idPid = Number(match[1]);
    windowIndex = Number(match[2]);
    if (explicitPid && explicitPid !== idPid) throw new Error('macOS window id and pid refer to different processes');
    cached = cachedMacWindowTarget(rawId);
  }
  return {
    id:rawId,
    idCached:Boolean(cached),
    pid:idPid || explicitPid,
    windowIndex,
    app:optionalString(args.app) || '',
    title:optionalString(args.window_title || args.windowTitle || args.title) || '',
    expectedApp:cached?.app || '',
    expectedTitle:cached?.title || '',
    expectedBounds:cached ? [cached.x,cached.y,cached.width,cached.height] : null,
  };
}
