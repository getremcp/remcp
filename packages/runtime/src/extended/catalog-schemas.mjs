export const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export const readOnlyLive = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export const readOnlyOpen = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
export const additive = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
export const mutatingNonDestructive = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
export const openMutatingNonDestructive = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
export const mutating = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
export const openMutating = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

export const s = description => ({ type: 'string', ...(description ? { description } : {}) });
export const n = description => ({ type: 'number', ...(description ? { description } : {}) });
export const b = description => ({ type: 'boolean', ...(description ? { description } : {}) });
export const e = (values, description) => ({ type: 'string', enum: values, ...(description ? { description } : {}) });
export const o = (properties = {}, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false });

export const AI_TOOL_DESCRIPTIONS = Object.freeze({
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
  browser_snapshot: 'Use this to inspect a web page structurally through CDP accessibility. Reuse the last snapshot_id as diff_from to return changed/removed semantic nodes rather than retransmitting the whole page after each step; refresh with a full snapshot when unavailable. Prefer it over desktop ui_snapshot for page content; add include_screenshot=true only when final pixel/layout verification is needed. A selector may be temporarily centered for capture, but the original page scroll position is restored before the tool returns.',
  browser_find: 'Use this to locate visible web elements by CSS selector, text or ARIA role and obtain reusable selectors/bounds. It requires an element criterion; use browser_snapshot, not an empty browser_find, to enumerate page structure. Prefer this before browser_action rather than guessing selectors or coordinates.',
  browser_action: 'Use this for deterministic DOM/CDP interaction with a known web element: click/focus/type/value/select/upload/key/scroll or viewport emulation. Prefer it over desktop pointer/ui_action for page content; use action=fill_form with CSS selectors to edit up to 20 visible fields in one tool call without submitting. Use browser_evaluate only when supported actions cannot express the task.',
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

export const COMMON_PARAM_DESCRIPTIONS = Object.freeze({
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

export function enrichSchemaDescriptions(schema) {
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

export const outputString = description => ({ type:'string', ...(description ? { description } : {}) });
export const outputNumber = description => ({ type:'number', ...(description ? { description } : {}) });
export const outputBoolean = description => ({ type:'boolean', ...(description ? { description } : {}) });
export const outputObject = description => ({ type:'object', additionalProperties:true, ...(description ? { description } : {}) });
export const outputNullableObject = description => ({ type:['object','null'], additionalProperties:true, ...(description ? { description } : {}) });
export const outputRecord = (properties = {}, description) => ({ type:'object', properties, additionalProperties:true, ...(description ? { description } : {}) });
export const outputArray = (items = {}, description) => ({ type:'array', items, ...(description ? { description } : {}) });

export const OUTPUT_FIELDS = Object.freeze({
  computer_snapshot: {
    device:outputObject('Device/platform metadata for the captured computer state.'),
    windows:outputArray(outputObject(), 'Top-level windows with stable ids/PIDs/bounds when available.'),
    displays:outputArray(outputObject(), 'Display inventory used for virtual-desktop geometry.'),
    active_window:outputNullableObject('Active top-level window when known; null when accessibility state cannot be joined to top-level window enumeration.'),
    ui:outputObject('Native accessibility snapshot and semantic tree.'),
    cursor:outputObject('Pointer position when available.'),
    clipboard:outputObject('Clipboard metadata only unless clipboard content was explicitly requested.'),
    browser:outputObject('Optional browser DOM/CDP snapshot.'),
    browser_readiness:outputObject('Optional bounded local CDP readiness status and fallback hint; no tab titles or URLs.'),
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
  installed_apps: {
    data:outputArray(outputRecord({
      name:outputString('Installed application/package name.'),
      version:{ type:['string','null'], description:'Installed version when available.' },
      publisher:{ type:['string','null'], description:'Publisher/maintainer/vendor when available.' },
      path:{ type:['string','null'], description:'Installation path when available.' },
      signed_by:outputString('Optional macOS signing identity summary.'),
    }, 'Normalized installed app/package record.')),
    backend:outputString('Native inventory backend used on this platform.'),
    count:outputNumber('Total matching records before the requested limit.'),
    returned:outputNumber('Number of records returned in data.'),
    truncated:outputBoolean('True when count is larger than returned because of the requested limit.'),
  },
  environment: {
    platform:outputString(),
    arch:outputString(),
    node:outputString(),
    cwd:outputString('Runtime working directory.'),
    home:outputString('Current user home directory.'),
    temp:outputString('Operating-system temporary directory.'),
    shell:{ type:['string','null'], description:'Configured command shell when available.' },
    path_entries:outputArray(outputString('One PATH entry in native search order.')),
    environment:outputObject('Sanitized environment variables when include_env=true.'),
  },
  audio: { volume:outputNumber(), muted:outputBoolean(), action:outputString(), backend:outputString(), text:outputString() },
  power_action: { text:outputString(), action:outputString() },
  record_screen: { path:outputString(), bytes:outputNumber(), duration_seconds:outputNumber(), format:outputString() },
  read_document: { text:outputString(), path:outputString(), data:{}, sheets:outputArray(outputObject()), sheet:outputString(), rows:outputArray({}), cells:outputArray({}) },
  edit_spreadsheet: { path:outputString(), sheet:outputString(), edited_cells:outputNumber(), bytes:outputNumber(), created:outputBoolean() },
  edit_document: { path:outputString(), operations:outputNumber(), changes:outputNumber(), bytes:outputNumber(), created:outputBoolean() },
  pdf_action: { action:outputString(), path:outputString(), source:outputString(), output:outputString(), output_dir:outputString(), files:outputArray(outputString()), pages:outputString(), bytes:outputNumber(), annotations:outputArray(outputObject()), annotation_count:outputNumber('Number of PDF annotations found by the info action.'), inputs:outputNumber() },
});

export function outputSchemaFor(name, title) {
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

export function requiredAny(...groups) {
  return groups.map(required => ({ required }));
}
