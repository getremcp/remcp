import { renderUnicodeCompact } from 'uqr';

const USER_CODE_PATTERN = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/;

// A QR is a shortcut to the existing device review screen, not a login token.
// Only encode the same-origin HTTPS /device URL containing this exact short-lived code.
export function formatPairingQr({ server, approvalUrl, userCode, output = process.stdout, env = process.env }) {
  if (!output?.isTTY || env.TERM === 'dumb' || env.NO_COLOR) return null;
  if (!USER_CODE_PATTERN.test(String(userCode))) return null;

  let origin;
  let url;
  try {
    origin = new URL(server);
    url = new URL(approvalUrl);
  } catch { return null; }
  if (origin.protocol !== 'https:' || url.protocol !== 'https:' || url.origin !== origin.origin ||
    url.username || url.password || url.hash || url.pathname !== '/device' ||
    url.searchParams.size !== 1 || url.searchParams.get('user_code') !== userCode) return null;

  // Each pair of QR rows fits into one terminal line. Use explicit light/dark ANSI
  // colors so the quiet zone remains scannable regardless of terminal theme.
  let qr;
  try { qr = renderUnicodeCompact(url.href, { ecc: 'M', border: 3 }); }
  catch { return null; }
  const columns = Number.isFinite(output.columns) && output.columns > 0 ? output.columns : 80;
  const rows = qr.split('\n');
  if (rows.some(row => [...row].length + 2 > columns)) return null;
  // The library paints a dark lower half outside odd-sized matrices.
  // Restore the white bottom quiet zone so phone cameras can detect it.
  const last = rows.length - 1;
  rows[last] = rows[last].replaceAll('▀', '█');
  return rows.map(row => `\x1b[97;40m${row}\x1b[0m`).join('\n');
}

export function printPairingQr({ server, approvalUrl, userCode, output = process.stdout, env = process.env }) {
  const qr = formatPairingQr({ server, approvalUrl, userCode, output, env });
  if (!qr) return false;
  output.write('Scan with your phone to review this computer:\n');
  output.write(qr + '\n');
  output.write('Check the computer name before approving.\n');
  return true;
}
