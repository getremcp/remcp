import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshWorkspace } from './helpers.mjs';

const root = freshWorkspace('computer-documents');
const has = command => { const r = spawnSync(command, ['--version'], { stdio: 'ignore' }); return !r.error; };
const zipReady = has('zip') && has('unzip');
const ooxmlReady = process.platform === 'win32' || zipReady;

function writeTree(base, files) {
  for (const [relative, value] of Object.entries(files)) {
    const target = join(base, ...relative.split('/'));
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, value);
  }
}

function zipTree(base, output) {
  execFileSync('zip', ['-qr', output, '.'], { cwd: base });
}

test('runtime advertises the complete P3 document toolset when its OOXML backend is available', { skip: !ooxmlReady }, async () => {
  const { advertisedExtendedTools } = await import('../src/extended/catalog.mjs');
  const names = new Set((await advertisedExtendedTools()).map(tool => tool.name));
  for (const name of ['read_document','edit_spreadsheet','edit_document','pdf_action']) {
    assert.ok(names.has(name), `${process.platform} should advertise ${name}`);
  }
});

test('XLSX can be created from scratch through edit_spreadsheet', { skip: !ooxmlReady }, async () => {
  const xlsx = join(root, 'created-book.xlsx');
  const { editSpreadsheet, readDocument } = await import('../src/extended/documents.mjs');
  const created = await editSpreadsheet({
    path: xlsx,
    create: true,
    sheet: 'Data',
    edits: [
      { cell: 'A1', value: 'Name' },
      { cell: 'B1', value: 'Amount' },
      { range: 'A2:B3', values: [['Alpha', 12], ['Beta', 30]] },
      { cell: 'C2', formula: '=SUM(B2:B3)' },
    ],
  });
  const summary = JSON.parse(created.content[0].text);
  assert.equal(summary.path, xlsx);
  assert.equal(summary.sheet, 'Data');
  assert.equal(summary.created, true);

  const read = await readDocument({ path: xlsx, sheet: 'Data' });
  const parsed = JSON.parse(read.content[0].text);
  assert.equal(parsed.cells.find(cell => cell.ref === 'A1')?.value, 'Name');
  assert.equal(parsed.cells.find(cell => cell.ref === 'B3')?.value, 30);
  assert.equal(parsed.cells.find(cell => cell.ref === 'C2')?.formula, 'SUM(B2:B3)');

  await assert.rejects(
    () => editSpreadsheet({ path: xlsx, create:true, edits:[{ cell:'A1', value:'overwrite' }] }),
    /already exists/i,
  );
  await assert.rejects(
    () => editSpreadsheet({ path: join(root,'bad-sheet.xlsx'), create:true, sheet:'bad/name', edits:[{ cell:'A1', value:'x' }] }),
    /characters Excel does not allow/i,
  );
  await assert.rejects(
    () => editSpreadsheet({ path: join(root,'create-with-output.xlsx'), create:true, output:join(root,'other.xlsx'), edits:[{ cell:'A1', value:'x' }] }),
    /output is not used with create=true/i,
  );
});

test('DOCX can be created from scratch through edit_document', { skip: !ooxmlReady }, async () => {
  const docx = join(root, 'created-note.docx');
  const { editDocument, readDocument } = await import('../src/extended/documents.mjs');
  const created = await editDocument({
    path: docx,
    create: true,
    operations: [
      { action: 'append_paragraph', text: 'Created by ReMCP' },
      { action: 'prepend_paragraph', text: 'Document title' },
      { action: 'append_paragraph', text: 'Final paragraph' },
    ],
  });
  const summary = JSON.parse(created.content[0].text);
  assert.equal(summary.path, docx);
  assert.equal(summary.created, true);

  const read = await readDocument({ path: docx });
  assert.match(read.content[0].text, /Document title/);
  assert.match(read.content[0].text, /Created by ReMCP/);
  assert.match(read.content[0].text, /Final paragraph/);

  await assert.rejects(
    () => editDocument({ path: docx, create:true, operations:[{ action:'append_paragraph', text:'overwrite' }] }),
    /already exists/i,
  );
  await assert.rejects(
    () => editDocument({ path: join(root,'create-with-output.docx'), create:true, output:join(root,'other.docx'), operations:[{ action:'append_paragraph', text:'x' }] }),
    /output is not used with create=true/i,
  );
});

test('XLSX edit and read round-trip without a bundled spreadsheet dependency', { skip: !zipReady }, async () => {
  const sourceDir = join(root, 'xlsx-src');
  mkdirSync(sourceDir, { recursive: true });
  writeTree(sourceDir, {
    'xl/workbook.xml': '<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>old</t></is></c></row></sheetData></worksheet>',
  });
  const xlsx = join(root, 'book.xlsx');
  zipTree(sourceDir, xlsx);
  const { editSpreadsheet, readDocument } = await import('../src/extended/documents.mjs');
  const edited = await editSpreadsheet({ path: xlsx, edits: [
    { cell: 'A1', value: 'new' },
    { cell: 'B2', value: 42 },
    { range: 'C1:D2', values: [['c1','d1'], [3,4]] },
    { cell: 'E1', formula: '=SUM(C2:D2)' },
  ] });
  assert.equal(edited.isError, undefined);
  assert.equal(JSON.parse(edited.content[0].text).created, false);
  const read = await readDocument({ path: xlsx, sheet: 'Sheet1' });
  const parsed = JSON.parse(read.content[0].text);
  assert.deepEqual(parsed.cells.find(cell => cell.ref === 'A1')?.value, 'new');
  assert.equal(parsed.cells.find(cell => cell.ref === 'B2')?.value, 42);
  assert.equal(parsed.cells.find(cell => cell.ref === 'C1')?.value, 'c1');
  assert.equal(parsed.cells.find(cell => cell.ref === 'D2')?.value, 4);
  assert.equal(parsed.cells.find(cell => cell.ref === 'E1')?.formula, 'SUM(C2:D2)');
});

test('DOCX edit and read round-trip preserves plain paragraph text', { skip: !zipReady }, async () => {
  const sourceDir = join(root, 'docx-src');
  mkdirSync(sourceDir, { recursive: true });
  writeTree(sourceDir, {
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello world</w:t></w:r></w:p></w:body></w:document>',
  });
  const docx = join(root, 'note.docx');
  zipTree(sourceDir, docx);
  const { editDocument, readDocument } = await import('../src/extended/documents.mjs');
  const edited = await editDocument({ path: docx, operations: [
    { action: 'replace', search: 'world', replacement: 'ReMCP' },
    { action: 'prepend_paragraph', text: 'First paragraph' },
    { action: 'append_paragraph', text: 'Second paragraph' },
    { action: 'insert_paragraph_after', search: 'Hello ReMCP', text: 'Inserted paragraph' },
    { action: 'delete_paragraph', search: 'Second paragraph' },
  ] });
  assert.equal(JSON.parse(edited.content[0].text).created, false);
  const read = await readDocument({ path: docx });
  assert.match(read.content[0].text, /First paragraph/);
  assert.match(read.content[0].text, /Hello ReMCP/);
  assert.match(read.content[0].text, /Inserted paragraph/);
  assert.doesNotMatch(read.content[0].text, /Second paragraph/);
});

test('PDF reading falls back to local pdftotext when the built-in parser cannot decode text', { skip: process.platform === 'win32' }, async () => {
  const binDir = join(root, 'fake-bin');
  mkdirSync(binDir, { recursive: true });
  const fakePdftotext = join(binDir, 'pdftotext');
  writeFileSync(fakePdftotext, '#!/bin/sh\nprintf "Fallback PDF text\\nSecond fallback line\\n"\n');
  chmodSync(fakePdftotext, 0o755);

  const pdf = join(root, 'embedded-font-like.pdf');
  writeFileSync(pdf, '%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF');

  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}:${previousPath || ''}`;
  try {
    const { readDocument } = await import('../src/extended/documents.mjs');
    const result = await readDocument({ path: pdf });
    assert.match(result.content[0].text, /Fallback PDF text/);
    assert.match(result.content[0].text, /Second fallback line/);
  } finally {
    process.env.PATH = previousPath;
  }
});


test('PDF info fallback keeps annotation count distinct from the annotations array and matches outputSchema', async () => {
  const pdf = join(root, 'info-contract.pdf');
  writeFileSync(pdf, '%PDF-1.4\n1 0 obj << /Type /Annot /Subtype /Text /Rect [0 0 10 10] /Contents (note) >> endobj\n%%EOF\n');
  const previousPath = process.env.PATH;
  process.env.PATH = '';
  try {
    const [{ pdfAction }, { allExtendedTools }, { fromJsonSchema }] = await Promise.all([
      import('../src/extended/documents.mjs'),
      import('../src/extended/catalog.mjs'),
      import('@modelcontextprotocol/server'),
    ]);
    const result = await pdfAction({ action:'info', path:pdf });
    assert.equal(result.structuredContent.annotation_count, 1);
    assert.equal(result.structuredContent.annotations, undefined);
    const definition = allExtendedTools().find(tool => tool.name === 'pdf_action');
    assert.equal(definition.outputSchema.properties.annotation_count.type, 'number');
    const validator = fromJsonSchema(definition.outputSchema);
    const checked = await validator['~standard'].validate(result.structuredContent);
    assert.deepEqual(checked.issues || [], []);
  } finally {
    process.env.PATH = previousPath;
  }
});

test('PDF page selection expands ordered ranges and rejects invalid ranges', async () => {
  const { expandPdfPages } = await import('../src/extended/documents.mjs');
  assert.deepEqual(expandPdfPages('1-3, 5, 7-8'), [1,2,3,5,7,8]);
  assert.throws(() => expandPdfPages('0'), /Invalid PDF page/);
  assert.throws(() => expandPdfPages('3-1'), /Invalid PDF page range/);
  assert.throws(() => expandPdfPages('1-20', 10), /exceeds 10 pages/);
});

test('PDF extract_pages falls back to pdfseparate and pdfunite when qpdf/pdftk are unavailable', { skip: process.platform === 'win32' }, async () => {
  const binDir = join(root, 'fake-poppler-bin');
  mkdirSync(binDir, { recursive: true });
  const pdfseparate = join(binDir, 'pdfseparate');
  const pdfunite = join(binDir, 'pdfunite');
  writeFileSync(pdfseparate, '#!/bin/sh\npage="$2"\nsource="$5"\npattern="$6"\nout="$(printf "$pattern" "$page")"\n/bin/cp "$source" "$out"\n');
  writeFileSync(pdfunite, '#!/bin/sh\nfirst="$1"\nfor last do :; done\n/bin/cp "$first" "$last"\n');
  chmodSync(pdfseparate, 0o755);
  chmodSync(pdfunite, 0o755);

  const source = join(root, 'source.pdf');
  const output = join(root, 'selected.pdf');
  writeFileSync(source, '%PDF-1.4\n%%EOF\n');

  const previousPath = process.env.PATH;
  process.env.PATH = binDir;
  try {
    const { pdfAction } = await import('../src/extended/documents.mjs');
    const result = await pdfAction({ action:'extract_pages', path:source, pages:'1-2,4', output });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.pages, '1,2,4');
    assert.ok(parsed.bytes > 0);
  } finally {
    process.env.PATH = previousPath;
  }
});

test('OOXML extraction rejects symlink entries before document code follows them', { skip: !zipReady }, async () => {
  const sourceDir = join(root, 'symlink-src');
  const outside = join(root, 'symlink-outside.xml');
  mkdirSync(join(sourceDir, 'xl', '_rels'), { recursive: true });
  mkdirSync(join(sourceDir, 'xl', 'worksheets'), { recursive: true });
  writeFileSync(outside, '<workbook><sheets/></workbook>');
  symlinkSync(outside, join(sourceDir, 'xl', 'workbook.xml'));
  writeFileSync(join(sourceDir, 'xl', '_rels', 'workbook.xml.rels'), '<Relationships/>');
  writeFileSync(join(sourceDir, 'xl', 'worksheets', 'sheet1.xml'), '<worksheet><sheetData/></worksheet>');
  const archive = join(root, 'symlink.xlsx');
  execFileSync('zip', ['-qry', archive, '.'], { cwd: sourceDir });
  const { readDocument } = await import('../src/extended/documents.mjs');
  await assert.rejects(() => readDocument({ path: archive }), /symbolic link|special file/i);
});

test('OOXML extraction rejects archive traversal before unzip writes anything', { skip: !zipReady }, async () => {
  const sourceDir = join(root, 'unsafe-src', 'inner');
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(root, 'unsafe-src', 'escape.txt'), 'escape');
  const bad = join(sourceDir, 'unsafe.xlsx');
  execFileSync('zip', ['-q', bad, '../escape.txt'], { cwd: sourceDir });
  const { readDocument } = await import('../src/extended/documents.mjs');
  await assert.rejects(() => readDocument({ path: bad }), /unsafe path/i);
});

test.after(() => rmSync(root, { recursive: true, force: true }));
