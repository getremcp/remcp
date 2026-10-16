import { archiveBackendAvailable, fileToolHandlers } from './tools/files.mjs';
import { searchToolHandlers } from './tools/search.mjs';
import { terminalToolHandlers } from './tools/terminal.mjs';
import { systemToolHandlers } from './tools/system.mjs';
import { statsToolHandlers } from './tools/stats.mjs';
import { configToolHandlers } from './tools/config.mjs';

// Every tool answers with a text result (image tools add an image part as well), so the
// declared output schema is the same shape everywhere and clients can rely on it.
export const TEXT_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'Human-readable result of the tool call.' },
  },
  required: ['text'],
  additionalProperties: false,
};

export const NULLABLE_NUMBER_SCHEMA = { anyOf:[{ type:'number' }, { type:'null' }] };
export const NULLABLE_STRING_SCHEMA = { anyOf:[{ type:'string' }, { type:'null' }] };
export const TERMINAL_SESSION_PROPERTIES = {
  pid:{ type:'number', description:'Process/session id used by follow-up terminal tools.' },
  status:{ type:'string', description:'running or exited, with an exit code/signal when known.' },
  runtimeMs:{ type:'number' },
  lines:{ type:'number', description:'Total output lines produced by the session.' },
  exited:{ type:'boolean' },
  exitCode:NULLABLE_NUMBER_SCHEMA,
  signal:NULLABLE_STRING_SCHEMA,
};
function terminalOutputSchema(extraProperties = {}, extraRequired = []) {
  return {
    type:'object',
    properties:{ ...TERMINAL_SESSION_PROPERTIES, ...extraProperties },
    required:['pid','status','runtimeMs','lines','exited','exitCode','signal', ...extraRequired],
    additionalProperties:false,
  };
}
export const START_PROCESS_OUTPUT_SCHEMA = terminalOutputSchema({
  command:{ type:'string' },
  output:{ type:'string' },
  partial:{ type:'string' },
  warning:{ type:'string' },
}, ['command','output']);
export const READ_PROCESS_OUTPUT_SCHEMA = terminalOutputSchema({
  range:{ type:'string' },
  output:{ type:'string' },
  explicitOffset:{ type:'boolean' },
}, ['range','output','explicitOffset']);
export const WAIT_PROCESS_OUTPUT_SCHEMA = terminalOutputSchema({
  pattern:{ type:'string' },
  matched:{ type:'boolean' },
  bufferedMatch:{ type:'boolean' },
  timeoutMs:{ type:'number' },
  output:{ type:'string' },
}, ['pattern','matched','bufferedMatch','timeoutMs','output']);
export const INTERACT_PROCESS_OUTPUT_SCHEMA = terminalOutputSchema({
  output:{ type:'string' },
}, ['output']);
export const TERMINATE_PROCESS_OUTPUT_SCHEMA = terminalOutputSchema({
  terminated:{ type:'boolean' },
  alreadyExited:{ type:'boolean' },
  escalated:{ type:'boolean' },
}, ['terminated','alreadyExited','escalated']);
export const LIST_SESSIONS_OUTPUT_SCHEMA = {
  type:'object',
  properties:{
    sessions:{
      type:'array',
      items:{
        type:'object',
        properties:{
          ...TERMINAL_SESSION_PROPERTIES,
          blocked:{ type:'string' },
          command:{ type:'string' },
        },
        required:['pid','status','runtimeMs','lines','exited','exitCode','signal','blocked','command'],
        additionalProperties:false,
      },
    },
  },
  required:['sessions'],
  additionalProperties:false,
};

export const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export const readOnlyNonIdempotent = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false };
export const additive = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export const mutating = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
export const command = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };


export { archiveBackendAvailable, fileToolHandlers, searchToolHandlers, terminalToolHandlers, systemToolHandlers, statsToolHandlers, configToolHandlers };
