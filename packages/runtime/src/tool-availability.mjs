import process from 'node:process';
import { supportedCoreTools } from './catalog.mjs';
import { advertisedExtendedTools, capabilitySnapshot } from './extended/catalog.mjs';

// The core screenshot tool is distinct from extended screenshot_region, but
// both require a real Windows user desktop. Keep read_image and all other
// filesystem tools available to Session 0 service agents.
export function filterCoreToolsForLiveDesktop(tools, {
  platform = process.platform,
  capabilities = {},
} = {}) {
  if (platform !== 'win32' || capabilities.desktop_session === true) return tools;
  return tools.filter(tool => tool.name !== 'take_screenshot');
}

export async function supportedRuntimeToolDefinitions() {
  // One consistent OS capability snapshot for ordinary and compact MCP lists.
  const capabilities = await capabilitySnapshot();
  return {
    core:filterCoreToolsForLiveDesktop(supportedCoreTools(), { capabilities }),
    extended:await advertisedExtendedTools(capabilities),
  };
}
