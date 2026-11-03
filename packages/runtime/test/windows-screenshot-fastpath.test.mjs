import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { windowsRegionCaptureScript } from '../src/extended/desktop-windows.mjs';

test('Windows primary display uses a single PowerShell capture with bounded GDI cleanup', () => {
  const script = windowsRegionCaptureScript({primary:true}, "C:\\Temp\\cap'one.png");
  assert.match(script, /System\.Windows\.Forms,System\.Drawing/);
  assert.match(script, /Screen\]::PrimaryScreen\.Bounds/);
  assert.match(script, /CopyFromScreen\(\$r\.X,\$r\.Y,0,0,\$b\.Size\)/);
  assert.match(script, /Invalid or oversized display bounds/);
  assert.match(script, /finally\{if\(\$g\)\{\$g\.Dispose\(\)\};\$b\.Dispose\(\)\}/);
  assert.ok(script.includes("cap''one.png"), 'PowerShell single quotes must be escaped');
  assert.doesNotMatch(script, /@\{X=/);
});

test('explicit Windows screenshot rectangles retain negative origin support', () => {
  const script = windowsRegionCaptureScript({x:-1280,y:10,width:800,height:600},'C:\\Temp\\rect.png');
  assert.ok(script.includes('X=-1280;Y=10;Width=800;Height=600'));
  assert.doesNotMatch(script, /PrimaryScreen\.Bounds/);
});

test('only Windows primary monitor bypasses redundant inventory; no selector bypass', () => {
  const source=readFileSync(new URL('../src/extended/desktop-core.mjs',import.meta.url),'utf8');
  assert.match(source, /process\.platform === 'win32'/);
  assert.match(source, /optionalString\(args\.monitor\)\?\.toLowerCase\(\) === 'primary'/);
  assert.match(source, /args\.monitor_index == null/);
  assert.match(source, /adapter\.screenshotRegion\(\{ monitor:'primary' \}\)/);
  const windows=readFileSync(new URL('../src/extended/desktop-windows.mjs',import.meta.url),'utf8');
  assert.match(windows, /runPowerShell\(script,\{label:'screenshot region',timeout:30_000\}\)/);
});
