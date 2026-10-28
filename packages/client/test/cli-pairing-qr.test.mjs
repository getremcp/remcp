import test from 'node:test';
import assert from 'node:assert/strict';
import { encode } from 'uqr';
import { formatPairingQr, printPairingQr } from '../src/cli/pairing-qr.mjs';

const origin = 'https://remcp.site';
const code = 'ABCD-EFGH';
const approvalUrl = `${origin}/device?user_code=${code}`;
const tty = { isTTY: true, columns: 80 };

test('terminal QR uses the exact existing expiring device-approval URL', () => {
  const qr = formatPairingQr({ server: origin, approvalUrl, userCode: code, output: tty, env: {} });
  assert.ok(qr, 'the QR must render on a supported interactive terminal');
  assert.match(qr, /\x1b\[97;40m/);
  const lines = qr.split('\n').map(line => line.replace(/\x1b\[[0-9;]*m/g, ''));
  const matrix = encode(approvalUrl, { ecc: 'M', border: 3 });
  assert.equal(lines.length, Math.ceil(matrix.size / 2));
  assert.equal(lines[0].length, matrix.size);
  assert.ok(lines.every(line => line.length === matrix.size));
  // Check every QR cell survives compact rendering, including the quiet zone.
  for (let row = 0; row < lines.length; row++) {
    for (let col = 0; col < matrix.size; col++) {
      const glyph = lines[row][col];
      const top = glyph === '▄' || glyph === ' ';
      const bottom = glyph === '▀' || glyph === ' ';
      assert.equal(top, matrix.data[row * 2]?.[col] ?? false);
      assert.equal(bottom, matrix.data[row * 2 + 1]?.[col] ?? false);
    }
  }
});

test('QR output never replaces manual code, and has concise safety guidance', () => {
  let text = '';
  const output = { isTTY: true, columns: 90, write: chunk => { text += chunk; } };
  assert.equal(printPairingQr({ server: origin, approvalUrl, userCode: code, output, env: {} }), true);
  assert.match(text, /Scan with your phone/);
  assert.match(text, /Check the computer name before approving/);
  assert.ok(text.includes('\x1b[97;40m'));
});

test('QR is skipped safely when there is no readable interactive terminal', () => {
  for (const options of [
    { output: { isTTY: false, columns: 120 }, env: {} },
    { output: { isTTY: true, columns: 20 }, env: {} },
    { output: tty, env: { TERM: 'dumb' } },
    { output: tty, env: { NO_COLOR: '1' } },
  ]) {
    assert.equal(formatPairingQr({ server: origin, approvalUrl, userCode: code, ...options }), null);
  }
});

test('QR rejects links that could redirect a phone or reveal another code', () => {
  for (const [server, url, userCode] of [
    [origin, 'https://attacker.example/device?user_code=ABCD-EFGH', code],
    [origin, 'http://remcp.site/device?user_code=ABCD-EFGH', code],
    [origin, 'https://remcp.site/device?user_code=ZZZZ-2222', code],
    [origin, 'https://remcp.site/device?user_code=ABCD-EFGH&next=https://bad.example', code],
    [origin, 'https://remcp.site/device?user_code=ABCD-EFGH#fragment', code],
    [origin, 'https://remcp.site/device/other?user_code=ABCD-EFGH', code],
    ['http://localhost:3000', 'http://localhost:3000/device?user_code=ABCD-EFGH', code],
    [origin, approvalUrl, 'abcd-efgh'],
    [origin, approvalUrl, 'ABCD-1234'],
  ]) {
    assert.equal(formatPairingQr({ server, approvalUrl: url, userCode, output: tty, env: {} }), null);
  }
});
