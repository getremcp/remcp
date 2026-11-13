import test from 'node:test';
import assert from 'node:assert/strict';
import {WEB_APP_PROFILES,findWebAppProfile,listWebAppProfiles} from '../src/extended/app-web-profiles.mjs';
import {appCatalogPayload,appNavigate,planAppNavigation} from '../src/extended/app-navigation.mjs';
import {appGuidesFor} from '../src/extended/app-guides.mjs';
import {toolDefinitions} from '../src/catalog.mjs';
import {extendedToolDefinitions} from '../src/extended/catalog.mjs';

test('web service catalog is independent of installed desktop app catalog',()=>{
  assert.ok(WEB_APP_PROFILES.length>=30);
  assert.equal(new Set(WEB_APP_PROFILES.map(x=>x.id)).size,WEB_APP_PROFILES.length);
  assert.equal(findWebAppProfile('Gmail').id,'gmail-web');
  assert.equal(findWebAppProfile('Gmail (web)').id,'gmail-web');
  assert.equal(findWebAppProfile('GitHub').id,'github-web');
  assert.equal(findWebAppProfile('not-an-app'),null);
  const rows=listWebAppProfiles();
  assert.ok(rows.every(x=>x.web_only===true&&x.destinations.length===0));
  assert.ok(rows.every(x=>x.host&&!x.host.includes('/')&&!x.host.includes('?')));
  assert.equal(appCatalogPayload({platform:'linux',category:'web'}).count,WEB_APP_PROFILES.length);
  assert.throws(()=>appCatalogPayload({platform:'linux',category:'web',include_guides:true}),/Too many detailed/);
  assert.ok(appCatalogPayload({platform:'darwin',filter:'gmail'}).apps.some(x=>x.id==='gmail-web'));
  assert.equal(appCatalogPayload({platform:'win32',app:'Google Docs'}).count,1);
});

test('web app workflows are guides, never local executables or automated sends',async()=>{
  const tools=new Set([...toolDefinitions,...extendedToolDefinitions].map(x=>x.name));
  for(const item of WEB_APP_PROFILES) {
    assert.ok(item.targets.win32&&item.targets.darwin&&item.targets.linux);
    for(const os of ['win32','darwin','linux']){
      const guides=appGuidesFor(item,os);
      assert.ok(guides.length>=2,item.id+' '+os);
      assert.equal(new Set(guides.map(x=>x.id)).size,guides.length);
      for(const g of guides){
        assert.equal(g.execution,'guided');
        assert.ok(g.steps.length>=2);
        assert.ok(g.tools.every(tool=>tools.has(tool)));
        const plan=planAppNavigation({app:item.id,destination:g.id},{platform:os});
        assert.equal(plan.kind,'guided');
        assert.equal(plan.web_only,true);
        assert.equal(plan.host,item.host);
      }
    }
    assert.throws(()=>planAppNavigation({app:item.id,destination:'launch'}),/guides only/);
  }
  for(const [app,destination] of [['Gmail','compose_email'],['WhatsApp Web','draft_chat'],['Google Docs','export_pdf']]){
    const result=await appNavigate({app,destination});
    assert.equal(result.structuredContent.status,'guidance_only');
    assert.equal(result.structuredContent.executed,false);
    assert.equal(result.structuredContent.web_only,true);
    assert.ok(result.structuredContent.guide.note.includes('verified'));
  }
});

test('web services are never accidentally checked as installed binaries',()=>{
  const x=appCatalogPayload({platform:'linux',app:'Gmail',include_guides:true});
  assert.equal(x.apps[0].web_only,true);
  assert.ok(x.apps[0].guides.some(g=>g.id==='compose_email'));
  assert.ok(!('installation' in x.apps[0]));
});
