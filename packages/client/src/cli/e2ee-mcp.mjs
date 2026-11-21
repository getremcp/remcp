// A local stdio MCP endpoint is the encryption endpoint trusted by the AI host.
// Hosted relay sees only e2ee_transport packets, never device tool arguments/results.
import {Server} from '@modelcontextprotocol/server';
import {serveStdio} from '@modelcontextprotocol/server/stdio';
import {prepareEncryptedMcpConnection} from './e2ee-mcp-enrollment.mjs';
import {VERSION} from '../version.mjs';

export function createEncryptedMcpServer({client,version=VERSION}){
  const server=new Server({name:'remcp-encrypted-device',version},{
    capabilities:{tools:{}},
    instructions:'Tools execute on the pinned paired computer through authenticated end-to-end encryption. Use only operations authorized by the user and local device policy. Inspect semantic UI or browser state before control actions.',
    cacheHints:{'tools/list':{ttlMs:1500,cacheScope:'private'}},
  });
  server.setRequestHandler('tools/list',async(_request,extra)=>client.listTools({signal:extra?.mcpReq?.signal??extra?.signal}));
  server.setRequestHandler('tools/call',async(request,extra)=>{
    try{return await client.callTool(request.params,{signal:extra?.mcpReq?.signal??extra?.signal});}
    catch(error){
      const text=String(error?.message||'Encrypted device operation failed').slice(0,1000);
      return {isError:true,content:[{type:'text',text}]};
    }
  });
  return server;
}
export async function runEncryptedMcp(flags={}){
  const {client:encrypted,relay}=await prepareEncryptedMcpConnection(flags);
  const handle=serveStdio(()=>createEncryptedMcpServer({client:encrypted}),{
    legacy:'serve',onerror:()=>process.stderr.write('Encrypted MCP protocol error\n'),
  });
  let stopping=false;
  const stop=async()=>{
    if(stopping)return;stopping=true;
    await handle.close();await relay.close();
  };
  process.once('SIGTERM',()=>void stop());
  process.once('SIGINT',()=>void stop());
  process.stdin.once('end',()=>void stop());
}
