import test from 'node:test';
import assert from 'node:assert/strict';
import { cachedUiNodes, enrichUiPayload, invalidateUiSnapshotCache, latestUiSnapshot } from '../src/extended/desktop-core.mjs';
import { waitForUi } from '../src/extended/desktop-ui-actions.mjs';

test('core owns snapshot invalidation across ES module imports', () => {
  enrichUiPayload({ nodes:[{ id:'fixture', name:'ReMCP test', role:'button' }] });
  assert.ok(latestUiSnapshot);
  assert.equal(cachedUiNodes().length, 1);
  invalidateUiSnapshotCache();
  assert.equal(latestUiSnapshot, null);
  assert.equal(cachedUiNodes(), null);
});

test('wait_for_ui never directly assigns to an imported ES module binding', () => {
  assert.doesNotMatch(waitForUi.toString(), /latestUiSnapshot\s*=/);
  assert.match(waitForUi.toString(), /invalidateUiSnapshotCache\(\)/);
});
