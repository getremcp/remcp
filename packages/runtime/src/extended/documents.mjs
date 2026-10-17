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
import { newWorksheetName, createBlankXlsxTree, createBlankDocxTree, workbookSheetPath, readSharedStrings, readWorksheetCells, readXlsx, readDocxDocument, readPdfDocument, readDocument } from './documents-reading.mjs';
export { readDocument };

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
