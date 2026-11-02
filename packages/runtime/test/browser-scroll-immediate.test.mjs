import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { PAGE_SCROLL_ACTION } from '../src/extended/browser-actions.mjs';

// Smooth CSS scrolling can remain pending in a background CDP target. Returning
// before that animation must not report a successful delta with unchanged bounds.
function smoothScroller(tagName = 'HTML') {
  let x = 0, y = 0;
  return {
    tagName, scrollWidth:1000, clientWidth:300, scrollHeight:2000, clientHeight:200,
    get scrollLeft() { return x; }, set scrollLeft(_value) {},
    get scrollTop() { return y; }, set scrollTop(_value) {},
    scrollTo(options) {
      if (options.behavior === 'instant') { x = options.left; y = options.top; }
    },
  };
}

test('browser scroll applies both axes immediately despite smooth page CSS', () => {
  const root = smoothScroller();
  const result = runInNewContext('(' + PAGE_SCROLL_ACTION + ')(null,null,25,450)', {
    document:{ scrollingElement:root, documentElement:root },
  });
  assert.equal(result.before_y, 0);
  assert.equal(result.after_y, 450);
  assert.equal(result.after_x, 25);
});

test('browser scroll keeps the selected nested scroller and supports negative deltas', () => {
  const root = smoothScroller();
  const pane = smoothScroller('DIV');
  pane.parentElement = root;
  pane.scrollTo({left:100,top:500,behavior:'instant'});
  const result = runInNewContext('(' + PAGE_SCROLL_ACTION + ')("#pane",null,-20,-120)', {
    document:{ scrollingElement:root, documentElement:root, querySelector:()=>pane },
    getComputedStyle:()=>({overflowX:'auto',overflowY:'auto'}),
  });
  assert.equal(result.scroller, 'div');
  assert.equal(result.before_y, 500);
  assert.equal(result.after_y, 380);
  assert.equal(result.after_x, 80);
  assert.equal(root.scrollTop, 0);
});
