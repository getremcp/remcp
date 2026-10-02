import test from 'node:test';
import assert from 'node:assert/strict';

import {
  installedAppsPayload,
  normalizeInstalledApp,
  parseInstalledAppsTsv,
} from '../src/extended/diagnostics.mjs';
import { extendedToolDefinitions } from '../src/extended/catalog.mjs';

test('installed app records normalize Windows and macOS native fields', () => {
  assert.deepEqual(normalizeInstalledApp({
    DisplayName:'Visual Studio Code',
    DisplayVersion:'1.99.0',
    Publisher:'Microsoft',
    InstallLocation:'C:\\Apps\\VS Code',
  }), {
    name:'Visual Studio Code',
    version:'1.99.0',
    publisher:'Microsoft',
    path:'C:\\Apps\\VS Code',
  });

  assert.deepEqual(normalizeInstalledApp({
    _name:'Safari',
    version:'26.0',
    path:'/Applications/Safari.app',
    signed_by:['Software Signing', 'Apple Code Signing Certification Authority'],
  }), {
    name:'Safari',
    version:'26.0',
    publisher:null,
    path:'/Applications/Safari.app',
    signed_by:'Software Signing,Apple Code Signing Certification Authority',
  });

  assert.equal(normalizeInstalledApp({ DisplayVersion:'1.0' }), null);
});

test('Linux package TSV is normalized into stable app records', () => {
  assert.deepEqual(parseInstalledAppsTsv([
    'bash\t5.2.15-2+b9\tDebian Bash Maintainers <pkg-bash-maint@lists.alioth.debian.org>',
    'curl\t8.10.1-2\tDebian Curl Maintainers',
    '',
  ].join('\n')), [
    {
      name:'bash',
      version:'5.2.15-2+b9',
      publisher:'Debian Bash Maintainers <pkg-bash-maint@lists.alioth.debian.org>',
      path:null,
    },
    {
      name:'curl',
      version:'8.10.1-2',
      publisher:'Debian Curl Maintainers',
      path:null,
    },
  ]);
});

test('installed app payload filters by name, de-duplicates, sorts, and reports truncation', () => {
  const payload = installedAppsPayload([
    { name:'Zulu', version:'2', publisher:'Vendor Z' },
    { name:'Alpha', version:'1', publisher:'Vendor A' },
    { name:'alpha', version:'1', publisher:'duplicate case' },
    { name:'Alpha Tools', version:'3', publisher:'Vendor B' },
    { name:'Hidden', version:'9', publisher:'alpha publisher should not match name filter' },
  ], {
    backend:'fixture',
    filter:'alpha',
    limit:1,
  });

  assert.deepEqual(payload, {
    data:[{
      name:'Alpha',
      version:'1',
      publisher:'Vendor A',
      path:null,
    }],
    backend:'fixture',
    count:2,
    returned:1,
    truncated:true,
  });
});

test('installed_apps output schema declares the stable structured inventory fields', () => {
  const tool = extendedToolDefinitions.find(candidate => candidate.name === 'installed_apps');
  assert.ok(tool);
  const properties = tool.outputSchema.properties;
  for (const field of ['data','backend','count','returned','truncated']) assert.ok(properties[field], field);
  const item = properties.data.items;
  for (const field of ['name','version','publisher','path']) assert.ok(item.properties[field], field);
});
