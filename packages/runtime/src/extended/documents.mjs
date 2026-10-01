import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, link, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { readDocxXmlText, readPdfText } from '../documents.mjs';
import { openDirectoryPath } from '../tools/files.mjs';
import { resolveSafePath, text } from '../util.mjs';
import {
  clamp,
  commandExists,
  escapePowerShellSingle,
  jsonResult,
  optionalString,
  removeTemp,
  requireEnum,
  runFile,
  runPowerShell,
  tempDir,
  unavailable,
} from './common.mjs';

function xmlEscape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function xmlUnescape(value) {
  return String(value).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

const MAX_OOXML_ENTRIES = 10_000;
const MAX_OOXML_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 128 * 1024 * 1024;
const DOCUMENT_READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0);

function descriptorAnchorsAvailable() {
  return process.platform === 'linux' && Boolean(constants.O_NOFOLLOW) && Boolean(constants.O_DIRECTORY);
}

async function openDocumentSource(filePath) {
  if (!descriptorAnchorsAvailable()) {
    const handle = await open(filePath, DOCUMENT_READ_FLAGS);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error('Document path must be a regular file');
      return { handle, close: () => handle.close() };
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
  }
  const parent = await openDirectoryPath(path.dirname(filePath));
  let handle;
  try {
    handle = await open(path.join(parent.anchor, path.basename(filePath)), DOCUMENT_READ_FLAGS);
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('Document path must be a regular file');
    return {
      handle,
      close: async () => {
        try { await handle.close(); }
        finally { await parent.close().catch(() => {}); }
      },
    };
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await parent.close().catch(() => {});
    throw error;
  }
}

async function openDocumentDirectoryPath(directory, { create = false } = {}) {
  const opened = await openDirectoryPath(directory, { create });
  return { ...opened, descriptorBound:opened.anchor !== directory || process.platform === 'linux' };
}

async function createAnchoredTempDirectory(parent, prefix) {
  const directory = await openDocumentDirectoryPath(parent, { create:true });
  try {
    const childAnchor = directory.descriptorBound === false
      ? directory.anchor
      : directory.anchor.replace('/proc/self/fd/', `/proc/${process.pid}/fd/`);
    const directoryPath = await mkdtemp(path.join(childAnchor, prefix));
    return { path:directoryPath, close:directory.close };
  } catch (error) {
    await directory.close().catch(() => {});
    throw error;
  }
}

async function readBounded(handle, maximum, label) {
  const chunks = [];
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let offset = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    if (!bytesRead) break;
    if (!Number.isSafeInteger(offset + bytesRead) || offset + bytesRead > maximum) {
      throw new Error(`${label} exceeds the ${maximum}-byte safety limit`);
    }
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    offset += bytesRead;
  }
  return Buffer.concat(chunks, offset);
}

async function readDocumentFile(filePath) {
  const opened = await openDocumentSource(filePath);
  try {
    const info = await opened.handle.stat();
    if (!info.isFile()) throw new Error('Document path must be a regular file');
    if (info.size > MAX_DOCUMENT_BYTES) throw new Error(`Document is too large (maximum ${MAX_DOCUMENT_BYTES} bytes)`);
    return await readBounded(opened.handle, MAX_DOCUMENT_BYTES, 'Document');
  } finally {
    await opened.close();
  }
}

async function copyRegularNoFollow(source, destination) {
  const opened = await openDocumentSource(source);
  try {
    const info = await opened.handle.stat();
    if (!info.isFile()) throw new Error('Document path must be a regular file');
    if (info.size > MAX_DOCUMENT_BYTES) throw new Error(`Document is too large (maximum ${MAX_DOCUMENT_BYTES} bytes)`);
    const destinationHandle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
    try {
      const data = await readBounded(opened.handle, MAX_DOCUMENT_BYTES, 'Document');
      await destinationHandle.writeFile(data);
    } finally {
      await destinationHandle.close();
    }
  } finally {
    await opened.close();
  }
}

async function snapshotDocumentFile(filePath) {
  const dir = await tempDir('remcp-pdf-input-');
  const snapshot = path.join(dir, `input-${randomUUID()}.pdf`);
  try {
    await copyRegularNoFollow(filePath, snapshot);
    return { dir, path: snapshot };
  } catch (error) {
    await removeTemp(dir);
    throw error;
  }
}

async function assertSafeExtractedTree(root, state = { entries: 0 }) {
  const info = await lstat(root);
  if (info.isSymbolicLink()) throw new Error('OOXML archive contains a symbolic link');
  if (!info.isDirectory() && !info.isFile()) throw new Error('OOXML archive contains a special file');
  state.entries += 1;
  if (state.entries > MAX_OOXML_ENTRIES) throw new Error('OOXML archive has too many extracted entries');
  if (!info.isDirectory()) return;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    await assertSafeExtractedTree(path.join(root, entry.name), state);
  }
}

function safePdfPattern(value, fallback) {
  const pattern = String(value || fallback);
  if (!pattern || pattern.length > 240 || pattern.includes('\0') || path.isAbsolute(pattern) || /[\\/]/.test(pattern) || pattern.split(/[\\/]/).includes('..')) {
    throw new Error('PDF split pattern must be a filename without path separators');
  }
  return pattern;
}

function safeArchiveEntry(name) {
  const normalized = String(name || '').replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return false;
  return !normalized.split('/').includes('..');
}

async function validateZipArchive(source) {
  if (process.platform === 'win32') {
    const script = `Add-Type -AssemblyName System.IO.Compression.FileSystem;$z=[IO.Compression.ZipFile]::OpenRead('${escapePowerShellSingle(source)}');try{$count=$z.Entries.Count;$total=0;foreach($e in $z.Entries){$n=$e.FullName.Replace('\\','/');if([IO.Path]::IsPathRooted($n) -or $n.StartsWith('/') -or ($n.Split('/') -contains '..')){throw ('unsafe archive path: '+$n)};$total += $e.Length};if($count -gt ${MAX_OOXML_ENTRIES}){throw 'too many archive entries'};if($total -gt ${MAX_OOXML_UNCOMPRESSED_BYTES}){throw 'archive expands beyond the OOXML limit'};[pscustomobject]@{count=$count;total=$total}|ConvertTo-Json -Compress}finally{$z.Dispose()}`;
    await runPowerShell(script, { label:'validate OOXML archive', timeout:30_000 });
    return;
  }
  if (!commandExists('unzip')) unavailable('OOXML document editing', 'unzip is required');
  const names = await runFile('unzip', ['-Z','-1',source], { label:'inspect OOXML archive', timeout:30_000, maxBuffer:16 * 1024 * 1024 });
  const entries = names.stdout.split(/\r?\n/).filter(Boolean);
  if (entries.length > MAX_OOXML_ENTRIES) throw new Error(`OOXML archive has too many entries (${entries.length}; max ${MAX_OOXML_ENTRIES})`);
  const unsafe = entries.find(name => !safeArchiveEntry(name));
  if (unsafe) throw new Error(`OOXML archive contains an unsafe path: ${unsafe}`);
  const details = await runFile('unzip', ['-Z','-v',source], { label:'inspect OOXML entry types', timeout:30_000, maxBuffer:16 * 1024 * 1024 });
  if (/symbolic link|Unix file attributes \([^)]*\b12\d{4}/i.test(details.stdout)) throw new Error('OOXML archive contains a symbolic link');
  const totals = await runFile('unzip', ['-Z','-t',source], { label:'inspect OOXML archive size', timeout:30_000 });
  const uncompressed = Number(totals.stdout.match(/(?:^|,\s)([0-9]+) bytes uncompressed/)?.[1] || 0);
  if (uncompressed > MAX_OOXML_UNCOMPRESSED_BYTES) throw new Error(`OOXML archive expands to ${uncompressed} bytes; max ${MAX_OOXML_UNCOMPRESSED_BYTES}`);
}

async function extractZip(source, destination) {
  const sourceDirectory = await tempDir('remcp-ooxml-source-');
  const sourceCopy = path.join(sourceDirectory, 'source.zip');
  try {
    await copyRegularNoFollow(source, sourceCopy);
    await validateZipArchive(sourceCopy);
    await mkdir(destination, { recursive:true });
    if (process.platform === 'win32') {
      await runPowerShell(`Add-Type -AssemblyName System.IO.Compression.FileSystem;[IO.Compression.ZipFile]::ExtractToDirectory('${escapePowerShellSingle(sourceCopy)}','${escapePowerShellSingle(destination)}')`, { label:'extract OOXML archive', timeout:30_000 });
    } else {
      if (!commandExists('unzip')) unavailable('OOXML document editing', 'unzip is required');
      await runFile('unzip', ['-qq',sourceCopy,'-d',destination], { label:'extract OOXML archive', timeout:30_000 });
    }
    await assertSafeExtractedTree(destination);
  } finally {
    await removeTemp(sourceDirectory);
  }
}

async function createZip(sourceDir, destination) {
  await rm(destination, { force:true }).catch(() => {});
  if (process.platform === 'win32') {
    await runPowerShell(`Add-Type -AssemblyName System.IO.Compression.FileSystem;[IO.Compression.ZipFile]::CreateFromDirectory('${escapePowerShellSingle(sourceDir)}','${escapePowerShellSingle(destination)}',[IO.Compression.CompressionLevel]::Optimal,$false)`, { label:'create OOXML archive', timeout:30_000 });
    return;
  }
  if (!commandExists('zip')) unavailable('OOXML document editing', 'zip is required');
  await runFile('zip', ['-qr',destination,'.'], { cwd:sourceDir, label:'create OOXML archive', timeout:30_000 });
}

async function commitDocumentOutput(staged, destination, { noReplace = false } = {}) {
  const parentDirectory = await openDocumentDirectoryPath(path.dirname(destination));
  const parentAnchor = parentDirectory.anchor;
  const destinationPath = path.join(parentAnchor, path.basename(destination));
  try {
    if (noReplace) {
      await link(staged, destinationPath);
      await unlink(staged);
      return;
    }
    try {
      await rename(staged, destinationPath);
      return;
    } catch (error) {
      if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error?.code)) throw error;
    }
    const backup = path.join(parentAnchor, `.${path.basename(destination)}.remcp-old-${randomUUID()}`);
    let moved = false;
    try {
      await rename(destinationPath, backup);
      moved = true;
      await rename(staged, destinationPath);
      await rm(backup, { force: true }).catch(() => {});
    } catch (error) {
      if (moved && !await lstat(destinationPath).catch(() => null)) await rename(backup, destinationPath).catch(() => {});
      throw error;
    }
  } finally {
    await parentDirectory.close().catch(() => {});
  }
}

async function ensureCreateTargetIsNew(filePath) {
  try {
    await stat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`Cannot create document because path already exists: ${filePath}`);
}

async function writeOoxmlPart(root, relative, content) {
  const target = path.join(root, ...relative.split('/'));
  await mkdir(path.dirname(target), { recursive:true });
  await writeFile(target, content, 'utf8');
}

function newWorksheetName(value) {
  const name = optionalString(value) || 'Sheet1';
  if (name.length > 31) throw new Error('Worksheet name must be 31 characters or fewer');
  if (/[\\/*?:\[\]]/.test(name) || name.startsWith("'") || name.endsWith("'")) {
    throw new Error('Worksheet name contains characters Excel does not allow');
  }
  return name;
}

async function createBlankXlsxTree(root, sheetName) {
  const name = newWorksheetName(sheetName);
  await writeOoxmlPart(root, '[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
  await writeOoxmlPart(root, '_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  await writeOoxmlPart(root, 'xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEscape(name)}" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  await writeOoxmlPart(root, 'xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
  await writeOoxmlPart(root, 'xl/worksheets/sheet1.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData></sheetData></worksheet>');
  return name;
}

async function createBlankDocxTree(root) {
  await writeOoxmlPart(root, '[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  await writeOoxmlPart(root, '_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  await writeOoxmlPart(root, 'word/document.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>');
}

function workbookSheetPath(workbookXml, relsXml, requestedName) {
  const sheets = [...workbookXml.matchAll(/<sheet\b[^>]*name="([^"]+)"[^>]*(?:r:id|id)="([^"]+)"[^>]*\/?>(?:<\/sheet>)?/g)].map(match => ({ name:xmlUnescape(match[1]), rid:match[2] }));
  const sheet = requestedName ? sheets.find(item => item.name.toLowerCase() === requestedName.toLowerCase()) : sheets[0];
  if (!sheet) throw new Error(requestedName ? `Worksheet not found: ${requestedName}` : 'Workbook contains no worksheets');
  const relationships = [...relsXml.matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/?>/g)].map(match => ({ id:match[1], target:match[2] }));
  const rel = relationships.find(item => item.id === sheet.rid);
  if (!rel) throw new Error(`Relationship for worksheet ${sheet.name} was not found`);
  const target = rel.target.replace(/^\//, '').replace(/\\/g, '/');
  if (!safeArchiveEntry(target)) throw new Error(`Worksheet relationship contains an unsafe path: ${target}`);
  const relative = path.posix.normalize(target.startsWith('xl/') ? target : path.posix.join('xl', target));
  if (!relative.startsWith('xl/') || relative.split('/').includes('..')) throw new Error(`Worksheet relationship escapes the workbook: ${target}`);
  return { name:sheet.name, relative };
}

function readSharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(match => [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(textMatch => xmlUnescape(textMatch[1])).join(''));
}

function readWorksheetCells(xml, sharedStrings, maxCells) {
  const cells = [];
  const pattern = /<c\b([^>]*)\br="([A-Z]+\d+)"([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\br="([A-Z]+\d+)"([^>]*)\/>/g;
  for (const match of xml.matchAll(pattern)) {
    if (cells.length >= maxCells) break;
    const attrs = `${match[1] || match[5] || ''}${match[3] || match[7] || ''}`;
    const ref = match[2] || match[6];
    const body = match[4] || '';
    const type = attrs.match(/\bt="([^"]+)"/)?.[1] || '';
    const formula = body.match(/<f\b[^>]*>([\s\S]*?)<\/f>/)?.[1];
    const raw = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1] ?? '';
    let value;
    if (type === 's') value = sharedStrings[Number(raw)] ?? raw;
    else if (type === 'inlineStr') value = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(item => xmlUnescape(item[1])).join('');
    else if (type === 'b') value = raw === '1';
    else if (raw !== '' && Number.isFinite(Number(raw))) value = Number(raw);
    else value = xmlUnescape(raw);
    cells.push({ ref, value, ...(formula ? { formula:xmlUnescape(formula) } : {}) });
  }
  return cells;
}

async function readXlsx(filePath, args) {
  const dir = await tempDir('remcp-xlsx-read-');
  try {
    // extractZip already snapshots the user-approved source into a private temp file
    // before invoking unzip. A second snapshot here used to re-open ReMCP's own temp
    // path through allowedRoots, so read_document failed whenever confinement was on.
    await extractZip(filePath, dir);
    const workbook = await readFile(path.join(dir,'xl','workbook.xml'),'utf8');
    const rels = await readFile(path.join(dir,'xl','_rels','workbook.xml.rels'),'utf8');
    const sheet = workbookSheetPath(workbook, rels, optionalString(args.sheet));
    const worksheet = await readFile(path.join(dir,...sheet.relative.split('/')),'utf8');
    let shared = [];
    try { shared = readSharedStrings(await readFile(path.join(dir,'xl','sharedStrings.xml'),'utf8')); } catch {}
    const cells = readWorksheetCells(worksheet, shared, clamp(args.max_cells,5000,1,50_000));
    return { kind:'xlsx', sheet:sheet.name, count:cells.length, cells };
  } finally {
    await removeTemp(dir);
  }
}

async function readDocxDocument(filePath) {
  const dir = await tempDir('remcp-docx-read-');
  try {
    await extractZip(filePath, dir);
    let xml;
    try {
      xml = await readFile(path.join(dir, 'word', 'document.xml'), 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error('This file is not a readable .docx (word/document.xml is missing)');
      }
      throw error;
    }
    return readDocxXmlText(xml);
  } finally {
    await removeTemp(dir);
  }
}

async function readPdfDocument(data) {
  try {
    return readPdfText(data);
  } catch (builtinError) {
    if (commandExists('pdftotext')) {
      const dir = await tempDir('remcp-pdf-read-');
      try {
        const snapshot = path.join(dir, 'input.pdf');
        await writeFile(snapshot, data, { mode: 0o600 });
        const extracted = await runFile('pdftotext', ['-enc','UTF-8',snapshot,'-'], {
          label:'PDF text extraction',
          timeout:60_000,
          allowFailure:true,
        });
        const fallbackText = String(extracted.stdout || '').replace(/\f/g, '\n').trim();
        if (extracted.code === 0 && fallbackText) return fallbackText;
      } finally {
        await removeTemp(dir);
      }
    }
    throw builtinError;
  }
}

export async function readDocument(args) {
  const filePath = await resolveSafePath(args.path,'path');
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.docx')) return text(await readDocxDocument(filePath));
  if (lower.endsWith('.xlsx')) return jsonResult(await readXlsx(filePath,args));
  const data = await readDocumentFile(filePath);
  if (lower.endsWith('.pdf')) return text(await readPdfDocument(data));
  if (/\.(txt|md|csv|json|xml|yaml|yml)$/i.test(lower)) return text(data.toString('utf8'));
  throw new Error('read_document supports PDF, DOCX, XLSX, TXT, Markdown, CSV, JSON, XML, YAML');
}

function cellXml(ref, value, formula) {
  if (formula != null) return `<c r="${ref}"><f>${xmlEscape(String(formula).replace(/^=/,''))}</f></c>`;
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`;
  if (typeof value === 'boolean') return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value ?? '')}</t></is></c>`;
}

function setWorksheetCell(xml, ref, value, formula) {
  if (!/^[A-Z]+[1-9]\d*$/.test(ref)) throw new Error(`Invalid cell reference: ${ref}`);
  const replacement = cellXml(ref,value,formula);
  const cellPattern = new RegExp(`<c\\b[^>]*\\br="${ref}"[^>]*(?:>[\\s\\S]*?<\\/c>|\\/>)`);
  if (cellPattern.test(xml)) return xml.replace(cellPattern,replacement);
  const rowNo = ref.match(/\d+$/)[0];
  const rowPattern = new RegExp(`(<row\\b[^>]*\\br="${rowNo}"[^>]*>)([\\s\\S]*?)(<\\/row>)`);
  if (rowPattern.test(xml)) return xml.replace(rowPattern, (_match,start,body,end) => `${start}${body}${replacement}${end}`);
  if (!/<sheetData\b[^>]*>/.test(xml)) throw new Error('Worksheet XML has no sheetData');
  return xml.replace(/<\/sheetData>/, `<row r="${rowNo}">${replacement}</row></sheetData>`);
}

function columnNumber(label) {
  let value = 0;
  for (const char of String(label)) value = value * 26 + (char.charCodeAt(0) - 64);
  return value;
}

function columnLabel(number) {
  let value = Number(number), out = '';
  while (value > 0) { value -= 1; out = String.fromCharCode(65 + (value % 26)) + out; value = Math.floor(value / 26); }
  return out;
}

function cellPoint(ref) {
  const match = String(ref || '').toUpperCase().match(/^([A-Z]+)([1-9]\d*)$/);
  if (!match) throw new Error(`Invalid cell reference: ${ref}`);
  return { col: columnNumber(match[1]), row: Number(match[2]) };
}

function expandSpreadsheetEdits(edits) {
  const expanded = [];
  for (const edit of edits) {
    if (edit?.cell) {
      const cell = String(edit.cell).toUpperCase(); cellPoint(cell);
      expanded.push({ cell, value:edit.value, formula:edit.formula });
      continue;
    }
    const range = String(edit?.range || '').toUpperCase();
    const match = range.match(/^([A-Z]+[1-9]\d*):([A-Z]+[1-9]\d*)$/);
    if (!match) throw new Error('Each spreadsheet edit requires cell or a range like A1:C3');
    const start = cellPoint(match[1]), end = cellPoint(match[2]);
    if (end.col < start.col || end.row < start.row) throw new Error(`Invalid range order: ${range}`);
    const rows = end.row - start.row + 1, cols = end.col - start.col + 1;
    const values = Array.isArray(edit.values) ? edit.values : null;
    if (values && (values.length !== rows || values.some(row => !Array.isArray(row) || row.length !== cols))) {
      throw new Error(`values for ${range} must be a ${rows}x${cols} matrix`);
    }
    for (let rowOffset = 0; rowOffset < rows; rowOffset += 1) {
      for (let colOffset = 0; colOffset < cols; colOffset += 1) {
        expanded.push({
          cell: `${columnLabel(start.col + colOffset)}${start.row + rowOffset}`,
          value: values ? values[rowOffset][colOffset] : edit.value,
          formula: edit.formula,
        });
        if (expanded.length > 500) throw new Error('Expanded spreadsheet edits exceed the 500-cell limit');
      }
    }
  }
  return expanded;
}

export async function editSpreadsheet(args) {
  const filePath = await resolveSafePath(args.path,'path');
  if (!filePath.toLowerCase().endsWith('.xlsx')) throw new Error('edit_spreadsheet supports .xlsx files');
  const create = args.create === true;
  if (create && args.output) throw new Error('output is not used with create=true; path is the new workbook destination');
  const requestedEdits = Array.isArray(args.edits) ? args.edits : [];
  if (!requestedEdits.length || requestedEdits.length > 500) throw new Error('edits must contain 1..500 cell/range edits');
  const edits = expandSpreadsheetEdits(requestedEdits);
  const output = args.output ? await resolveSafePath(args.output,'output') : filePath;
  const dir = await tempDir(create ? 'remcp-xlsx-create-' : 'remcp-xlsx-edit-');
  let outputStage = '';
  let outputStageDirectory = null;
  let tempOut = '';
  try {
    outputStageDirectory = await createAnchoredTempDirectory(path.dirname(output), '.remcp-xlsx-output-');
    outputStage = outputStageDirectory.path;
    tempOut = path.join(outputStage, path.basename(output));
    if (create) {
      await ensureCreateTargetIsNew(filePath);
      await createBlankXlsxTree(dir, optionalString(args.sheet));
    } else {
      await extractZip(filePath,dir);
    }
    const workbook = await readFile(path.join(dir,'xl','workbook.xml'),'utf8');
    const rels = await readFile(path.join(dir,'xl','_rels','workbook.xml.rels'),'utf8');
    const sheet = workbookSheetPath(workbook,rels,optionalString(args.sheet));
    const worksheetPath = path.join(dir,...sheet.relative.split('/'));
    let xml = await readFile(worksheetPath,'utf8');
    for (const edit of edits) xml = setWorksheetCell(xml,String(edit.cell || '').toUpperCase(),edit.value,edit.formula);
    await writeFile(worksheetPath,xml,'utf8');
    await createZip(dir,tempOut);
     await commitDocumentOutput(tempOut,output,{ noReplace:create });
     return jsonResult({ path:output, sheet:sheet.name, edited_cells:edits.length, bytes:(await stat(output)).size, created:create });

  } finally {
    if (tempOut) await rm(tempOut,{force:true}).catch(() => {});
    if (outputStage) await rm(outputStage,{recursive:true, force:true}).catch(() => {});
    if (outputStageDirectory) await outputStageDirectory.close().catch(() => {});
    await removeTemp(dir);
  }
}

function paragraphText(xml) {
  return [...xml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map(match => xmlUnescape(match[1])).join('');
}

function replaceDocxText(documentXml, search, replacement, all) {
  let changed = 0;
  const needle = String(search);
  const xml = documentXml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, paragraph => {
    if (!needle || !paragraphText(paragraph).includes(needle) || (!all && changed)) return paragraph;
    const current = paragraphText(paragraph);
    const next = all ? current.split(needle).join(String(replacement)) : current.replace(needle,String(replacement));
    if (next === current) return paragraph;
    changed += all ? current.split(needle).length - 1 : 1;
    const start = paragraph.match(/^<w:p\b[^>]*>/)?.[0] || '<w:p>';
    const pPr = paragraph.match(/<w:pPr\b[^>]*>[\s\S]*?<\/w:pPr>/)?.[0] || '';
    return `${start}${pPr}<w:r><w:t xml:space="preserve">${xmlEscape(next)}</w:t></w:r></w:p>`;
  });
  return { xml, changed };
}

function docxParagraph(value) {
  return `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(String(value ?? ''))}</w:t></w:r></w:p>`;
}

function insertDocxParagraphAtEnd(xml, paragraph) {
  const sect = xml.match(/<w:sectPr\b[\s\S]*?<\/w:sectPr>\s*<\/w:body>/);
  if (sect) return xml.replace(sect[0], `${paragraph}${sect[0]}`);
  return xml.replace(/<\/w:body>/, `${paragraph}</w:body>`);
}

function mutateMatchingParagraphs(xml, op) {
  const needle = optionalString(op.search);
  if (!needle) throw new Error(`${op.action} requires search`);
  const insert = docxParagraph(op.text);
  let changed = 0;
  const all = op.all !== false;
  const next = xml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, paragraph => {
    if (!paragraphText(paragraph).includes(needle) || (!all && changed)) return paragraph;
    changed += 1;
    if (op.action === 'delete_paragraph') return '';
    if (op.action === 'insert_paragraph_before') return `${insert}${paragraph}`;
    if (op.action === 'insert_paragraph_after') return `${paragraph}${insert}`;
    return paragraph;
  });
  return { xml: next, changed };
}

export async function editDocument(args) {
  const filePath = await resolveSafePath(args.path,'path');
  if (!filePath.toLowerCase().endsWith('.docx')) throw new Error('edit_document supports .docx files');
  const create = args.create === true;
  if (create && args.output) throw new Error('output is not used with create=true; path is the new document destination');
  const operations = Array.isArray(args.operations) ? args.operations : [];
  if (!operations.length || operations.length > 100) throw new Error('operations must contain 1..100 edits');
  const output = args.output ? await resolveSafePath(args.output,'output') : filePath;
  const dir = await tempDir(create ? 'remcp-docx-create-' : 'remcp-docx-edit-');
  let outputStage = '';
  let outputStageDirectory = null;
  let tempOut = '';
  let changes = 0;
  try {
    outputStageDirectory = await createAnchoredTempDirectory(path.dirname(output), '.remcp-docx-output-');
    outputStage = outputStageDirectory.path;
    tempOut = path.join(outputStage, path.basename(output));
    if (create) {
      await ensureCreateTargetIsNew(filePath);
      await createBlankDocxTree(dir);
    } else {
      await extractZip(filePath,dir);
    }
    const documentPath = path.join(dir,'word','document.xml');
    let xml = await readFile(documentPath,'utf8');
    for (const op of operations) {
      const action = requireEnum(op.action,'operation.action',['replace','append_paragraph','prepend_paragraph','insert_paragraph_before','insert_paragraph_after','delete_paragraph']);
      if (action === 'replace') {
        const search = optionalString(op.search); if (!search) throw new Error('replace requires search');
        const result = replaceDocxText(xml,search,String(op.replacement ?? ''),op.all !== false);
        xml = result.xml; changes += result.changed;
      } else if (action === 'append_paragraph') {
        xml = insertDocxParagraphAtEnd(xml, docxParagraph(op.text)); changes += 1;
      } else if (action === 'prepend_paragraph') {
        xml = xml.replace(/(<w:body\b[^>]*>)/, `$1${docxParagraph(op.text)}`); changes += 1;
      } else {
        const result = mutateMatchingParagraphs(xml, { ...op, action });
        xml = result.xml; changes += result.changed;
      }
    }
    await writeFile(documentPath,xml,'utf8');
    await createZip(dir,tempOut);
     await commitDocumentOutput(tempOut,output,{ noReplace:create });
     return jsonResult({ path:output, operations:operations.length, changes, bytes:(await stat(output)).size, created:create });

  } finally {
    if (tempOut) await rm(tempOut,{force:true}).catch(() => {});
    if (outputStage) await rm(outputStage,{recursive:true, force:true}).catch(() => {});
    if (outputStageDirectory) await outputStageDirectory.close().catch(() => {});
    await removeTemp(dir);
  }
}

export function expandPdfPages(spec, maxPages = 10_000) {
  const normalized = String(spec || '').replace(/\s+/g, '');
  if (!normalized || !/^[0-9,\-]+$/.test(normalized)) throw new Error('pages must look like 1-3,5');
  const pages = [];
  for (const token of normalized.split(',')) {
    if (!token) throw new Error('pages must look like 1-3,5');
    const range = token.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) throw new Error(`Invalid PDF page range: ${token}`);
      if (pages.length + (end - start + 1) > maxPages) throw new Error(`PDF page selection exceeds ${maxPages} pages`);
      for (let page = start; page <= end; page += 1) pages.push(page);
      continue;
    }
    const page = Number(token);
    if (!Number.isInteger(page) || page < 1) throw new Error(`Invalid PDF page: ${token}`);
    pages.push(page);
    if (pages.length > maxPages) throw new Error(`PDF page selection exceeds ${maxPages} pages`);
  }
  return pages;
}

function pdfAnnotations(buffer) {
  const raw = buffer.toString('latin1');
  const rows = [];
  for (const match of raw.matchAll(/(\d+)\s+(\d+)\s+obj([\s\S]*?)endobj/g)) {
    const body = match[3];
    if (!/\/Type\s*\/Annot\b|\/Subtype\s*\/(?:Text|FreeText|Highlight|Underline|StrikeOut|Square|Circle|Stamp|Ink|Link)\b/.test(body)) continue;
    rows.push({
      object:Number(match[1]),
      generation:Number(match[2]),
      subtype:body.match(/\/Subtype\s*\/([A-Za-z]+)/)?.[1] || null,
      contents:body.match(/\/Contents\s*\(((?:\\.|[^\\()])*)\)/)?.[1] || null,
      rect:body.match(/\/Rect\s*\[([^\]]+)\]/)?.[1]?.trim().split(/\s+/).map(Number) || null,
    });
  }
  return rows;
}

export async function pdfAction(args) {
  const action = requireEnum(args.action,'action',['merge','split','extract_pages','annotations','info']);
  if (action === 'annotations') {
    const source = await resolveSafePath(args.path,'path');
    return jsonResult({ path:source, annotations:pdfAnnotations(await readDocumentFile(source)) });
  }
  if (action === 'info') {
    const source = await resolveSafePath(args.path,'path');
    if (commandExists('pdfinfo')) {
      const snapshot = await snapshotDocumentFile(source);
      try { return text((await runFile('pdfinfo',[snapshot.path],{label:'pdfinfo'})).stdout); }
      finally { await removeTemp(snapshot.dir); }
    }
    const data = await readDocumentFile(source);
    return jsonResult({ path:source, bytes:data.length, annotation_count:pdfAnnotations(data).length });
  }
  if (action === 'merge') {
    const requested = Array.isArray(args.paths) ? args.paths : [];
    if (requested.length < 2 || requested.length > 100) throw new Error('merge requires 2..100 PDFs in paths');
    const sources=[];
    for(const value of requested) sources.push(await resolveSafePath(value,'paths'));
    const output=await resolveSafePath(args.output,'output');
    const inputDir=await tempDir('remcp-pdf-merge-input-');
    const outputStageDirectory=await createAnchoredTempDirectory(path.dirname(output), '.remcp-pdf-output-');
    const outputDir=outputStageDirectory.path;
    const staged=path.join(outputDir,path.basename(output));
    try {
      const snapshots=[];
      for(let index=0;index<sources.length;index+=1){
        const snapshot=path.join(inputDir,`input-${index}.pdf`);
        await copyRegularNoFollow(sources[index],snapshot);
        snapshots.push(snapshot);
      }
      if(commandExists('pdfunite')) await runFile('pdfunite',[...snapshots,staged],{label:'PDF merge',timeout:60_000});
      else if(commandExists('qpdf')) await runFile('qpdf',['--empty','--pages',...snapshots,'--',staged],{label:'PDF merge',timeout:60_000});
      else unavailable('PDF merge','install poppler-utils (pdfunite) or qpdf');
      await commitDocumentOutput(staged,output);
      return jsonResult({action,output,inputs:sources.length,bytes:(await stat(output)).size});
    } finally {
      await removeTemp(inputDir);
      await rm(outputDir,{recursive:true,force:true}).catch(()=>{});
      await outputStageDirectory.close().catch(()=>{});
    }
  }
  const source=await resolveSafePath(args.path,'path');
  if(action==='split'){
    const requestedOutputDir=await resolveSafePath(args.output_dir || path.dirname(source),'output_dir');
    const outputDir=await resolveSafePath(requestedOutputDir,'output_dir');
    const patternName=safePdfPattern(optionalString(args.pattern),`${path.basename(source,path.extname(source))}-%d.pdf`);
    const snapshot=await snapshotDocumentFile(source);
    const work=await tempDir('remcp-pdf-split-');
    const stageDirectory=await createAnchoredTempDirectory(outputDir, '.remcp-pdf-output-');
    const stageDir=stageDirectory.path;
    try {
      const pattern=path.join(work,patternName);
      if(commandExists('pdfseparate')) await runFile('pdfseparate',[snapshot.path,pattern],{label:'PDF split',timeout:60_000});
      else unavailable('PDF split','install poppler-utils (pdfseparate)');
      for(const name of await readdir(work)){
        if(!name.toLowerCase().endsWith('.pdf')) continue;
        const staged=path.join(stageDir,name);
        await copyFile(path.join(work,name),staged,constants.COPYFILE_EXCL);
        await commitDocumentOutput(staged,path.join(outputDir,name));
      }
      return jsonResult({action,output_dir:outputDir,files:(await readdir(outputDir)).filter(name=>name.toLowerCase().endsWith('.pdf')).sort()});
    } finally {
      await removeTemp(snapshot.dir);
      await removeTemp(work);
      await rm(stageDir,{recursive:true,force:true}).catch(()=>{});
      await stageDirectory.close().catch(()=>{});
    }
  }
  const pages=optionalString(args.pages);
  const selectedPages=expandPdfPages(pages);
  const normalizedPages=selectedPages.join(',');
  const output=await resolveSafePath(args.output,'output');
  const snapshot=await snapshotDocumentFile(source);
  const stageDirectory=await createAnchoredTempDirectory(path.dirname(output), '.remcp-pdf-output-');
  const stageDir=stageDirectory.path;
  const staged=path.join(stageDir,path.basename(output));
  try {
    if(commandExists('qpdf')) {
      await runFile('qpdf',[snapshot.path,'--pages','.',pages.replace(/\s+/g,''),'--',staged],{label:'PDF extract pages',timeout:60_000});
    } else if(commandExists('pdftk')) {
      await runFile('pdftk',[snapshot.path,'cat',...pages.replace(/\s+/g,'').split(','),'output',staged],{label:'PDF extract pages',timeout:60_000});
    } else if(commandExists('pdfseparate')) {
      const work=await tempDir('remcp-pdf-pages-');
      try {
        const extracted=[];
        for(let index=0;index<selectedPages.length;index+=1){
          const page=selectedPages[index];
          const pattern=path.join(work,`selection-${index+1}-%d.pdf`);
          await runFile('pdfseparate',['-f',String(page),'-l',String(page),snapshot.path,pattern],{label:`PDF extract page ${page}`,timeout:60_000});
          extracted.push(path.join(work,`selection-${index+1}-${page}.pdf`));
        }
        if(extracted.length===1) {
          await copyFile(extracted[0],staged,constants.COPYFILE_EXCL);
        } else if(commandExists('pdfunite')) {
          await runFile('pdfunite',[...extracted,staged],{label:'PDF assemble extracted pages',timeout:60_000});
        } else {
          unavailable('PDF page extraction','pdfunite is required with pdfseparate when extracting multiple pages');
        }
      } finally { await removeTemp(work); }
    } else {
      unavailable('PDF page extraction','install qpdf, pdftk, or poppler-utils (pdfseparate; pdfunite for multiple pages)');
    }
    await commitDocumentOutput(staged,output);
    return jsonResult({action,source,pages:normalizedPages,output,bytes:(await stat(output)).size});
  } finally {
    await removeTemp(snapshot.dir);
    await rm(stageDir,{recursive:true,force:true}).catch(()=>{});
    await stageDirectory.close().catch(()=>{});
  }
}

export const documentHandlers = {
  read_document:readDocument,
  edit_spreadsheet:editSpreadsheet,
  edit_document:editDocument,
  pdf_action:pdfAction,
};
