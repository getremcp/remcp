import test from 'node:test';
import assert from 'node:assert/strict';
import { productionBrowserSessions } from '../src/extended/browser-endpoint.mjs';
import { withTarget } from '../src/extended/browser-session.mjs';

test('reuses guarded CDP socket with zero tab-list HTTP requests for repeat exact-ID actions',async t=>{
 const original=process.env.NODE_ENV;
 const originalAllowed=process.env.REMCP_BROWSER_ALLOWED_HOSTS;
 process.env.NODE_ENV='production';
 process.env.REMCP_BROWSER_ALLOWED_HOSTS='93.184.215.14';
 t.after(()=>{process.env.NODE_ENV=original; if(originalAllowed===undefined)delete process.env.REMCP_BROWSER_ALLOWED_HOSTS; else process.env.REMCP_BROWSER_ALLOWED_HOSTS=originalAllowed;productionBrowserSessions.clear();});
 const endpoint='http://127.0.0.1:19381';
 const target={id:'cached',title:'Initial',url:'https://93.184.215.14',
   webSocketDebuggerUrl:'ws://127.0.0.1:19381/devtools/page/cached'};
 let checks=0, called=0;
 const session={url:target.webSocketDebuggerUrl,closed:false,socket:{readyState:1},close(){this.closed=true;},
   async send(method,payload){
    if(method==='Fetch.disable')return {};
    assert.equal(method,'Runtime.evaluate');
    checks++;
    return {result:{value:'https://93.184.215.14/workflow'}};
   }
 };
 const key=endpoint+'|cached';
 const record={target,targetId:target.id,session,guardInstalled:true,removeGuard(){},
   schedule(){called++;}};
 productionBrowserSessions.set(key,record);
 for(let i=0;i<4;i++){
   const result=await withTarget({endpoint,target_id:'cached'},async (_,chosen)=>{
     assert.equal(chosen.id,'cached');
     assert.equal(chosen.url,'https://93.184.215.14/workflow');
     return 'step-'+i;
   });
   assert.equal(result,'step-'+i);
 }
 assert.equal(checks,8,'must validate current page URL before and after each action');
 assert.equal(called,4,'cached socket stays alive and reschedules eviction');
});

test('fails closed on a forbidden current URL instead of running a cached action',async t=>{
 const original=process.env.NODE_ENV;
 const originalAllowed=process.env.REMCP_BROWSER_ALLOWED_HOSTS;
 process.env.NODE_ENV='production';
 process.env.REMCP_BROWSER_ALLOWED_HOSTS='93.184.215.14';
 t.after(()=>{process.env.NODE_ENV=original; if(originalAllowed===undefined)delete process.env.REMCP_BROWSER_ALLOWED_HOSTS; else process.env.REMCP_BROWSER_ALLOWED_HOSTS=originalAllowed;productionBrowserSessions.clear();});
 const endpoint='http://127.0.0.1:19382';
 const target={id:'cached-unsafe',url:'https://93.184.215.14',
   webSocketDebuggerUrl:'ws://127.0.0.1:19382/devtools/page/cached-unsafe'};
 let invoked=false, closed=false;
 const session={url:target.webSocketDebuggerUrl,closed:false,socket:{readyState:1},
   async send(method){
     return method==='Fetch.disable'?{}:{result:{value:'http://127.0.0.1/private'}};
   },close(){closed=true;this.closed=true;}};
 const key=endpoint+'|cached-unsafe';
 productionBrowserSessions.set(key,{target,targetId:target.id,session,guardInstalled:true,removeGuard(){},schedule(){}});
 await assert.rejects(
   withTarget({endpoint,target_id:'cached-unsafe'},async()=>{invoked=true;}),
   /loopback|private|not in REMCP_BROWSER_ALLOWED_HOSTS/i
 );
 assert.equal(invoked,false);
 assert.equal(closed,true,'deny a poisoned cached connection');
 assert.equal(productionBrowserSessions.has(key),false);
});


test('stale CDP discovery URL cannot authorize a cached mutation on about:blank',async t=>{
 const previousEnv=process.env.NODE_ENV;
 const previousHosts=process.env.REMCP_BROWSER_ALLOWED_HOSTS;
 process.env.NODE_ENV='production';
 process.env.REMCP_BROWSER_ALLOWED_HOSTS='93.184.215.14';
 t.after(()=>{
  if(previousEnv===undefined)delete process.env.NODE_ENV;
  else process.env.NODE_ENV=previousEnv;
  if(previousHosts===undefined)delete process.env.REMCP_BROWSER_ALLOWED_HOSTS;
  else process.env.REMCP_BROWSER_ALLOWED_HOSTS=previousHosts;
  productionBrowserSessions.clear();
 });
 const endpoint='http://127.0.0.1:19384';
 const target={id:'pending-navigation',url:'https://93.184.215.14/start',
  webSocketDebuggerUrl:'ws://127.0.0.1:19384/devtools/page/pending-navigation'};
 let acted=false,closed=false;
 const session={url:target.webSocketDebuggerUrl,closed:false,socket:{readyState:1},
  async send(method){
   if(method==='Fetch.disable')return {};
   assert.equal(method,'Runtime.evaluate');
   return {result:{value:'about:blank'}};
  },
  close(){closed=true;this.closed=true;},
 };
 productionBrowserSessions.set(endpoint+'|pending-navigation',{
  target,targetId:target.id,session,guardInstalled:true,removeGuard(){},schedule(){},
 });
 await assert.rejects(withTarget({endpoint,target_id:target.id},async()=>{
  acted=true;
 }),/target origin changed before action/);
 assert.equal(acted,false,'no user action may run against a stale target');
 assert.equal(closed,true);
 assert.equal(productionBrowserSessions.has(endpoint+'|pending-navigation'),false);
});
