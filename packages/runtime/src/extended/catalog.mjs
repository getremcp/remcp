import { AI_TOOL_DESCRIPTIONS, enrichSchemaDescriptions, outputSchemaFor, readOnly, readOnlyLive, readOnlyOpen, additive, mutatingNonDestructive, openMutatingNonDestructive, mutating, openMutating, s, n, b, e, o } from './catalog-schemas.mjs';
import { applySchemaRules } from './catalog-rules.mjs';
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
import { displayInventoryAvailable, regionScreenshotBackends } from './desktop-linux.mjs';
import { diagnosticHandlers, gnomeScreencastSupported, recordScreenAvailable } from './diagnostics.mjs';
import { documentHandlers } from './documents.mjs';

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

  define('browser_tabs', 'Browser tabs', 'List debuggable Chrome, Edge, or Chromium page targets from a loopback-only Chrome DevTools Protocol endpoint.', o({ ...browserTarget }), readOnlyOpen, browserHandlers.browser_tabs, ['browser_cdp']),
  define('browser_navigate', 'Browser navigate', 'Open a new debuggable tab or navigate a selected browser page by URL, history back/forward, or reload through Chrome DevTools Protocol.', o({ ...browserTarget, action:e(['url','new_tab','back','forward','reload'], 'Default url when url is provided, otherwise reload. new_tab creates the first page target when needed.'), url:s('Destination URL for action=url or action=new_tab.'), wait:b('Wait for the page load event; default true.'), ignore_cache:b('Reload without cache when action=reload.') }), openMutatingNonDestructive, browserHandlers.browser_navigate, ['browser_cdp']),
  define('browser_snapshot', 'Browser snapshot', 'Return the selected browser page accessibility tree through Chrome DevTools Protocol and, when requested, attach a real rendered viewport PNG for visual verification. A selector is temporarily recentered for capture, its exact viewport bounds are returned, and the prior scroll position is restored before return.', o({ ...browserTarget, max_nodes:n('Maximum AX nodes; default 1500.'), include_screenshot:b('Attach a real CDP-rendered viewport PNG screenshot; default false.'), selector:s('When include_screenshot=true, center this CSS-selected element before capture and report its viewport bounds.') }), readOnlyOpen, browserHandlers.browser_snapshot, ['browser_cdp']),
  define('browser_find', 'Find browser element', 'Find visible DOM elements by CSS selector, text, or ARIA role and return reusable selectors plus text, value, and bounding boxes.', o({ ...browserTarget, selector:s('CSS selector.'), text:s('Visible text substring.'), role:s('ARIA role.'), limit:n() }), readOnlyOpen, browserHandlers.browser_find, ['browser_cdp']),
  define('browser_action', 'Browser element action', 'Click, focus, type/set a value, fill up to 20 form fields in one guarded call, select, scroll a page or scrollable element, scroll an element into view, upload files, press a key, or set an exact responsive-test viewport in a debuggable browser page using DOM/CDP semantics.', o({ ...browserTarget, action:e(['click','focus','type','set_value','select','scroll','scroll_into_view','upload','press','set_viewport','fill_form','workflow']), selector:s('CSS selector for the target element; prefer the reusable selector returned by browser_find.'), steps:{type:'array',minItems:1,maxItems:12,description:'Workflow on one page: explicit CSS actions and bounded waits, max 12 seconds. Never silently submits; click must be explicit.',items:{type:'object',additionalProperties:false,properties:{action:e(['fill_form','set_value','select','focus','click','wait_for']),selector:s('CSS selector for action or wait_for.'),value:{type:['string','number','boolean']},fields:{type:'array',description:'CSS-selected field edits within the workflow step; no implicit form submission.',minItems:1,maxItems:20,items:{type:'object',additionalProperties:false,properties:{selector:s(),value:{type:['string','number','boolean']}},required:['selector','value']}},condition:e(['selector','text','url_contains','load']),text:s('Text or URL fragment for wait condition.'),timeout_ms:n('Wait timeout 100..4000 ms; default 1500.')},required:['action']}}, fields:{type:'array',minItems:1,maxItems:20,items:{type:'object',additionalProperties:false,properties:{selector:s('CSS selector.'),value:{type:['string','boolean','number'],description:'New field value; not returned in results.'}},required:['selector','value']},description:'fill_form: 1–20 CSS form fields in one CDP call. Does not submit.'}, browser_text:s('Visible text used only to locate a DOM element; use this instead of overloading text for action=type.'), text:s('For action=type, Unicode text to insert. For non-type element actions without selector/browser_text, visible text may identify the target.'), clear:b('For action=type, clear the current value before inserting text.'), value:s('Value for action=set_value; also accepted as a legacy type payload when text is used as the locator.'), text_value:s('Compatibility alias for the type/set_value text value.'), option:s(), delta_x:n('Horizontal scroll delta; positive means right.'), delta_y:n('Vertical scroll delta; positive means down.'), delta:n('Alias for delta_y.'), direction:e(['up','down','left','right']), wheel_times:n('Number of 120-unit wheel steps for direction; 1..50.'), path:s(), paths:{type:'array',items:{type:'string'}}, key:s(), width:n('CSS viewport width for set_viewport.'), height:n('CSS viewport height for set_viewport.'), device_scale_factor:n('Device scale factor for set_viewport; default 1.'), mobile:b('Enable mobile emulation for set_viewport.') }, ['action']), openMutating, browserHandlers.browser_action, ['browser_cdp']),
  define('browser_wait', 'Wait for browser', 'Wait for DOM state, page text, URL, completed loading, a navigation away from the current URL, or a short network-idle period in a debuggable browser page. Use browser_evaluate separately for JavaScript predicates or page-specific inspection.', o({ ...browserTarget, condition:e(['selector','text','url_contains','load','navigation','network_idle']), selector:s(), text:s(), value:s(), poll_ms:n(), idle_ms:n('Required zero-in-flight network quiet window for network_idle; default 500 ms.') }), readOnlyOpen, browserHandlers.browser_wait, ['browser_cdp']),
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
  const displayInventoryReady = linux && desktopSession ? await displayInventoryAvailable() : false;
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
    displays: win || mac || displayInventoryReady,
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
