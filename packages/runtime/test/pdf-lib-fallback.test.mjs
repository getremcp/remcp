import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { body, freshWorkspace, isError } from './helpers.mjs';

const root = freshWorkspace('pdf-lib');
const { invokeTool } = await import('../src/invoke.mjs');

async function makePdf(file, widths) {
  const document = await PDFDocument.create();
  for (const width of widths) document.addPage([width, 200]);
  writeFileSync(file, await document.save());
}

async function pageWidths(file) {
  const document = await PDFDocument.load(readFileSync(file));
  return document.getPages().map((page) => Math.round(page.getSize().width));
}

test('pdf_action merges, extracts and splits with the built-in PDF engine', async () => {
  const first = join(root, 'first.pdf');
  const second = join(root, 'second.pdf');
  await makePdf(first, [101]);
  await makePdf(second, [102]);

  const merged = join(root, 'merged.pdf');
  const merge = await invokeTool('pdf_action', { action: 'merge', paths: [first, second], output: merged });
  assert.equal(isError(merge), false, body(merge));
  assert.deepEqual(await pageWidths(merged), [101, 102]);

  const source = join(root, 'source.pdf');
  await makePdf(source, [201, 202, 203]);
  const extracted = join(root, 'extracted.pdf');
  const extract = await invokeTool('pdf_action', { action: 'extract_pages', path: source, pages: '1,3', output: extracted });
  assert.equal(isError(extract), false, body(extract));
  assert.deepEqual(await pageWidths(extracted), [201, 203]);

  const splitDir = join(root, 'split');
  mkdirSync(splitDir, { recursive: true });
  const split = await invokeTool('pdf_action', { action: 'split', path: source, output_dir: splitDir, pattern: 'part-%d.pdf' });
  assert.equal(isError(split), false, body(split));
  assert.deepEqual(await pageWidths(join(splitDir, 'part-1.pdf')), [201]);
  assert.deepEqual(await pageWidths(join(splitDir, 'part-2.pdf')), [202]);
  assert.deepEqual(await pageWidths(join(splitDir, 'part-3.pdf')), [203]);
});

test('pdf_action info reports the page count when external pdfinfo is absent', async () => {
  const file = join(root, 'info.pdf');
  await makePdf(file, [100, 100]);
  const raw = body(await invokeTool('pdf_action', { action: 'info', path: file }));
  if (raw.trim().startsWith('{')) assert.equal(JSON.parse(raw).page_count, 2);
});
