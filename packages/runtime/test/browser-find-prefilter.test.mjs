import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { findExpression } from '../src/extended/browser-read.mjs';

function node(tag='div',text='',id='',attributes={}) {
  return {
    nodeType:1,tagName:tag.toUpperCase(),id,
    innerText:text,textContent:text,disabled:false,parentElement:null,children:[],
    type:attributes.type||'text',
    getAttribute(key) { return attributes[key]||''; },
    hasAttribute(key) { return Boolean(attributes[key]); },
    getClientRects() { return [{}]; },
    getBoundingClientRect() { return {x:0,y:0,width:150,height:24}; },
    contains(other) { for(let p=other;p;p=p.parentElement) if(p===this)return true;return false; },
  };
}

function run(args,source) {
  let styles=0,visited=0,geometry=0;
  // Keep element identity: DOM contains()/parentElement rely on references.
  const elements=source;
  for(const el of elements) el.getClientRects=()=>{geometry++;return [{}];};
  const sandbox={
    document:{
      documentElement:{},
      querySelectorAll:()=>{
        // A large NodeList is iterable without materializing all elements
        // before the first bounded role/selector match.
        return { *[Symbol.iterator]() {
          for(const el of elements){visited++;yield el;}
        }};
      },
    },
    getComputedStyle:()=>{styles++;return {visibility:'visible',display:'block'};},
    CSS:{escape:value=>value},
  };
  const matches=runInNewContext(findExpression(args),sandbox);
  return {matches,styles,visited,geometry};
}

test('role lookup skips thousands of irrelevant layout/style reads',()=>{
  const irrelevant=Array.from({length:10000},(_,i)=>node('div','ordinary row '+i,'row-'+i));
  const target=node('button','Launch QA action','desired');
  const {matches,styles,visited,geometry}=run({role:'button',limit:1},[...irrelevant,target,...irrelevant]);
  assert.equal(matches.length,1);
  assert.equal(matches[0].selector,'#desired');
  assert.equal(matches[0].role,'button');
  assert.equal(visited,10001);
  assert.equal(styles,1);
  assert.equal(geometry,1);
});

test('text-only search prefilters before touching layout and still returns exact interactive text',()=>{
  const irrelevant=Array.from({length:4000},(_,i)=>node('div','ordinary row '+i,'row-'+i));
  const parent=node('section','Run unique QA action','outer');
  const target=node('button','Run unique QA action','submit');
  target.parentElement=parent;parent.children=[target];
  const result=run({text:'Run unique QA action',limit:5},[parent,...irrelevant,target]);
  assert.equal(result.matches.length,1);
  assert.equal(result.matches[0].role,'button');
  assert.equal(result.matches[0].selector,'#submit');
  assert.equal(result.styles,2,'layout work is limited to text candidates');
});

test('searches with selector or role and no ranking stop after requested number of matches',()=>{
  const elements=Array.from({length:3000},(_,i)=>node('button','Action '+i,'button-'+i));
  const found=run({selector:'button',limit:2},elements);
  assert.equal(found.matches.length,2);
  assert.equal(found.visited,2,'do not inspect the remaining page after filling the output limit');
  assert.equal(found.styles,2);
  assert.equal(found.matches[0].selector,'#button-0');
  assert.equal(found.matches[1].selector,'#button-1');
});

test('ARIA text fallback works, while hidden descendant text cannot create a visible match',()=>{
  const labelled=node('button','','aria',{ 'aria-label':'Open QA settings' });
  const hiddenChild=node('div','Target hidden text','hidden');
  hiddenChild.innerText='Visible only';
  const aria=run({text:'Open QA settings'},[labelled]);
  assert.equal(aria.matches.length,1);
  assert.equal(aria.matches[0].selector,'#aria');
  assert.equal(run({text:'Target hidden text'},[hiddenChild]).matches.length,0);
});

test('invalid DOM selection does not turn an empty search into input values',()=>{
  const secret=node('input','','otp',{type:'password',name:'one-time-code'});
  secret.value='confidential-otp';
  const result=run({selector:'input',limit:5},[secret]);
  assert.equal(result.matches.length,1);
  assert.equal(result.matches[0].value,'');
  assert.equal(result.matches[0].text,'');
});

test('role-aware DOM queries keep explicit ARIA roles without scanning all elements',()=>{
  const source=String(findExpression({role:'button'}));
  assert.match(source,/button,summary,input/);
  assert.ok(source.includes(" + ',[role]'"), 'explicit ARIA roles stay searchable');
  const explicit=node('div','Custom action','custom',{'role':'button'});
  assert.equal(run({role:'button'},[explicit]).matches[0].selector,'#custom');
  assert.ok(findExpression({role:'heading'}).includes('h1,h2,h3,h4,h5,h6'));
  assert.ok(findExpression({role:'unknown-role'}).includes(" : '*'"));
});

test('CSS-generated line breaks do not break text candidate prefilter',()=>{
  const el=node('div','A\nB','multiline');
  el.textContent='AB';
  const {matches}=run({text:'A\nB'},[el]);
  assert.equal(matches.length,1);
  assert.equal(matches[0].selector,'#multiline');
});


test('prototype property names are not mistaken for built-in role selectors',()=>{
  for(const role of ['constructor','__proto__','toString']){
    const result=run({role},[node('button','public test','public')]);
    assert.equal(result.matches.length,0);
    assert.ok(findExpression({role}).includes(" : '*'"));
  }
});
