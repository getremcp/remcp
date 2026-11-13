import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_PROFILES } from '../src/extended/app-launch-registry.mjs';
import { matchWindowsStartApps, matchLinuxBinaries, matchMacApplications } from '../src/extended/app-presence-core.mjs';
import { appCatalog } from '../src/extended/app-navigation.mjs';

test('Windows exact Start menu app matches are confirmed; fuzzy names remain unconfirmed', () => {
  const profiles = APP_PROFILES.filter(p => ['vscode','chrome','firefox'].includes(p.id));
  const statuses = matchWindowsStartApps([
    {Name:'Visual Studio Code',AppID:'VSCode'},
    {Name:'Chromium (portable)',AppID:'test'}
  ],profiles);
  assert.deepEqual(statuses,{vscode:'confirmed',chrome:'unconfirmed',firefox:'unconfirmed'});
  assert.equal(matchWindowsStartApps([{Name:'google chrome'}],profiles).chrome,'confirmed');
  assert.equal(matchWindowsStartApps(null,profiles).vscode,'unconfirmed');
});

test('Linux executable presence checks use a caller-supplied predicate only', () => {
  const profiles = APP_PROFILES.filter(p => ['vscode','chrome','libreoffice'].includes(p.id));
  const observed = [];
  const statuses = matchLinuxBinaries(profiles,name => {
    observed.push(name);
    return name === 'code';
  });
  assert.deepEqual(statuses,{vscode:'confirmed',chrome:'unconfirmed',libreoffice:'unconfirmed'});
  assert.deepEqual(observed,['code','google-chrome','libreoffice']);
});

test('LibreOffice module presence is not inferred from a shared launcher', async () => {
  const modules = APP_PROFILES.filter(p => ['libreoffice-writer','libreoffice-calc'].includes(p.id));
  assert.deepEqual(matchLinuxBinaries(modules, name => name === 'libreoffice'), {
    'libreoffice-writer':'launcher_present','libreoffice-calc':'launcher_present',
  });
  const mac = await matchMacApplications(modules,{
    exists:async file => file.endsWith('/LibreOffice.app'),
  });
  assert.deepEqual(mac,{'libreoffice-writer':'launcher_present','libreoffice-calc':'launcher_present'});
});

test('macOS application probes use known directories; do not invent installation', async () => {
  const profiles = APP_PROFILES.filter(p => ['vscode','chrome','firefox'].includes(p.id));
  const visited = [];
  const result = await matchMacApplications(profiles,{
    home:'/Users/qa',
    exists:async file => {
      visited.push(file);
      return file === '/Applications/Visual Studio Code.app';
    },
  });
  assert.deepEqual(result,{vscode:'confirmed',chrome:'unconfirmed',firefox:'unconfirmed'});
  assert.equal(visited.length,15);
  assert.ok(visited.every(p => !p.includes('..')));
});

test('installed-app hints only appear when explicitly requested', async () => {
  const fast = appCatalog({category:'media'});
  assert.ok(!('then' in fast));
  assert.ok(!('installation' in fast.structuredContent.apps[0]));
  const checked = await appCatalog({category:'development',check_installed:true});
  assert.ok(checked.structuredContent.apps.length > 0);
  assert.ok(checked.structuredContent.apps.every(app => ['confirmed','unconfirmed'].includes(app.installation)));
  assert.equal(checked.structuredContent.availability_source,'path_executables');
  assert.deepEqual(JSON.parse(checked.content[0].text),checked.structuredContent);
  const refreshed = await appCatalog({category:'development',check_installed:true,refresh:true});
  assert.ok(refreshed.structuredContent.apps.length>0);
  assert.ok(refreshed.structuredContent.inspected_at);
});
