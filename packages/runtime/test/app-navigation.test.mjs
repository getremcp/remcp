import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_PROFILES, findAppProfile, resolveAppLaunchAlias } from '../src/extended/app-launch-registry.mjs';
import { appCatalog, appCatalogPayload, appNavigate, planAppNavigation, chooseAppWindow, verifiedAppFocus, findLaunchUiWindow } from '../src/extended/app-navigation.mjs';
import { resolveSystemRoute, systemRouteIds } from '../src/extended/app-system-routes.mjs';
import { extendedToolDefinitions } from '../src/extended/catalog.mjs';
import { compactRuntimeGroups } from '../src/compact-catalog.mjs';
import { parseActiveX11WindowId } from '../src/extended/desktop-linux-windows.mjs';

test('system OS navigation comes first in every catalog', () => {
  for (const platform of ['win32','darwin','linux']) {
    const catalog = appCatalogPayload({ platform });
    assert.equal(catalog.apps[0].id,'system');
    assert.equal(catalog.count,catalog.apps.length);
    assert.ok(catalog.apps.find(row => row.id === 'firefox'));
    assert.ok(catalog.apps.find(row => row.id === 'vscode'));
    assert.ok(catalog.apps.some(row => row.category === 'office'));
    assert.ok(catalog.apps.some(row => row.category === 'media'));
    assert.ok(catalog.apps.some(row => row.category === 'communication'));
    assert.ok(catalog.apps.some(row => row.category === 'graphics'));
    assert.ok(catalog.apps.some(row => row.category === 'utilities'));
  }
});

test('Windows Settings, Control Panel, Start, Task Manager and Explorer are direct routes', () => {
  for (const [destination,method,value] of [
    ['settings','uri','ms-settings:'],
    ['display','uri','ms-settings:display'],
    ['network','uri','ms-settings:network-status'],
    ['apps','uri','ms-settings:appsfeatures'],
    ['control_panel','launch','control.exe'],
    ['file_manager','launch','explorer.exe'],
    ['task_manager','launch','Taskmgr.exe'],
    ['start_menu','key','CTRL+ESC'],
  ]) assert.deepEqual(resolveSystemRoute(destination,'win32'),{
    destination,platform:'win32',method,value,
  });
});

test('macOS System Settings and panels use separate allowed Apple routes', () => {
  assert.equal(resolveSystemRoute('settings','darwin').value,'System Settings');
  assert.match(resolveSystemRoute('network','darwin').value,/^x-apple\.systempreferences:com\.apple\./);
  assert.equal(resolveSystemRoute('file_manager','darwin').value,'Finder');
  assert.equal(resolveSystemRoute('task_manager','darwin').value,'Activity Monitor');
  assert.equal(resolveSystemRoute('spotlight','darwin').value,'CMD+SPACE');
});

test('Linux GNOME/KDE desktop settings use different native settings backends', () => {
  assert.deepEqual(resolveSystemRoute('display','linux','GNOME'),{
    destination:'display',platform:'linux',method:'desktop_panel',shell:'gnome',panel:'display',
  });
  assert.equal(resolveSystemRoute('display','linux','KDE:Plasma').panel,'kcm_kscreen');
  assert.equal(resolveSystemRoute('network','linux','KDE').panel,'kcm_networkmanagement');
  assert.equal(resolveSystemRoute('file_manager','linux','GNOME').method,'chooser');
  assert.ok(systemRouteIds('linux').includes('apps'));
});

test('X11 foreground parser is exact and fails closed on absent window or malformed output', () => {
  assert.equal(parseActiveX11WindowId('_NET_ACTIVE_WINDOW(WINDOW): window id # 0x04a00006'),0x04a00006);
  assert.equal(parseActiveX11WindowId('_NET_ACTIVE_WINDOW(WINDOW): window id # 0x0'),0);
  assert.equal(parseActiveX11WindowId('_NET_ACTIVE_WINDOW(WINDOW): not found'),null);
  assert.equal(parseActiveX11WindowId('window id # 0x04a00006'),null);
});

test('app catalog has known categories, many profiles and per-OS navigation templates', () => {
  assert.ok(APP_PROFILES.length >= 45);
  assert.ok(new Set(APP_PROFILES.map(p => p.category)).size >= 7);
  const office = appCatalogPayload({ platform:'win32',category:'office' });
  assert.ok(office.apps.length >= 5);
  assert.ok(office.apps.every(row => row.category === 'office'));
  assert.ok(appCatalogPayload({ platform:'darwin',category:'system' }).apps.every(row => row.id === 'system'));
  assert.ok(appCatalogPayload({ platform:'linux',filter:'settings' }).apps.some(row => row.id === 'vscode'));
  assert.equal(findAppProfile('VS Code').id,'vscode');
  assert.equal(resolveAppLaunchAlias('Microsoft Excel','linux'),null);
});

test('shortcuts only resolve for registered OS and app destinations', () => {
  assert.equal(planAppNavigation({ app:'vscode',destination:'explorer' },{platform:'linux'}).shortcut,'CTRL+SHIFT+E');
  assert.equal(planAppNavigation({ app:'vscode',destination:'explorer' },{platform:'darwin'}).shortcut,'CMD+SHIFT+E');
  assert.equal(planAppNavigation({ app:'vlc',destination:'playlist' },{platform:'win32'}).shortcut,'CTRL+L');
  assert.equal(planAppNavigation({ app:'word',destination:'new_document' },{platform:'darwin'}).shortcut,'CMD+N');
  assert.equal(planAppNavigation({ app:'firefox',destination:'address_bar' },{platform:'linux'}).shortcut,'CTRL+L');
  assert.deepEqual(planAppNavigation({app:'libreoffice-writer',destination:'launch'},{platform:'linux'}).launchArgs,['--writer']);
  assert.deepEqual(planAppNavigation({app:'libreoffice-calc',destination:'launch'},{platform:'darwin'}).launchArgs,['--calc']);
  assert.throws(()=>planAppNavigation({app:'word',destination:'new_document'},{platform:'linux'}),/not supported/);
});

test('unknown and unsafe actions fail closed instead of dispatching keys/commands', () => {
  for (const args of [
    {app:'system',destination:'rm -rf /'},
    {app:'system',destination:'../../secrets'},
    {app:'system',destination:'unknown_panel'},
    {app:'vscode',destination:'install_extension'},
    {app:'nonexistent',destination:'launch'},
  ]) assert.throws(()=>planAppNavigation(args,{platform:'linux'}));
});

test('planning an application route never launches a GUI app', async () => {
  const plan = await appNavigate({app:'vscode',destination:'explorer',dry_run:true});
  const raw=plan.content.find(row=>row.type==='text')?.text;
  const response=plan.structuredContent || JSON.parse(raw);
  assert.equal(response.status,'planned');
  assert.equal(response.plan.app,'vscode');
});

test('app_catalog handler returns valid MCP content and matching structured data', () => {
  const result = appCatalog({category:'media'});
  assert.ok(Array.isArray(result.content));
  const decoded = JSON.parse(result.content[0].text);
  assert.ok(decoded.apps.some(app => app.id === 'vlc'));
  assert.deepEqual(result.structuredContent,decoded);
});

test('app navigation selects exact active process and refuses ambiguous windows', () => {
  const target = {id:'w1',pid:42,app:'Code',title:'Work',active:false};
  const other = {id:'w2',pid:99,app:'Other',title:'Other',active:true};
  const plan = {app:'vscode',windowNames:['code']};
  assert.equal(chooseAppWindow([target,other],plan).id,'w1');
  assert.equal(verifiedAppFocus(target,[other]),false);
  assert.equal(verifiedAppFocus(target,[{...target,active:true}]),true);
  assert.equal(verifiedAppFocus(target,[{...target,id:'w3',active:true}]),true);
  assert.equal(verifiedAppFocus(target,[{...target,id:'w3',title:'Other',active:true}]),false);
  assert.equal(verifiedAppFocus(target,[{...target,active:true},other]),false);
  assert.throws(()=>chooseAppWindow([target,{...target,id:'w4',title:'Other'}],plan),/Multiple/);
});

test('launch verification requires a real matching app window, not process-only or foreign UI', () => {
  const plan={windowNames:['gnome-calculator']};
  const row={app:'gnome-calculator',role:'frame',window:'Calculator',width:360,height:616,pid:42};
  assert.equal(findLaunchUiWindow({nodes:[row]},plan)?.window,'Calculator');
  assert.equal(findLaunchUiWindow({nodes:[{...row,role:'application'}]},plan),null);
  assert.equal(findLaunchUiWindow({nodes:[{...row,app:'other'}]},plan),null);
  assert.equal(findLaunchUiWindow({nodes:[{...row,width:0}]},plan),null);
  assert.equal(findLaunchUiWindow({nodes:[{...row,window:''}]},plan),null);
  assert.equal(findLaunchUiWindow({nodes:[row]},{windowNames:[]}),null);
  assert.equal(findLaunchUiWindow({},plan),null);
});

test('compact MCP toolset exposes both new operations with appropriate annotations', () => {
  for (const name of ['app_catalog','app_navigate']) {
    assert.ok(compactRuntimeGroups.control_computer.includes(name));
    assert.ok(extendedToolDefinitions.find(item => item.name === name));
  }
  assert.equal(extendedToolDefinitions.find(x=>x.name==='app_catalog').annotations.readOnlyHint,true);
  assert.equal(extendedToolDefinitions.find(x=>x.name==='app_navigate').annotations.readOnlyHint,false);
});
