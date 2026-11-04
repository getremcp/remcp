import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

function record({ format = 'mp4', extension = '', outside = false, symlink = false, noDestination = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remcp-gnome-record-test-'));
  const bin = path.join(root, 'bin');fs.mkdirSync(bin);
  const destination = path.join(root, 'result' + extension);
  const external = path.join(root, 'outside.mp4');
  fs.writeFileSync(external, 'KEEP_OUTSIDE');
  if (extension) fs.writeFileSync(destination, 'KEEP_DESTINATION');
  fs.writeFileSync(path.join(bin, 'gjs'), `#!${process.execPath}
const fs=require('node:fs');
if(process.argv[2]==='-c'){console.log('true');process.exit(0);}
const requested=process.argv[3];
const actual=${outside ? JSON.stringify(external) : "requested.replace(/\\.webm$/,'." + format + "')"};
${symlink ? `fs.symlinkSync(${JSON.stringify(external)},actual);` : outside ? '' : "fs.writeFileSync(actual,'SYNTHETIC_VIDEO');"}
console.log(JSON.stringify({destination:actual,stopped:true}));
`, { mode:0o755 });
  const url = new URL('../src/extended/diagnostics-recording.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module','-e', `
    import {recordScreen} from ${JSON.stringify(url)};
    try {const r=await recordScreen({duration_seconds:1,destination:${noDestination ? 'undefined' : JSON.stringify(destination)}});
      console.log(JSON.stringify({ok:true,payload:JSON.parse(r.content[0].text)}));}
    catch(e){console.log(JSON.stringify({ok:false,error:e.message}));}`], {
    encoding:'utf8',timeout:8000,env:{...process.env,
      PATH:bin + path.delimiter + process.env.PATH,
      XDG_SESSION_TYPE:'wayland',WAYLAND_DISPLAY:'wayland-test',
      XDG_CURRENT_DESKTOP:'GNOME',DBUS_SESSION_BUS_ADDRESS:'unix:path=/synthetic-qa-bus',
      TMPDIR:root,REMCP_RUNTIME_CONFIG_DIR:path.join(root,'config'),REMCP_RUNTIME_ALLOWED_ROOTS:root,
    },
  });
  try {
    assert.equal(result.status,0,result.stderr || String(result.error));
    const parsed = JSON.parse(result.stdout);
    return { ...parsed,
      stagedContent:noDestination && parsed.ok ? fs.readFileSync(parsed.payload.path,'utf8') : null,
      content:fs.existsSync(destination) ? fs.readFileSync(destination,'utf8') : null,
      outside:fs.readFileSync(external,'utf8'),
      remaining:fs.readdirSync(root).filter(name=>name.startsWith('remcp-screen-')),
    };
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
}

for (const format of ['mp4','webm']) {
  test(`GNOME's actual ${format} file is copied and reported`, {skip:process.platform!=='linux'}, () => {
    const r=record({format});assert.equal(r.ok,true,r.error);
    assert.equal(r.payload.format,format);assert.equal(r.payload.bytes,15);
    assert.equal(r.content,'SYNTHETIC_VIDEO');assert.deepEqual(r.remaining,[]);
  });
}
test('actual format mismatch leaves the requested file unchanged', {skip:process.platform!=='linux'}, () => {
  const r=record({extension:'.webm'});assert.equal(r.ok,false);
  assert.match(r.error,/produces \.mp4/);assert.equal(r.content,'KEEP_DESTINATION');
  assert.deepEqual(r.remaining,[]);
});
test('an explicit MP4 destination accepts GNOME MP4 output', {skip:process.platform!=='linux'}, () => {
  const r=record({extension:'.mp4'});assert.equal(r.ok,true,r.error);
  assert.equal(r.payload.format,'mp4');assert.equal(r.content,'SYNTHETIC_VIDEO');
});
test('default destination retains and reports the actual GNOME staging file', {skip:process.platform!=='linux'}, () => {
  const r=record({noDestination:true});assert.equal(r.ok,true,r.error);
  assert.equal(r.payload.format,'mp4');assert.match(r.payload.path,/\.mp4$/);
  assert.equal(r.stagedContent,'SYNTHETIC_VIDEO');assert.equal(r.remaining.length,1);
});
test('GNOME cannot redirect the recording outside its private staging directory', {skip:process.platform!=='linux'}, () => {
  const r=record({outside:true});assert.equal(r.ok,false);assert.equal(r.content,null);
  assert.match(r.error,/invalid screen recording staging path/);
  assert.equal(r.outside,'KEEP_OUTSIDE');assert.deepEqual(r.remaining,[]);
});
test('GNOME recording staging symlinks are rejected', {skip:process.platform!=='linux'}, () => {
  const r=record({symlink:true});assert.equal(r.ok,false);assert.equal(r.content,null);
  assert.match(r.error,/non-empty regular file/);
  assert.equal(r.outside,'KEEP_OUTSIDE');assert.deepEqual(r.remaining,[]);
});
