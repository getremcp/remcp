import os from 'node:os';
import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { liveConfig, runtimeConfig } from './config.mjs';

export class ToolError extends Error {}

export function fail(message) {
  throw new ToolError(String(message));
}

// Cooperative cancellation for handlers that loop over many items. The MCP layer already rejects
// the call to the client on abort, so the job here is to stop the device-side side effects: a bulk
// read/write/archive that ignored the signal kept mutating files long after the client gave up.
// Long handlers call this between items, so a cancel lands at the next item boundary.
export function throwIfCancelled(signal) {
  if (signal?.aborted) fail('Cancelled by the client; stopped before the next item.');
}

export function expandHome(value) {
  const text = String(value ?? '');
  if (text === '~') return os.homedir();
  if (text.startsWith('~/') || text.startsWith('~\\')) return path.join(os.homedir(), text.slice(2));
  return text;
}

export function requireString(value, field) {
  if (typeof value !== 'string' || !value.trim()) fail(`${field} is required`);
  return value.trim();
}

export function requireInteger(value, field) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) fail(`${field} must be a positive integer`);
  return parsed;
}

export function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

export function resolveInputPath(value, field = 'path') {
  const raw = expandHome(requireString(value, field));
  if (raw.includes('\0')) fail(`${field} contains an invalid character`);
  const absolute = path.resolve(raw);
  if (runtimeConfig.allowedRoots.length && !isInsideAnyRoot(absolute)) {
    fail(`Path is outside the directories this device allows: ${runtimeConfig.allowedRoots.join(', ')}`);
  }
  return absolute;
}

export function isInsideRoot(candidate, root) {
  if (candidate === root) return true;
  // `allowedRoots: ["/"]` is a legitimate way to say "the whole filesystem"; a naive
  // `root + sep` check turns it into "//" and rejects every path.
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return candidate.startsWith(prefix);
}

function isInsideAnyRoot(candidate) {
  return runtimeConfig.allowedRoots.some(root => isInsideRoot(candidate, root));
}

// Resolve symlinks for the deepest path segment that exists, then re-append the
// segments that do not exist yet. A lexical prefix check alone is not enough:
// `<allowed>/link -> /etc` would otherwise pass the allowlist and read /etc.
export async function canonicalizePath(target) {
  let current = path.resolve(target);
  const missing = [];
  for (;;) {
    try {
      const resolved = await realpath(current);
      return missing.length ? path.join(resolved, ...missing) : resolved;
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') return missing.length ? path.join(current, ...missing) : current;
      const parent = path.dirname(current);
      if (parent === current) return missing.length ? path.join(current, ...missing) : current;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

let resolvedRootsPromise;
export async function resolvedAllowedRoots() {
  return resolvedRoots();
}

function resolvedRoots() {
  if (!resolvedRootsPromise) {
    resolvedRootsPromise = Promise.all(runtimeConfig.allowedRoots.map(async root => {
      try { return await realpath(root); } catch { return root; }
    }));
  }
  return resolvedRootsPromise;
}

// Canonical, allowlist-checked path for every file tool. The canonical path is what
// callers must use, so a symlink cannot be swapped between the check and the access.
export async function resolveSafePath(value, field = 'path') {
  const raw = expandHome(requireString(value, field));
  if (raw.includes('\0')) fail(`${field} contains an invalid character`);
  const absolute = path.resolve(raw);
  if (!runtimeConfig.allowedRoots.length) return absolute;

  const leaf = await lstat(absolute).catch(error => {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  });
  if (leaf?.isSymbolicLink()) fail(`Path is a symbolic link: ${absolute}`);

  // Canonicalize both sides before enforcing confinement. This matters on macOS where
  // /var is a symlink to /private/var: a safe path returned by an earlier canonicalization
  // must not be rejected merely because its lexical prefix differs from the configured root.
  // Symlink escapes remain blocked because the final canonical target must still be inside
  // one of the canonical allowed roots.
  const canonical = await canonicalizePath(absolute);
  const roots = await resolvedRoots();
  if (!roots.some(root => isInsideRoot(canonical, root))) {
    fail(`Path resolves outside the directories this device allows: ${runtimeConfig.allowedRoots.join(', ')}`);
  }
  return canonical;
}

export function displayPath(absolute) {
  const home = os.homedir();
  return absolute.startsWith(home + path.sep) ? `~/${absolute.slice(home.length + 1)}` : absolute;
}

// The transport measures the serialised frame, not the raw string: a control character becomes six
// bytes once JSON-escaped, so an ANSI-heavy command output could pass this check and still exceed
// the stdio/relay frame limit, which closes the connection and restarts the runtime.
function frameBytes(text) {
  return Buffer.byteLength(JSON.stringify(String(text)), 'utf8');
}

export function fitsOutput(text, maxBytes) {
  const limit = maxBytes || liveConfig('maxOutputBytes');
  const value = String(text);
  return Buffer.byteLength(value, 'utf8') <= limit && frameBytes(value) <= limit;
}

export function truncate(text, maxBytes) {
  const limit = maxBytes || liveConfig('maxOutputBytes');
  const value = String(text);
  if (fitsOutput(value, limit)) return value;
  // Shrink until the escaped frame fits, so the escaped size is what the caller gets is bounded.
  let size = Math.min(Buffer.byteLength(value, 'utf8'), limit);
  let rendered = '';
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const buffer = Buffer.from(value, 'utf8');
    const head = buffer.subarray(0, Math.max(0, Math.floor(size * 0.7))).toString('utf8');
    const tail = buffer.subarray(Math.max(0, buffer.length - Math.floor(size * 0.2))).toString('utf8');
    rendered = `${head}\n… output truncated (${buffer.length} bytes, limit ${limit}) …\n${tail}`;
    if (frameBytes(rendered) <= limit) return rendered;
    size = Math.floor(size * 0.6);
    if (size < 512) break;
  }
  const buffer = Buffer.from(value, 'utf8');
  return `${buffer.subarray(0, 256).toString('utf8')}\n… output truncated (${buffer.length} bytes, limit ${limit}) …`;
}

// structuredContent mirrors the text so a client can rely on the declared outputSchema, but the
// same string twice doubles the message: above this size the mirror becomes a summary and the full
// result stays in content, which is the primary channel every client reads.
const STRUCTURED_MIRROR_LIMIT_BYTES = 256 * 1024;

export function text(value, isError = false) {
  const body = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const rendered = truncate(body);
  const size = Buffer.byteLength(rendered, 'utf8');
  const mirror = size <= STRUCTURED_MIRROR_LIMIT_BYTES
    ? rendered
    : `${rendered.slice(0, 512)}… (${size} bytes total; the full result is in the text content)`;
  return { content: [{ type: 'text', text: rendered }], structuredContent: { text: mirror }, ...(isError ? { isError: true } : {}) };
}

export function structured(value, fallbackText = null) {
  const serialized = JSON.stringify(value);
  const bytes = Buffer.byteLength(serialized ?? 'null', 'utf8');
  const rendered = truncate(fallbackText == null ? JSON.stringify(value, null, 2) : String(fallbackText));
  let structuredContent;
  if (bytes > STRUCTURED_MIRROR_LIMIT_BYTES) {
    structuredContent = { truncated: true, bytes, preview: rendered.slice(0, 2048) };
  } else if (value && typeof value === 'object' && !Array.isArray(value)) {
    structuredContent = value;
  } else {
    structuredContent = { data: value };
  }
  return { content: [{ type: 'text', text: rendered }], structuredContent };
}

export function image(data, mimeType) {
  return { type: 'image', data, mimeType };
}

export function multi(parts) {
  const summary = parts.find(part => part.type === 'text')?.text ?? '';
  return { content: parts, structuredContent: { text: summary } };
}

export function splitLines(value) {
  const normalized = String(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (normalized === '') return [];
  const lines = normalized.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function looksBinary(buffer) {
  return buffer.subarray(0, 8000).includes(0);
}

// Text decoding that keeps Windows-authored files readable: UTF-16LE/BE with a BOM, and
// UTF-8 with a BOM, are decoded rather than reported as binary.
export function decodeText(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: buffer.subarray(2).toString('utf16le'), encoding: 'utf16le' };
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2));
    swapped.swap16();
    return { text: swapped.toString('utf16le'), encoding: 'utf16be' };
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: buffer.subarray(3).toString('utf8'), encoding: 'utf8bom' };
  }
  return { text: buffer.toString('utf8'), encoding: 'utf8' };
}

export function pageLines(lines, offset, length) {
  const total = lines.length;
  const requested = Math.trunc(offset || 0);
  if (requested < 0) {
    const count = Math.min(Math.abs(requested), total);
    return { start: total - count, end: total, slice: lines.slice(total - count) };
  }
  const start = Math.min(requested, total);
  const end = Math.min(start + Math.max(1, Math.trunc(length || liveConfig('maxReadLines'))), total);
  return { start, end, slice: lines.slice(start, end) };
}

// Glob translation for the file tools. `?` never crosses a directory separator, `[abc]` and
// `{a,b}` are honoured, and `**/` may match no directory at all so `**/*` also matches a file in
// the root. The previous version escaped class and brace syntax, so those patterns silently
// matched nothing.
export function globToRegExp(pattern) {
  const source = String(pattern);
  let out = '';
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '*') {
      if (source[index + 1] === '*') {
        if (source[index + 2] === '/') { out += '(?:.*/)?'; index += 2; }
        else { out += '.*'; index += 1; }
      } else out += '[^/]*';
      continue;
    }
    if (char === '?') { out += '[^/]'; continue; }
    if (char === '[') {
      const close = source.indexOf(']', index + 1);
      if (close > index + 1 && close - index <= 64) {
        let body = source.slice(index + 1, close);
        const negated = body.startsWith('!') || body.startsWith('^');
        if (negated) body = body.slice(1);
        body = body.replace(/\\/g, '\\\\').replace(/\]/g, '\\]').replace(/\^/g, '\\^');
        const candidate = `[${negated ? '^/' : ''}${body}]`;
        // A class like [z-a] is not a valid range: the pattern falls back to a literal match instead
        // of throwing out of the tool, because a user pattern must never break a call.
        try {
          new RegExp(candidate);
          out += candidate;
        } catch {
          out += `\\${char}`;
        }
        index = close;
        continue;
      }
      out += '\\[';
      continue;
    }
    if (char === '{') {
      const close = source.indexOf('}', index + 1);
      if (close > index + 1) {
        const alternatives = source.slice(index + 1, close).split(',').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        out += `(?:${alternatives.join('|')})`;
        index = close;
        continue;
      }
      out += '\\{';
      continue;
    }
    out += /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`^${out}$`);
}
