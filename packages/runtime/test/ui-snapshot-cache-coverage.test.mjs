import test from 'node:test';
import assert from 'node:assert/strict';
import {enrichUiPayload,cachedUiNodes,invalidateUiSnapshotCache} from '../src/extended/desktop-core.mjs';

const node=(id,props={})=>({id,app:'Editor',window:'Draft',pid:814,
 name:'Save',role:'push button',depth:1,...props});
const cache=(nodes,args={})=>enrichUiPayload({nodes,count:nodes.length},args);

test.afterEach(()=>invalidateUiSnapshotCache());

test('a cached active-window snapshot cannot answer a cross-desktop query',()=>{
 cache([node('active')],{active_only:true,max_nodes:500,max_depth:12});
 assert.equal(cachedUiNodes({active_only:true})?.length,1);
 assert.equal(cachedUiNodes({active_only:false}),null);
 assert.equal(cachedUiNodes({scope:'desktop'}),null);
});

test('a scoped native snapshot cannot impersonate a global or other-app scan',()=>{
 cache([node('editor')],{app:'Editor',active_only:false,max_nodes:500,max_depth:12});
 assert.equal(cachedUiNodes({app:'Editor',active_only:false})?.length,1);
 assert.equal(cachedUiNodes({active_only:false}),null);
 assert.equal(cachedUiNodes({app:'Browser',active_only:false}),null);
 assert.equal(cachedUiNodes({pid:999,active_only:false}),null);
});

test('browser-DOM-only queries cannot use a standard native accessibility tree',()=>{
 cache([node('native')],{active_only:true,browser_dom:false,max_nodes:500});
 assert.equal(cachedUiNodes({browser_dom:true,active_only:true}),null);
 assert.equal(cachedUiNodes({browser_dom:false,active_only:true})?.length,1);
 cache([node('web')],{active_only:true,browser_dom:true,max_nodes:500});
 assert.equal(cachedUiNodes({browser_dom:true,active_only:true})?.length,1);
});

test('truncated or shallow cached trees cannot satisfy wider deep scans',()=>{
 enrichUiPayload({nodes:[node('capped')],count:501,truncated:true},
   {active_only:true,max_nodes:1,max_depth:5});
 assert.equal(cachedUiNodes({active_only:true,max_nodes:100}),null);
 assert.equal(cachedUiNodes({active_only:true,max_depth:12}),null);
 assert.equal(cachedUiNodes({active_only:true,max_nodes:1,max_depth:5})?.length,1);
});

test('complete small snapshots remain fast for larger requested node budgets',()=>{
 cache([node('complete')],{active_only:true,max_nodes:500,max_depth:12});
 assert.equal(cachedUiNodes({active_only:true,max_nodes:2000,max_depth:12})?.length,1);
});

test('null and empty pid mean unscoped lookup, never an implicit PID 0',()=>{
 cache([node('normal')],{active_only:true,max_nodes:500,max_depth:8});
 assert.equal(cachedUiNodes({pid:null})?.length,1);
 assert.equal(cachedUiNodes({pid:''})?.length,1);
});

test('cache_only exact ID miss returns promptly without a new native capture',async()=>{
 cache([node('existing')],{active_only:true,max_nodes:500,max_depth:12});
 const {uiMatches}=await import('../src/extended/desktop-ui-actions.mjs');
 const start=performance.now();
 assert.deepEqual(await uiMatches({id:'missing',cache_only:true,active_only:true}),[]);
 assert.ok(performance.now()-start<500,'cache-only must not launch an OS accessibility scan');
});

test('native mutations invalidate old and in-flight accessibility cache even on failure',async()=>{
 const {withFreshUiAfterAction}=await import('../src/extended/desktop-core.mjs');
 cache([node('old')],{active_only:true,max_nodes:500,max_depth:8});
 const out=await withFreshUiAfterAction(async()=>{
   assert.equal(cachedUiNodes(),null,'the old cache must not survive dispatch');
   cache([node('during')],{active_only:true,max_nodes:500,max_depth:8});
   return {verified:true};
 });
 assert.deepEqual(out,{verified:true});
 assert.equal(cachedUiNodes(),null,'the in-flight capture must not survive completion');
 cache([node('old')],{active_only:true,max_nodes:500,max_depth:8});
 await assert.rejects(withFreshUiAfterAction(async()=>{
   cache([node('uncertain')],{active_only:true,max_nodes:500,max_depth:8});
   throw Error('OS action result unavailable');
 }),/OS action result unavailable/);
 assert.equal(cachedUiNodes(),null,'uncertain mutation must not retain stale state');
});

test('a late pre-mutation capture cannot revive an obsolete UI tree',async()=>{
 const core=await import('../src/extended/desktop-core.mjs');
 const captureStartedAt=core.uiSnapshotCacheEpoch;
 await core.withFreshUiAfterAction(async()=>({executed:true}));
 enrichUiPayload({nodes:[node('late-old')],count:1},
   {active_only:true,max_nodes:500,max_depth:8},captureStartedAt);
 assert.equal(cachedUiNodes(),null,
  'a delayed native capture from before a mutation must not revive the cache');
 const returned=enrichUiPayload({nodes:[node('fresh')],count:1},
   {active_only:true,max_nodes:500,max_depth:8},core.uiSnapshotCacheEpoch);
 assert.equal(returned.nodes[0].id,'fresh');
 assert.equal(cachedUiNodes()?.[0].id,'fresh');
});

test('read-only polling invalidates caches without posing as a UI mutation',async()=>{
 const core=await import('../src/extended/desktop-core.mjs');
 const mutationEpoch=core.uiSnapshotMutationEpoch;
 const cacheEpoch=core.uiSnapshotCacheEpoch;
 core.invalidateUiSnapshotCache();
 assert.equal(core.uiSnapshotMutationEpoch,mutationEpoch);
 assert.equal(core.uiSnapshotCacheEpoch,cacheEpoch+1);
 await core.withFreshUiAfterAction(async()=>({executed:true}));
 assert.equal(core.uiSnapshotMutationEpoch,mutationEpoch+2);
});
