import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hasPinnedUiElement } from '../src/extended/desktop-computer-actions.mjs';

test('only native UI element ids pin the locator to the accessibility tree', () => {
  for (const args of [
    { id:'linux:42:node-8' }, { id:'mac:AXUIElement:some-id', name:'Save' },
    { automation_id:'SubmitButton' }, { automationId:'control-42' },
  ]) assert.equal(hasPinnedUiElement(args),true,JSON.stringify(args));
  for (const args of [
    {}, { name:'Save' }, { label:'Continue' }, { role:'button' },
    { target_id:'CDP_TAB_7', selector:'#save' }, { window_id:'window-8' },
    { x:10,y:20 }, { ocr_text:'Save' },
  ]) assert.equal(hasPinnedUiElement(args),false,JSON.stringify(args));
});

test('auto actions refuse cross-target fallback for an old pinned UI reference', () => {
  const source=readFileSync(new URL('../src/extended/desktop-computer-actions.mjs',import.meta.url),'utf8');
  assert.match(source,/const pinnedUi = automatic && hasPinnedUiElement\(args\)/);
  const stableError='if (pinnedUi) throw stalePinnedUiElement();';
  const guards=source.split(stableError).length-1;
  assert.equal(guards,4,'type, scroll, UI action, click all fail closed on an expired UI id');
  assert.match(source,/No browser, OCR, window or coordinate fallback was attempted/);
  assert.match(source,/use ui_snapshot and ui_find to refresh its ID/);
  // All fallback execution happens only after the protected native accessibility attempt.
  for (const action of ["type","scroll","click"]) {
    const start=action==='click' ? source.indexOf("if (action === 'click' && automatic)")
      : source.indexOf("if (action === '"+action+"')");
    assert.ok(start>0,'missing '+action+' handling');
    const section=source.slice(start,start+2600);
    assert.ok(section.includes('if (pinnedUi) throw stalePinnedUiElement()'),action+' fail-closed');
  }
});
