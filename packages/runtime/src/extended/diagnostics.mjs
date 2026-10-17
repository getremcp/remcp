// Public compatibility surface for the diagnostic tool family.
// Implementations are grouped by OS concern; existing imports and handler identities remain stable.
import { serviceTool, eventLog, networkTool, installedApps, environmentTool } from './diagnostics-system.mjs';
import { audioTool, powerAction } from './diagnostics-audio-power.mjs';
import { recordScreen } from './diagnostics-record-screen.mjs';

export * from './diagnostics-system.mjs';
export * from './diagnostics-audio-power.mjs';
export * from './diagnostics-record-screen.mjs';

export const diagnosticHandlers = {
  service:serviceTool,
  event_log:eventLog,
  network:networkTool,
  installed_apps:installedApps,
  environment:environmentTool,
  audio:audioTool,
  power_action:powerAction,
  record_screen:recordScreen,
};
