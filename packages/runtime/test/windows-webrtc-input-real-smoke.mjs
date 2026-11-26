// Explicit operator-only smoke test on a visible Windows QA desktop.
// Focus the unique QA window; the test never sends input without verified foreground.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {windowsPowerShellArguments} from '../src/extended/common.mjs';
import {windowsInteropLoad} from '../src/extended/windows-interop.mjs';
import {createWindowsWebRtcInput} from '../src/extended/desktop-windows-webrtc-input.mjs';

assert.equal(process.platform,'win32','Requires real Windows');
assert.equal(process.env.REMCP_QA_NATIVE_INPUT,'1','Explicit opt-in required; uses an isolated foreground QA window');
const title='ReMCP isolated input QA';
const form=String.raw`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
${windowsInteropLoad('foreground')}
$form=New-Object System.Windows.Forms.Form
$form.Text='${title}'
$form.Size=New-Object System.Drawing.Size(440,160)
$form.StartPosition='CenterScreen'
$form.TopMost=$true
$box=New-Object System.Windows.Forms.TextBox
$box.Dock='Fill'
$box.Multiline=$true
$form.Controls.Add($box)
$expected=' ReMCP-QA-'+([string][char]0x041f)+([string][char]0x0440)+([string][char]0x0438)+([string][char]0x0432)+([string][char]0x0435)+([string][char]0x0442)+'!'
$script:ready=$false
$script:space=$false
$script:typed=$false
$script:initial=[string](Get-Clipboard -Raw -ErrorAction Stop)
$clock=[Diagnostics.Stopwatch]::StartNew()
$timer=New-Object System.Windows.Forms.Timer
$timer.Interval=50
$form.Add_Shown({$form.BringToFront();$form.Activate();[void]$box.Focus();[Console]::WriteLine('SHOWN')})
$box.Add_MouseClick({if($script:ready -and [RMFG]::GetForegroundWindow() -eq $form.Handle){[Console]::WriteLine('CLICK_OK')}})
$timer.Add_Tick({
 if($clock.ElapsedMilliseconds -gt 55000){[Console]::WriteLine('QA_TIMEOUT');$form.Close();return}
 if([RMFG]::GetForegroundWindow() -ne $form.Handle -or -not $form.ContainsFocus -or -not $box.Focused){
  if($script:ready){[Console]::WriteLine('FOCUS_LOST');$form.Close()}
  return
 }
 if(-not $script:ready){
  $p=$box.PointToScreen((New-Object System.Drawing.Point([int]($box.Width/2),[int]($box.Height/2))))
  $r=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  if(-not $r.Contains($p)){[Console]::WriteLine('QA_OUTSIDE_PRIMARY');$form.Close();return}
  $script:ready=$true
  $coords=[pscustomobject]@{x=($p.X-$r.X)/($r.Width-1);y=($p.Y-$r.Y)/($r.Height-1)}
  [Console]::WriteLine('READY:'+($coords|ConvertTo-Json -Compress))
 }
 if(-not $script:space -and $box.Text -ceq ' '){$script:space=$true;[Console]::WriteLine('SPACE_OK')}
 if($script:space -and -not $script:typed -and $box.Text -ceq $expected){$script:typed=$true;[Console]::WriteLine('TEXT_OK')}
 if($script:typed -and $box.Text -ceq $expected.Substring(0,$expected.Length-1)){
  if(([string](Get-Clipboard -Raw -ErrorAction Stop)) -ceq $script:initial){[Console]::WriteLine('KEY_AND_CLIPBOARD_OK')}
  else{[Console]::WriteLine('CLIPBOARD_MISMATCH')}
  $form.Close()
 }
})
$timer.Start()
[void]$form.ShowDialog()
$timer.Dispose()
$form.Dispose()
`;
const worker=createWindowsWebRtcInput();
const ps=path.win32.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
const app=spawn(ps,windowsPowerShellArguments(form),{stdio:['ignore','pipe','pipe'],windowsHide:false});
let data='';
app.stdout.setEncoding('utf8');
app.stdout.on('data',chunk=>{data+=chunk;});
app.stderr.on('data',()=>{});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function wait(token,timeout=35_000){
 const end=Date.now()+timeout;
 while(!data.includes(token)&&Date.now()<end&&app.exitCode===null&&!/FOCUS_LOST|QA_TIMEOUT|QA_OUTSIDE_PRIMARY/.test(data))await sleep(40);
 assert.ok(data.includes(token),'Native QA did not observe '+token);
}
let seq=0;
const timed=async input=>{
 assert.ok(app.exitCode===null&&!data.includes('FOCUS_LOST'),'QA window is no longer active');
 const at=performance.now();
 await worker.dispatch({seq:++seq,...input});
 return Math.round(performance.now()-at);
};
try{
 worker.prepare();
 console.log('Focus the visible QA window: '+title);
 await wait('READY:');
 const match=data.match(/READY:(\{[^\r\n]+\})/);
 assert.ok(match);
 const point=JSON.parse(match[1]);
 assert.ok([point.x,point.y].every(v=>Number.isFinite(v)&&v>=0&&v<=1));
 const pointerMs=[];
 for(let i=0;i<5;i++)pointerMs.push(await timed({kind:'pointer',op:'move',...point}));
 const clickMs=await timed({kind:'pointer',op:'click',button:'left',...point});
 await wait('CLICK_OK');
 const spaceMs=await timed({kind:'keyboard',shortcut:'Space'});
 await wait('SPACE_OK');
 const textMs=await timed({kind:'text',text:'ReMCP-QA-Привет!'});
 await wait('TEXT_OK');
 const keyboardMs=await timed({kind:'keyboard',shortcut:'Backspace'});
 await wait('KEY_AND_CLIPBOARD_OK');
 console.log(JSON.stringify({pointerMs,clickMs,spaceMs,textMs,keyboardMs,clipboardRestored:true}));
 console.log('WINDOWS_NATIVE_WEBRTC_INPUT_PASS');
}finally{
 await worker.close();
 if(app.exitCode===null)app.kill();
}
