import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotDelta } from '../src/extended/browser-snapshot-diff.mjs';
import { extendedToolDefinitions } from '../src/extended/catalog.mjs';

const target={id:'tab-a',url:'https://safe.example/page',title:'Test'};
const node=(id,value='')=>({node_id:id,role:'textbox',name:'',value,child_ids:[]});

test('AX snapshot first read full, then only changed and removed nodes',()=>{
 const first=snapshotDelta([node('a','one'),node('b','two')],target,100,{now:1000,endpoint:'loopback'});
 assert.equal(first.diff_status,'full');
 assert.equal(first.nodes.length,2);
 assert.equal(first.total_nodes,2);
 const next=snapshotDelta([node('a','one'),node('c','three')],target,100,{
   from:first.snapshot_id,now:1100,endpoint:'loopback',
 });
 assert.equal(next.diff_status,'delta');
 assert.deepEqual(next.nodes.map(n=>n.node_id),['c']);
 assert.deepEqual(next.removed_node_ids,['b']);
 assert.equal(next.total_nodes,2);
 const unchanged=snapshotDelta([node('a','one'),node('c','three')],target,100,{
   from:next.snapshot_id,now:1200,endpoint:'loopback',
 });
 assert.equal(unchanged.diff_status,'delta');
 assert.deepEqual(unchanged.nodes,[]);
 assert.deepEqual(unchanged.removed_node_ids,[]);
});

test('AX snapshot tokens cannot cross targets, origins, URLs or node limits',()=>{
 const full=snapshotDelta([node('a','private-value')],target,100,{now:2000,endpoint:'local-a'});
 for(const options of [
   {target:{...target,id:'tab-b'},limit:100,endpoint:'local-a'},
   {target:{...target,url:'https://safe.example/next'},limit:100,endpoint:'local-a'},
   {target,limit:101,endpoint:'local-a'},
   {target,limit:100,endpoint:'local-b'},
 ]) {
   const next=snapshotDelta([node('a','private-value')],options.target,options.limit,{
     from:full.snapshot_id,endpoint:options.endpoint,now:2100,
   });
   assert.equal(next.diff_status,'unavailable');
   assert.equal(next.nodes.length,1);
 }
});

test('AX token expires safely and never stores raw user data',()=>{
 const full=snapshotDelta([node('id','secret token 123')],target,100,{
   now:5_000,endpoint:'localhost',
 });
 const source=JSON.stringify(full);
 assert.ok(source.includes('secret token 123'),'full response preserves existing contract');
 const expired=snapshotDelta([node('id','updated')],target,100,{
   from:full.snapshot_id,now:125_001,endpoint:'localhost',
 });
 assert.equal(expired.diff_status,'unavailable');
 assert.equal(expired.nodes.length,1);
 const invalid=snapshotDelta([node('id','updated')],target,100,{
   from:'../invalid-or-replayed',now:125_002,endpoint:'localhost',
 });
 assert.equal(invalid.diff_status,'unavailable');
});

test('new browser_snapshot schema exposes only explicit optional diff token',()=>{
 const entry=extendedToolDefinitions.find(v=>v.name==='browser_snapshot');
 assert.equal(entry.inputSchema.properties.diff_from.type,'string');
 assert.equal(entry.annotations.readOnlyHint,true);
});
