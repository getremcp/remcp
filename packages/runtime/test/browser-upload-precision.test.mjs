import test from 'node:test';
import assert from 'node:assert/strict';
import {uniqueUploadNodeId} from '../src/extended/browser-upload-target.mjs';

test('upload selector requires exactly one live CDP node without extra queries',async()=>{
 let calls=0;
 const session={async send(method,payload){
  calls++;
  assert.equal(method,'DOM.querySelectorAll');
  assert.deepEqual(payload,{nodeId:17,selector:'input[type=file]'});
  return {nodeIds:[1234]};
 }};
 assert.equal(await uniqueUploadNodeId(session,17,'input[type=file]'),1234);
 assert.equal(calls,1);
});

test('ambiguous, missing and malformed upload targets fail before file assignment',async()=>{
 for(const ids of [[],[10,20],null,[0],[-1],[1.5],['20']]){
  let setFiles=false;
  const session={async send(method){
   if(method==='DOM.setFileInputFiles')setFiles=true;
   return {nodeIds:ids};
  }};
  await assert.rejects(uniqueUploadNodeId(session,1,'input'),
   /selector missing or ambiguous/);
  assert.equal(setFiles,false);
 }
});
