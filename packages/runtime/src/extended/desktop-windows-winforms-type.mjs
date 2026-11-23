// Strict scoped computer_type -> WinForms native UIA bridge.
// Only a fresh same-window/native-ID value can establish a CAS precondition.
// No clipboard, keystrokes, focus stealing, or text in returned attestation.
const idPattern=/^win:-?\d+(?:\.-?\d+)*$/;
const hwndPattern=/^0x[0-9a-f]{1,16}$/i;
const sensitive=/password|passphrase|passcode|secret|token|otp|recovery[\s-]*code|api[\s-]*key|\bpin\b|two[\s-]*factor|verification[\s-]*code/i;
const control=/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;

export function eligibleWinFormsTextTarget(args={}){
  const id=String(args.id||''),title=String(args.window_title||args.windowTitle||'');
  const hwnd=String(args.window_id||args.windowId||'');
  return args.clear===true && args.press_enter!==true &&
    idPattern.test(id)&&hwndPattern.test(hwnd)&&
    Number.isSafeInteger(args.pid)&&args.pid>0&&title.length>0&&title.length<=512&&
    !control.test(title)&&
    (args.role==null||args.role==='Edit')&&
    (args.name==null||typeof args.name==='string') &&
    (args.method==null||args.method==='auto'||args.method==='accessibility');
}

export async function strictWinFormsText(args,{
  uiSnapshot,uiAction,resultValue
}){
  if(!eligibleWinFormsTextTarget(args))return null;
  const replacement=String(args.text??'');
  if(replacement.length<1||replacement.length>256||control.test(replacement))
    throw Error('Native WinForms text requires bounded ordinary single-line replacement');
  const windowTitle=String(args.window_title||args.windowTitle);
  const windowId=String(args.window_id||args.windowId);
  // Do not trust a cached, potentially stale accessibility element or a label.
  const snapshot=resultValue(await uiSnapshot({
    pid:args.pid,window_title:windowTitle,max_nodes:200,max_depth:8,
    semantic_tree:false,
  }));
  const nodes=Array.isArray(snapshot?.nodes)?snapshot.nodes:[];
  const roots=nodes.filter(node=>node.id&&
    node.pid===args.pid&&node.window_id===windowId&&
    node.active===true&&node.window===windowTitle&&
    ['Window','Dialog','Frame'].includes(node.role));
  const targets=nodes.filter(node=>node.id===args.id&&
    node.pid===args.pid&&node.window===windowTitle);
  if(roots.length!==1||targets.length!==1)
    throw Error('Native WinForms text target is not uniquely foreground verified');
  const element=targets[0];
  if(element.role!=='Edit'||element.password!==false||
     element.enabled!==true||element.offscreen===true||
     element.focusable!==true||
     !String(element.className||'').startsWith('WindowsForms10.EDIT.')||
     !Array.isArray(element.patterns)||!element.patterns.includes('value')||
     typeof element.value!=='string'||element.value.length>256||
     !element.name||sensitive.test(element.name)||
     args.name!=null&&args.name!==element.name)
    throw Error('Native WinForms target is not verified ordinary editable text');
  // A second independent OS-level CAS and identity/foreground check happens
  // inside desktop-windows.uiAction, immediately before the actual message.
  const result=resultValue(await uiAction({
    action:'set_value',id:element.id,pid:args.pid,
    window_id:windowId,window_title:windowTitle,
    app:element.app,name:element.name,role:'Edit',
    strict_target_id:true,semantic_only:true,
    expected_value:element.value,value:replacement,
  }));
  if(result?.foreground_after!==true||result?.value_matches_after!==true||
     result?.backend!=='Win32WMSetText')
    throw Error('Native WinForms mutation lacks verified OS readback');
  return {length:replacement.length,method:'accessibility',
    clear:true,press_enter:false,verified:true,backend:'Win32WMSetText'};
}
