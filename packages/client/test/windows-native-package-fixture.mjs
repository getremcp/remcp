// Stage an isolated package-shaped Windows native test fixture.
// Real Windows helper loaders resolve ../../package.json from src/cli.
import fs from 'node:fs';
import path from 'node:path';

export function stageWindowsNativeClientFixture(packageRoot) {
 const root=path.resolve(packageRoot);
 if(fs.existsSync(root))throw Error('Windows native fixture root must be fresh');
 const source=path.resolve('src/cli');
 const metadata=JSON.parse(fs.readFileSync(path.resolve('package.json'),'utf8'));
 if(![1,2].includes(metadata.remcpWindowsInterop))
  throw Error('Windows fixture requires an explicit interop package mode');
 const entry=path.join(root,'src','cli');
 fs.mkdirSync(entry,{recursive:true});
 fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({
  name:'@remcp/remcp',type:'module',version:metadata.version,
  remcpWindowsInterop:metadata.remcpWindowsInterop,
 }));
 for(const name of ['windows-user-supervisor.mjs','windows-owned-job.mjs',
   'windows-owned-job-source.mjs','windows-interop.mjs']){
  fs.copyFileSync(path.join(source,name),path.join(entry,name));
 }
 fs.cpSync(path.join(source,'native'),path.join(entry,'native'),{recursive:true});
 return entry;
}
