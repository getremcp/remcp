import test from 'node:test';
import assert from 'node:assert/strict';
import {assertLiveTargetOrigin} from '../src/extended/browser-target-origin.mjs';

test('live URL may change paths and queries within discovered target origin',()=>{
 assert.doesNotThrow(()=>assertLiveTargetOrigin(
   'https://example.test/start','https://example.test/next?x=1'));
 assert.doesNotThrow(()=>assertLiveTargetOrigin('about:blank','about:blank'));
});

test('stale CDP page metadata cannot authorize actions against about:blank or a new origin',()=>{
 for(const [discovered,live] of [
  ['https://example.test/start','about:blank'],
  ['about:blank','https://example.test/page'],
  ['https://example.test/start','https://other.example.test/page'],
  ['https://example.test/start','http://example.test/page'],
  ['https://example.test/start','https://example.test:8443/page'],
 ]){
  assert.throws(()=>assertLiveTargetOrigin(discovered,live),
   /target origin changed before action/);
 }
 assert.throws(()=>assertLiveTargetOrigin('not-a-url','about:blank'),
  /could not be verified/);
});
