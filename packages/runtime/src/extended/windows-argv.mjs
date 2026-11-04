// Start-Process joins ArgumentList into one command-line string. Encode each
// argument using the Windows CRT quoting rules before handing that string over.
export function quoteWindowsArgument(value) {
  const argument = String(value);
  if (argument.includes('\0')) throw new Error('Application arguments must not contain NUL');
  const escaped = argument.replace(/(\\*)"/g, (_, slashes) => `${slashes}${slashes}\\"`)
    .replace(/\\+$/g, slashes => slashes + slashes);
  return `"${escaped}"`;
}
