// Tests the actual Linux AT-SPI subprocess with a private synthetic tree.
// No real desktop is altered; the only write is into an isolated test marker.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

const py=[
  'import os',
  'STATE_ACTIVE=1',
  'STATE_FOCUSED=2',
  'DESKTOP_COORDS=0',
  'class State:',
  ' def __init__(self,active):self.active=active',
  ' def contains(self,code):return self.active if code==STATE_ACTIVE else False',
  'class Node:',
  ' def __init__(self,name,role,active=False,children=None):',
  '  self.name=name;self.role=role;self.active=active;self.children=children or [];self.text="old"',
  ' @property',
  ' def childCount(self):return len(self.children)',
  ' def getChildAtIndex(self,i):return self.children[i]',
  ' def getRoleName(self):return self.role',
  ' def getState(self):return State(self.active)',
  ' def getProcessId(self):return 321',
  ' def queryValue(self):',
  '  if self.name=="Password":',
  '   with open(os.environ["REMCP_ATSPI_MARKER"],"w") as f:f.write("read")',
  '  raise Exception("Value unavailable")',
  ' def queryText(self):',
  '  if self.name=="Password":',
  '   with open(os.environ["REMCP_ATSPI_MARKER"],"w") as f:f.write("read")',
  '  return self',
  ' def getText(self,start,end):return "changed" if os.getenv("REMCP_ATSPI_CASE")=="stale" else self.text',
  ' def queryEditableText(self):return self',
  ' def setTextContents(self,value):',
  '  with open(os.environ["REMCP_ATSPI_MARKER"],"w") as f:f.write(value)',
  '  self.text="old" if os.getenv("REMCP_ATSPI_CASE")=="reactive" else value',
  '  return True',
  'class Registry:',
  ' @staticmethod',
  ' def getDesktop(i):',
  '  mode=os.getenv("REMCP_ATSPI_CASE")',
  '  title="Main Copy" if mode=="lookalike" else "Main"',
  '  main=Node(title,"frame",mode!="background",[Node("Password" if mode=="private" else "Search","entry")])',
  '  other=Node("Other","frame",mode=="background")',
  '  return [Node("Future Widget App","application",False,[other,main])]',
].join('\n')+'\n';

function scenario(mode,overrides={},operation='action'){
  const root=mkdtempSync(path.join(tmpdir(),'remcp-atspi-action-'));
  const marker=path.join(root,'write.marker');
  try{
    writeFileSync(path.join(root,'pyatspi.py'),py);
    const entry=new URL('../src/extended/desktop-core.mjs',import.meta.url).href;
    const args={action:'set_value',id:'linux:321:r.1.0',pid:321,
      app:'Future Widget App',window_title:'Main',name:'Search',
      role:'entry',expected_value:'old',value:'new',
      strict_target_id:true,semantic_only:true,...overrides};
    const code=operation==='snapshot'
      ? 'import {uiSnapshot,resultValue} from '+JSON.stringify(entry)+';\n'
        +'try {const v=resultValue(await uiSnapshot({scope:"desktop",pid:321,max_nodes:12,max_depth:3}));console.log(JSON.stringify({ok:true,v}));}\n'
        +'catch(e){console.log(JSON.stringify({ok:false,error:String(e.message||e)}));}\n'
      : 'import {uiAction,resultValue} from '+JSON.stringify(entry)+';\n'
        +'const args=JSON.parse(process.env.REMCP_ATSPI_ARGS);\n'
        +'try {const v=resultValue(await uiAction(args));console.log(JSON.stringify({ok:true,v}));}\n'
        +'catch(e){console.log(JSON.stringify({ok:false,error:String(e.message||e)}));}\n';
    const child=spawnSync(process.execPath,['--input-type=module','-e',code],{
      encoding:'utf8',timeout:12000,maxBuffer:512*1024,
      env:{...process.env,PYTHONPATH:root,REMCP_ATSPI_CASE:mode,
        REMCP_ATSPI_MARKER:marker,REMCP_ATSPI_ARGS:JSON.stringify(args)},
    });
    assert.equal(child.status,0,child.stderr||String(child.error));
    const lines=child.stdout.trim().split('\n');
    const value=JSON.parse(lines.at(-1));
    return {...value,written:existsSync(marker)?
      readFileSync(marker,'utf8'):null};
  }finally{rmSync(root,{recursive:true,force:true})}
}

test('strict AT-SPI updates the uniquely identified active foreground window',()=>{
  const r=scenario('foreground');
  assert.equal(r.ok,true,JSON.stringify(r));
  assert.equal(r.written,'new');
  assert.equal(r.v.path,'r.1.0');
});
test('strict AT-SPI refuses a background window even when a sibling is active',()=>{
  const r=scenario('background');
  assert.equal(r.ok,false);
  assert.equal(r.written,null);
});
test('strict AT-SPI refuses substring window-title impersonation',()=>{
  const r=scenario('lookalike');
  assert.equal(r.ok,false);
  assert.equal(r.written,null);
});
test('strict AT-SPI compare-and-swap refuses an old value changed on the host',()=>{
  const r=scenario('stale');
  assert.equal(r.ok,false);
  assert.equal(r.written,null);
});
test('strict AT-SPI refuses missing or legacy target identifiers before execution',()=>{
  for(const id of ['linux:321','linux:321:12','linux:777:r.1.0','linux:321:r.0.x']){
    const r=scenario('foreground',{id});
    assert.equal(r.ok,false,id);
    assert.equal(r.written,null,id);
  }
});

test('Linux snapshot never queries the value of a protected field',()=>{
  const result=scenario('private',{},'snapshot');
  assert.equal(result.ok,true,JSON.stringify(result));
  const field=result.v.nodes.find(n=>n.name==='Password');
  assert.ok(field);
  assert.equal(field.password,true);
  assert.equal(field.value,'');
  assert.equal(result.written,null,'protected field was never read');
});

test('strict AT-SPI rejects a provider that acknowledges a write but keeps the old text',()=>{
  const r=scenario('reactive');
  assert.equal(r.ok,false,JSON.stringify(r));
  assert.equal(r.written,'new','OS adapter did attempt the write once');
  assert.match(r.error,/Native text readback mismatch/);
  assert.doesNotMatch(JSON.stringify(r),/private secret content/i);
});
