// SDK-driven Authorization Code + PKCE, exact issuer/resource binding, OS vault tokens.
import http from 'node:http';
import {randomBytes,timingSafeEqual,createHash} from 'node:crypto';
import {Client,StreamableHTTPClientTransport,UnauthorizedError} from '@modelcontextprotocol/client';
import {openInBrowser} from './connect.mjs';
import {VERSION} from '../version.mjs';

export async function connectEncryptedRelay({vault,pin,port=42831}){
  if(!Number.isSafeInteger(port)||port<1024||port>65535)throw new Error('Invalid OAuth loopback port');
  const resource=new URL(pin.server),issuer=pin.issuer;
  if(resource.protocol!=='https:'||new URL(issuer).protocol!=='https:')throw new Error('HTTPS OAuth endpoints required');
  const host='127.0.0.1:'+port,path='/remcp/e2ee/callback',redirect='http://'+host+path;
  const storageKey=createHash('sha256').update(resource.href+'|'+issuer+'|'+redirect).digest('hex');
  let verifier,discovery,lastState='',settled=false,resolveCallback,rejectCallback;
  const callback=new Promise((resolve,reject)=>{resolveCallback=resolve;rejectCallback=reject;});
  callback.catch(()=>{});
  const timer=setTimeout(()=>rejectCallback(new Error('OAuth authorization timed out')),180000);
  timer.unref();
  const listener=http.createServer((req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'");
    const url=new URL(req.url||'/',redirect);
    const state=url.searchParams.get('state')||'';
    const supplied=Buffer.from(state),expected=Buffer.from(lastState);
    const validState=expected.length>0&&supplied.length===expected.length&&
      timingSafeEqual(supplied,expected);
    if(req.method!=='GET'||req.headers.host!==host||url.pathname!==path||settled||
        url.searchParams.getAll('state').length!==1||!validState){
      res.writeHead(400);res.end('Authorization callback rejected.');return;
    }
    if(url.searchParams.getAll('code').length!==1||!url.searchParams.get('code')||
        url.searchParams.has('error')){
      if(url.searchParams.has('error')){settled=true;rejectCallback(new Error('Owner authorization declined'));}
      res.writeHead(400);res.end('Authorization was not completed.');return;
    }
    settled=true;resolveCallback(url.searchParams);
    res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'});
    res.end('ReMCP authorization received. You can return to your AI client.');
  });
  listener.headersTimeout=5000;listener.requestTimeout=10000;
  await new Promise((resolve,reject)=>{
    listener.once('error',reject);listener.listen(port,'127.0.0.1',resolve);
  }).catch(()=>{clearTimeout(timer);throw new Error('Encrypted MCP OAuth callback port is unavailable');});
  const assertIssuer=ctx=>{
    if(ctx?.issuer!==issuer)throw new Error('Unexpected OAuth issuer');
  };
  const load=async()=>((await vault.read())?.oauth||{})[storageKey]||{};
  const save=async patch=>{
    const record=await vault.read();
    if(!record?.identity)throw new Error('Encrypted MCP identity was removed');
    const oauth={...(record.oauth||{})};
    oauth[storageKey]={...(oauth[storageKey]||{}),...patch};
    await vault.write({...record,oauth});
  };
  const provider={
    redirectUrl:redirect,
    clientMetadata:{client_name:'ReMCP encrypted MCP bridge',application_type:'native',
      redirect_uris:[redirect],grant_types:['authorization_code','refresh_token'],
      response_types:['code'],token_endpoint_auth_method:'none'},
    state(){lastState=randomBytes(32).toString('base64url');return lastState;},
    async clientInformation(ctx){if(!ctx)return undefined;assertIssuer(ctx);return (await load()).client;},
    async saveClientInformation(client,ctx){assertIssuer(ctx);await save({client});},
    async tokens(ctx){if(ctx)assertIssuer(ctx);return (await load()).tokens;},
    async saveTokens(tokens,ctx){if(ctx)assertIssuer(ctx);await save({tokens});},
    saveCodeVerifier(value){verifier=value;},codeVerifier(){
      if(!verifier)throw new Error('Missing PKCE verifier');return verifier;
    },
    saveDiscoveryState(value){
      if(value.authorizationServerUrl!==issuer||value.authorizationServerMetadata?.issuer!==issuer)
        throw new Error('OAuth discovery issuer mismatch');
      const endpoints=value.authorizationServerMetadata;
      for(const name of ['authorization_endpoint','token_endpoint','registration_endpoint']){
        if(endpoints?.[name]&&new URL(endpoints[name]).origin!==new URL(issuer).origin)
          throw new Error('OAuth endpoint origin mismatch');
      }
      discovery=value;
    },
    discoveryState:()=>discovery,
    async validateResourceURL(_server,advertised){
      if(advertised&&new URL(advertised).href!==resource.href)throw new Error('OAuth resource mismatch');
      return resource;
    },
    redirectToAuthorization(url){
      if(url.origin!==new URL(issuer).origin||url.protocol!=='https:')
        throw new Error('OAuth authorization origin mismatch');
      process.stderr.write('Authorize encrypted ReMCP: '+url.href+'\n');
      openInBrowser(url.href);
    },
    async invalidateCredentials(scope){
      if(scope==='verifier'||scope==='all')verifier=undefined;
      if(scope==='discovery'||scope==='all')discovery=undefined;
      const patch={};
      if(['all','client'].includes(scope))patch.client=null;
      if(['all','tokens'].includes(scope))patch.tokens=null;
      if(Object.keys(patch).length)await save(patch);
    },
  };
  const client=new Client({name:'remcp-encrypted-client',version:VERSION});
  let transport=new StreamableHTTPClientTransport(resource,{authProvider:provider,requestInit:{headers:{'x-remcp-encrypted-client':'remcp-hpke-auth-p256-v1'}}});
  try{
    try{await client.connect(transport);}
    catch(error){
      if(!(error instanceof UnauthorizedError))throw error;
      const params=await callback;
      await transport.finishAuth(params);
      await transport.close().catch(()=>{});
      transport=new StreamableHTTPClientTransport(resource,{authProvider:provider,requestInit:{headers:{'x-remcp-encrypted-client':'remcp-hpke-auth-p256-v1'}}});
      await client.connect(transport);
    }
    return client;
  }catch{
    await transport.close().catch(()=>{});
    throw new Error('Encrypted MCP OAuth connection failed; verify the endpoint and complete owner authorization.');
  }finally{
    clearTimeout(timer);
    await new Promise(resolve=>listener.close(resolve));
  }
}
