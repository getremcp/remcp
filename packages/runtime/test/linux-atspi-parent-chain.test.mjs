// Run the real AT-SPI Python snapshot generator against a synthetic desktop.
// This verifies cross-window lineage and truthful truncation, not mocked JS.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function linuxSnapshot(maxNodes){
  const root=mkdtempSync(path.join(os.tmpdir(),'remcp-atspi-tree-'));
  const py=`STATE_ACTIVE=1
STATE_FOCUSED=2
DESKTOP_COORDS=0
class Rect:
 x=0;y=0;width=420;height=360
class State:
 def contains(self,state): return state==STATE_ACTIVE
class Node:
 def __init__(self,name,role,children=None):
  self.name=name;self.role=role;self.children=children or []
 @property
 def childCount(self): return len(self.children)
 def getChildAtIndex(self,index): return self.children[index]
 def getRoleName(self): return self.role
 def getState(self): return State()
 def queryComponent(self): return self
 def getExtents(self,coord): return Rect()
 def getProcessId(self): return 42
 def queryValue(self): raise Exception('no numeric value')
class Registry:
 @staticmethod
 def getDesktop(index):
  return [Node('Calculator','application',[
   Node('Window One','frame',[Node('Mode','button')]),
   Node('Window Two','frame',[Node('Search','entry')])
  ])]
`;
  try{
    writeFileSync(path.join(root,'pyatspi.py'),py);
    const entry=new URL('../src/extended/desktop-core.mjs',import.meta.url).href;
    const code=`import {uiSnapshot,resultValue} from ${JSON.stringify(entry)};
      const r=await uiSnapshot({scope:'desktop',pid:42,max_nodes:${maxNodes},max_depth:3});
      console.log(JSON.stringify(resultValue(r)));`;
    const proc=spawnSync(process.execPath,['--input-type=module','-e',code],{
      encoding:'utf8',timeout:9000,maxBuffer:1024*1024,
      env:{...process.env,PYTHONPATH:root},
    });
    assert.equal(proc.status,0,proc.stderr||String(proc.error));
    return JSON.parse(proc.stdout.trim());
  }finally{
    rmSync(root,{recursive:true,force:true});
  }
}

test('Linux AT-SPI emits parent lineage through a window, never by PID alone',
  {skip:process.platform!=='linux'},()=>{
  const result=linuxSnapshot(9);
  assert.equal(result.truncated,false);
  assert.equal(result.nodes.length,5);
  const byId=new Map(result.nodes.map(node=>[node.id,node]));
  assert.equal(byId.get('linux:42:r').parent_id,null);
  assert.equal(byId.get('linux:42:r.0').parent_id,'linux:42:r');
  assert.equal(byId.get('linux:42:r.0.0').parent_id,'linux:42:r.0');
  assert.equal(byId.get('linux:42:r.1.0').parent_id,'linux:42:r.1');
  assert.equal(byId.get('linux:42:r.0.0').role,'button');
});

test('Linux AT-SPI sets truncated=true when queued elements exceed max_nodes',
  {skip:process.platform!=='linux'},()=>{
  const result=linuxSnapshot(2);
  assert.equal(result.nodes.length,2);
  assert.equal(result.truncated,true);
  assert.equal(result.max_nodes,2);
});
