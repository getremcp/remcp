import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeDomGeometry, inspectDomGeometry } from '../src/extended/browser-geometry.mjs';
import { buildDevtoolsReport } from '../src/extended/browser-devtools.mjs';

const strings=['#document','HTML','BODY','DIV','SPAN','BUTTON','IMG','INPUT','TABLE','PRIVATE_CUSTOM','SECRET TOKEN'];
function fixture() {
  return {
    strings,
    documents: [{
      nodes:{nodeName:[0,1,2,3,4,5,6,7,8,9]},
      layout:{nodeIndex:[1,2,3,4,5,6,7,8,9],
        bounds:[
          [0,0,375,1000], // html ignored
          [0,0,375,1000], // body ignored
          [-17.25,60,490.5,30], // div to both sides
          [8,30,100,20],
          [100,25,100,40],
          [350,40,75,80], // image to the right
          [0,0,0,10], // hidden/zero
          [50,100,450,200], // table to the right
          [150,100,900,90], // unlisted tag is not leaked
        ]},
    },{nodes:{nodeName:[8]},layout:{nodeIndex:[0],bounds:[[999,0,1,1]]}}],
  };
}
const metrics={cssLayoutViewport:{clientWidth:375,clientHeight:600,pageX:0}};
test('DOMSnapshot geometry returns only bounded numeric and HTML tag diagnostics',()=>{
  const output=summarizeDomGeometry(fixture(),metrics);
  assert.equal(output.viewport_width_px,375);
  assert.equal(output.eligible_elements,5);
  assert.equal(output.candidate_count,3);
  assert.equal(output.left_overflow_count,1);
  assert.equal(output.right_overflow_count,3);
  assert.equal(output.maximum_overflow_px,125);
  assert.equal(output.frames_omitted,1);
  assert.ok(output.candidates.length<=8);
  assert.deepEqual(output.by_tag,{div:1,table:1,img:1});
  assert.ok(!JSON.stringify(output).includes('SECRET TOKEN'));
  assert.ok(!JSON.stringify(output).includes('PRIVATE_CUSTOM'));
  assert.ok(!JSON.stringify(output).includes('name'));
});
test('geometry truncates samples and returns only the main frame',()=>{
  const o=summarizeDomGeometry(fixture(),metrics,{maxNodes:5});
  assert.equal(o.sampled_layout_nodes,5);
  assert.equal(o.truncated,true);
  assert.equal(o.frames_omitted,1);
  assert.equal(o.candidate_count,1);
});
test('invalid dimensions, hidden elements and unknown tags are ignored',()=>{
  const f=fixture();f.documents[0].layout.bounds[2]=[NaN,60,400,50];
  const o=summarizeDomGeometry(f,metrics);
  assert.equal(o.candidate_count,2);
  assert.equal(o.eligible_elements,4);
  assert.equal(o.maximum_overflow_px,125);
});
test('geometry uses horizontally scrolled viewport coordinates',()=>{
  const f={strings:['DIV'],documents:[{nodes:{nodeName:[0]},layout:{nodeIndex:[0],bounds:[[110,12,80,35]]}}]};
  assert.equal(summarizeDomGeometry(f,{cssLayoutViewport:{clientWidth:100,pageX:100}}).candidate_count,0);
  assert.equal(summarizeDomGeometry(f,{cssLayoutViewport:{clientWidth:100,pageX:0}}).right_overflow_count,1);
});
test('geometry requires a valid viewport',()=>{
  assert.throws(()=>summarizeDomGeometry(fixture(),{cssLayoutViewport:{clientWidth:0}}),/viewport/);
});
test('DOMSnapshot method is read-only and raw page data stays local',async()=>{
  const seen=[];
  const snapshot=fixture();
  snapshot.strings.push('user@example.com','Bearer very-private-token');
  const session={async send(method,args){
    seen.push({method,args});
    return method==='DOMSnapshot.captureSnapshot'?snapshot:metrics;
  }};
  const result=await inspectDomGeometry(session);
  assert.equal(result.action,'geometry');
  assert.equal(result.geometry.candidate_count,3);
  assert.deepEqual(seen.map(x=>x.method),['Page.getLayoutMetrics','DOMSnapshot.captureSnapshot']);
  assert.deepEqual(seen[1].args,{computedStyles:[],includePaintOrder:false,includeDOMRects:false});
  assert.doesNotMatch(JSON.stringify(result),/very-private-token|user@example.com|SECRET TOKEN/);
});
test('geometry response does not expose the URL of the inspected tab',()=>{
  const target={id:'target-one',url:'https://private.example/account?key=secret'};
  const geometry=buildDevtoolsReport(target,'geometry',{action:'geometry',geometry:{candidate_count:0}});
  assert.deepEqual(geometry,{target_id:'target-one',action:'geometry',geometry:{candidate_count:0}});
  assert.doesNotMatch(JSON.stringify(geometry),/private|secret|https/);
  assert.equal(buildDevtoolsReport(target,'layout',{action:'layout'}).url,'https://private.example/account');
});
test('maximum sample size and top-candidate count enforce hard bounds',()=>{
  const n=15000;
  const snapshot={strings:['BUTTON'],documents:[{
    nodes:{nodeName:Array(n).fill(0)},
    layout:{nodeIndex:Array.from({length:n},(_,i)=>i),bounds:Array.from({length:n},(_,i)=>[1000+i,10,40,30])},
  }]};
  const out=summarizeDomGeometry(snapshot,metrics,{maxNodes:999999});
  assert.equal(out.sampled_layout_nodes,12000);
  assert.equal(out.truncated,true);
  assert.equal(out.candidate_count,12000);
  assert.equal(out.candidates.length,8);
});
