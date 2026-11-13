// Strict native Windows UIA identity for explicit semantic actions.
import {escapePowerShellSingle} from './common.mjs';

export function strictWindowsActionGate(args={}){
  if(args.strict_target_id!==true)return '';
  const id=String(args.id||''),pid=args.pid;
  const name=String(args.name||''),role=String(args.role||'');
  // UIA providers sometimes mislabel sensitive controls as ordinary Edit.
  // Block explicitly sensitive semantic names before running any OS script.
  if(args.action==='set_value'&&/password|passphrase|passcode|secret|token|otp|recovery[\s-]*code|api[\s-]*key|\bpin\b|two[\s-]*factor|verification[\s-]*code/i.test(name))
    throw Error('Strict Windows GUI action refuses sensitive text field');
  if(!/^win:-?\d+(?:\.-?\d+)*$/.test(id)||
    !Number.isSafeInteger(pid)||pid<=0||
    !name||name.length>180||!role||role.length>70||
    /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(name+role))
    throw Error('Strict Windows GUI action needs exact native ID, PID, name and role');
  const title=String(args.window_title||args.windowTitle||'');
  if(title.length>512||/[\u0000-\u001f\u007f]/u.test(title))
    throw Error('Strict Windows GUI action has an invalid window title');
  const hwnd=strictWindowsHwnd(args);
  const expected=escapePowerShellSingle(title);
  return [
    "if(-not [RMFG]::IsWindow($h)){throw 'Native guided action refused: HWND is invalid'}",
    "if($h.ToInt64() -ne "+hwnd.toString()+"){throw 'Native guided action refused: HWND changed'}",
    "$osPid=[uint32]0",
    "[void][RMFG]::GetWindowThreadProcessId($h,[ref]$osPid)",
    "if($osPid -ne "+pid+"){throw 'Native guided action refused: HWND owner changed'}",
    "if($rootPid -ne "+pid+"){throw 'Native guided action refused: root process changed'}",
    "if('"+expected+"' -ne '' -and $windowName -cne '"+expected+"'){",
    " throw 'Native guided action refused: root window title changed'",
    "}",
  ].join('\n');
}

// A strict root is resolved from its exact observed HWND, never from a
// process MainWindowHandle that may identify a different dialog.
export function strictWindowsHwnd(args={}){
  if(args.strict_target_id!==true)return null;
  const raw=String(args.window_id||'');
  if(!/^0x[0-9a-fA-F]{1,16}$/.test(raw))
    throw Error('Strict Windows GUI action requires an exact native HWND');
  const hwnd=BigInt(raw);
  if(hwnd<=0n||hwnd>0x7fffffffffffffffn)
    throw Error('Strict Windows GUI action has an invalid HWND');
  return hwnd;
}
