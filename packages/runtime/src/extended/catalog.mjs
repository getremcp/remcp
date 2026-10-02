import process from 'node:process';
const JSON_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  description: 'Structured tool result. Array/scalar payloads are exposed under data for compatibility with MCP clients that require object-root output schemas.',
};
import { browserControlAvailable, browserHandlers, browserRemoteEnabled } from './browser.mjs';
import { isWaylandSession } from '../screenshot-portal.mjs';
import { waylandPortalCandidate } from '../wayland-remote-desktop.mjs';
import { commandExists, desktopSessionAvailable, runFile } from './common.mjs';
import { desktopHandlers } from './desktop.mjs';
import { regionScreenshotBackends } from './desktop-linux.mjs';
import { diagnosticHandlers, gnomeScreencastSupported, recordScreenAvailable } from './diagnostics.mjs';
import { documentHandlers } from './documents.mjs';

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const readOnlyLive = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const readOnlyOpen = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const additive = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const mutatingNonDestructive = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const openMutatingNonDestructive = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const mutating = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const openMutating = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

const s = description => ({ type: 'string', ...(description ? { description } : {}) });
const n = description => ({ type: 'number', ...(description ? { description } : {}) });
const b = description => ({ type: 'boolean', ...(description ? { description } : {}) });
const e = (values, description) => ({ type: 'string', enum: values, ...(description ? { description } : {}) });
const o = (properties = {}, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false });

const AI_TOOL_DESCRIPTIONS = Object.freeze({
  computer_snapshot: 'Use this for the first look at an unfamiliar desktop state when you need one compact bundle of windows, semantic UI, displays, clipboard metadata and optional pixels/browser/OCR. Prefer it over repeated screenshots; narrow later with ui_find, browser_find or screenshot_region.',
  computer_action: 'Use this only when one semantic click/type/invoke/select/focus/scroll/drag action must work across an uncertain target backend and may need Accessibility → browser DOM/CDP → OCR → coordinate fallback, or when multi_select/multi_edit avoids many identical native UI calls. When the backend is already known, prefer the specialist tool (ui_action, browser_action, type_text, drag_drop, scroll or window_action) for its full controls. Keep keyboard, clipboard, launch/open/reveal/notification and raw pointer gestures in their dedicated tools.',
  list_windows: 'Use this to discover top-level desktop windows or obtain a stable window id/PID/bounds before window_action, screenshot_region or targeted input. Use ui_snapshot instead when you need controls inside a window; prefer list_windows over screenshot-based window guessing.',
  window_action: 'Use this to focus, minimize, maximize, restore, move, resize or close one known top-level window. Select it by id/PID/app/title from list_windows. Use ui_action for controls inside the window; do not use pointer coordinates for window management when this semantic tool can express the action.',
  launch_app: 'Use this to start a desktop application by executable/path or friendly application name without a shell. Prefer it over start_process for GUI application launch. If the user wants to open a specific file or directory in its associated application, use open_path instead; use start_process for terminal commands, build tools and shell pipelines.',
  ui_snapshot: 'Use this to inspect native desktop Accessibility/UI Automation semantics for the active app before clicking or typing. Prefer scope=active; use scope=desktop only for cross-application discovery. For a Chromium web page with CDP available, prefer browser_snapshot for page DOM semantics.',
  ui_find: 'Use this after ui_snapshot when you need a small set of native UI elements by role/name/label/AutomationId. It requires an element criterion; use ui_snapshot, not an empty ui_find, to enumerate UI. Prefer returned id or compact label for subsequent ui_action; refresh only when the UI has changed.',
  ui_action: 'Use this to invoke, focus, edit, select, toggle, expand/collapse, range-edit or scroll a native accessible UI element. Prefer this over pointer clicks because semantic actions survive layout changes; fall back to pointer only when accessibility cannot perform the requested action.',
  type_text: 'Use this for reliable Unicode text entry into a native semantic target or focused native control. Prefer method=auto so Accessibility is used when the target supports verified semantic editing. For Chromium page DOM, use browser_action instead of forcing desktop accessibility text input; auto fails safely when a semantic element rejects the write rather than claiming an unverified paste. Use method=keys only for deliberate physical key-by-key input, and keyboard for shortcuts/navigation/control keys.',
  keyboard: 'Use this for shortcuts and individual key presses such as Ctrl/Cmd+C, Tab, Enter or Escape. Do not use it to enter normal prose when type_text is available. On Wayland auto uses an already-authorized portal; backend=portal explicitly requests consent.',
  pointer: 'Use this only when an action truly requires screen coordinates or a semantic UI/browser action is unavailable. Prefer ui_action for native controls and browser_action for web controls; pointer is the coordinate fallback for move/click/button-down/button-up.',
  drag_drop: 'Use this for a real drag gesture between two UI element ids or coordinates. Prefer element ids from ui_find/ui_snapshot because their current bounds are resolved at execution time; use coordinates only when no semantic endpoints exist. On GNOME Wayland, real drag input requires the consent-backed Remote Desktop portal because XTEST/xdotool drag delivery is not reliable.',
  scroll: 'Use this for native wheel scrolling of a desktop region or semantic UI target. Prefer browser_action scroll_into_view for a known web element and ui_action scroll_into_view for a known accessible desktop element.',
  wait_for_ui: 'Use this after a desktop action to wait for an explicit native UI state or condition instead of sleeping or polling screenshots. Presence/absence waits need a semantic target; use state=changed for a broad tree change and set a bounded timeout.',
  clipboard: 'Use this for explicit text clipboard read/write/clear operations. Do not use clipboard as a typing workaround directly; type_text already uses safe clipboard paste with restoration when needed.',
  display_inventory: 'Use this before monitor-specific screenshots, cross-monitor geometry or coordinate work to obtain monitor bounds, scale and primary-display information.',
  screenshot_region: 'Use this when static pixels are required for visual verification but only one window, monitor or rectangle matters. Prefer it over take_screenshot for a full desktop and over record_screen when motion/timing is not required; use ui_snapshot/browser_snapshot first when semantic structure is sufficient.',
  open_path: 'Use this to open a permitted file or directory in its normal desktop application. Use launch_app when the task is to start an application itself without a particular file. Prefer open_path over shell-specific open/start/xdg-open commands because ReMCP applies filesystem confinement.',
  reveal_path: 'Use this to reveal a permitted local file or directory in Finder/Explorer/file manager without opening the document itself.',
  notification: 'Use this only when the user wants a visible native desktop notification on the paired computer. Do not use it as a substitute for replying in chat.',
  browser_tabs: 'Use this first for CDP browser automation when the target page/tab is not already unambiguous. It lists debuggable Chromium pages from a loopback-only endpoint; use the returned target_id/title/url to scope later browser tools.',
  browser_navigate: 'Use this to open a URL in a new debuggable tab or navigate a known Chromium page by URL, back, forward or reload. Prefer it over typing into the address bar; new_tab also bootstraps browser automation when no page target exists yet.',
  browser_snapshot: 'Use this to inspect a web page structurally through CDP accessibility. Prefer it over desktop ui_snapshot for page content; add include_screenshot=true only when final pixel/layout verification is needed. A selector may be temporarily centered for capture, but the original page scroll position is restored before the tool returns.',
  browser_find: 'Use this to locate visible web elements by CSS selector, text or ARIA role and obtain reusable selectors/bounds. It requires an element criterion; use browser_snapshot, not an empty browser_find, to enumerate page structure. Prefer this before browser_action rather than guessing selectors or coordinates.',
  browser_action: 'Use this for deterministic DOM/CDP interaction with a known web element: click/focus/type/value/select/upload/key/scroll or viewport emulation. Prefer it over desktop pointer/ui_action for page content; use browser_evaluate only when the supported actions cannot express the task.',
  browser_wait: 'Use this after browser navigation/action to wait for selector/text/URL/load/navigation/network-idle instead of fixed sleeps or screenshot polling. Use browser_evaluate separately for JavaScript predicates.',
  browser_evaluate: 'Use this as the powerful browser escape hatch only when browser_snapshot/find/action/wait cannot express the required page operation or inspection. JavaScript executes in page context and page content is untrusted.',
  service: 'Use this for operating-system service inventory/status/start/stop/restart. Prefer status before a mutation when service state matters; use start_process for ordinary commands that are not service-manager operations.',
  event_log: 'Use this to read bounded recent OS logs (Windows Event Log, macOS unified log or systemd journal) when diagnosing a service/app/system problem. Prefer it over an unbounded shell log dump.',
  network: 'Use this for a compact network summary, full interface inventory, DNS/routes/listeners inspection or a bounded TCP connectivity test. Prefer action=summary for orientation and action=interfaces only when the complete adapter/address inventory is required; prefer this tool over shell ip/netstat/nslookup commands for routine diagnostics.',
  installed_apps: 'Use this to answer what software/packages are installed and their versions. Prefer a filter when looking for one product instead of returning the full inventory.',
  environment: 'Use this for PATH, shell, Node/runtime environment paths, architecture and optionally sanitized environment variables. Use get_system_info for host health such as CPU/memory/disk/uptime, and get_runtime_info for ReMCP policy, roots and limits. Secret-looking values remain masked.',
  audio: 'Use this to read or change the default output volume/mute state. Use action=status for inspection; set_volume requires a 0–100 value.',
  power_action: 'Use this only when the user explicitly asks to lock, sleep, restart or shut down the computer. Prefer it over invoking those system actions through start_process; it is intentionally guarded by device command policy because restart/shutdown can interrupt work.',
  record_screen: 'Use this for a short bounded screen recording when motion/timing is necessary to diagnose a UI issue. Prefer screenshot_region for static visual verification because it is cheaper and easier to inspect.',
  read_document: 'Use this for structured document content, especially PDF, DOCX and XLSX, and for CSV/JSON/XML when document-style parsing is useful. Use read_file for ordinary source code, logs, configuration, Markdown, or other plain line-oriented text. Prefer read_document over shell extraction or launching Office when the goal is document content; PDF reading uses the built-in parser first and may fall back to local pdftotext when embedded fonts prevent direct decoding.',
  edit_spreadsheet: 'Use this to create a new XLSX workbook or directly edit XLSX cells/ranges/formulas without launching Excel. Set create=true only for a new path; it fails rather than overwriting an existing workbook. Prefer explicit cells/ranges and write to output when preserving an existing original matters.',
  edit_document: 'Use this to create a new DOCX document or make structured DOCX paragraph edits without launching Word. Set create=true only for a new path; it fails rather than overwriting an existing document. It is best for replace/insert/delete paragraph operations; use native UI automation only when document formatting/layout interaction is required.',
  pdf_action: 'Use this for PDF metadata/annotations inspection or structural merge/split/page extraction. For reading PDF text use read_document; supply an output/output_dir for write actions when preserving originals matters.',
});

const COMMON_PARAM_DESCRIPTIONS = Object.freeze({
  action:'Operation to perform; choose the narrowest action that directly matches the requested outcome.',
  id:'Stable target id returned by the corresponding discovery tool.',
  label:'Compact numeric accessibility label from the most recent semantic UI snapshot/find.',
  pid:'Owning process id used to scope the target.',
  app:'Application/process name or substring used to select the target.',
  title:'Window/page title substring used to select the target.',
  window_title:'Top-level accessibility window/frame title substring used to scope native UI matching.',
  name:'Accessible element name/title substring.',
  role:'Accessible or ARIA role used to narrow semantic matching.',
  automation_id:'Windows UI Automation AutomationId when available.',
  x:'Virtual-desktop X coordinate in pixels.',
  y:'Virtual-desktop Y coordinate in pixels.',
  width:'Width in pixels.',
  height:'Height in pixels.',
  value:'Value required by the selected action.',
  text:'Text required by the selected action.',
  selector:'CSS selector identifying a web element.',
  endpoint:'Loopback Chrome DevTools Protocol endpoint; normally leave unset to use the default.',
  target_id:'Browser page target id returned by browser_tabs.',
  url_contains:'Substring used to select a browser page by URL.',
  timeout_ms:'Bounded timeout in milliseconds.',
  poll_ms:'Polling interval in milliseconds.',
  path:'Permitted local filesystem path.',
  output:'Optional permitted output path; when omitted the tool may update the input according to its action.',
  output_dir:'Permitted directory for generated output files.',
  paths:'List of permitted local filesystem paths.',
  args:'Argument array passed directly to the launched application; no shell parsing.',
  backend:'Input backend preference; auto is recommended unless a specific backend is required.',
  key:'Single key name such as Enter, Escape, Tab or A.',
  shortcut:'Keyboard shortcut such as CTRL+L, CMD+K or ALT+F4.',
  delta_x:'Horizontal wheel/scroll delta; positive values move right.',
  delta_y:'Vertical wheel/scroll delta; positive values move down.',
  from_x:'Source X coordinate for a drag gesture.',
  from_y:'Source Y coordinate for a drag gesture.',
  to_x:'Destination X coordinate for a drag gesture.',
  to_y:'Destination Y coordinate for a drag gesture.',
  from_id:'Source semantic UI element id; preferred over source coordinates when available.',
  to_id:'Destination semantic UI element id; preferred over destination coordinates when available.',
  limit:'Maximum number of results to return.',
  filter:'Optional bounded filter expression or text used to reduce returned results.',
  query:'Optional platform-specific query used to reduce returned log results.',
  scope:'Scope of the operation; choose user scope unless the task explicitly requires a system service.',
  host:'Host name or IP address for a bounded connectivity test.',
  port:'TCP port number for a connectivity test.',
  duration_seconds:'Bounded recording/action duration in seconds.',
  fps:'Frames per second for screen recording.',
  sheet:'Worksheet name.',
  max_cells:'Maximum number of spreadsheet cells to return.',
  pattern:'Output filename pattern where supported.',
  pages:'PDF page numbers/ranges such as 1-3,5.',
  message:'User-visible notification text.',
  max_nodes:'Maximum accessibility nodes to inspect or return; keep this bounded and raise it only when the target is missing.',
  max_depth:'Maximum accessibility tree depth to traverse.',
  method:'Text-entry strategy. auto is recommended; accessibility is semantic, clipboard preserves Unicode, and keys emits physical key events whose printable characters follow the computer current keyboard layout.',
  caret_position:'Where text insertion should occur when the semantic editor supports caret placement.',
  keys:'Ordered key names that together form the requested shortcut or key sequence.',
  button:'Pointer button to use for click/down/up or drag gestures.',
  hold_ms:'How long to hold the pointer button before movement during a drag.',
  duration_ms:'Duration of the drag/movement gesture in milliseconds.',
  replacement:'Replacement text for matching document content.',
  direction:'Human-readable scroll direction used with wheel_times instead of explicit deltas.',
  condition:'Semantic condition to wait for; choose the condition that directly proves the requested state transition.',
  timeout_seconds:'Bounded native notification display timeout in seconds when the platform supports it.',
  text_value:'Text value used by browser type/set-value actions; use text or value when possible unless the action specifically expects this compatibility alias.',
  option:'Option value to select in a browser select element.',
  expression:'JavaScript expression or predicate used only by the selected browser operation/wait condition.',
  edits:'Bounded list of spreadsheet edits; each item names a cell/range and the value(s) or formula to write.',
  operations:'Bounded list of structured document operations executed in order.',
});

function enrichSchemaDescriptions(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const copy = structuredClone(schema);
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (node.properties && typeof node.properties === 'object') {
      for (const [key, property] of Object.entries(node.properties)) {
        if (property && typeof property === 'object' && !property.description) {
          property.description = COMMON_PARAM_DESCRIPTIONS[key] || ('Parameter ' + key.replaceAll('_',' ') + ' for this operation.');
        }
        visit(property);
      }
    }
    if (node.items) visit(node.items);
    for (const key of ['oneOf','anyOf','allOf']) if (Array.isArray(node[key])) node[key].forEach(visit);
  };
  visit(copy);
  return copy;
}

const outputString = description => ({ type:'string', ...(description ? { description } : {}) });
const outputNumber = description => ({ type:'number', ...(description ? { description } : {}) });
const outputBoolean = description => ({ type:'boolean', ...(description ? { description } : {}) });
const outputObject = description => ({ type:'object', additionalProperties:true, ...(description ? { description } : {}) });
const outputNullableObject = description => ({ type:['object','null'], additionalProperties:true, ...(description ? { description } : {}) });
const outputRecord = (properties = {}, description) => ({ type:'object', properties, additionalProperties:true, ...(description ? { description } : {}) });
const outputArray = (items = {}, description) => ({ type:'array', items, ...(description ? { description } : {}) });

const OUTPUT_FIELDS = Object.freeze({
  computer_snapshot: {
    device:outputObject('Device/platform metadata for the captured computer state.'),
    windows:outputArray(outputObject(), 'Top-level windows with stable ids/PIDs/bounds when available.'),
    displays:outputArray(outputObject(), 'Display inventory used for virtual-desktop geometry.'),
    active_window:outputNullableObject('Active top-level window when known; null when accessibility state cannot be joined to top-level window enumeration.'),
    ui:outputObject('Native accessibility snapshot and semantic tree.'),
    cursor:outputObject('Pointer position when available.'),
    clipboard:outputObject('Clipboard metadata only unless clipboard content was explicitly requested.'),
    browser:outputObject('Optional browser DOM/CDP snapshot.'),
    ocr:outputObject('Optional OCR words/metadata.'),
    fallback_chain:outputObject('Which semantic/DOM/OCR/coordinate layers were requested and available.'),
    errors:outputArray(outputObject(), 'Non-fatal sub-capture errors.'),
  },
  computer_action: { action:outputString(), ok:outputBoolean(), completed:outputNumber(), results:outputArray(outputObject()), stopped_at:outputNumber(), count:outputNumber(), waited_ms:outputNumber(), capped:outputBoolean() },
  list_windows: { data:outputArray(outputRecord({ id:outputString('Stable window id.'), pid:outputNumber('Owning process id.'), app:outputString(), title:outputString(), x:outputNumber(), y:outputNumber(), width:outputNumber(), height:outputNumber(), monitor:{ type:['string','number','null'], description:'Monitor name or platform index when available.' }, active:outputBoolean(), minimized:outputBoolean(), maximized:outputBoolean() }, 'Top-level window record.'), 'Top-level windows.') },
  window_action: { action:outputString(), id:outputString(), pid:outputNumber(), title:outputString(), text:outputString() },
  launch_app: { text:outputString('Human-readable launch result and optional ready-window confirmation.') },
  ui_snapshot: { platform:outputString(), count:outputNumber(), nodes:outputArray(outputRecord({ id:outputString('Stable accessibility element id.'), label:outputNumber('Compact label valid for the current cached snapshot.'), role:outputString(), name:outputString(), value:{ type:['string','number','boolean','null'], description:'Accessible value in its native scalar type when available.' }, x:outputNumber(), y:outputNumber(), width:outputNumber(), height:outputNumber(), focused:outputBoolean(), enabled:outputBoolean() }, 'Accessible semantic node.')), semantic_tree:outputString(), label_count:outputNumber(), browser_dom:outputObject() },
  ui_find: { count:outputNumber(), nodes:outputArray(outputRecord({ id:outputString('Stable accessibility element id.'), label:outputNumber('Compact snapshot label.'), role:outputString(), name:outputString(), value:{ type:['string','number','boolean','null'], description:'Accessible value in its native scalar type when available.' }, x:outputNumber(), y:outputNumber(), width:outputNumber(), height:outputNumber() }, 'Matched accessible node.')) },
  ui_action: { action:outputString(), id:outputString(), label:outputNumber(), backend:outputString(), result:outputObject(), text:outputString() },
  type_text: { length:outputNumber(), method:outputString(), target:outputObject(), clear:outputBoolean(), press_enter:outputBoolean(), clipboard_restored:outputBoolean(), backend:outputString() },
  keyboard: { action:outputString(), backend:outputString(), text:outputString() },
  pointer: { action:outputString(), x:outputNumber(), y:outputNumber(), button:outputString(), backend:outputString(), id:outputString() },
  drag_drop: { from:outputArray(outputNumber()), to:outputArray(outputNumber()), from_element:outputString(), to_element:outputString(), backend:outputString() },
  scroll: { delta_x:outputNumber(), delta_y:outputNumber(), backend:outputString(), text:outputString() },
  wait_for_ui: { state:outputString(), wanted:outputString(), matched:{ type:['number','boolean'], description:'Match count for state waits or boolean result for condition waits.' }, attempts:outputNumber(), elapsed_ms:outputNumber(), nodes:outputArray(outputObject()), before:outputObject() },
  clipboard: { action:outputString(), length:outputNumber(), backend:outputString(), text:outputString(), data:outputString() },
  display_inventory: { data:outputArray(outputObject('Display with id/name/virtual bounds/scale/primary state.')) },
  screenshot_region: { text:outputString('Capture summary; image bytes are returned as MCP image content.'), image:outputObject('Optional structured image metadata when the client mirrors image content.') },
  open_path: { text:outputString() },
  reveal_path: { text:outputString() },
  notification: { text:outputString() },
  browser_tabs: { data:outputArray(outputRecord({ id:outputString('Stable CDP page target id.'), title:outputString(), url:outputString(), type:outputString(), webSocketDebuggerUrl:outputString() }, 'Debuggable browser page target.')) },
  browser_navigate: { target_id:outputString('Stable CDP page target id.'), action:outputString(), url:outputString(), title:outputString(), frame_id:{ type:['string','null'], description:'CDP frame id when navigation produced one.' }, error_text:{ type:['string','null'], description:'CDP navigation error text, or null when navigation succeeded.' } },
  browser_snapshot: { target_id:outputString('Stable CDP page target id.'), url:outputString(), title:outputString(), count:outputNumber(), nodes:outputArray(outputObject('Accessibility node for the page.')), semantic_tree:outputString(), screenshot:outputObject() },
  browser_find: { target_id:outputString(), count:outputNumber(), matches:outputArray(outputRecord({ selector:outputString('Reusable CSS selector when one can be derived.'), role:outputString(), text:outputString(), x:outputNumber(), y:outputNumber(), width:outputNumber(), height:outputNumber() }, 'Matched DOM element.')) },
  browser_action: { target_id:outputString(), action:outputString(), selector:outputString(), key:outputString(), files:outputNumber(), width:outputNumber(), height:outputNumber(), device_scale_factor:outputNumber(), mobile:outputBoolean(), result:outputObject() },
  browser_wait: { target_id:outputString(), condition:outputString(), matched:outputBoolean(), attempts:outputNumber(), elapsed_ms:outputNumber(), value:outputObject(), url:outputString(), text:outputString() },
  browser_evaluate: { target_id:outputString(), value:{} },
  service: { data:outputArray(outputObject('Service record.')), action:outputString(), name:outputString(), text:outputString() },
  event_log: { text:outputString('Bounded log output.'), data:outputArray(outputObject()) },
  network: { hostname:outputString(), interfaces:outputObject(), dns:outputArray(outputString()), servers:outputArray(outputString()), host:outputString(), port:outputNumber(), ok:outputBoolean(), latency_ms:outputNumber(), interface_count:outputNumber(), interface_count_returned:outputNumber(), address_count:outputNumber(), address_count_returned:outputNumber(), interfaces_truncated:outputBoolean(), addresses_truncated:outputBoolean(), data:outputArray(outputObject()) },
  installed_apps: { data:outputArray(outputObject('Installed app/package with name/version/path where available.')) },
  environment: { platform:outputString(), arch:outputString(), hostname:outputString(), release:outputString(), shell:outputString(), path:outputString(), node:outputString(), env:outputObject() },
  audio: { volume:outputNumber(), muted:outputBoolean(), action:outputString(), backend:outputString(), text:outputString() },
  power_action: { text:outputString(), action:outputString() },
  record_screen: { path:outputString(), bytes:outputNumber(), duration_seconds:outputNumber(), format:outputString() },
  read_document: { text:outputString(), path:outputString(), data:{}, sheets:outputArray(outputObject()), sheet:outputString(), rows:outputArray({}), cells:outputArray({}) },
  edit_spreadsheet: { path:outputString(), sheet:outputString(), edited_cells:outputNumber(), bytes:outputNumber(), created:outputBoolean() },
  edit_document: { path:outputString(), operations:outputNumber(), changes:outputNumber(), bytes:outputNumber(), created:outputBoolean() },
  pdf_action: { action:outputString(), path:outputString(), source:outputString(), output:outputString(), output_dir:outputString(), files:outputArray(outputString()), pages:outputString(), bytes:outputNumber(), annotations:outputArray(outputObject()), annotation_count:outputNumber('Number of PDF annotations found by the info action.'), inputs:outputNumber() },
});

function outputSchemaFor(name, title) {
  const properties = {
    ...(OUTPUT_FIELDS[name] || {}),
    truncated:{ type:'boolean', description:'True when the structured mirror was bounded because the result was large.' },
    bytes:{ type:'number', description:'Serialized structured-result size when truncation metadata is returned.' },
    preview:{ type:'string', description:'Bounded JSON preview when the full structured mirror is too large.' },
    data:(OUTPUT_FIELDS[name] || {}).data || { description:'Array/scalar payload wrapper used when the natural result is not an object.' },
    text:(OUTPUT_FIELDS[name] || {}).text || { type:'string', description:'Human-readable structured mirror for text-only results.' },
  };
  return {
    type:'object',
    properties,
    additionalProperties:true,
    description:title + ' structured result for ' + name + '. Stable fields are declared explicitly; platform-specific fields may be added. Large results may return truncated/bytes/preview instead of the full payload.',
  };
}

function requiredAny(...groups) {
  return groups.map(required => ({ required }));
}

function applySchemaRules(name, schema) {
  const next = structuredClone(schema);
  if (name === 'computer_action') {
    const nativeTarget = requiredAny(['id'], ['label'], ['name'], ['role'], ['automation_id']);
    const browserElementTarget = requiredAny(['selector'], ['browser_text'], ['name']);
    const windowTarget = requiredAny(['window_id'], ['pid'], ['app'], ['window_title'], ['title']);
    const semanticTarget = [...nativeTarget, ...browserElementTarget];
    next.allOf = [
      {
        if:{ properties:{ target:{ const:'window' } }, required:['target'] },
        then:{
          properties:{ action:{ enum:['type','focus','scroll','drag'] } },
          anyOf:windowTarget,
        },
      },
      {
        if:{ properties:{ action:{ const:'click' } }, required:['action'] },
        then:{ anyOf:[...semanticTarget, { required:['ocr_text'] }, { required:['x','y'] }] },
      },
      {
        if:{ properties:{ action:{ enum:['invoke','set_value','select','toggle','expand','collapse','scroll_into_view','set_range_value','add_to_selection','remove_from_selection'] } }, required:['action'] },
        then:{ anyOf:semanticTarget },
      },
      {
        if:{ properties:{ action:{ const:'focus' } }, required:['action'] },
        then:{ anyOf:[...semanticTarget, ...requiredAny(['window_id'], ['pid'], ['app'], ['window_title'], ['title'])] },
      },
      {
        if:{ properties:{ action:{ const:'type' } }, required:['action'] },
        then:{
          required:['text'],
          properties:{ target:{ enum:['auto','ui','ui_element','browser','window'] } },
          allOf:[
            { anyOf:[...semanticTarget, ...windowTarget] },
            {
              if:{ properties:{ target:{ enum:['ui','ui_element'] } }, required:['target'] },
              then:{ anyOf:nativeTarget },
            },
            {
              if:{ properties:{ target:{ const:'browser' } }, required:['target'] },
              then:{ anyOf:browserElementTarget },
            },
          ],
        },
      },
      {
        if:{ properties:{ action:{ const:'scroll' } }, required:['action'] },
        then:{
          properties:{ target:{ enum:['auto','ui','ui_element','browser','coordinates','window'] } },
          allOf:[
            { anyOf:requiredAny(['delta_x'], ['delta_y'], ['delta'], ['direction']) },
            {
              if:{ properties:{ target:{ enum:['ui','ui_element'] } }, required:['target'] },
              then:{ anyOf:nativeTarget },
            },
            {
              if:{ properties:{ target:{ const:'coordinates' } }, required:['target'] },
              then:{ required:['x','y'] },
            },
          ],
        },
      },
      {
        if:{ properties:{ action:{ const:'drag' } }, required:['action'] },
        then:{
          properties:{ target:{ enum:['auto','ui','ui_element','coordinates','window'] } },
          allOf:[
            { anyOf:requiredAny(['from_id'], ['from_x','from_y']) },
            { anyOf:requiredAny(['to_id'], ['to_x','to_y']) },
            {
              if:{ properties:{ target:{ enum:['ui','ui_element'] } }, required:['target'] },
              then:{ required:['from_id','to_id'] },
            },
            {
              if:{ properties:{ target:{ const:'coordinates' } }, required:['target'] },
              then:{ required:['from_x','from_y','to_x','to_y'] },
            },
          ],
        },
      },
      {
        if:{ properties:{ action:{ enum:['set_value','set_range_value'] } }, required:['action'] },
        then:{ required:['value'] },
      },
      {
        if:{ properties:{ action:{ const:'multi_select' } }, required:['action'] },
        then:{ required:['targets'] },
      },
      {
        if:{ properties:{ action:{ const:'multi_edit' } }, required:['action'] },
        then:{ required:['edits'] },
      },
    ];
  } else if (name === 'ui_find') {
    next.anyOf = requiredAny(['id'], ['label'], ['name'], ['role'], ['automation_id']);
  } else if (name === 'ui_action') {
    next.allOf = [
      { anyOf:requiredAny(['id'], ['label'], ['name'], ['role'], ['automation_id']) },
      {
        if:{ properties:{ action:{ enum:['set_value','set_range_value'] } }, required:['action'] },
        then:{ required:['value'] },
      },
    ];
  } else if (name === 'wait_for_ui') {
    next.anyOf = requiredAny(['state'], ['condition']);
    next.allOf = [
      {
        if:{ properties:{ condition:{ const:'text_exists' } }, required:['condition'] },
        then:{ required:['text'] },
      },
      {
        if:{ properties:{ condition:{ const:'active_window' } }, required:['condition'] },
        then:{ anyOf:requiredAny(['text'], ['name'], ['window_title']) },
      },
      {
        if:{ properties:{ condition:{ enum:['element_exists','element_enabled'] } }, required:['condition'] },
        then:{ anyOf:requiredAny(['id'], ['label'], ['name'], ['role'], ['automation_id']) },
      },
      {
        if:{ properties:{ state:{ enum:['present','absent'] } }, required:['state'] },
        then:{ anyOf:requiredAny(['id'], ['label'], ['name'], ['role'], ['automation_id']) },
      },
    ];
  } else if (name === 'window_action') {
    next.allOf = [
      { anyOf:requiredAny(['id'], ['pid'], ['app'], ['title']) },
      {
        if:{ properties:{ action:{ const:'move' } }, required:['action'] },
        then:{ required:['x','y'] },
      },
      {
        if:{ properties:{ action:{ const:'resize' } }, required:['action'] },
        then:{ required:['width','height'] },
      },
      {
        if:{ properties:{ action:{ const:'move_resize' } }, required:['action'] },
        then:{ required:['x','y','width','height'] },
      },
    ];
  } else if (name === 'pointer') {
    next.allOf = [{
      if:{ properties:{ action:{ const:'move' } }, required:['action'] },
      then:{ required:['x','y'] },
    }];
  } else if (name === 'scroll') {
    next.anyOf = requiredAny(['delta_x'], ['delta_y'], ['delta'], ['direction']);
  } else if (name === 'network') {
    next.allOf = [{
      if:{ properties:{ action:{ const:'test' } }, required:['action'] },
      then:{ required:['host','port'] },
    }];
  } else if (name === 'launch_app') {
    next.anyOf = requiredAny(['app'], ['path']);
  } else if (name === 'keyboard') {
    next.anyOf = requiredAny(['shortcut'], ['key'], ['keys']);
    if (next.properties?.keys) next.properties.keys.minItems = 1;
  } else if (name === 'drag_drop') {
    next.allOf = [
      { anyOf: requiredAny(['from_id'], ['from_x','from_y']) },
      { anyOf: requiredAny(['to_id'], ['to_x','to_y']) },
    ];
  } else if (name === 'screenshot_region') {
    next.anyOf = [
      { required:['x','y','width','height'] },
      ...requiredAny(['window_id'], ['pid'], ['app'], ['title'], ['monitor'], ['monitor_index']),
    ];
  } else if (name === 'browser_find') {
    next.anyOf = requiredAny(['selector'], ['text'], ['role']);
  } else if (name === 'browser_navigate') {
    next.allOf = [{
      if:{ properties:{ action:{ enum:['url','new_tab'] } }, required:['action'] },
      then:{ required:['url'] },
    }];
  } else if (name === 'browser_action') {
    next.allOf = [
      {
        if:{ properties:{ action:{ enum:['click','focus','set_value','select','scroll_into_view'] } }, required:['action'] },
        then:{ anyOf:requiredAny(['selector'], ['text'], ['browser_text']) },
      },
      {
        if:{ properties:{ action:{ const:'type' } }, required:['action'] },
        then:{
          required:['text'],
          anyOf:requiredAny(['selector'], ['browser_text'], ['value'], ['text_value']),
        },
      },
      {
        if:{ properties:{ action:{ const:'scroll' } }, required:['action'] },
        then:{ anyOf:requiredAny(['delta_x'], ['delta_y'], ['delta'], ['direction']) },
      },
      {
        if:{ properties:{ action:{ const:'upload' } }, required:['action'] },
        then:{ required:['selector'], anyOf:requiredAny(['path'], ['paths']) },
      },
      {
        if:{ properties:{ action:{ const:'press' } }, required:['action'] },
        then:{ required:['key'] },
      },
    ];
    if (next.properties?.paths) next.properties.paths.minItems = 1;
  } else if (name === 'browser_wait') {
    next.allOf = [
      {
        if:{ not:{ required:['condition'] } },
        then:{ required:['selector'] },
      },
      {
        if:{ properties:{ condition:{ const:'selector' } }, required:['condition'] },
        then:{ required:['selector'] },
      },
      {
        if:{ properties:{ condition:{ const:'text' } }, required:['condition'] },
        then:{ required:['text'] },
      },
      {
        if:{ properties:{ condition:{ const:'url_contains' } }, required:['condition'] },
        then:{ anyOf:requiredAny(['value'], ['text']) },
      },
    ];
  } else if (name === 'service') {
    next.allOf = [{
      if:{ properties:{ action:{ enum:['status','start','stop','restart'] } }, required:['action'] },
      then:{ required:['name'] },
    }];
  } else if (name === 'audio') {
    next.allOf = [{
      if:{ properties:{ action:{ const:'set_volume' } }, required:['action'] },
      then:{ required:['volume'] },
    }];
  } else if (name === 'pdf_action') {
    next.allOf = [
      {
        if:{ properties:{ action:{ enum:['annotations','info','split','extract_pages'] } }, required:['action'] },
        then:{ required:['path'] },
      },
      {
        if:{ properties:{ action:{ const:'merge' } }, required:['action'] },
        then:{ required:['paths','output'] },
      },
      {
        if:{ properties:{ action:{ const:'extract_pages' } }, required:['action'] },
        then:{ required:['pages','output'] },
      },
    ];
    if (next.properties?.paths) {
      next.properties.paths.minItems = 2;
      next.properties.paths.maxItems = 100;
    }
  }
  return next;
}

function define(name, title, description, inputSchema, annotations, handler, requires = []) {
  const enriched = enrichSchemaDescriptions(inputSchema);
  return {
    name,
    title,
    description: AI_TOOL_DESCRIPTIONS[name] || description,
    inputSchema: applySchemaRules(name, enriched),
    annotations,
    outputSchema: outputSchemaFor(name, title),
    handler,
    requires,
  };
}

const windowSelector = {
  id: s('Window id returned by list_windows.'),
  pid: n('Owning process id.'),
  app: s('Application/process name substring.'),
  title: s('Window title substring.'),
};
const uiSelector = {
  id: s('Element id returned by ui_snapshot or ui_find. Linux ids are stable per-process accessibility paths and legacy linux:<index> ids remain accepted.'),
  label: n('Compact numeric label from the most recent ui_snapshot/ui_find; useful for repeated actions without repeating names or coordinates.'),
  pid: n('Limit matching to one owning process id when available.'),
  app: s('Limit matching to an application/process name substring when available.'),
  window_title: s('Limit matching to a top-level accessibility window/frame title substring when available.'),
  name: s('Accessible name/title substring.'),
  role: s('Accessible role such as Button, Edit, textbox or AXButton.'),
  automation_id: s('Windows AutomationId when available.'),
};
const inputBackendSelector = {
  backend: e(['auto','x11','portal'], 'Input backend preference. auto uses proven local backends and already-authorized portal input; portal explicitly requests XDG RemoteDesktop consent on Wayland; x11 forces XWayland/xdotool only for operations where read-back testing shows it is reliable. GNOME Wayland keyboard/text deliberately reject x11.'),
};
const inputWindowSelector = {
  window_id: s('Optional target window id returned by list_windows. On Wayland the target is focused and verified before keyboard/text input is dispatched.'),
  pid: n('Optional target process id.'),
  app: s('Optional target application/process name substring.'),
  title: s('Optional target window title substring.'),
};
const browserTarget = {
  endpoint: s('Loopback Chrome DevTools endpoint. Defaults to REMCP_CDP_URL or http://127.0.0.1:9222.'),
  target_id: s('Page target id returned by browser_tabs.'),
  title: s('Choose a page whose title contains this text.'),
  url_contains: s('Choose a page whose URL contains this text.'),
  timeout_ms: n('Timeout in milliseconds.'),
};

export const extendedToolDefinitions = [
  define('computer_snapshot', 'Computer snapshot', 'Capture one compact computer-use state bundle: displays, visible windows, labeled semantic accessibility state, clipboard metadata, optional native browser accessibility/CDP/OCR, and real screenshot pixels. Use include_ui=false for a fast screenshot-first state; screenshot_window_id/monitor/region scope pixels without adding another tool.', o({ max_ui_nodes:n('Maximum native accessibility nodes; default 800.'), max_ui_depth:n('Maximum native accessibility depth; default 12.'), include_ui:b('Include native accessibility tree; default true. False is the fast screenshot-only path.'), ui_scope:e(['active','desktop'],'Accessibility scope for computer_snapshot. Default active keeps the compact snapshot fast; desktop requests all accessible applications/windows.'), semantic_tree:b('Include compact semantic hierarchy text alongside nodes; default true.'), ui_browser_dom:b('Prefer the native browser accessibility document subtree when the OS exposes one; on Windows this also enables the Firefox MSAA/IAccessible fallback.'), include_screenshot:b('Include real rendered desktop pixels; default true.'), screenshot_region:{type:'array',minItems:4,maxItems:4,items:{type:'number'},description:'Virtual-desktop [left,top,right,bottom] region; takes precedence over full desktop.'}, screenshot_window_id:s('Capture the window returned by list_windows instead of the whole desktop.'), screenshot_monitor:s('Monitor name substring or "primary".'), screenshot_monitor_index:n('Zero-based monitor index.'), screenshot_padding:n('Pixels of context around a targeted screenshot; 0..200.'), grid_columns:n('Optional reference-grid column count returned as visual metadata; 0..20.'), grid_rows:n('Optional reference-grid row count returned as visual metadata; 0..20.'), include_browser:b('Include CDP browser accessibility when available. Default auto: only when the active app looks Chromium-based.'), browser_max_nodes:n('Maximum browser accessibility nodes; default 500, maximum 2000.'), include_ocr:b('Run optional local OCR. Default auto: only when native accessibility and browser DOM are unavailable. Requires tesseract on PATH.'), ocr_language:s('Tesseract language code, default eng; multiple languages may use eng+deu.'), ocr_max_words:n('Maximum OCR word boxes returned; default 2000, maximum 10000.'), ocr_psm:n('Tesseract page segmentation mode, 3..13; default 11.'), ocr_timeout_ms:n('OCR timeout, default 30000 ms, maximum 120000 ms.') }), readOnlyLive, desktopHandlers.computer_snapshot),
  define(
    'computer_action',
    'Computer action',
    'Perform one semantic cross-backend action when the target may require Accessibility → browser DOM/CDP → OCR → coordinate fallback.',
    o({
      action:e([
        'click','type','invoke','focus','select','scroll','drag','set_value','toggle','expand','collapse',
        'scroll_into_view','set_range_value','add_to_selection','remove_from_selection',
        'multi_select','multi_edit',
      ]),
      target:e(
        ['auto','ui','ui_element','browser','ocr','coordinates','window'],
        'Optional target type. auto prefers native accessibility, then browser DOM/CDP, then OCR/coordinates where supported. Use window for explicit top-level window focus/text/scroll targeting.',
      ),
      ...uiSelector,
      title:s('Optional browser page title substring or top-level window title when target=window.'),
      window_id:s('Top-level window id returned by list_windows when target=window.'),
      text:s('Unicode text to enter for action=type, or text used by multi_edit.'),
      clear:b('For action=type, clear the current semantic/browser value before inserting text when supported.'),
      value:s('New value for set_value, set_range_value, or select.'),
      x:n('Virtual-desktop X coordinate used by click/scroll coordinate targeting.'),
      y:n('Virtual-desktop Y coordinate used by click/scroll coordinate targeting.'),
      selector:s('CSS selector when the fallback target is a browser element.'),
      browser_text:s('Visible browser text used only to locate a DOM target; for action=type, text remains the value to enter.'),
      delta_x:n('Horizontal scroll delta; positive means right.'),
      delta_y:n('Vertical scroll delta; positive means down.'),
      delta:n('Alias for delta_y.'),
      direction:e(['up','down','left','right']),
      wheel_times:n('Number of 120-unit wheel steps for direction; 1..50.'),
      from_x:n('Drag source X coordinate.'),
      from_y:n('Drag source Y coordinate.'),
      to_x:n('Drag destination X coordinate.'),
      to_y:n('Drag destination Y coordinate.'),
      from_id:s('Source semantic UI element id for action=drag.'),
      to_id:s('Destination semantic UI element id for action=drag.'),
      button:e(['left','right','middle']),
      hold_ms:n('Delay after pointer down before moving during action=drag.'),
      duration_ms:n('Drag movement duration.'),
      ocr_text:s('Visible text to find in rendered pixels for the OCR click fallback.'),
      ocr_region:{
        type:'array',
        minItems:4,
        maxItems:4,
        items:{type:'number'},
        description:'Optional virtual-desktop [left,top,right,bottom] region to OCR. Prefer bounds from list_windows or computer_snapshot.',
      },
      ocr_language:s('Tesseract language code, default eng.'),
      ocr_psm:n('Tesseract page segmentation mode, default 11.'),
      ocr_timeout_ms:n('OCR timeout in milliseconds.'),
      endpoint:s('Loopback Chrome DevTools endpoint for a browser fallback.'),
      target_id:s('Browser page target id returned by browser_tabs.'),
      url_contains:s('Browser URL substring used to select a page.'),
      option:s('Option value for browser select.'),
      targets:{
        type:'array',
        minItems:1,
        maxItems:100,
        items:o({ ...uiSelector }),
        description:'Native semantic targets for action=multi_select.',
      },
      replace_selection:b('For multi_select, select the first item before adding the rest; default true.'),
      edits:{
        type:'array',
        minItems:1,
        maxItems:100,
        items:o({
          ...uiSelector,
          text:s('Replacement text for this semantic edit.'),
          method:e(['auto','accessibility','clipboard','keys'], 'Text-entry strategy; auto is recommended.'),
          clear:b('Clear the current value before entering text; default true.'),
        }, ['text']),
        description:'Native semantic target + text entries for action=multi_edit.',
      },
      ...inputBackendSelector,
    }, ['action']),
    openMutating,
    desktopHandlers.computer_action,
  ),
  define('list_windows', 'List windows', 'List visible top-level desktop windows with stable-enough identifiers, PID, application name, title, bounds, and the monitor containing the largest part of each window when display geometry is available.', o({ include_monitor:b('Enrich each window with monitor and monitor_index; default true.') }), readOnlyLive, desktopHandlers.list_windows, ['windows']),
  define('window_action', 'Window action', 'Focus, minimize, maximize, restore, move, resize, or close a top-level desktop window selected by id, pid, application name, or title. Native GNOME Wayland focus uses AT-SPI; compositor window-manager actions use the consent-backed XDG RemoteDesktop input path.', o({ action:e(['focus','minimize','maximize','restore','move','resize','move_resize','close']), ...windowSelector, x:n(), y:n(), width:n(), height:n(), ...inputBackendSelector }, ['action']), mutating, desktopHandlers.window_action, ['windows']),
  define('launch_app', 'Launch application', 'Launch a desktop application or executable without invoking a shell. On Windows, executable/path launch falls back to Start Menu/UWP app discovery by friendly name. cwd is confined by the ReMCP filesystem policy and is only accepted when the platform can guarantee the child working directory. Optionally wait until a matching top-level window exists.', o({ app:s('Application name, friendly Start Menu name, or executable path.'), path:s('Alias for app.'), args:{ type:'array', items:{type:'string'} }, cwd:s('Optional permitted working directory for direct executable launch.'), wait_for_window:s('Optional application/title substring that must appear after launch.'), wait_timeout_ms:n('Maximum wait for wait_for_window; default 10000, maximum 120000.') }), openMutatingNonDestructive, desktopHandlers.launch_app, ['desktop_session']),
  define('ui_snapshot', 'UI accessibility snapshot', 'Read the active desktop accessibility/UI Automation tree with compact labels, semantic hierarchy, bounds, state and suggested actions. Default scope is the active application/window; scope=desktop requests the full desktop tree. Explicit pid/app/window_title scopes override the active default. browser_dom asks the OS accessibility provider for the web-document subtree when available.', o({ scope:e(['active','desktop'],'Default active. Use desktop only when cross-application discovery is required.'), pid:n('Optional owning process id scope.'), app:s('Optional application/process name substring scope.'), window_title:s('Optional top-level accessibility window/frame title scope.'), browser_dom:b('Prefer the native browser document accessibility subtree instead of browser chrome when supported.'), semantic_tree:b('Include compact semantic hierarchy text; default true.'), max_nodes:n('Maximum nodes; default 500, maximum 5000.'), max_depth:n('Maximum traversal depth; default 8, maximum 32.') }), readOnlyLive, desktopHandlers.ui_snapshot, ['ui']),
  define('ui_find', 'Find UI elements', 'Find native accessible desktop elements by label/id/name/role/AutomationId. Reuses the latest five-second semantic snapshot for fast repeated targeting; refresh=true forces a new OS accessibility capture.', o({ ...uiSelector, refresh:b('Force a fresh accessibility capture instead of the short-lived snapshot cache.'), limit:n('Maximum matches; default 20.'), max_nodes:n(), max_depth:n() }), readOnlyLive, desktopHandlers.ui_find, ['ui']),
  define('ui_action', 'Act on UI element', 'Act on a native accessibility/UI Automation element by id, label or semantic selector. Supports invoke/focus/value/toggle/selection, expand-collapse, range values and scroll-into-view before falling back to coordinates.', o({ action:e(['click','invoke','focus','set_value','select','toggle','expand','collapse','scroll_into_view','set_range_value','add_to_selection','remove_from_selection']), ...uiSelector, value:{description:'New text or numeric range value.'} }, ['action']), openMutating, desktopHandlers.ui_action, ['ui']),
  define('type_text', 'Type text', 'Enter Unicode text into a native semantic accessibility target or focused native control. Auto prefers verified accessibility editing; with clear=true and an explicit window target it can replace the value of the single editable accessibility control in that window without compositor focus. Explicit semantic targets fail safely when the platform rejects the write instead of claiming an unverified paste. Use browser_action for Chromium page DOM. Clipboard/keys/Enter fallbacks still require verified window focus on Wayland.', o({ text:s('Text to enter.'), method:e(['auto','accessibility','clipboard','keys'], 'Default auto prefers verified accessibility editing and falls back to clipboard paste. keys sends physical key events and therefore follows the active keyboard layout.'), clear:b('Replace existing text for semantic/window-scoped accessibility input, or clear it before keyboard/paste fallback.'), caret_position:e(['start','idle','end']), press_enter:b('Press Enter after typing; physical Enter delivery requires verified window focus.'), delay_ms:n('Per-key delay for method=keys.'), ...uiSelector, window_id:s('Optional target window id. With auto/accessibility + clear=true, a unique editable control may be updated semantically without focus; keyboard/clipboard fallbacks verify focus before dispatch.'), title:s('Optional target window title substring. With auto/accessibility + clear=true, a unique editable control may be updated semantically without compositor focus.'), ...inputBackendSelector }, ['text']), openMutating, desktopHandlers.type_text, ['input']),
  define('keyboard', 'Keyboard shortcut', 'Send a keyboard shortcut or key press to the active desktop application or an explicitly selected window. On Wayland, window_id/pid/app/title targets are focused and verified before input is dispatched; backend=portal explicitly requests the consent-backed XDG RemoteDesktop path.', o({ shortcut:s(), key:s(), keys:{ type:'array', items:{type:'string'} }, ...inputWindowSelector, ...inputBackendSelector }), openMutating, desktopHandlers.keyboard, ['input']),
  define('pointer', 'Pointer action', 'Move the pointer or perform click, double-click, right-click, mouse-down, or mouse-up at desktop screen coordinates. Wayland supports XWayland fallback and an explicitly consented XDG RemoteDesktop backend.', o({ action:e(['move','click','double_click','right_click','down','up']), x:n(), y:n(), button:e(['left','right','middle']), ...inputBackendSelector }, ['action']), openMutating, desktopHandlers.pointer, ['pointer']),
  define('drag_drop', 'Drag and drop', 'Drag between desktop coordinates or semantic UI element IDs returned by ui_snapshot/ui_find. Element IDs are resolved to current accessibility bounds before input. GNOME Wayland requires the consent-backed Remote Desktop portal for real drag delivery; unreliable XTEST/xdotool drag is rejected.', o({ from_x:n(), from_y:n(), to_x:n(), to_y:n(), from_id:s('Source UI element id; use instead of from_x/from_y.'), to_id:s('Destination UI element id; use instead of to_x/to_y.'), button:e(['left','right','middle']), hold_ms:n(), duration_ms:n(), ...inputBackendSelector }), openMutating, desktopHandlers.drag_drop, ['drag']),
  define('scroll', 'Scroll', 'Scroll vertically or horizontally using native wheel input. Target a semantic UI element/label or x/y first so the wheel is delivered to the intended region; direction+wheel_times is a convenience over normalized deltas.', o({ delta_x:n('Horizontal delta; positive means right.'), delta_y:n('Vertical delta; positive means down.'), delta:n('Alias for delta_y.'), direction:e(['up','down','left','right']), wheel_times:n('Number of 120-unit wheel steps when direction is used; 1..50.'), x:n(), y:n(), ...uiSelector, ...inputBackendSelector }), mutatingNonDestructive, desktopHandlers.scroll, ['pointer']),
  define('wait_for_ui', 'Wait for UI', 'Wait on fresh native accessibility state without screenshot polling. Use state=present/absent/changed or condition=text_exists/active_window/element_exists/element_enabled/focused_element.', o({ state:e(['present','absent','changed'], 'changed captures the first matching semantic state and waits until it differs.'), condition:e(['text_exists','active_window','element_exists','element_enabled','focused_element']), text:s('Text used by text_exists or active_window.'), browser_dom:b('Use native browser document accessibility where supported.'), ...uiSelector, timeout_ms:n('Maximum wait, capped at 120000 ms.'), poll_ms:n('Polling interval, 50..5000 ms.') }), readOnlyLive, desktopHandlers.wait_for_ui, ['ui']),
  define('clipboard', 'Clipboard', 'Read, write, or clear the system text clipboard using native operating-system clipboard facilities.', o({ action:e(['read','write','clear']), text:s('Text to write.') }, ['action']), mutating, desktopHandlers.clipboard, ['clipboard']),
  define('display_inventory', 'Display inventory', 'List connected displays/monitors and their geometry and primary-display status using native display tools.', o(), readOnlyLive, desktopHandlers.display_inventory, ['displays']),
  define('screenshot_region', 'Screenshot region', 'Capture a desktop rectangle, a selected top-level window, or a selected monitor and return it as an inline PNG. This avoids full-desktop screenshots when only one UI area matters.', o({ x:n(), y:n(), width:n(), height:n(), window_id:s('Window id returned by list_windows.'), pid:n(), app:s(), title:s(), monitor:s('Monitor name substring, or "primary".'), monitor_index:n('Zero-based monitor index from display_inventory.'), padding:n('Optional pixels added around the resolved rectangle; 0..200.') }), readOnlyLive, desktopHandlers.screenshot_region, ['screen_region']),
  define('open_path', 'Open path', 'Open a permitted local file or directory in its system-associated desktop application. Filesystem confinement is checked before opening.', o({ path:s('File or directory to open.') }, ['path']), additive, desktopHandlers.open_path, ['desktop_open']),
  define('reveal_path', 'Reveal path', 'Reveal a permitted local file or directory in Finder, Explorer, or the Linux file manager after applying ReMCP filesystem confinement.', o({ path:s('File or directory to reveal.') }, ['path']), additive, desktopHandlers.reveal_path, ['desktop_open']),
  define('notification', 'Desktop notification', 'Show a native desktop notification or user-visible popup on the paired computer.', o({ title:s(), message:s('Notification message.'), timeout_seconds:n() }, ['message']), additive, desktopHandlers.notification, ['notifications']),

  define('browser_tabs', 'Browser tabs', 'List debuggable Chrome, Edge, or Chromium page targets from a loopback-only Chrome DevTools Protocol endpoint.', o({ ...browserTarget }), readOnlyLive, browserHandlers.browser_tabs, ['browser_cdp']),
  define('browser_navigate', 'Browser navigate', 'Open a new debuggable tab or navigate a selected browser page by URL, history back/forward, or reload through Chrome DevTools Protocol.', o({ ...browserTarget, action:e(['url','new_tab','back','forward','reload'], 'Default url when url is provided, otherwise reload. new_tab creates the first page target when needed.'), url:s('Destination URL for action=url or action=new_tab.'), wait:b('Wait for the page load event; default true.'), ignore_cache:b('Reload without cache when action=reload.') }), openMutatingNonDestructive, browserHandlers.browser_navigate, ['browser_cdp']),
  define('browser_snapshot', 'Browser snapshot', 'Return the selected browser page accessibility tree through Chrome DevTools Protocol and, when requested, attach a real rendered viewport PNG for visual verification. A selector is temporarily recentered for capture, its exact viewport bounds are returned, and the prior scroll position is restored before return.', o({ ...browserTarget, max_nodes:n('Maximum AX nodes; default 1500.'), include_screenshot:b('Attach a real CDP-rendered viewport PNG screenshot; default false.'), selector:s('When include_screenshot=true, center this CSS-selected element before capture and report its viewport bounds.') }), readOnlyLive, browserHandlers.browser_snapshot, ['browser_cdp']),
  define('browser_find', 'Find browser element', 'Find visible DOM elements by CSS selector, text, or ARIA role and return reusable selectors plus text, value, and bounding boxes.', o({ ...browserTarget, selector:s('CSS selector.'), text:s('Visible text substring.'), role:s('ARIA role.'), limit:n() }), readOnlyLive, browserHandlers.browser_find, ['browser_cdp']),
  define('browser_action', 'Browser element action', 'Click, focus, type/set a value, select, scroll a page or scrollable element, scroll an element into view, upload files, press a key, or set an exact responsive-test viewport in a debuggable browser page using DOM/CDP semantics.', o({ ...browserTarget, action:e(['click','focus','type','set_value','select','scroll','scroll_into_view','upload','press','set_viewport']), selector:s('CSS selector for the target element; prefer the reusable selector returned by browser_find.'), browser_text:s('Visible text used only to locate a DOM element; use this instead of overloading text for action=type.'), text:s('For action=type, Unicode text to insert. For non-type element actions without selector/browser_text, visible text may identify the target.'), clear:b('For action=type, clear the current value before inserting text.'), value:s('Value for action=set_value; also accepted as a legacy type payload when text is used as the locator.'), text_value:s('Compatibility alias for the type/set_value text value.'), option:s(), delta_x:n('Horizontal scroll delta; positive means right.'), delta_y:n('Vertical scroll delta; positive means down.'), delta:n('Alias for delta_y.'), direction:e(['up','down','left','right']), wheel_times:n('Number of 120-unit wheel steps for direction; 1..50.'), path:s(), paths:{type:'array',items:{type:'string'}}, key:s(), width:n('CSS viewport width for set_viewport.'), height:n('CSS viewport height for set_viewport.'), device_scale_factor:n('Device scale factor for set_viewport; default 1.'), mobile:b('Enable mobile emulation for set_viewport.') }, ['action']), openMutating, browserHandlers.browser_action, ['browser_cdp']),
  define('browser_wait', 'Wait for browser', 'Wait for DOM state, page text, URL, completed loading, a navigation away from the current URL, or a short network-idle period in a debuggable browser page. Use browser_evaluate separately for JavaScript predicates or page-specific inspection.', o({ ...browserTarget, condition:e(['selector','text','url_contains','load','navigation','network_idle']), selector:s(), text:s(), value:s(), poll_ms:n(), idle_ms:n('Required zero-in-flight network quiet window for network_idle; default 500 ms.') }), readOnlyLive, browserHandlers.browser_wait, ['browser_cdp']),
  define('browser_evaluate', 'Evaluate browser JavaScript', 'Evaluate JavaScript in a selected debuggable browser page and return its serializable value. This is a powerful escape hatch for page-specific automation.', o({ ...browserTarget, expression:s('JavaScript expression.'), await_promise:b('Await a returned Promise; default true.') }, ['expression']), openMutating, browserHandlers.browser_evaluate, ['browser_evaluate']),

  define('service', 'Service control', 'List, inspect, start, stop, or restart operating-system services using Service Control Manager, launchctl, or systemd. Mutating actions pass through ReMCP command policy.', o({ action:e(['list','status','start','stop','restart']), name:s('Service/unit/launchd label.'), scope:e(['user','system']) }, ['action']), mutating, diagnosticHandlers.service, ['services']),
  define('event_log', 'Event logs', 'Read recent Windows Event Log, macOS unified log, or systemd journal entries with bounded time and result limits.', o({ log:s('Windows log name.'), since:s('Time window such as 30s, 10m, 2h, or 1d.'), filter:s(), query:s(), limit:n() }), readOnlyLive, diagnosticHandlers.event_log, ['logs']),
  define('network', 'Network diagnostics', 'Inspect a bounded network summary, full interface inventory, DNS servers, routes and listening sockets, or perform a bounded TCP connectivity test to a host and port. Use action=interfaces when the complete adapter/address inventory is needed.', o({ action:e(['summary','interfaces','dns','routes','listeners','test']), host:s(), port:n(), timeout_ms:n() }), readOnlyOpen, diagnosticHandlers.network),
  define('installed_apps', 'Installed applications', 'Inventory installed applications or packages with versions and publishers where available using native package/application inventories.', o({ filter:s('Name substring.'), limit:n('Maximum results; default 1000.') }), readOnly, diagnosticHandlers.installed_apps, ['apps']),
  define('environment', 'Runtime environment', 'Report platform, architecture, Node version, working/home/temp paths, shell, PATH, and optionally environment variables. Environment variables are opt-in and secret-looking or credential-bearing values are masked.', o({ include_env:b('Include sanitized environment variables; default false.') }), readOnly, diagnosticHandlers.environment),
  define('audio', 'Audio control', 'Read or change default output volume or mute state using native operating-system audio controls when available.', o({ action:e(['status','set_volume','mute','unmute']), volume:n('0..100 for set_volume.') }, ['action']), mutatingNonDestructive, diagnosticHandlers.audio, ['audio']),
  define('power_action', 'Power action', 'Lock, sleep, restart, or shut down the paired computer using native operating-system power facilities. The action passes through ReMCP command policy. Delayed actions are cancelled if the client stops waiting.', o({ action:e(['lock','sleep','restart','shutdown']), delay_seconds:{ type:'number', minimum:0, maximum:90, description:'Optional delay in seconds, maximum 90. Longer delays are rejected because hosted calls expire before they can complete safely.' } }, ['action']), mutating, diagnosticHandlers.power_action, ['power']),
  define('record_screen', 'Record screen', 'Record a short bounded desktop video to a permitted local file for debugging and return its path and size. Uses native/available recording helpers.', o({ duration_seconds:n('1..120 seconds.'), fps:n('1..60.'), destination:s('Permitted output path. If an extension is supplied, use .webm for native GNOME Wayland recording and .mp4 for the other recorder backends.') }), mutating, diagnosticHandlers.record_screen, ['record']),

  define('read_document', 'Read document', 'Read PDF, DOCX, XLSX, TXT, Markdown, CSV, JSON, or XML. PDF/DOCX extraction is built in and XLSX is parsed from its OOXML worksheet cells.', o({ path:s('Document path.'), sheet:s('Worksheet name for XLSX.'), max_cells:n() }, ['path']), readOnly, documentHandlers.read_document, ['documents']),
  define('edit_spreadsheet', 'Edit spreadsheet', 'Create a new XLSX workbook or edit up to 500 expanded XLSX cells directly in OOXML without launching Excel. For creation set create=true and use path as a new destination; existing files are never overwritten by create mode. Each edit may target one cell or a rectangular range, with a scalar fill, a values matrix, or a formula.', o({ path:s('Existing .xlsx path, or the new workbook destination when create=true.'), create:b('Create a new XLSX at path. Fails if path already exists; do not combine with output.'), output:s('Optional output .xlsx when editing an existing workbook; defaults to replacing input.'), sheet:s('Worksheet name. For create=true, defaults to Sheet1 and becomes the new workbook sheet name.'), edits:{ type:'array', maxItems:500, items:o({ cell:s('Single A1 cell reference.'), range:s('Rectangular range such as A1:C3.'), value:{ description:'Scalar value for one cell or to fill a range.' }, values:{ type:'array', items:{ type:'array', items:{} }, description:'2D matrix matching the range dimensions.' }, formula:s('Optional formula; for a range it is written to each expanded cell.') }) } }, ['path','edits']), mutating, documentHandlers.edit_spreadsheet, ['documents','ooxml']),
  define('edit_document', 'Edit DOCX document', 'Create a new DOCX document or edit DOCX paragraph structure directly in OOXML: replace text, append/prepend paragraphs, insert before/after matching paragraphs, or delete matching paragraphs. For creation set create=true and use path as a new destination; existing files are never overwritten by create mode.', o({ path:s('Existing .docx path, or the new document destination when create=true.'), create:b('Create a new DOCX at path. Fails if path already exists; do not combine with output.'), output:s('Optional output .docx path when editing an existing document.'), operations:{ type:'array', maxItems:100, items:o({ action:e(['replace','append_paragraph','prepend_paragraph','insert_paragraph_before','insert_paragraph_after','delete_paragraph']), search:s('Paragraph text substring for replace/insert/delete operations.'), replacement:s(), all:b('Apply to all matching paragraphs; default true.'), text:s('Paragraph text to append/prepend/insert.') }, ['action']) } }, ['path','operations']), mutating, documentHandlers.edit_document, ['documents','ooxml']),
  define('pdf_action', 'PDF action', 'Inspect PDF annotations or metadata, merge PDFs, split a PDF into pages, or extract selected page ranges. Structural writes use qpdf/poppler/pdftk when installed.', o({ action:e(['merge','split','extract_pages','annotations','info']), path:s(), paths:{type:'array',items:{type:'string'}}, output:s(), output_dir:s(), pattern:s(), pages:s('Page list/ranges such as 1-3,5.') }, ['action']), mutating, documentHandlers.pdf_action, ['documents']),
];

export const extendedToolHandlers = new Map(extendedToolDefinitions.map(definition => [definition.name, definition]));

let pyAtSpiCache = { value: false, expiresAt: 0 };

async function linuxHasPyAtSpi() {
  const now = Date.now();
  if (pyAtSpiCache.expiresAt > now) return pyAtSpiCache.value;
  if (!commandExists('python3')) {
    pyAtSpiCache = { value: false, expiresAt: now + 60_000 };
    return false;
  }
  const probe = [
    'try:',
    ' import pyatspi',
    'except Exception:',
    ' import gi',
    ' gi.require_version("Atspi","2.0")',
    ' from gi.repository import Atspi',
  ].join('\n');
  const result = await runFile('python3', ['-c', probe], { allowFailure: true, timeout: 2000 });
  pyAtSpiCache = { value: result.code === 0, expiresAt: now + 60_000 };
  return pyAtSpiCache.value;
}

export function desktopShellCapabilitySnapshot({
  platform = process.platform,
  env = process.env,
  commandExistsFn = commandExists,
} = {}) {
  const nativeDesktop = platform === 'win32' || platform === 'darwin';
  const desktopSession = desktopSessionAvailable({ platform, env });
  return {
    desktop_session:desktopSession,
    desktop_open:desktopSession && (nativeDesktop || commandExistsFn('xdg-open')),
  };
}

export function powerCapabilitySnapshot({
  platform = process.platform,
  commandExistsFn = commandExists,
} = {}) {
  if (platform === 'win32' || platform === 'darwin') return true;
  if (platform !== 'linux') return false;
  return commandExistsFn('loginctl') && commandExistsFn('systemctl');
}

export function documentCapabilitySnapshot({
  platform = process.platform,
  commandExistsFn = commandExists,
} = {}) {
  const supportedPlatform = ['win32','darwin','linux'].includes(platform);
  const nativeOoxml = platform === 'win32';
  const archiveOoxml = (platform === 'darwin' || platform === 'linux')
    && commandExistsFn('zip')
    && commandExistsFn('unzip');
  return {
    documents:supportedPlatform,
    ooxml:supportedPlatform && (nativeOoxml || archiveOoxml),
  };
}

export async function capabilitySnapshot() {
  const win = process.platform === 'win32';
  const mac = process.platform === 'darwin';
  const linux = process.platform === 'linux';
  const desktopShellCapabilities = desktopShellCapabilitySnapshot();
  const desktopSession = desktopShellCapabilities.desktop_session;
  const pyAtSpi = linux && desktopSession ? await linuxHasPyAtSpi() : false;
  const wayland = linux && desktopSession && isWaylandSession();
  const gnomeRecord = wayland ? await gnomeScreencastSupported() : false;
  const portalCandidate = wayland && waylandPortalCandidate();
  const portalInput = portalCandidate;
  const x11Input = linux && desktopSession && !wayland && (commandExists('wdotool') || commandExists('xdotool'));
  const browserCdp = browserRemoteEnabled() && await browserControlAvailable(undefined, 500);
  const documentCapabilities = documentCapabilitySnapshot();
  return {
    ...desktopShellCapabilities,
    windows: win || mac || (desktopSession && (commandExists('wdotool') || commandExists('wmctrl') || (wayland && pyAtSpi))),
    ui: win || mac || (desktopSession && pyAtSpi),
    input: win || mac || (desktopSession && (portalInput || x11Input || (wayland && commandExists('wtype')))),
    pointer: win || mac || (desktopSession && (portalInput || x11Input)),
    drag: win || mac || (desktopSession && (portalInput || x11Input)),
    clipboard: win || mac || (desktopSession && (commandExists('wl-paste') || commandExists('xclip') || commandExists('xsel'))),
    displays: win || mac || (desktopSession && ((wayland && linux) || commandExists('wlr-randr') || commandExists('xrandr'))),
    screen_region: win || mac || (desktopSession && regionScreenshotBackends({ wayland, portalCandidate }).length > 0),
    notifications: win || mac || (desktopSession && commandExists('notify-send')),
    browser_cdp: browserCdp,
    browser_evaluate: browserCdp && (process.env.NODE_ENV !== 'production' || ['1', 'true', 'yes', 'on'].includes(String(process.env.REMCP_BROWSER_ALLOW_EVALUATE || '').toLowerCase())),
    services: win || mac || commandExists('systemctl'),

    logs: win || mac || commandExists('journalctl'),
    apps: win || mac || commandExists('dpkg-query') || commandExists('rpm'),
    audio: win || mac || commandExists('wpctl') || commandExists('pactl') || commandExists('amixer'),
    power: powerCapabilitySnapshot(),
    record: recordScreenAvailable({ platform:process.platform, wayland, gnomeSupported:gnomeRecord }),
    ...documentCapabilities,
  };
}

function isSupported(definition, capabilities) {
  return (definition.requires || []).every(name => capabilities[name] !== false);
}

function publicShape(definition) {
  const { name, title, description, inputSchema, annotations, outputSchema } = definition;
  return { name, title, description, inputSchema, annotations, outputSchema };
}

export function allExtendedTools() {
  return extendedToolDefinitions.map(publicShape);
}

export async function advertisedExtendedTools() {
  const capabilities = await capabilitySnapshot();
  return extendedToolDefinitions.filter(definition => isSupported(definition, capabilities)).map(publicShape);
}

export async function capabilityFingerprint() {
  const capabilities = await capabilitySnapshot();
  const names = extendedToolDefinitions.filter(definition => isSupported(definition, capabilities)).map(definition => definition.name);
  return JSON.stringify({ capabilities, names });
}
