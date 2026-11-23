import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync, readFileSync} from 'node:fs';
import {preflightExistingRelease} from
  '../scripts/release-prepublish-preflight.mjs';

const repo = 'getremcp/remcp';
const tag = 'v0.2.258';
const token = 'fake-QA-token-not-a-credential';
const names = [
  'chatgpt-app-submission.json', 'remcp-plugin.zip',
  'remcp-openai-existing-plugin.zip', 'remcp-skills-only.zip',
];
const files = Object.fromEntries(names.map((name, index) =>
  [name, Buffer.from('Synthetic release-only asset ' + index)]));
const paths = Object.fromEntries(names.map((name, index) =>
  [index === 0 ? name : 'submission/' + name, files[name]]));
const url = name => 'https://github.com/' + repo +
  '/releases/download/' + tag + '/' + name;
const asset = name => ({
  name, size:files[name]?.length ?? 3, browser_download_url:url(name),
});
const release = (...items) => ({
  tag_name:tag, draft:false, assets:items.map(asset),
});

function mock({metadata=release(),metadataStatus=200,downloads={},
  downloadStatus=200,failMetadata=false}={}) {
  const calls = [];
  const fetchFn = async (location, options) => {
    calls.push({location,options});
    if (location.includes('/releases/tags/')) {
      if (failMetadata) throw new Error('network unavailable');
      return new Response(JSON.stringify(metadata), {status:metadataStatus});
    }
    const name = location.split('/').at(-1);
    if (downloadStatus !== 200) {
      return new Response('not found', {status:downloadStatus});
    }
    return new Response(downloads[name] ?? files[name], {status:200});
  };
  const readFileFn = async name => {
    assert.ok(Object.hasOwn(paths,name),'never read outside the four subjects');
    return paths[name];
  };
  return {calls,run:(options={}) => preflightExistingRelease({
    repository:repo,tag,token,fetchFn,readFileFn,...options,
  })};
}

test('absent tag is safe but only an exact HTTP 404 authorizes first publication',async()=>{
  const missing=mock({metadataStatus:404});
  assert.deepEqual(await missing.run(),{state:'absent',verified:0});
  assert.equal(missing.calls.length,1);
  for(const code of [401,403,429,500,502]) {
    await assert.rejects(mock({metadataStatus:code}).run(),
      /preflight HTTP/,'HTTP '+code+' must fail closed');
  }
  await assert.rejects(mock({failMetadata:true}).run(),/API unavailable/);
});

test('atomic publication requires an absent release even on old partial replies',async()=>{
  const absent=mock({metadataStatus:404});
  assert.deepEqual(await absent.run({requireAbsent:true}),
    {state:'absent',verified:0});
  for(const namesOfRelease of [[], names.slice(0, 1), names]) {
    const input=mock({metadata:release(...namesOfRelease)});
    await assert.rejects(input.run({requireAbsent:true}), /Atomic release already exists/);
    assert.equal(input.calls.length,1,
      'must reject an existing release before any asset fetch');
  }
  for(const code of [401,403,429,500]) {
    await assert.rejects(mock({metadataStatus:code}).run({requireAbsent:true}),
      /preflight HTTP/);
  }
});

test('empty and byte-identical incomplete release inventories may retry',async()=>{
  for(const items of [[],names.slice(0,1),names.slice(0,3),names]) {
    const input=mock({metadata:release(...items)});
    assert.deepEqual(await input.run(),
      {state:'verified-partial',verified:items.length});
    assert.equal(input.calls.length,1+items.length);
    assert.match(input.calls[0].location,
      /api\.github\.com\/repos\/getremcp\/remcp\/releases\/tags\/v0\.2\.258/);
    assert.equal(input.calls[0].options.headers.Authorization,'Bearer '+token);
    for(const call of input.calls.slice(1)) {
      assert.equal(call.options.headers.Authorization,undefined,
        'do not send credentials to public artifact download URL');
    }
  }
});

test('unknown, duplicate, attested or signed assets block before any download',async()=>{
  for(const assets of [
    [asset('unexpected.exe')], [asset(names[0]),asset(names[0])],
    [asset(names[0]),asset('remcp-release.intoto.jsonl')],
    [...names.map(asset),asset('SHA256SUMS'),asset('SHA256SUMS.sigstore.json')],
  ]) {
    const input=mock({metadata:{tag_name:tag,draft:false,assets}});
    await assert.rejects(input.run(),/asset|immutable|attestation/i);
    assert.equal(input.calls.length,1);
  }
});

test('tampered, truncated or unavailable published bytes are never accepted',async()=>{
  for(const opts of [
    {downloads:{[names[0]]:Buffer.from('tampered size!')}},
    {downloads:{[names[0]]:Buffer.from('x'.repeat(files[names[0]].length))}},
    {downloadStatus:404},
  ]) {
    const input=mock({metadata:release(names[0]),...opts});
    await assert.rejects(input.run(),/release asset|download/i);
  }
});

test('invalid repository, tag or token cannot run a GitHub release query',async()=>{
  const fetchFn=()=>{throw new Error('must not be invoked');};
  for(const bad of [
    {repository:'..',tag,token}, {repository:repo,tag:'v0.2.258/evil',token},
    {repository:repo,tag,token:''}, {repository:repo,tag,token:null},
  ]) {
    await assert.rejects(preflightExistingRelease({...bad,fetchFn}),
      /valid GitHub repo/);
  }
});

test('mismatched tag, draft status or forged asset URL fails closed',async()=>{
  for(const metadata of [
    {tag_name:'v0.2.257',draft:false,assets:[]},
    {tag_name:tag,draft:true,assets:[]},
    {tag_name:tag,assets:[]},
    {tag_name:tag,draft:false,assets:[{...asset(names[0]),
      browser_download_url:'https://evil.example/remcp-plugin.zip'}]},
    {tag_name:tag,draft:false,assets:[{...asset(names[0]),size:1}]},
  ]) {
    await assert.rejects(mock({metadata}).run(),
      /tag mismatch|unsafe|size differs/i);
  }
});

test('all subjects are checked before irreversible npm publish in the release workflow',()=>{
  const privateWorkflow=new URL('../docs/public-repo-ci.yml',import.meta.url);
  const publicWorkflow=new URL('../.github/workflows/ci.yml',import.meta.url);
  const workflow=readFileSync(existsSync(privateWorkflow)
    ? privateWorkflow : publicWorkflow,'utf8');
  const publish=workflow.slice(workflow.indexOf('  publish:\n'),
    workflow.indexOf('  repair-release:\n'));
  const attest=publish.indexOf('      - name: Attest the four tagged');
  const preflight=publish.indexOf('      - name: Verify existing release bytes before npm publication');
  const publishNpm=publish.indexOf('      - name: Publish @remcp/runtime');
  assert.ok(attest>=0 && preflight>attest && publishNpm>preflight,
    'check existing released bytes before irreversible npm trusted publication');
  const step=publish.slice(preflight,publishNpm);
  assert.match(step,/node scripts\/release-prepublish-preflight\.mjs/);
  assert.match(step,/GH_TOKEN: \$\{\{ github\.token \}\}/);
  const exporterFile=new URL('../scripts/build-public-repo.mjs',import.meta.url);
  if (existsSync(exporterFile)) {
    const exporter=readFileSync(exporterFile,'utf8');
    assert.match(exporter,/scripts\/release-prepublish-preflight\.mjs/);
    assert.match(exporter,/test\/release-prepublish-preflight\.test\.mjs/);
    assert.match(exporter,/copy\(repoRoot,\s*file\)/);
  } else {
    // The public checkout has the generated workflow and preflight files,
    // but intentionally never receives the private projection script.
    assert.ok(existsSync(new URL('../scripts/release-prepublish-preflight.mjs',import.meta.url)));
  }
});
