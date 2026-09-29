// Where the CLI keeps its state and which npm it drives. Everything here is resolved once, at import
// time, so a background service and an interactive shell agree on the same paths.
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { resolveNpm } from '../npm.mjs';

export const home = os.homedir();
export const configDir = process.env.REMCP_CONFIG_DIR || path.join(home, '.config', 'remcp');
export const configFile = path.join(configDir, 'config.json');
export const runtimeConfigFile = path.join(configDir, 'runtime.json');
export const machineIdFile = path.join(configDir, 'machine-id');
export const linuxServiceFile = path.join(home, '.config', 'systemd', 'user', 'remcp-agent.service');
export const linuxServiceLauncherFile = path.join(configDir, 'remcp-agent-launcher');
export const macServiceLabel = 'com.remcp.agent';
export const macServiceFile = path.join(home, 'Library', 'LaunchAgents', `${macServiceLabel}.plist`);
export const macLogFile = path.join(home, 'Library', 'Logs', 'remcp-agent.log');
export const windowsTaskName = 'ReMCP Agent';
export const windowsServiceLauncherFile = path.join(configDir, 'remcp-agent.cmd');
// How npm is invoked is resolved from the running node when possible: a background service has a
// minimal PATH, which is why auto-update used to find no npm on macOS. See src/npm.mjs.
export const npm = resolveNpm();
export const officialOrigin = 'https://remcp.site';
