import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_PROFILES, listAppProfiles, findAppProfile, resolveAppLaunchAlias } from '../src/extended/app-launch-registry.mjs';
import { appGuidesFor } from '../src/extended/app-guides.mjs';
import { appCatalogPayload, appNavigate, planAppNavigation } from '../src/extended/app-navigation.mjs';
import { toolDefinitions } from '../src/catalog.mjs';
import { extendedToolDefinitions } from '../src/extended/catalog.mjs';

const platforms=['win32','darwin','linux'];
const categories=['browsers','office','development','communication','media','graphics','utilities','security'];
const tools=new Set([...toolDefinitions,...extendedToolDefinitions].map(x=>x.name));

test('at least 100 real desktop profiles, with broad app and OS coverage',()=>{
  assert.ok(APP_PROFILES.length>=150);
  assert.equal(new Set(APP_PROFILES.map(p=>p.id)).size,APP_PROFILES.length);
  for(const category of categories) assert.ok(APP_PROFILES.some(x=>x.category===category),category);
  assert.ok(listAppProfiles('win32').length>=100);
  assert.ok(listAppProfiles('darwin').length>=100);
  assert.ok(listAppProfiles('linux').length>=100);
  assert.ok(APP_PROFILES.every(p=>Object.keys(p.targets).length>0));
  assert.equal(findAppProfile('Blender')?.id,'blender');
  assert.equal(findAppProfile('Cursor')?.id,'cursor');
  assert.equal(findAppProfile('WhatsApp')?.id,'whatsapp');
  assert.equal(findAppProfile('DaVinci Resolve')?.id,'davinci-resolve');
  assert.equal(resolveAppLaunchAlias('/tmp/blender','linux'),null);
  assert.equal(resolveAppLaunchAlias('WhatsApp','linux'),null);
});

test('every route exposed for an OS has a bounded native app identifier',()=>{
  for(const platform of platforms){
    for(const profile of APP_PROFILES.filter(x=>x.targets[platform])){
      assert.ok(Array.isArray(profile.processes[platform]) && profile.processes[platform].length,profile.id+' '+platform);
      for(const [name,perOs] of Object.entries(profile.routes)){
        const shortcut=perOs[platform];
        if(!shortcut) continue;
        assert.match(name,/^[a-z][a-z0-9_]*$/);
        assert.equal(typeof shortcut,'string');
        assert.ok(shortcut.length>0 && shortcut.length<90);
        assert.ok(!/[\n\r\x00]/.test(shortcut));
        assert.ok(!/SEND|DELETE|ENTER|ALT\+F4|CMD\+Q/i.test(shortcut),'unsafe default '+name);
      }
    }
  }
});

test('mail, Blender, messenger, browser, office and coding shortcuts stay platform-specific',()=>{
  assert.equal(planAppNavigation({app:'blender',destination:'operator_search'},{platform:'linux'}).shortcut,'F3');
  assert.equal(planAppNavigation({app:'Blender',destination:'save_as_dialog'},{platform:'darwin'}).shortcut,'CTRL+SHIFT+S');
  assert.equal(planAppNavigation({app:'Slack',destination:'compose'},{platform:'darwin'}).shortcut,'CMD+N');
  assert.equal(planAppNavigation({app:'Thunderbird',destination:'quick_filter'},{platform:'win32'}).shortcut,'CTRL+SHIFT+K');
  assert.equal(planAppNavigation({app:'Outlook',destination:'new_message'},{platform:'win32'}).shortcut,'CTRL+SHIFT+M');
  assert.equal(planAppNavigation({app:'Obsidian',destination:'command_palette'},{platform:'darwin'}).shortcut,'CMD+P');
  assert.equal(planAppNavigation({app:'Cursor',destination:'quick_open'},{platform:'linux'}).shortcut,'CTRL+P');
  assert.equal(resolveAppLaunchAlias('LibreOffice Impress','linux').args[0],'--impress');
  assert.equal(resolveAppLaunchAlias('LibreOffice Draw','darwin').args[0],'--draw');
  assert.ok(findAppProfile('LibreOffice Impress').processes.linux.includes('soffice'));
  assert.ok(findAppProfile('LibreOffice Impress').processes.win32.includes('soffice.bin'));
  assert.throws(()=>planAppNavigation({app:'Outlook',destination:'new_message'},{platform:'linux'}));
});

test('every supported app provides realistic, separate read-only or guided in-app workflows',()=>{
  for(const profile of APP_PROFILES) for(const platform of platforms) {
    const guides=appGuidesFor(profile,platform);
    if(!profile.targets[platform]) {assert.deepEqual(guides,[]);continue;}
    assert.ok(guides.length>=1,profile.id+' '+platform);
    assert.equal(new Set(guides.map(x=>x.id)).size,guides.length,profile.id);
    for(const guide of guides){
      assert.equal(guide.execution,'guided');
      assert.match(guide.id,/^[a-z][a-z0-9_]*$/);
      assert.ok(guide.steps.length>=2);
      assert.ok(['read_only','review'].includes(guide.safety));
      assert.ok(guide.tools.every(name=>tools.has(name)),guide.id+': '+guide.tools.filter(t=>!tools.has(t)));
      const result=planAppNavigation({app:profile.id,destination:guide.id},{platform});
      assert.equal(result.kind,'guided');
      assert.equal(result.guide.id,guide.id);
    }
  }
});

test('catalog lists guide ids compactly; detailed guide needs a scope',()=>{
  const catalog=appCatalogPayload({platform:'linux'});
  assert.ok(catalog.count>=100);
  assert.equal(catalog.apps[0].id,'system');
  const row=catalog.apps.find(x=>x.id==='blender');
  assert.ok(row.guide_ids.includes('blender_add_object'));
  assert.ok(!('guides' in row));
  assert.throws(()=>appCatalogPayload({platform:'linux',include_guides:true}),/select an app/);
  const single=appCatalogPayload({platform:'linux',app:'blender',include_guides:true});
  assert.equal(single.count,1);
  assert.equal(single.apps[0].id,'blender');
  assert.ok(single.apps[0].guides.some(g=>g.id==='blender_render'));
  assert.equal(appCatalogPayload({platform:'win32',app:'WhatsApp'}).apps[0].id,'whatsapp');
  assert.equal(appCatalogPayload({platform:'linux',app:'WhatsApp'}).count,0);
  assert.ok(appCatalogPayload({platform:'win32',category:'security'}).count>=4);
  const taskSearch=appCatalogPayload({platform:'linux',filter:'draft_chat'});
  assert.ok(taskSearch.apps.some(p=>p.id==='telegram'));
  assert.ok(taskSearch.apps.some(p=>p.id==='whatsapp-web'));
  assert.ok(taskSearch.apps.every(p=>p.guide_ids.includes('draft_chat')));
});

test('guided tasks never dispatch UI actions or require an active GUI',async()=>{
  const x=await appNavigate({app:'blender',destination:'blender_add_object'});
  assert.equal(x.structuredContent.status,'guidance_only');
  assert.equal(x.structuredContent.executed,false);
  const y=await appNavigate({app:'thunderbird',destination:'compose_email'});
  assert.equal(y.structuredContent.status,'guidance_only');
  assert.equal(y.structuredContent.guide.id,'compose_email');
  assert.match(y.structuredContent.guide.steps.join(' '),/Sending is separate/);
  assert.throws(()=>planAppNavigation({app:'blender',destination:'delete_everything'}));
});
