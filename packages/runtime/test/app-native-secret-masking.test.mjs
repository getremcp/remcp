import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read=name=>readFileSync(new URL('../src/extended/'+name,import.meta.url),'utf8');

test('Windows UIA does not query password ValuePattern or LegacyIAccessible contents',()=>{
  const s=read('desktop-windows.mjs');
  assert.match(s,/if\(-not \$privateField\)\{\$p=\$null;try\{\$p=\[System\.Windows\.Automation\.ValuePattern\]/);
  assert.match(s,/if\(-not \$p\)\{try\{\$p=\[System\.Windows\.Automation\.ValuePattern\]\$e.GetCurrentPattern/);
  assert.match(s,/if\(\$p\)\{try\{\$value=\$p.Current.Value/);
  assert.match(s,/if\(-not \$privateField -and \(\$null -eq \$value/);
  assert.match(s,/password=\$privateField/);
  assert.match(s,/privateField=\(\$c\.IsPassword -or/);
});
test('macOS AX does not extract the value of password or secure subrole',()=>{
  const s=read('desktop-macos.mjs');
  assert.ok(s.includes('const protectedValue=/secure|password|passphrase|passcode'));
  assert.ok(s.includes("role+' '+subrole+' '+name"));
  assert.match(s,/rawValue=protectedValue\?'':scalar\(p\.value\)/);
  assert.match(s,/password:protectedValue/);
});
