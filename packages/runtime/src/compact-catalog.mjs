import { TEXT_OUTPUT_SCHEMA, supportedCoreTools, toolDefinitions } from './catalog.mjs';
import { advertisedExtendedTools, extendedToolDefinitions } from './extended/catalog.mjs';

export const compactRuntimeGroups = Object.freeze({
  manage_files: Object.freeze([
    'read_files','read_multiple_files','read_binary','write_binary','hash_file','list_directory','get_file_info',
    'write_file','write_files','apply_patch','set_permissions','edit_block','replace_lines','replace_in_files','diff_files',
    'move_to_trash','create_directory','move_file','copy_file','copy_paths','move_paths','delete_path','delete_paths',
    'create_archive','extract_archive','start_search','get_more_search_results','stop_search','list_searches',
  ]),
  run_terminal: Object.freeze([
    'start_process','read_process_output','interact_with_process','wait_for_process_output','force_terminate','list_sessions',
  ]),
  control_computer: Object.freeze([
    'computer_snapshot','list_windows','ui_snapshot','ui_find','wait_for_ui','display_inventory',
    'computer_action','window_action','launch_app','ui_action','type_text','keyboard','pointer','drag_drop','scroll',
    'clipboard','open_path','reveal_path','notification','record_screen',
  ]),
  view_image: Object.freeze(['read_image','take_screenshot','screenshot_region']),
  control_browser: Object.freeze([
    'browser_tabs','browser_navigate','browser_snapshot','browser_find','browser_action','browser_wait','browser_devtools','browser_evaluate',
  ]),
  manage_system: Object.freeze([
    'get_system_info','list_processes','kill_process','get_runtime_info','get_runtime_stats','set_config_value',
    'service','event_log','network','installed_apps','environment','audio','power_action',
  ]),
  manage_documents: Object.freeze(['read_document','edit_spreadsheet','edit_document','pdf_action']),
});

const groupTitles = Object.freeze({
  manage_files:'Manage files',
  run_terminal:'Run terminal operations',
  control_computer:'Control computer',
  view_image:'View image or screenshot',
  control_browser:'Control browser',
  manage_system:'Manage system',
  manage_documents:'Manage documents',
});

const groupDescriptions = Object.freeze({
  manage_files:'Use this when the task is about files, directories, archives, or filesystem search on this computer. Choose exactly one operation; parameters must contain only that operation’s arguments and are validated against its closed schema. Write, edit, move, permission, and delete operations can change or remove local data, while read and search operations leave files unchanged. Use read_file for one known text file.',
  run_terminal:'Use this when the task needs a shell command or an existing ReMCP terminal session: start, read, wait, interact, stop, or list sessions. Choose exactly one operation; parameters are validated against that operation’s closed schema. Starting or interacting with commands can change local or external state, and force termination can lose unsaved process work; reading, waiting, and listing do not mutate the session.',
  control_computer:'Use this for semantic inspection or control of native desktop applications on this computer: windows, accessibility/UI elements, waits, displays, app launch, text/input, clipboard, open/reveal, notifications, or short screen recording. Snapshot/find/wait operations observe state; clicks, typing, window close, app launch, clipboard writes, and recording can change local application state. Prefer semantic targets before raw coordinates.',
  view_image:'Use this when the result must be pixels from this computer: read an existing image or capture the desktop, one window, monitor, or region. These operations return pixels without interacting with the visible UI. Use control_computer when semantic structure or an action is enough.',
  control_browser:'Use this for a debuggable Chromium page when the task needs tabs, navigation, DOM/accessibility inspection, element search/actions, waits, or explicit JavaScript evaluation. Snapshot, find, and wait operations observe page state; navigation, clicks, typing, uploads, and JavaScript evaluation can change page or remote-site state. Use control_computer for browser chrome or non-CDP applications.',
  manage_system:'Use this for operating-system or ReMCP runtime state: system/runtime/process facts, runtime preferences, services, event logs, networking, installed apps, environment, audio, or explicit power actions. Fact, log, and inventory operations only observe state; process termination, preference/service/audio changes, restart, and shutdown can interrupt work or change the machine. Use run_terminal for general shell commands.',
  manage_documents:'Use this for structured document content: read PDF/DOCX/XLSX, edit DOCX/XLSX directly, or merge, split, extract, or inspect PDFs. DOCX/XLSX edits can replace the input when no separate output is supplied, and PDF write operations create or replace their requested output; read_document itself is read-only. Use read_file for plain line-oriented text.',
});

const allDefinitions = [...toolDefinitions, ...extendedToolDefinitions];
const definitionByName = new Map(allDefinitions.map(definition => [definition.name, definition]));

function publicDefinition(definition) {
  return {
    name:definition.name,
    title:definition.title,
    description:definition.description,
    inputSchema:structuredClone(definition.inputSchema || { type:'object', properties:{}, additionalProperties:false }),
    outputSchema:structuredClone(definition.outputSchema || TEXT_OUTPUT_SCHEMA),
    annotations:{ ...(definition.annotations || {}) },
  };
}

function uniqueSchemas(schemas) {
  const seen = new Set();
  return schemas.filter(schema => {
    const key = JSON.stringify(schema);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function groupedInputSchema(members) {
  const rules = members.map(name => {
    const definition = definitionByName.get(name);
    if (!definition) throw new Error(`Unknown compact runtime operation: ${name}`);
    const schema = structuredClone(definition.inputSchema || { type:'object', properties:{}, additionalProperties:false });
    const needsParameters = Array.isArray(schema.required) && schema.required.length > 0;
    return {
      if:{ properties:{ operation:{ const:name } }, required:['operation'] },
      then:{
        properties:{ parameters:schema },
        ...(needsParameters ? { required:['parameters'] } : {}),
      },
    };
  });
  return {
    type:'object',
    properties:{
      operation:{ type:'string', enum:[...members], description:'Concrete local runtime operation to execute in this domain.' },
      parameters:{ type:'object', description:'Arguments for the selected operation; validated against that operation’s original closed schema.' },
    },
    required:['operation'],
    allOf:rules,
    additionalProperties:false,
  };
}

function groupedOutputSchema(memberDefinitions) {
  const schemas = uniqueSchemas(memberDefinitions.map(definition => structuredClone(definition.outputSchema || TEXT_OUTPUT_SCHEMA)));
  return schemas.length === 1 ? schemas[0] : { oneOf:schemas };
}

function groupedDefinition(name, members) {
  const memberDefinitions = members.map(member => {
    const definition = definitionByName.get(member);
    if (!definition) throw new Error(`Missing compact runtime operation: ${member}`);
    return definition;
  });
  return {
    name,
    title:groupTitles[name],
    description:groupDescriptions[name],
    inputSchema:groupedInputSchema(members),
    outputSchema:groupedOutputSchema(memberDefinitions),
    annotations:{
      title:groupTitles[name],
      readOnlyHint:memberDefinitions.every(tool => tool.annotations?.readOnlyHint === true),
      destructiveHint:memberDefinitions.some(tool => tool.annotations?.destructiveHint === true),
      idempotentHint:memberDefinitions.every(tool => tool.annotations?.idempotentHint === true),
      openWorldHint:memberDefinitions.some(tool => tool.annotations?.openWorldHint === true),
    },
  };
}

export async function supportedRuntimeOperationNames() {
  const supportedExtended = new Set((await advertisedExtendedTools()).map(tool => tool.name));
  return new Set([
    ...supportedCoreTools().map(tool => tool.name),
    ...extendedToolDefinitions.filter(tool => supportedExtended.has(tool.name)).map(tool => tool.name),
  ]);
}

export async function compactRuntimeToolDefinitions() {
  const supported = await supportedRuntimeOperationNames();
  const tools = [];
  const readFile = definitionByName.get('read_file');
  if (readFile && supported.has('read_file')) tools.push(publicDefinition(readFile));
  for (const [name, configuredMembers] of Object.entries(compactRuntimeGroups)) {
    const members = configuredMembers.filter(member => supported.has(member));
    if (members.length) tools.push(groupedDefinition(name, members));
  }
  return tools;
}

export function resolveCompactRuntimeCall(name, args = {}, definitions = []) {
  if (name === 'read_file') return { runtimeName:'read_file', runtimeArguments:{ ...args } };
  const definition = definitions.find(tool => tool.name === name);
  if (!definition || !compactRuntimeGroups[name]) throw new Error(`Unknown compact runtime tool: ${name}`);
  const runtimeName = String(args.operation || '').trim();
  const allowed = definition.inputSchema?.properties?.operation?.enum || [];
  if (!allowed.includes(runtimeName)) throw new Error(`Unsupported ${name} operation: ${runtimeName || '(empty)'}`);
  const runtimeArguments = args.parameters && typeof args.parameters === 'object' && !Array.isArray(args.parameters)
    ? { ...args.parameters }
    : {};
  return { runtimeName, runtimeArguments };
}
