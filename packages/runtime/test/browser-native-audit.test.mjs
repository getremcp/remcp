import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeLayoutMetrics, summarizeAccessibilityTree, inspectNativeBrowserAudit,
} from '../src/extended/browser-native-audit.mjs';

test('native Page layout uses CSS pixels and detects real document overflow', () => {
  const layout = normalizeLayoutMetrics({
    cssLayoutViewport:{clientWidth:375,clientHeight:800,pageX:0,pageY:120},
    cssVisualViewport:{clientWidth:375,clientHeight:800,scale:1},
    cssContentSize:{width:423.35,height:1689.2},
    contentSize:{width:9000,height:9999},
  });
  assert.equal(layout.horizontal_overflow_px,49);
  assert.equal(layout.vertical_scroll_px,890);
  assert.equal(layout.viewport.width,375);
  assert.equal(layout.visual_viewport.scale,1);
  assert.equal(layout.document.width,423.35);
});
test('invalid layout metrics never leak unbounded or nonnumeric values', () => {
  const layout=normalizeLayoutMetrics({cssLayoutViewport:{clientWidth:-9,clientHeight:Infinity},cssContentSize:{width:NaN,height:1e20}});
  assert.equal(layout.horizontal_overflow_px,0);
  assert.equal(layout.viewport.width,0);
  assert.equal(layout.document.height,10_000_000);
});
test('native Accessibility reports unnamed controls but never exposes page text', () => {
  const nodes=[
    {role:{value:'button'},name:{value:'Pay now'},ignored:false},
    {role:{value:'button'},name:{value:''},ignored:false},
    {role:{value:'link'},name:{value:'https://private.example/?secret=yes'},ignored:false},
    {role:{value:'heading'},name:{value:'Confidential page'},properties:[{name:'level',value:{value:2}}]},
    {role:{value:'image'},name:{value:''}},
    {role:{value:'textbox'},name:{value:'Private input'}},
    {role:{value:'button'},name:{value:''},ignored:true},
  ];
  const out=summarizeAccessibilityTree(nodes);
  assert.equal(out.interactive_controls,4);
  assert.equal(out.unlabeled_controls,1);
  assert.equal(out.unnamed_images,1);
  assert.equal(out.heading_levels[2],1);
  assert.equal(out.ignored_nodes,1);
  assert.doesNotMatch(JSON.stringify(out),/Pay now|private\.example|Confidential page|Private input|secret=yes/);
});
test('role groups are restricted to a safe allowlist', () => {
  const out=summarizeAccessibilityTree([{role:{value:'https://secret.example'},name:{value:'password'}}]);
  assert.deepEqual(out.roles,{});
});
test('native layout mode sends only Page.getLayoutMetrics and returns aggregates', async () => {
  const methods=[];
  const session={async send(method){methods.push(method);return {cssLayoutViewport:{clientWidth:100,clientHeight:100},cssContentSize:{width:200,height:140}};}};
  const out=await inspectNativeBrowserAudit(session,'layout');
  assert.deepEqual(methods,['Page.getLayoutMetrics']);
  assert.equal(out.layout.horizontal_overflow_px,100);
});
test('native accessibility mode bounds recursion depth and strips content', async () => {
  const methods=[];
  const session={async send(method,args){methods.push({method,args});return {nodes:[{role:{value:'button'},name:{value:'account 424242'}},{role:{value:'button'},name:{value:''}}]};}};
  const out=await inspectNativeBrowserAudit(session,'accessibility');
  assert.deepEqual(methods,[{method:'Accessibility.getFullAXTree',args:{depth:6}}]);
  assert.equal(out.accessibility.unlabeled_controls,1);
  assert.doesNotMatch(JSON.stringify(out),/424242/);
});
