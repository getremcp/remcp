import process from 'node:process';
import { ToolError } from './util.mjs';

export function cleanError(error) {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim().slice(0, 500) || 'unknown error';
}

export function unwrap(value) {
  if (value && typeof value === 'object' && Object.hasOwn(value, 'value')) return unwrap(value.value);
  if (Array.isArray(value)) return value.map(unwrap);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unwrap(item)]));
  return value;
}

export function token(prefix) {
  return `${prefix}_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`.replace(/[^A-Za-z0-9_]/g, '_');
}

export function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ToolError(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
    Promise.resolve(promise).then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}
