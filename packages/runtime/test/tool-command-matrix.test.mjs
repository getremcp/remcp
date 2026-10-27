import test from 'node:test';
import assert from 'node:assert/strict';
import { toolDefinitions, toolHandlers, TEXT_OUTPUT_SCHEMA } from '../src/catalog.mjs';
import { extendedToolDefinitions, extendedToolHandlers } from '../src/extended/catalog.mjs';
import { hasTool, invokeTool } from '../src/invoke.mjs';

// Every advertised runtime command is checked independently. No destructive
// device operation is executed here: dispatcher tests use a scoped replacement
// handler and cancellation checks must short-circuit before the handler.
const all = [...toolDefinitions, ...extendedToolDefinitions];
const propertyTypes = new Set(['string','number','integer','boolean','array','object','null']);
function validateSchema(schema, context) {
  assert.ok(schema && typeof schema === 'object' && !Array.isArray(schema), context);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    for (const type of types) assert.ok(propertyTypes.has(type), context+': type '+type);
  }
  if (schema.properties) {
    assert.equal(typeof schema.properties, 'object', context+'.properties');
    if (schema.required) for (const field of schema.required) {
      assert.ok(Object.hasOwn(schema.properties,field),context+': required property '+field+' missing');
    }
    for (const [key,value] of Object.entries(schema.properties))
      validateSchema(value,context+'.'+key);
  }
  if (schema.items) validateSchema(schema.items,context+'[]');
  if (Array.isArray(schema.oneOf)) schema.oneOf.forEach((item,i)=>validateSchema(item,context+'.oneOf['+i+']'));
  if (Array.isArray(schema.anyOf)) schema.anyOf.forEach((item,i)=>validateSchema(item,context+'.anyOf['+i+']'));
  if (Array.isArray(schema.enum)) assert.ok(schema.enum.length>0,context+': empty enum');
}

test('every runtime command has a unique actual handler', () => {
  assert.equal(all.length,84,'update this gate deliberately when adding/removing runtime operations');
  assert.equal(new Set(all.map(x=>x.name)).size,all.length);
  assert.equal(toolHandlers.size,toolDefinitions.length);
  assert.equal(extendedToolHandlers.size,extendedToolDefinitions.length);
});

for (const tool of all) {
  test('tool contract + dispatch + cancellation: '+tool.name, async () => {
    const {name,title,description,inputSchema,outputSchema,annotations}=tool;
    assert.match(name,/^[a-z][a-z0-9_]*$/);
    assert.ok(title?.trim(),'missing title');
    assert.ok(description?.trim()?.length>=20,'missing actionable description');
    assert.equal(typeof tool.handler,'function','handler is missing');
    assert.equal(hasTool(name),true,'unreachable handler');
    assert.equal(inputSchema?.type,'object');
    assert.equal(inputSchema?.additionalProperties,false,
      'unknown parameters must fail in the MCP input validator');
    validateSchema(inputSchema,name+'.input');
    validateSchema(outputSchema || TEXT_OUTPUT_SCHEMA,name+'.output');
    for(const key of ['readOnlyHint','destructiveHint','idempotentHint','openWorldHint'])
      assert.equal(typeof annotations?.[key],'boolean',name+'.'+key);
    if(annotations.readOnlyHint)assert.equal(annotations.destructiveHint,false,
      'read-only cannot be destructive');
    if(annotations.destructiveHint)assert.equal(annotations.idempotentHint,false,
      'destructive tool must not advertise idempotent retries');

    // Abort must never reach *any* handler, even when the name/args would
    // otherwise be valid. Device permissions and OS state are untouched.
    const cancelled=new AbortController();
    cancelled.abort();
    const aborted=await invokeTool(name,{},{signal:cancelled.signal});
    assert.equal(aborted?.isError,true,name+': cancellation status');
    assert.match(aborted?.content?.[0]?.text||'',/cancelled/i,name+': cancellation error');
    // Exercise the real dispatcher lookup with an inert handler. Restore in a
    // finally block so a regression cannot poison other tests in this worker.
    const original=tool.handler;
    const marker='remcp-command-qa:'+name;
    let invoked=0;
    tool.handler=async (args,extra) => {
      invoked++;
      assert.deepEqual(args,{test_mode:true});
      assert.deepEqual(extra,{});
      return {content:[{type:'text',text:marker}]};
    };
    try {
      const routed=await invokeTool(name,{test_mode:true});
      assert.notEqual(routed?.isError,true,'safe dispatch returned failure');
      assert.equal(routed?.content?.[0]?.text,marker);
      assert.equal(invoked,1,name+': wrong handler/called more than once');
    } finally {
      tool.handler=original;
    }
  });
}
