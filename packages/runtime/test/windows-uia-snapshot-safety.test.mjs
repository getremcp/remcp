import test from 'node:test';
import assert from 'node:assert/strict';
import {uiSnapshot} from '../src/extended/desktop-windows.mjs';
import {resultValue} from '../src/extended/desktop-core.mjs';

async function captureSource(){
  let script='',calls=0;
  const response=await uiSnapshot({
    pid:1234,window_title:'ReMCP WPF Native QA2',
    max_nodes:40,max_depth:6,
  },{
    runPowerShellFn:async source=>{
      calls++;script=source;
      return {stdout:JSON.stringify({platform:'win32',nodes:[],count:0})};
    },
  });
  assert.equal(calls,1);
  assert.equal(resultValue(response).count,0);
  return script;
}

test('Windows UIA native snapshot uses live ValuePattern for WPF text fields',async()=>{
  const script=await captureSource();
  const block=script.split('\n').find(line=>line.includes('if(-not $privateField){$p=$null;'));
  assert.ok(block,'one protected read block must exist');
  assert.match(block,/GetCachedPattern/);
  assert.match(block,/GetCurrentPattern/);
  assert.match(block,/\$value=\$p\.Current\.Value/);
  assert.ok(block.indexOf('GetCurrentPattern')>block.indexOf('GetCachedPattern'));
  assert.ok(block.indexOf('$value=$p.Current.Value')>block.indexOf('GetCurrentPattern'));
});

test('Windows ambiguous WinForms EDIT Pane hides name and value',async()=>{
  const script=await captureSource();
  assert.match(script,/ControlType\.Pane' -and \$c\.ClassName -match '\^WindowsForms10\\\.EDIT'/);
  assert.match(script,/name=\$\(if\(\$privateField\)\{''\}else\{\$c\.Name\}\)/);
  assert.match(script,/password=\$privateField/);
  assert.match(script,/if\(-not \$privateField\).*GetCurrentPattern/);
  assert.match(script,/if\(-not \$privateField -and \(\$null -eq \$value/);
});

test('LegacyIAccessiblePattern is feature-detected and optional under PS 5.1',async()=>{
  const script=await captureSource();
  assert.match(script,/LegacyIAccessiblePattern' -as \[type\]/);
  assert.match(script,/if\(\$legacyType\)/);
  assert.match(script,/if\(\$legacyPattern\)/);
  assert.doesNotMatch(script,/\[System\.Windows\.Automation\.LegacyIAccessiblePattern\]::Pattern/);
  assert.match(script,/GetCachedPattern\(\$legacyPattern\)/);
  assert.match(script,/if\(-not \$privateField -and \(\$null -eq \$value/);
});

test('native snapshot retains target PID and current foreground check',async()=>{
  const script=await captureSource();
  assert.match(script,/GetCurrentProcess\(\)\.SessionId -eq 0/);
  assert.match(script,/\$windowForeground=\(\$h -eq \[RMFG\]::GetForegroundWindow\(\)\)/);
  assert.match(script,/active=\(\$d -eq 0 -and \$windowForeground\)/);
  assert.match(script,/1234 -eq 0 -or \$_.Id -eq 1234/);
  assert.match(script,/ReMCP WPF Native QA2/);
  assert.match(script,/window_id=\$\(if\(\$d -eq 0\)/);
  assert.match(script,/0x\{0:X\}' -f \$h.ToInt64\(\)/);
});

test('legacy MSAA fallback never reads unverified edit or protected values',async()=>{
  const {readFileSync}=await import('node:fs');
  const source=readFileSync(
    new URL('../src/extended/desktop-windows-msaa.mjs',import.meta.url),'utf8');
  const secure=source.indexOf('$privateByRole=($role -eq 42');
  const nameGuard=source.indexOf('if(-not $privateByRole){try{$name=[string]$acc.get_accName(0)}');
  const guard=source.indexOf('if(-not $privateField){try{$value=[string]$acc.get_accValue(0)}');
  const read=source.indexOf('$acc.get_accValue(0)');
  assert.ok(secure>0&&nameGuard>secure&&guard>nameGuard&&read>guard);
  assert.match(source,/STATE_SYSTEM_PROTECTED|0x20000000/);
  assert.match(source,/name=\$\(if\(\$privateField\)\{''\}else\{\$name\}\)/);
  assert.match(source,/password=\$privateField/);
  assert.match(source,/if\(-not \$privateField -and \$role -in @\(42,46,47\)\)/);
});
