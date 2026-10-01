import { inflateRawSync, inflateSync } from 'node:zlib';

// Reading PDF and DOCX without pulling a document stack into the device runtime.
//
// Desktop Commander installs libraries for this. ReMCP keeps its one-dependency promise and reads the
// two formats that are actually documents with text in them:
//
//   DOCX - a ZIP whose word/document.xml holds the text in <w:t> elements. Inflating a stored or
//          deflated entry is all that is needed.
//   PDF  - objects with content streams. Text drawn with the standard encodings (Tj/TJ/'/") is
//          extracted; a PDF that uses embedded subset fonts with custom CMaps cannot be read this
//          way, and says so instead of returning mojibake.
//
// Nothing here writes, and nothing leaves the computer.

const MAX_INFLATE_BYTES = 32 * 1024 * 1024;
const MAX_PDF_DECODED_BYTES = 128 * 1024 * 1024;
const MAX_PDF_STREAMS = 10_000;

function inflate(buffer, raw = false) {
  try {
    const out = raw ? inflateRawSync(buffer, { maxOutputLength: MAX_INFLATE_BYTES }) : inflateSync(buffer, { maxOutputLength: MAX_INFLATE_BYTES });
    return out;
  } catch {
    return null;
  }
}

function unzipEntry(buffer, wanted) {
  // Walk the central directory once: enough to find one entry without implementing the whole format.
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) return null;
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  for (let index = 0; index < count && offset + 46 <= buffer.length; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) return null;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength).replace(/\\/g, '/');
    if (name === wanted) {
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const raw = buffer.subarray(start, start + compressedSize);
      if (method === 0) return raw;
      if (method === 8) return inflate(raw, true);
      return null;
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

const DOCX_ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };

function xmlTagName(tag) {
  let index = 0;
  while (index < tag.length && /\s/.test(tag[index])) index += 1;
  let closing = false;
  if (tag[index] === '/') {
    closing = true;
    index += 1;
    while (index < tag.length && /\s/.test(tag[index])) index += 1;
  }
  const start = index;
  while (index < tag.length && !/\s|\/|>/.test(tag[index])) index += 1;
  return { name: tag.slice(start, index), closing };
}

function wordXmlText(xml) {
  let output = '';
  let index = 0;
  while (index < xml.length) {
    if (xml[index] !== '<') {
      output += xml[index];
      index += 1;
      continue;
    }
    if (xml.startsWith('<!--', index)) {
      const end = xml.indexOf('-->', index + 4);
      index = end < 0 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', index)) {
      const end = xml.indexOf(']]>', index + 9);
      if (end < 0) break;
      output += xml.slice(index + 9, end);
      index = end + 3;
      continue;
    }
    let quote = '';
    let end = index + 1;
    for (; end < xml.length; end += 1) {
      const character = xml[end];
      if (quote) {
        if (character === quote) quote = '';
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character === '>') break;
    }
    if (end >= xml.length) break;
    const { name, closing } = xmlTagName(xml.slice(index + 1, end));
    if (closing && name === 'w:p') output += '\n';
    else if (!closing && (name === 'w:br' || name === 'w:cr')) output += '\n';
    else if (!closing && name === 'w:tab') output += '\t';
    index = end + 1;
  }
  return output;
}

export function readDocxXmlText(xml) {
  return wordXmlText(String(xml))
    .replace(/&(amp|lt|gt|quot|apos);/g, match => DOCX_ENTITIES[match])
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function readDocxText(buffer) {
  const document = unzipEntry(buffer, 'word/document.xml');
  if (!document) throw new Error('This file is not a readable .docx (its word/document.xml is missing or compressed in an unsupported way)');
  return readDocxXmlText(document.toString('utf8'));
}

function decodePdfString(raw) {
  // Literal strings arrive with backslash escapes; hex strings are pairs of hex digits.
  return raw
    .replace(/\\([nrtbf()\\])/g, (_match, character) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[character] ?? character))
    .replace(/\\([0-7]{1,3})/g, (_match, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
}

const PDF_HEX = '0123456789abcdefABCDEF';

function readPdfLiteral(content, start) {
  let raw = '';
  let depth = 1;
  let index = start + 1;
  while (index < content.length) {
    const character = content[index];
    if (character === '\\') {
      raw += character;
      index += 1;
      if (index < content.length) {
        raw += content[index];
        index += 1;
      }
      continue;
    }
    if (character === '(') {
      depth += 1;
      raw += character;
      index += 1;
      continue;
    }
    if (character === ')') {
      depth -= 1;
      index += 1;
      if (depth === 0) return { value: decodePdfString(raw), next: index };
      raw += character;
      continue;
    }
    raw += character;
    index += 1;
  }
  return { value: '', next: content.length };
}

function readPdfHex(content, start) {
  let hex = '';
  let index = start + 1;
  while (index < content.length && content[index] !== '>') {
    if (PDF_HEX.includes(content[index])) hex += content[index];
    index += 1;
  }
  if (hex.length % 2) hex += '0';
  const value = Buffer.from(hex, 'hex').toString('latin1').replace(/\0/g, '');
  return { value, next: index < content.length ? index + 1 : index };
}

function readPdfArray(content, start) {
  const values = [];
  let index = start + 1;
  while (index < content.length) {
    const character = content[index];
    if (character === ']') return { value: values.join(''), next: index + 1 };
    if (character === '(') {
      const token = readPdfLiteral(content, index);
      if (token.value) values.push(token.value);
      index = token.next;
      continue;
    }
    if (character === '<' && content[index + 1] !== '<') {
      const token = readPdfHex(content, index);
      if (token.value) values.push(token.value);
      index = token.next;
      continue;
    }
    index += 1;
  }
  return { value: values.join(''), next: index };
}

function pdfTextPieces(content) {
  const pieces = [];
  let operand = '';
  let index = 0;
  while (index < content.length) {
    const character = content[index];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === '%') {
      const newline = content.indexOf('\n', index + 1);
      index = newline < 0 ? content.length : newline + 1;
      continue;
    }
    if (character === '(') {
      const token = readPdfLiteral(content, index);
      operand = token.value;
      index = token.next;
      continue;
    }
    if (character === '<' && content[index + 1] !== '<') {
      const token = readPdfHex(content, index);
      operand = token.value;
      index = token.next;
      continue;
    }
    if (character === '[') {
      const token = readPdfArray(content, index);
      operand = token.value;
      index = token.next;
      continue;
    }
    const start = index;
    while (index < content.length && !/\s|[()[\]<>]/.test(content[index])) index += 1;
    if (index === start) {
      index += 1;
      continue;
    }
    const operator = content.slice(start, index);
    if (operator === 'Tj' || operator === 'TJ') {
      if (operand) pieces.push(operand);
      operand = '';
    } else if (operator === "'" || operator === '"') {
      pieces.push('\n');
      if (operand) pieces.push(operand);
      operand = '';
    } else if (operator === 'T*' || operator === 'Td' || operator === 'TD' || operator === 'ET') {
      pieces.push('\n');
      operand = '';
    }
  }
  return pieces;
}

export function readPdfText(buffer) {
  const raw = buffer.toString('latin1');
  const chunks = [];
  let decodedBytes = 0;
  let streamCount = 0;
  let index = 0;
  while (index < raw.length) {
    const streamStart = raw.indexOf('stream', index);
    if (streamStart < 0) break;
    let start = streamStart + 'stream'.length;
    if (raw[start] === '\r') start += 1;
    if (raw[start] === '\n') start += 1;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    const body = Buffer.from(raw.slice(start, end), 'latin1');
    const decoded = body.subarray(0, 5).toString('latin1') === '<?xml' ? body : (inflate(body) ?? inflate(body, true) ?? body);
    decodedBytes += decoded.length;
    streamCount += 1;
    if (decodedBytes > MAX_PDF_DECODED_BYTES || streamCount > MAX_PDF_STREAMS) throw new Error('PDF decoded content exceeds the safety limit');
    chunks.push(decoded.toString('latin1'));
    index = end + 'endstream'.length;
  }
  const content = chunks.join('\n');

  const pieces = pdfTextPieces(content);
  const text = pieces.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const printable = text.replace(/[^\p{L}\p{N}\p{P}\p{Zs}\n\t]/gu, '');
  if (text.length < 8 || printable.length / Math.max(1, text.length) < 0.7) {
    throw new Error('This PDF has no extractable text — it is a scan, or it uses embedded fonts the built-in reader cannot decode. Run a text extraction tool on that computer (for example pdftotext) and read the result instead.');
  }
  return text;
}

export function documentKind(filePath) {
  const lower = String(filePath).toLowerCase();
  if (lower.endsWith('.docx')) return 'docx';
  if (lower.endsWith('.pdf')) return 'pdf';
  return '';
}
