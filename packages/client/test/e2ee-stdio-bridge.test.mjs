import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {fileURLToPath} from 'node:url';

test('AI MCP client executes a native tool through encrypted stdio bridge',{timeout:15000},async()=>{
  const source=`
    import {serveStdio} from '@modelcontextprotocol/server/stdio';
    import {createEncryptedMcpServer} from './src/cli/e2ee-mcp.mjs';
    import {createE2eeIdentity} from './src/agent-e2ee-crypto.mjs';
    import {createAgentE2eeEndpoint} from './src/agent-e2ee-endpoint.mjs';
    import {createE2eeDeviceClient} from './src/agent-e2ee-client.mjs';
    const device=await createE2eeIdentity(),owner=await createE2eeIdentity();
    const deviceId='device-stdio-1234';
    const endpoint=createAgentE2eeEndpoint({identity:device,deviceId,
      getPeer:async()=>({publicKey:owner.publicKey,fingerprint:owner.fingerprint,mode:'control'}),
      getRuntimeState:()=>({mcp:{
        listTools:async()=>({tools:[{name:'type_text',description:'Unicode text test',
          inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']},
          annotations:{readOnlyHint:false,destructiveHint:true}}]}),
        callTool:async args=>({content:[{type:'text',text:args.arguments.text}],
          structuredContent:{typed:args.arguments.text}})
      }})});
    const client=createE2eeDeviceClient({identity:owner,deviceId,pinnedDevice:device.fingerprint,
      describe:async()=>endpoint.identity(),dispatch:async(packet,options)=>endpoint.handle(packet,options)});
    serveStdio(()=>createEncryptedMcpServer({client}),{legacy:'serve'});
  `;
  const transport=new StdioClientTransport({command:process.execPath,
    args:['--input-type=module','--eval',source],
    cwd:fileURLToPath(new URL('..',import.meta.url)),stderr:'pipe'});
  const client=new Client({name:'AI-encrypted-stdio-qa',version:'1'});
  let stderr='';transport.stderr?.on('data',chunk=>{stderr+=chunk;});
  try{
    await client.connect(transport);
    const catalog=await client.listTools();
    assert.deepEqual(catalog.tools.map(tool=>tool.name),['type_text']);
    assert.equal(catalog.tools[0].annotations.destructiveHint,true);
    const text='MCP 日本語 Привет 🌐';
    const result=await client.callTool({name:'type_text',arguments:{text}});
    assert.equal(result.content[0].text,text);
    assert.equal(result.structuredContent.typed,text);
    const denied=await client.callTool({name:'unknown',arguments:{}});
    assert.equal(denied.isError,true);
    assert.ok(!stderr.includes(text),'plaintext tool output must not be logged to stderr');
  }finally{await client.close();}
});
