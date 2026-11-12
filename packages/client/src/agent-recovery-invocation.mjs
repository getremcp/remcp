import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { isNewer, updateInvocationArgs } from './agent-update.mjs';
import { resolveNpm } from './npm.mjs';

function regularFile(file) {
 try { const stat=fs.statSync(file); return stat.isFile() && stat.size>0; } catch { return false; }
}
export function installedUpdateEntry(cli, { platform=process.platform, exists=regularFile }={}) {
 if (!cli) return null;
 const paths = platform === 'win32' && /^[a-z]:[\\/]/i.test(cli) ? path.win32 : path;
 const entry = platform === 'win32' && /\.cmd$/i.test(cli)
   ? paths.join(paths.dirname(cli),'node_modules','@remcp','remcp','bin','remcp.mjs') : cli;
 return exists(entry) && /\.mjs$/i.test(entry) ? entry : null;
}

// A live agent may outlast quarantined files. Fetch only a newer, exact official
// pair; never loop reinstalling the same blocked bytes or execute a registry tag.
export function agentUpdateInvocation({cli, decision, cliVersion, trustRuntime=false,
 platform=process.platform, npm, exists=regularFile}={}) {
 const entry=installedUpdateEntry(cli,{platform,exists});
 if (entry) return {command:process.execPath,args:[entry,...updateInvocationArgs(decision,trustRuntime)],recovery:false};
 const target=String(decision?.target||'');
 const match=target.match(/^@remcp\/remcp@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/);
 if (platform!=='win32' || !match || decision?.runtime!=='@remcp/runtime@'+match[1] || !isNewer(match[1],cliVersion)) return null;
 const resolved=npm||resolveNpm();
 // Running npm's JavaScript entry with Node avoids cmd.exe interpolation and
 // works without the quarantined npm-generated remcp.cmd/remcp.ps1 shims.
 if (!resolved.command || !Array.isArray(resolved.args) || !resolved.args[0]?.endsWith('npm-cli.js')) return null;
 return {command:resolved.command,recovery:true,args:[...resolved.args,
  'exec','--yes','--ignore-scripts','--registry=https://registry.npmjs.org','--package='+target,'--',
  'remcp',...updateInvocationArgs(decision,trustRuntime),'--repair']};
}
