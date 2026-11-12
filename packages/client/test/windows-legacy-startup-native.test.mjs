import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('native Windows startup installs and stops only an isolated owned agent', {
  skip:process.platform !== 'win32', timeout:210000,
}, () => {
  // No production credentials, Startup folder, relay or running agent are used.
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'remcp-native-startup-'));
  const appData=path.join(root,'roaming');
  const prefix=path.join(root,'runtime');
  const installed=path.join(prefix,'node_modules','@remcp','remcp');
  const cli=path.join(installed,'bin','remcp.mjs');
  const service=path.resolve('src/cli/service.mjs');
  const supervisor=path.resolve('src/cli/windows-user-supervisor.mjs');
  const entry=path.join(installed,'src','cli');
  const startup=path.join(appData,'Microsoft','Windows','Start Menu',
    'Programs','Startup','ReMCP Agent.vbs');
  const pidFile=path.join(root,'owned-agent.pid');
  fs.mkdirSync(path.dirname(cli),{recursive:true});
  fs.mkdirSync(entry,{recursive:true});
  fs.writeFileSync(cli,
    "import fs from 'node:fs';\n" +
    "fs.writeFileSync(process.env.REMCP_QA_OWNED_PID, String(process.pid));\n" +
    "setInterval(() => {}, 500);\n");
  for(const file of ['windows-user-supervisor.mjs','windows-owned-job.mjs',
    'windows-owned-job-source.mjs','windows-interop.mjs']) {
    fs.copyFileSync(path.resolve('src/cli',file),path.join(entry,file));
  }
  fs.cpSync(path.resolve('src/cli/native'),path.join(entry,'native'),{recursive:true});
  const script=[
    "import fs from 'node:fs';",
    "import assert from 'node:assert/strict';",
    `import {installWindowsService,uninstallPersistentService} from ${JSON.stringify(new URL('../src/cli/service.mjs',import.meta.url).href)};`,
    `import {windowsSupervisorCommand} from ${JSON.stringify(new URL('../src/cli/windows-user-supervisor.mjs',import.meta.url).href)};`,
    `const cliPath=${JSON.stringify(path.join(prefix,'remcp.cmd'))};`,
    `const startup=${JSON.stringify(startup)};`,
    `const pidFile=${JSON.stringify(pidFile)};`,
    "installWindowsService(cliPath,{nodePath:process.execPath});",
    "const status=windowsSupervisorCommand('status');",
    "assert.equal(status.running,true);",
    "assert.equal(fs.existsSync(startup),true);",
    "assert.equal(fs.existsSync(pidFile),true);",
    "const agentPid=Number(fs.readFileSync(pidFile,'utf8'));",
    "assert.ok(Number.isSafeInteger(agentPid)&&agentPid>0);",
    "uninstallPersistentService();",
    "assert.equal(fs.existsSync(startup),false);",
    "let alive=true;",
    "try{process.kill(agentPid,0);}catch(e){if(e.code==='ESRCH')alive=false;else throw e;}",
    "assert.equal(alive,false,'owned agent survived verified uninstall');",
    "console.log('ISOLATED_WINDOWS_STARTUP_QA=PASS');",
  ].join('\n');
  const run=spawnSync(process.execPath,['--input-type=module','-e',script],{
    cwd:path.resolve('.'),encoding:'utf8',windowsHide:true,timeout:190000,
    maxBuffer:64*1024,env:{...process.env,APPDATA:appData,
      REMCP_CONFIG_DIR:path.join(root,'config'),REMCP_QA_OWNED_PID:pidFile},
  });
  if(run.error||run.status!==0) {
    throw new Error('Isolated Windows Startup QA failed; fixture preserved at '+root+
      '\n'+String(run.error?.message||'')+'\n'+run.stderr+'\n'+run.stdout);
  }
  assert.match(run.stdout,/ISOLATED_WINDOWS_STARTUP_QA=PASS/);
  fs.rmSync(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});
});
