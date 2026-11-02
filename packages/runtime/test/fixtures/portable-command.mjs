// A child-process fixture that exercises ReMCP's actual Windows cmd.exe shell
// without assuming Linux printf, sleep, or /bin/sh exist on the machine.
export function portableCommand(posixCommand, jsSource) {
  if (process.platform !== 'win32') return posixCommand;
  const encoded = Buffer.from(jsSource, 'utf8').toString('base64');
  return `"${process.execPath}" -e "eval(Buffer.from('${encoded}','base64').toString('utf8'))"`;
}
