import test from 'node:test';
import assert from 'node:assert/strict';
import {pyAtSpiPrelude} from '../src/extended/desktop-linux-ui.mjs';

test('GI AT-SPI compatibility exposes native text reads for snapshot and compare-and-swap',()=>{
 const src=pyAtSpiPrelude({pid:321,app:'ReMCP QA'});
 assert.match(src,/class _Text:/);
 assert.match(src,/def getText\(self,start,end\):/);
 assert.match(src,/Atspi\.Text\.get_text\(self\.a,start,end\)/);
 assert.match(src,/def queryText\(self\): return _Text\(self\.a\)/);
 assert.match(src,/get_text_iface\(\) is None/);
 assert.match(src,/scope_pid=321/);
});
