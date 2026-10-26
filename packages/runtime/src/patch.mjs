import { splitLines } from './util.mjs';

// Minimal unified-diff applier. Models produce `--- a/file` / `+++ b/file` patches with
// `@@ -start,count +start,count @@` hunks; applying them directly is far more reliable
// than asking a model to re-send whole files or exact blocks.

const HUNK_HEADER = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

// `diff -u` writes `--- a/file<TAB>2026-09-17 12:00:00` and a model may paste that verbatim. The
// tab-separated timestamp is not part of the path, and keeping it made apply_patch create a file
// whose name contained the date while the real target was never touched.
function patchPath(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const [path] = raw.split('\t');
  return path.trim();
}

export function parseUnifiedDiff(patch) {
  const lines = String(patch).replace(/\r\n/g, '\n').split('\n');
  const files = [];
  let current = null;
  let hunk = null;
  for (const line of lines) {
    if (line.startsWith('--- ')) {
      current = { oldPath: patchPath(line.slice(4)), newPath: null, hunks: [] };
      files.push(current);
      hunk = null;
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (current) current.newPath = patchPath(line.slice(4));
      continue;
    }
    const header = line.match(HUNK_HEADER);
    if (header) {
      if (!current) { current = { oldPath: null, newPath: null, hunks: [] }; files.push(current); }
      hunk = {
        oldStart: Number(header[1]),
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      current.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    if (line === '') {
      // A blank line inside a hunk is an empty context line (" " with its trailing space stripped by
      // an editor or a chat client), not a separator. Dropping it shifted every following line and
      // applied the hunk in the wrong place while still reporting success.
      if (hunk.lines.length) hunk.lines.push({ type: ' ', text: '' });
      continue;
    }
    const marker = line[0];
    if (marker === ' ' || marker === '+' || marker === '-') hunk.lines.push({ type: marker, text: line.slice(1) });
  }
  // A diff ends with a newline, and a chat client may strip the trailing space of the last context
  // line, leaving an empty string that is not part of any hunk. The declared line counts say how
  // many lines belong to a hunk, so trailing empty context lines beyond them are dropped.
  for (const file of files) {
    for (const entry of file.hunks) {
      const countOld = lines => lines.filter(line => line.type !== '+').length;
      const countNew = lines => lines.filter(line => line.type !== '-').length;
      while (entry.lines.length > 1) {
        const last = entry.lines[entry.lines.length - 1];
        const overOld = countOld(entry.lines) > entry.oldCount;
        const overNew = countNew(entry.lines) > entry.newCount;
        if (last.type !== ' ' || last.text !== '' || (!overOld && !overNew)) break;
        entry.lines.pop();
      }
    }
  }
  return files.filter(file => file.hunks.length);
}

function normalize(line) {
  return String(line).replace(/[ \t]+/g, ' ').trim();
}

// Find the block a hunk expects, allowing for a few lines of drift and for whitespace
// differences, the same way patch(1) does with fuzz.
function locate(lines, hunk) {
  const expected = hunk.lines.filter(entry => entry.type !== '+').map(entry => entry.text);
  // A hunk with no context and no removals is a pure insertion: `@@ -N,0 +M,K @@` inserts after
  // line N, so the zero-based insertion point is N (and the end of file when N is the last line).
  // Using N-1 here inserted every such hunk one line too early while still reporting success.
  if (!expected.length) {
    // A stale or malformed insertion offset must fail instead of silently
    // appending to EOF (which can corrupt an unrelated section of a file).
    if (!Number.isSafeInteger(hunk.oldStart) || hunk.oldStart < 0 || hunk.oldStart > lines.length) return null;
    return { index: hunk.oldStart, fuzz: 0 };
  }
  const candidates = [];
  const anchor = Math.max(0, hunk.oldStart - 1);
  for (let offset = 0; offset <= 200; offset += 1) {
    for (const index of offset === 0 ? [anchor] : [anchor - offset, anchor + offset]) {
      if (index < 0 || index + expected.length > lines.length) continue;
      const window = lines.slice(index, index + expected.length);
      if (window.every((line, position) => line === expected[position])) candidates.push({ index, fuzz: offset });
      else if (window.every((line, position) => normalize(line) === normalize(expected[position]))) candidates.push({ index, fuzz: offset + 1000 });
    }
    if (candidates.length) break;
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.fuzz - b.fuzz || a.index - b.index);
  return candidates[0];
}

export function applyHunks(content, hunks) {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const endsWithNewline = /\n$/.test(content);
  const lines = splitLines(content);
  const applied = [];
  const failed = [];
  // Apply from the bottom of the file upwards so earlier hunks keep their line numbers.
  const ordered = [...hunks].sort((a, b) => b.oldStart - a.oldStart);
  for (const hunk of ordered) {
    const found = locate(lines, hunk);
    if (!found) { failed.push(hunk); continue; }
    let cursor = found.index;
    const replacement = [];
    for (const entry of hunk.lines) {
      if (entry.type === ' ') { replacement.push(lines[cursor]); cursor += 1; continue; }
      if (entry.type === '-') { cursor += 1; continue; }
      replacement.push(entry.text);
    }
    lines.splice(found.index, cursor - found.index, ...replacement);
    applied.push({ hunk, fuzz: found.fuzz });
  }
  const updated = `${lines.join(eol)}${endsWithNewline && lines.length ? eol : ''}`;
  return { updated, applied, failed };
}
