import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { allExtendedTools } from '../src/extended/catalog.mjs';
import { boundedComputerSnapshot, computerSnapshot, mapOcrBoxToDesktop } from '../src/extended/desktop.mjs';
import { findOcrText, ocrImage, parseTesseractTsv } from '../src/extended/ocr.mjs';

const TSV = [
  'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
  '5\t1\t1\t1\t1\t1\t10\t20\t50\t20\t96.5\tHello',
  '5\t1\t1\t1\t1\t2\t70\t20\t55\t20\t94.5\tWorld',
  '5\t1\t1\t1\t2\t1\t12\t60\t60\t22\t88.0\tSettings',
].join('\n');

test('Tesseract TSV is normalized into bounded words and grouped line boxes', () => {
  const parsed = parseTesseractTsv(TSV, 10);
  assert.equal(parsed.totalWords, 3);
  assert.equal(parsed.words.length, 3);
  assert.equal(parsed.lines.length, 2);
  assert.deepEqual(parsed.lines[0], {
    text: 'Hello World',
    confidence: 95.5,
    x: 10,
    y: 20,
    width: 115,
    height: 20,
    words: 2,
  });
  assert.equal(parsed.lines[1].text, 'Settings');
});

test('OCR parser counts all words while bounding the returned word boxes', () => {
  const parsed = parseTesseractTsv(TSV, 2);
  assert.equal(parsed.totalWords, 3);
  assert.equal(parsed.words.length, 2);
  assert.equal(parsed.lines.length, 1);
  assert.equal(parsed.lines[0].text, 'Hello World');
});

test('OCR text targeting prefers a matching line and returns its clickable box', () => {
  const parsed = parseTesseractTsv(TSV, 10);
  const ocr = { available: true, ...parsed };
  assert.deepEqual(findOcrText(ocr, 'hello world'), parsed.lines[0]);
  assert.equal(findOcrText(ocr, 'SETTINGS')?.text, 'Settings');
  assert.equal(findOcrText(ocr, 'missing'), null);
});

test('OCR fails closed when no local backend is available', async () => {
  const oldPath = process.env.PATH;
  const empty = await mkdtemp(path.join(os.tmpdir(), 'remcp-ocr-empty-'));
  try {
    process.env.PATH = empty;
    const result = await ocrImage(Buffer.from('not-an-image'));
    assert.equal(result.available, false);
    assert.match(result.reason, /tesseract is not installed/i);
  } finally {
    process.env.PATH = oldPath;
    await rm(empty, { recursive: true, force: true });
  }
});

test('OCR boxes map from screenshot pixels into HiDPI multi-monitor virtual coordinates', () => {
  const png = Buffer.alloc(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  png.writeUInt32BE(5760, 16);
  png.writeUInt32BE(1800, 20);
  const point = mapOcrBoxToDesktop(
    { x: 2880, y: 800, width: 200, height: 100 },
    { type: 'image', mimeType: 'image/png', data: png.toString('base64') },
    [
      { name: 'left', x: -1440, y: 0, width: 1440, height: 900, scale: 2 },
      { name: 'right', x: 0, y: 0, width: 1440, height: 900, scale: 2 },
    ],
  );
  assert.deepEqual({ x: point.x, y: point.y }, { x: 50, y: 425 });
  assert.equal(point.scale_x, 2);
  assert.equal(point.scale_y, 2);
  assert.deepEqual(point.desktop_origin, [-1440, 0]);
});

test('computer snapshot prunes huge semantic payloads without producing invalid JSON', () => {
  const huge = 'x'.repeat(1200);
  const payload = {
    device: { hostname: 'fixture', platform: 'linux', arch: 'x64' },
    platform: 'linux',
    hostname: 'fixture',
    windows: Array.from({ length: 200 }, (_, index) => ({ id:String(index), title:huge, x:0, y:0, width:100, height:100 })),
    displays: [{ name:'screen', x:0, y:0, width:1920, height:1080 }],
    cursor: { x:1, y:2 },
    ui: { platform:'linux', count:5000, nodes:Array.from({ length:5000 }, (_, index) => ({ id:String(index), role:'button', name:huge })) },
    browser: { target_id:'page', title:'fixture', url:'https://example.test/', count:2000, nodes:Array.from({ length:2000 }, (_, index) => ({ node_id:String(index), name:huge })) },
    ocr: { available:true, backend:'tesseract', text:huge.repeat(80), count:10000, total_words:10000, words:Array.from({ length:10000 }, () => ({ text:huge, x:1, y:1, width:10, height:10 })), lines:Array.from({ length:2000 }, () => ({ text:huge, x:1, y:1, width:10, height:10 })) },
    fallback_chain: {},
    clipboard: { available:true, length:0 },
    errors: [],
  };
  const bounded = boundedComputerSnapshot(payload);
  const rendered = JSON.stringify(bounded);
  assert.doesNotThrow(() => JSON.parse(rendered));
  assert.equal(bounded.snapshot_truncated, true);
  assert.ok(bounded.snapshot_original_bytes > bounded.snapshot_bytes);
  assert.ok(Buffer.byteLength(rendered, 'utf8') <= 800 * 1024);
  assert.ok((bounded.ui?.nodes?.length || 0) < 5000);
  assert.ok((bounded.ocr?.words?.length || 0) < 10000);
});

test('headless Linux computer_snapshot skips desktop probes and returns a stable empty desktop state', { skip: process.platform !== 'linux' }, async () => {
  const previous = new Map([
    ['DISPLAY', process.env.DISPLAY],
    ['WAYLAND_DISPLAY', process.env.WAYLAND_DISPLAY],
    ['XDG_SESSION_TYPE', process.env.XDG_SESSION_TYPE],
  ]);
  delete process.env.DISPLAY;
  delete process.env.WAYLAND_DISPLAY;
  delete process.env.XDG_SESSION_TYPE;
  try {
    const result = await computerSnapshot({
      include_browser:false,
      include_ocr:false,
      include_screenshot:true,
      include_ui:true,
    });
    const snapshot = result.structuredContent || JSON.parse(result.content?.find(part => part.type === 'text')?.text || '{}');
    assert.deepEqual(snapshot.windows, []);
    assert.deepEqual(snapshot.displays, []);
    assert.deepEqual(snapshot.cursor, { x:null, y:null });
    assert.deepEqual(snapshot.clipboard, { available:false, length:0 });
    assert.equal(snapshot.ui?.unavailable, true);
    assert.equal(snapshot.fallback_chain?.accessibility?.requested, true);
    assert.equal(snapshot.fallback_chain?.accessibility?.available, false);
    assert.equal(snapshot.fallback_chain?.ocr?.requested, false);
    assert.equal(snapshot.fallback_chain?.vision_screenshot?.available, false);
    assert.deepEqual(snapshot.errors, []);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('computer snapshot normalizes partial capture failures into schema-stable fields', () => {
  const bounded = boundedComputerSnapshot({
    device: { hostname:'fixture', platform:'darwin', arch:'arm64' },
    platform:'darwin',
    hostname:'fixture',
    active_window:'unavailable',
    windows:'window inventory failed',
    displays:null,
    cursor:'cursor unavailable',
    ui:null,
    clipboard:null,
    errors:[
      'window inventory failed',
      { source:'browser', message:'CDP unavailable' },
    ],
  });
  assert.equal(bounded.active_window, null);
  assert.deepEqual(bounded.windows, []);
  assert.deepEqual(bounded.displays, []);
  assert.deepEqual(bounded.cursor, { x:null, y:null });
  assert.deepEqual(bounded.ui.nodes, []);
  assert.deepEqual(bounded.clipboard, { available:false, length:0 });
  assert.deepEqual(bounded.errors, [
    { source:'snapshot', message:'window inventory failed' },
    { source:'browser', message:'CDP unavailable' },
  ]);
});

test('computer snapshot keeps structured errors when output bounding is required', () => {
  const huge = 'x'.repeat(1_200_000);
  const bounded = boundedComputerSnapshot({
    device: { hostname:'fixture', platform:'linux', arch:'x64' },
    platform:'linux',
    hostname:'fixture',
    active_window:null,
    windows:[],
    displays:[],
    cursor:{ x:null, y:null },
    ui:{ platform:'linux', count:0, nodes:[], semantic_tree:huge },
    clipboard:{ available:false, length:0 },
    errors:[{ source:'windows', message:'temporary failure' }],
  });
  assert.equal(bounded.snapshot_truncated, true);
  assert.deepEqual(bounded.errors, [{ source:'windows', message:'temporary failure' }]);
});

test('computer snapshot/action expose OCR through the compact universal tool surface', () => {
  const tools = allExtendedTools();
  const snapshot = tools.find(tool => tool.name === 'computer_snapshot');
  const action = tools.find(tool => tool.name === 'computer_action');
  assert.ok(snapshot?.inputSchema?.properties?.include_ocr);
  assert.ok(snapshot?.inputSchema?.properties?.ocr_language);
  assert.ok(snapshot?.inputSchema?.properties?.ocr_max_words);
  assert.ok(action?.inputSchema?.properties?.ocr_text);
  assert.ok(action?.inputSchema?.properties?.target?.enum?.includes('ocr'));
  assert.equal(tools.length, 39, 'OCR must not inflate the MCP tool count');
});
