#!/usr/bin/env node
// Dependency-free validation shared with the public npm/plugin repository.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function decodePngPixels(buffer) {
  assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'plugin icon must be a PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  assert.equal(bitDepth, 8, 'plugin icon PNG must use 8-bit channels');
  assert.ok(colorType === 2 || colorType === 6, 'plugin icon PNG must be RGB or RGBA');
  assert.equal(interlace, 0, 'plugin icon PNG must be non-interlaced for deterministic validation');
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  assert.equal(raw.length, height * (stride + 1), 'plugin icon PNG has an unexpected decoded size');
  const rows = [];
  let cursor = 0;
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor++];
    const encoded = raw.subarray(cursor, cursor + stride);
    cursor += stride;
    const row = Buffer.alloc(stride);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? row[x - channels] : 0;
      const up = previous[x] || 0;
      const upLeft = x >= channels ? previous[x - channels] : 0;
      const source = encoded[x];
      if (filter === 0) row[x] = source;
      else if (filter === 1) row[x] = (source + left) & 0xff;
      else if (filter === 2) row[x] = (source + up) & 0xff;
      else if (filter === 3) row[x] = (source + Math.floor((left + up) / 2)) & 0xff;
      else if (filter === 4) row[x] = (source + paeth(left, up, upLeft)) & 0xff;
      else assert.fail(`unsupported PNG filter ${filter}`);
    }
    rows.push(row);
    previous = row;
  }
  return { width, height, channels, rows };
}

function assertPluginIconLegible(buffer, brandColor) {
  const decoded = decodePngPixels(buffer);
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(brandColor || ''));
  assert.ok(match, 'brandColor must be available before validating the plugin icon');
  const brand = match.slice(1).map(value => Number.parseInt(value, 16));
  let brandPixels = 0;
  let brightPixels = 0;
  let transparentPixels = 0;
  let total = 0;
  for (const row of decoded.rows) {
    for (let x = 0; x < decoded.width; x += 1) {
      const index = x * decoded.channels;
      const rgb = [row[index], row[index + 1], row[index + 2]];
      const alpha = decoded.channels === 4 ? row[index + 3] : 255;
      total += 1;
      if (alpha < 250) transparentPixels += 1;
      if (rgb.every((value, channel) => Math.abs(value - brand[channel]) <= 4)) brandPixels += 1;
      if (rgb.every(value => value >= 235) && alpha >= 250) brightPixels += 1;
    }
  }
  assert.equal(transparentPixels, 0, 'plugin icon must be opaque so a dark transparent mark cannot disappear on dark ChatGPT surfaces');
  assert.ok(brandPixels / total >= 0.45, 'plugin icon must visibly use the declared brandColor as its background');
  assert.ok(brightPixels / total >= 0.08, 'plugin icon must contain a substantial bright mark that contrasts on the brand background');
}

export function checkPlugin(root = fileURLToPath(new URL('..', import.meta.url))) {
  const read = file => readFileSync(join(root, file));
  const plugin = JSON.parse(read('plugin.json'));
  const pkg = JSON.parse(read('package.json'));
  const mcp = JSON.parse(read('mcp.json'));
  assert.equal(plugin.version, pkg.version, 'plugin and package versions must match');
  assert.equal(mcp.mcpServers.remcp.type, 'streamable-http');
  assert.equal(mcp.mcpServers.remcp.url, 'https://remcp.site/mcp');
  const files = ['plugin.json', 'mcp.json'];
  const iface = plugin.extensions['com.openai'].interface;
  assert.deepEqual(iface.capabilities, ['Read', 'Write'], 'OpenAI interface declares the read/write capability shown by the actual tool surface');
  for (const asset of new Set([iface.logo, iface.composerIcon])) {
    assert.match(asset, /^\.\/assets\/[\w.-]+$/, 'icons must be bundled assets');
    files.push(asset.slice(2));
  }
  assertPluginIconLegible(read(iface.logo.slice(2)), iface.brandColor);
  if (iface.screenshots !== undefined) {
    assert.ok(Array.isArray(iface.screenshots) && iface.screenshots.length > 0, 'screenshots must be a non-empty array when supplied');
    assert.equal(iface.screenshots.length, iface.defaultPrompt?.length || 0, 'OpenAI requires exactly one screenshot for each starter prompt when screenshots are supplied');
    const dimensions = buffer => {
      const isPng = buffer.length >= 24 && buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
      if (isPng) return { type:'png', width:buffer.readUInt32BE(16), height:buffer.readUInt32BE(20) };
      if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
        let offset = 2;
        while (offset + 8 < buffer.length) {
          if (buffer[offset] !== 0xff) { offset += 1; continue; }
          const marker = buffer[offset + 1];
          offset += 2;
          if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
          if (offset + 2 > buffer.length) break;
          const length = buffer.readUInt16BE(offset);
          if (length < 2 || offset + length > buffer.length) break;
          if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
            return { type:'jpeg', height:buffer.readUInt16BE(offset + 3), width:buffer.readUInt16BE(offset + 5) };
          }
          offset += length;
        }
      }
      return null;
    };
    for (const asset of iface.screenshots) {
      assert.match(asset, /^\.\/assets\/[\w.-]+\.(?:png|jpe?g)$/i, 'screenshots must be bundled PNG or JPEG assets');
      const relative = asset.slice(2);
      const image = read(relative);
      const size = dimensions(image);
      assert.ok(size, `${relative} is a valid PNG or JPEG`);
      assert.equal(size.width, 706, `${relative} must be exactly 706 px wide`);
      assert.ok(size.height >= 400 && size.height <= 860, `${relative} height must be 400–860 px`);
      files.push(relative);
    }
  }
  const walk = relative => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const file = `${relative}/${entry.name}`;
      assert.ok(!entry.isSymbolicLink(), `symlink cannot be bundled: ${file}`);
      if (entry.isDirectory()) walk(file);
      else files.push(file);
    }
  };
  const skills = readdirSync(join(root, 'skills'), { withFileTypes: true }).filter(entry => entry.isDirectory());
  assert.equal(skills.length, 5, 'the repository keeps all five cross-client ReMCP workflows');
  const openAiExcludedSkills = new Set(['run-and-watch-processes']);
  const publishedSkills = [];
  for (const { name } of skills) {
    const skillPath = `skills/${name}`;
    const md = read(`${skillPath}/SKILL.md`).toString();
    assert.ok(md.startsWith(`---\nname: ${name}\ndescription: `), `${name} front matter`);
    assert.match(md, /\ndescription: .+\n---\n/);
    const metadata = read(`${skillPath}/agents/openai.yaml`).toString();
    assert.match(metadata, /display_name: ".+"/);
    assert.match(metadata, /short_description: ".+"/);
    assert.match(metadata, /value: "remcp"/);
    assert.match(metadata, /transport: "streamable_http"/);
    assert.match(metadata, /url: "https:\/\/remcp.site\/mcp"/);
    if (openAiExcludedSkills.has(name)) continue;
    publishedSkills.push(name);
    walk(skillPath);
  }
  assert.deepEqual(
    publishedSkills.sort(),
    ['change-code-and-verify','remcp-operator','safe-destructive-operations','transfer-files-between-machines'],
    'the OpenAI archive contains only the four reviewed skills',
  );
  for (const file of files.filter(file => file.endsWith('.md'))) {
    for (const match of read(file).toString().matchAll(/\]\((references\/[^)#]+)(?:#[^)]*)?\)/g)) {
      assert.ok(files.includes(join(dirname(file), match[1])), `missing reference in ${file}: ${match[1]}`);
    }
  }
  // Validate the actual upload, not just the source tree. Our ZIP writer stores entries without
  // compression so this check runs in a bare checkout without installing an unzip dependency.
  const zip = read('submission/remcp-plugin.zip');
  const entries = new Map();
  let offset = 0;
  while (offset + 30 <= zip.length && zip.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(zip.readUInt16LE(offset + 8), 0, 'archive entries must be stored');
    const size = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    const name = zip.subarray(offset + 30, offset + 30 + nameLength).toString();
    const start = offset + 30 + nameLength + extraLength;
    assert.ok(start + size <= zip.length, 'truncated ZIP entry');
    assert.ok(!entries.has(name), `duplicate ZIP entry: ${name}`);
    entries.set(name, zip.subarray(start, start + size));
    offset = start + size;
  }
  assert.deepEqual([...entries.keys()].sort(), files.sort(), 'archive must contain the entire portable plugin');
  for (const file of files) assert.deepEqual(entries.get(file), read(file), `stale archive entry: ${file}`);
  return { skills: publishedSkills.length, repositorySkills: skills.length, files: files.length, version: plugin.version };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkPlugin();
  console.log(`Plugin ${result.version}: ${result.skills} OpenAI skills (${result.repositorySkills} repository skills), ${result.files} archived files; archive matches the reviewed allowlist.`);
}
