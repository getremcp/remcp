import path from 'node:path';
import { constants } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { openDirectoryPath, openRegularFile } from './files.mjs';
import { countEvent, recordEvent } from '../telemetry.mjs';
import {
  appendSearchResults,
  createSearchSession,
  finishSearchSession,
  getSearchSession,
  listSearchSessions,
  waitForSearchResults,
} from '../sessions.mjs';
import { clampInteger, displayPath, fail, globToRegExp, looksBinary, requireString, resolveSafePath, splitLines, text } from '../util.mjs';

const SKIP_DIRECTORIES = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', '.cache', '__pycache__', '.venv', 'venv']);
const SKIP_GLOBS = ['!**/node_modules/**', '!**/.git/**', '!**/.hg/**', '!**/.svn/**', '!**/dist/**', '!**/build/**', '!**/.cache/**', '!**/__pycache__/**', '!**/.venv/**', '!**/venv/**'];
const MAX_FALLBACK_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PATTERN_LENGTH = 400;

let ripgrepPath;

function ripgrep() {
  // REMCP_RUNTIME_FORCE_FALLBACK=1 exercises the dependency-free scanner even where
  // ripgrep is installed, which is how CI covers both code paths.
  if (process.env.REMCP_RUNTIME_FORCE_FALLBACK === '1') return null;
  if (ripgrepPath !== undefined) return ripgrepPath;
  try {
    const result = spawnSync('rg', ['--version'], { encoding: 'utf8', windowsHide:true });
    ripgrepPath = !result.error && result.status === 0 ? 'rg' : null;
  } catch { ripgrepPath = null; }
  return ripgrepPath;
}

function normalizePattern(value, literal, ignoreCase) {
  const pattern = requireString(value, 'pattern');
  if (pattern.length > MAX_PATTERN_LENGTH) fail(`pattern must be at most ${MAX_PATTERN_LENGTH} characters`);
  if (literal) return { regex: null, literal: pattern, patternIsLiteral: true };
  // The flag has to be baked into the expression: the fallback scanner has no separate
  // case-folding step, so `ignoreCase` used to be silently ignored without ripgrep.
  try { return { regex: new RegExp(pattern, ignoreCase ? 'gi' : 'g'), literal: null, patternIsLiteral: false }; } catch (error) {
    // Silently downgrading an invalid regular expression to a substring search changes the
    // meaning of the call without telling anyone.
    fail(`pattern is not a valid regular expression (${error instanceof Error ? error.message : String(error)}). Pass literalSearch: true to search for this text literally.`);
  }
}

// "*.js|*.ts" is the documented alternation form; ripgrep needs one -g per glob.
function splitGlobs(value) {
  return String(value || '').split('|').map(part => part.trim()).filter(Boolean);
}

// A file search pattern without any glob metacharacter means "files whose name contains
// this text", which is how callers read `pattern: "auth"`.
function fileNameGlob(pattern) {
  return /[*?[\]{}]/.test(pattern) ? pattern : `*${pattern}*`;
}

function matchLine(line, matcher, ignoreCase) {
  if (matcher.literal) {
    return ignoreCase ? line.toLowerCase().includes(matcher.literal.toLowerCase()) : line.includes(matcher.literal);
  }
  matcher.regex.lastIndex = 0;
  return matcher.regex.test(line);
}

function formatContentResult(file, lineNumber, line, contextLines) {
  const rows = [`${displayPath(file)}:${lineNumber}: ${line}`];
  for (const entry of contextLines) rows.push(`${displayPath(file)}-${entry.number}- ${entry.text}`);
  return rows.join('\n');
}

function rememberSearchWarning(session, warning) {
  if (session.warning) return;
  session.warning = warning instanceof Error ? warning.message : String(warning);
}

function displayRipgrepLine(line, target) {
  if (line === target.anchor) return target.displayPath;
  if (line.startsWith(`${target.anchor}/`)) return `${target.displayPath}${line.slice(target.anchor.length)}`;
  return line;
}

function ripgrepTraversalWarnings(stderr, target) {
  const lines = String(stderr || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length) return null;
  const root = path.resolve(target);
  for (const line of lines) {
    const match = line.match(/^rg: (.*): .* \(os error \d+\)$/);
    if (!match) return null;
    const reported = path.resolve(match[1]);
    const relative = path.relative(root, reported);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  }
  return lines;
}

const SEARCH_READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0);

function onceAsync(callback) {
  let called = false;
  return async () => {
    if (called) return;
    called = true;
    await callback();
  };
}

async function openSearchTarget(absolute) {
  let directory;
  let directoryError;
  try {
    directory = await openDirectoryPath(absolute);
    const info = await directory.handle.stat();
    if (!info.isDirectory()) fail('Search path is not a directory');
    const close = onceAsync(directory.close);
    const anchor = directory.anchor.replace(/^\/proc\/self\/fd\//, `/proc/${process.pid}/fd/`);
    return { kind:'directory', anchor, displayPath:absolute, close };
  } catch (error) {
    directoryError = error;
    if (directory) await directory.close().catch(() => {});
  }
  try {
    const opened = await openRegularFile(absolute, SEARCH_READ_FLAGS);
    const close = onceAsync(opened.close);
    const anchor = process.platform === 'linux' ? `/proc/${process.pid}/fd/${opened.handle.fd}` : absolute;
    return { kind:'file', anchor, displayPath:absolute, handle:opened.handle, info:opened.info, close };
  } catch (error) {
    if (directoryError?.code === 'ENOENT' || error?.code === 'ENOENT') fail(`Search path not found: ${displayPath(absolute)}`);
    throw error;
  }
}

async function walk(node, options, onFile, isRoot = true) {
  if (node.kind === 'file') {
    await onFile(node);
    return;
  }
  let entries;
  try {
    entries = await readdir(node.anchor, { withFileTypes: true });
  } catch (error) {
    if (isRoot) throw error;
    options.onWarning?.(error);
    return;
  }
  for (const entry of entries) {
    if (options.stopped()) return;
    if (!options.includeHidden && entry.name.startsWith('.')) continue;
    const childDisplay = path.join(node.displayPath, entry.name);
    const childAnchor = path.join(node.anchor, entry.name);
    if (entry.isDirectory()) {
      if (options.skipDirectories.has(entry.name)) continue;
      let child;
      try {
        child = await openDirectoryPath(childAnchor);
        const info = await child.handle.stat();
        if (!info.isDirectory()) fail('Filesystem path component is not a directory');
        await walk({ kind:'directory', anchor:child.anchor, displayPath:childDisplay, close:child.close }, options, onFile, false);
      } catch (error) {
        options.onWarning?.(error);
      } finally {
        if (child) await child.close().catch(() => {});
      }
    } else if (entry.isFile()) {
      let child;
      try {
        child = await openRegularFile(childAnchor, SEARCH_READ_FLAGS);
        await onFile({ kind:'file', displayPath:childDisplay, handle:child.handle, info:child.info });
      } catch (error) {
        options.onWarning?.(error);
      } finally {
        if (child) await child.close().catch(() => {});
      }
    }
  }
}

function runRipgrep(session, { target, pattern, searchType, filePattern, ignoreCase, includeHidden, includeIgnored, contextLines, maxResults, patternIsLiteral }) {
  // Flags must come before the `--` separator: anything after it is treated as a path,
  // which silently turned `--hidden` into a search target.
  const args = ['--no-heading', '--color', 'never'];
  const searchTarget = target.anchor;
  if (ignoreCase) args.push('--ignore-case');
  if (includeHidden) args.push('--hidden');
  // includeIgnored must override both our skip globs and ripgrep's own ignore files.
  if (includeIgnored) args.push('--no-ignore');
  else for (const glob of SKIP_GLOBS) args.push('-g', glob);
  for (const glob of splitGlobs(filePattern)) args.push('-g', glob);
  if (searchType === 'files') {
    args.push('--files');
    // Globs are case-sensitive even under --ignore-case, so a case-insensitive file
    // search needs --iglob.
    args.push(ignoreCase ? '--iglob' : '-g', fileNameGlob(pattern));
    args.push('--', searchTarget);
  } else {
    args.push('--line-number', '--with-filename');
    if (patternIsLiteral) args.push('--fixed-strings');
    if (contextLines) args.push('-C', String(contextLines));
    args.push('--', pattern, searchTarget);
  }
  const child = spawn(ripgrep(), args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide:true });
  session.cancel = () => child.kill('SIGTERM');
  let buffer = '';
  let stderr = '';
  let collected = 0;
  let capped = false;
  child.stdout.on('data', chunk => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    const batch = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      batch.push(displayRipgrepLine(line, target));
      collected += 1;
      if (collected >= maxResults) { capped = true; child.kill('SIGTERM'); break; }
    }
    appendSearchResults(session, batch);
  });
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-2000); });
  child.on('error', error => finishSearchSession(session, 'failed', error.message));
  child.on('close', code => {
    if (session.status !== 'running') { finishSearchSession(session, session.status); return; }
    // ripgrep exits 2 both for fatal invocation errors and for partial traversal errors.
    // Descendant OS errors are recoverable: preserve readable matches and surface a warning.
    if (code === 2 && stderr.trim()) {
      const warnings = ripgrepTraversalWarnings(stderr, searchTarget);
      if (!warnings) { finishSearchSession(session, 'failed', stderr.trim().split(/\r?\n/)[0]); return; }
      rememberSearchWarning(session, warnings.length === 1 ? warnings[0] : `${warnings[0]} (+${warnings.length - 1} more)`);
    }
    finishSearchSession(session, capped ? 'capped' : 'completed');
  });
}

async function runFallback(session, { target, matcher, searchType, filePattern, ignoreCase, contextLines, maxResults, includeHidden, includeIgnored }) {
  const fileGlobs = splitGlobs(filePattern).map(globToRegExp);
  const nameGlob = searchType === 'files' ? globToRegExp(fileNameGlob(session.pattern)) : null;
  const nameLiteral = searchType === 'files' && !/[*?[\]{}]/.test(session.pattern) ? session.pattern : null;
  let collected = 0;
  await walk(target, {
    includeHidden,
    skipDirectories: includeIgnored ? new Set() : SKIP_DIRECTORIES,
    stopped: () => session.status !== 'running' || collected >= maxResults,
    onWarning: warning => rememberSearchWarning(session, warning),
  }, async file => {
    if (session.status !== 'running' || collected >= maxResults) return;
    if (fileGlobs.length && !fileGlobs.some(glob => glob.test(path.basename(file.displayPath)))) return;
    if (searchType === 'files') {
      const base = path.basename(file.displayPath);
      const matches = (nameGlob && nameGlob.test(base)) || (nameLiteral && (ignoreCase ? base.toLowerCase().includes(nameLiteral.toLowerCase()) : base.includes(nameLiteral)));
      if (!matches) return;
      collected += 1;
      appendSearchResults(session, [displayPath(file.displayPath)]);
      return;
    }
    if (!file.info.isFile() || file.info.size > MAX_FALLBACK_FILE_BYTES) return;
    const buffer = await file.handle.readFile();
    if (looksBinary(buffer)) return;
    const lines = splitLines(buffer.toString('utf8'));
    for (let index = 0; index < lines.length; index += 1) {
      if (session.status !== 'running' || collected >= maxResults) return;
      if (!matchLine(lines[index], matcher, ignoreCase)) continue;
      const context = [];
      if (contextLines) {
        for (let offset = Math.max(0, index - contextLines); offset <= Math.min(lines.length - 1, index + contextLines); offset += 1) {
          if (offset === index) continue;
          context.push({ number: offset + 1, text: lines[offset] });
        }
      }
      collected += 1;
      appendSearchResults(session, [formatContentResult(file.displayPath, index + 1, lines[index], context)]);
    }
  });
  finishSearchSession(session, session.status === 'running' ? (collected >= maxResults ? 'capped' : 'completed') : session.status);
}

export async function startSearchTool(args) {
  const target = await resolveSafePath(args.path);
  const pattern = requireString(args.pattern, 'pattern');
  const searchType = String(args.searchType || 'content').toLowerCase();
  if (!['content', 'files'].includes(searchType)) fail('searchType must be content or files');
  const filePattern = typeof args.filePattern === 'string' && args.filePattern.trim() ? args.filePattern.trim() : null;
  if (filePattern && path.isAbsolute(filePattern)) fail('filePattern must be a relative glob such as "*.ts"');
  const ignoreCase = args.ignoreCase === true;
  const includeHidden = args.includeHidden === true;
  const includeIgnored = args.includeIgnored === true;
  const contextLines = clampInteger(args.contextLines, 0, 0, 10);
  const maxResults = clampInteger(args.maxResults, 200, 1, 5000);
  const matcher = searchType === 'content' ? normalizePattern(pattern, args.literalSearch === true, ignoreCase) : { regex: null, literal: pattern, patternIsLiteral: false };
  const openedTarget = await openSearchTarget(target);
  const session = createSearchSession({ type: searchType, pattern, path: target, filePattern });
  session.release = openedTarget.close;
  countEvent('searchesStarted');
  recordEvent('session_started', { sessionKind: 'search', success: true });
  const options = { target: openedTarget, pattern, searchType, filePattern, ignoreCase, includeHidden, includeIgnored, contextLines, maxResults, matcher, patternIsLiteral: matcher.patternIsLiteral === true };
  if (ripgrep()) runRipgrep(session, options);
  else void runFallback(session, options).catch(error => finishSearchSession(session, 'failed', error instanceof Error ? error.message : String(error)));
  await waitForSearchResults(session, 1, 800);
  const initial = session.results.slice(0, 50);
  const status = session.error ? `failed: ${session.error}` : session.status;
  return text([
    `searchId: ${session.id} · type: ${searchType} · status: ${status} · results so far: ${session.results.length}`,
    `pattern: ${pattern} · path: ${displayPath(target)}`,
    session.warning ? `warning: ${session.warning}` : '',
    initial.join('\n'),
    session.results.length > initial.length ? `… ${session.results.length - initial.length} more results buffered; use get_more_search_results with searchId ${session.id}` : '',
  ].filter(Boolean).join('\n'));
}

export async function getMoreSearchResultsTool(args) {
  const sessionId = requireString(args.sessionId, 'sessionId');
  const session = getSearchSession(sessionId) || fail(`No search session ${sessionId}`);
  const length = clampInteger(args.length, 100, 1, 1000);
  const offset = Number.isFinite(Number(args.offset)) ? Math.trunc(Number(args.offset)) : 0;
  if (offset >= 0) await waitForSearchResults(session, offset + length, 1000);
  const total = session.results.length;
  let start;
  let end;
  if (offset < 0) {
    start = Math.max(0, total + offset);
    end = total;
  } else {
    start = Math.min(offset, total);
    end = Math.min(start + length, total);
  }
  const status = session.error ? `failed: ${session.error}` : session.status;
  return text([
    `searchId: ${session.id} · status: ${status} · results ${start}-${end} of ${total}`,
    session.warning ? `warning: ${session.warning}` : '',
    session.results.slice(start, end).join('\n'),
  ].filter(Boolean).join('\n'));
}

export async function stopSearchTool(args) {
  const sessionId = requireString(args.sessionId, 'sessionId');
  const session = getSearchSession(sessionId) || fail(`No search session ${sessionId}`);
  if (session.status !== 'running') return text(`Search ${sessionId} already ${session.status} with ${session.results.length} results.`);
  session.status = 'stopped';
  try { session.cancel?.(); } catch {}
  finishSearchSession(session, 'stopped');
  return text(`Stopped search ${sessionId} with ${session.results.length} results buffered.`);
}

export async function listSearchesTool() {
  const sessions = listSearchSessions();
  if (!sessions.length) return text('No active searches.');
  const rows = sessions.map(session => {
    const runtimeMs = (session.finishedAt || Date.now()) - session.startedAt;
    return `${session.id} · ${session.type} · ${session.status} · ${session.results.length} results · ${Math.round(runtimeMs / 1000)}s · ${session.pattern} (${displayPath(session.path)})`;
  });
  return text(rows.join('\n'));
}

export const searchToolHandlers = {
  start_search: startSearchTool,
  get_more_search_results: getMoreSearchResultsTool,
  stop_search: stopSearchTool,
  list_searches: listSearchesTool,
};
