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

import { xmlEscape, xmlUnescape, descriptorAnchorsAvailable, openDocumentSource, openDocumentDirectoryPath, createAnchoredTempDirectory, readBounded, readDocumentFile, copyRegularNoFollow, snapshotDocumentFile, assertSafeExtractedTree, safePdfPattern, safeArchiveEntry, validateZipArchive, extractZip, createZip, commitDocumentOutput, ensureCreateTargetIsNew, writeOoxmlPart } from './documents-filesystem.mjs';

export function newWorksheetName(value) {
  const name = optionalString(value) || 'Sheet1';
  if (name.length > 31) throw new Error('Worksheet name must be 31 characters or fewer');
  if (/[\\/*?:\[\]]/.test(name) || name.startsWith("'") || name.endsWith("'")) {
    throw new Error('Worksheet name contains characters Excel does not allow');
  }
  return name;
}

export async function createBlankXlsxTree(root, sheetName) {
  const name = newWorksheetName(sheetName);
  await writeOoxmlPart(root, '[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
  await writeOoxmlPart(root, '_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  await writeOoxmlPart(root, 'xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEscape(name)}" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  await writeOoxmlPart(root, 'xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
  await writeOoxmlPart(root, 'xl/worksheets/sheet1.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData></sheetData></worksheet>');
  return name;
}

export async function createBlankDocxTree(root) {
  await writeOoxmlPart(root, '[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  await writeOoxmlPart(root, '_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  await writeOoxmlPart(root, 'word/document.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>');
}

export function workbookSheetPath(workbookXml, relsXml, requestedName) {
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

export function readSharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(match => [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(textMatch => xmlUnescape(textMatch[1])).join(''));
}

export function readWorksheetCells(xml, sharedStrings, maxCells) {
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

export async function readXlsx(filePath, args) {
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

export async function readDocxDocument(filePath) {
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

export async function readPdfDocument(data) {
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
