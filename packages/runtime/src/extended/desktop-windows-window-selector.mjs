// Validate an observed HWND again immediately before native window mutation.
import { escapePowerShellSingle, optionalString } from './common.mjs';

export function windowsWindowSelector(args = {}) {
  const rawId = optionalString(args.id) || '';
  if (rawId && !/^0x[0-9a-fA-F]{1,16}$/.test(rawId))
    throw Error('Windows window action refused: invalid native HWND');
  const handle = rawId ? BigInt(rawId) : 0n;
  if (rawId && (handle <= 0n || handle > 0x7fffffffffffffffn))
    throw Error('Windows window action refused: out-of-range native HWND');
  const specifiedPid = args.pid !== undefined && args.pid !== null && args.pid !== '';
  const pid = specifiedPid ? Number(args.pid) : 0;
  if (specifiedPid && (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff))
    throw Error('Windows window action refused: invalid owner PID');
  const app = optionalString(args.app) || '';
  const title = optionalString(args.title) || '';
  if (app.length > 128 || title.length > 512 ||
    /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(app + title))
    throw Error('Windows window action refused: invalid app or title');
  const appQuoted = escapePowerShellSingle(app);
  const titleQuoted = escapePowerShellSingle(title);
  const expr = rawId ? '[IntPtr]::new(' + handle.toString() + ')' : '[IntPtr]::Zero';
  const lines = [
    "if([Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0 -or -not [Environment]::UserInteractive){throw 'Windows window action requires an interactive user desktop'}",
    '$h=' + expr,
    "if($h -eq [IntPtr]::Zero){$p=Get-Process|Where-Object{$_.MainWindowHandle -ne 0 -and (" +
      pid + " -eq 0 -or $_.Id -eq " + pid + ") -and ('" + appQuoted +
      "' -eq '' -or $_.ProcessName -like '*" + appQuoted + "*') -and ('" +
      titleQuoted + "' -eq '' -or $_.MainWindowTitle -like '*" + titleQuoted +
      "*')}|Select-Object -First 1;if(-not $p){throw 'No matching window found'};$h=$p.MainWindowHandle}",
    "if(-not [RMFG]::IsWindow($h)){throw 'Windows window action refused: HWND is invalid'}",
    '$nativePid=[uint32]0',
    '[void][RMFG]::GetWindowThreadProcessId($h,[ref]$nativePid)',
    "if($nativePid -eq 0){throw 'Windows window action refused: HWND owner missing'}",
  ];
  if (pid)
    lines.push("if($nativePid -ne " + pid + "){throw 'Windows window action refused: HWND owner changed'}");
  if (app) lines.push(
    "$nativeApp=(Get-Process -Id $nativePid -ErrorAction SilentlyContinue).ProcessName",
    "if(-not $nativeApp -or $nativeApp.IndexOf('" + appQuoted +
      "',[StringComparison]::OrdinalIgnoreCase) -lt 0){throw 'Windows window action refused: application changed'}",
  );
  if (title) lines.push(
    '$nativeCaption=New-Object System.Text.StringBuilder 513',
    '[void][RMFG]::GetWindowText($h,$nativeCaption,$nativeCaption.Capacity)',
    "if($nativeCaption.ToString().IndexOf('" + titleQuoted +
      "',[StringComparison]::OrdinalIgnoreCase) -lt 0){throw 'Windows window action refused: title changed'}",
  );
  return lines.join('\n');
}
