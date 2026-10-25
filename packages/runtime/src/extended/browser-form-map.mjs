// Read-only Chrome DOMSnapshot form map. Page strings/attributes never leave this module.
// Structural selectors contain only allowlisted HTML tag names and sibling indexes.
const TAGS = new Set(['HTML','HEAD','BODY','DIV','MAIN','SECTION','ARTICLE','ASIDE','FORM','FIELDSET',
  'LABEL','INPUT','SELECT','TEXTAREA','BUTTON','SPAN','P','UL','LI','DIALOG','TABLE','TR','TD']);
const FIELDS = new Set(['INPUT','SELECT','TEXTAREA']);
const TYPES = new Set(['text','email','password','tel','url','search','number','date','time',
  'datetime-local','month','week','color','range','checkbox','radio','file','hidden','submit',
  'reset','button','image']);
const AUTOCOMPLETE = new Set(['on','off','name','given-name','family-name','email','username',
  'new-password','current-password','one-time-code','tel','street-address','postal-code',
  'country','country-name','organization','address-line1','address-line2','address-level1',
  'address-level2','cc-name','cc-number','cc-exp','cc-exp-month','cc-exp-year','cc-csc']);
const MAX_NODES=12000, MAX_FIELDS=40, MAX_FORMS=8, MAX_DEPTH=16;
const safeNum = n => Number.isSafeInteger(n) && n>=0 ? n : -1;
function nodeTag(nodes,strings,i) {
  const name=strings?.[nodes?.nodeName?.[i]];
  if (typeof name !== 'string') return '';
  const tag=name.toUpperCase();
  // Chrome also reports a lowercase 'html' doctype, which is not an element.
  return name===tag && TAGS.has(tag) ? tag : '';
}
function attrs(nodes,strings,i) {
  const list=nodes?.attributes?.[i];
  const found=Object.create(null);
  if (!Array.isArray(list)) return found;
  for(let j=0;j<Math.min(list.length,80)-1;j+=2) {
    const name=strings?.[list[j]], value=strings?.[list[j+1]];
    // Chrome encodes valueless HTML attributes (for example required) with -1.
    if(typeof name==='string' && name.length<=40)
      found[name.toLowerCase()]=typeof value==='string'?value:'';
  }
  return found;
}
function ancestorWithTag(i,parents,tags,tag) {
  let current=i;
  for(let depth=0;depth<MAX_DEPTH;depth++) {
    current=parents[current];
    if(!Number.isSafeInteger(current)||current<0||current>=tags.length) return -1;
    if(tags[current]===tag)return current;
  }
  return -1;
}
function structuralSelector(i,parents,tags,siblingPositions) {
  const parts=[];
  let current=i;
  for(let depth=0;depth<MAX_DEPTH;depth++) {
    const tag=tags[current], pos=siblingPositions[current];
    if(!tag||!pos) return null;
    parts.push(tag.toLowerCase()+':nth-of-type('+pos+')');
    if(tag==='HTML')break;
    const parent=parents[current];
    if(!Number.isSafeInteger(parent)||parent<0) break;
    if(parent>=tags.length||parent===current) return null;
    current=parent;
  }
  if(parts.at(-1)!=='html:nth-of-type(1)') return null;
  const css=parts.reverse().join(' > ');
  return css.length<=350 ? css : null;
}
export function summarizeFormMap(snapshot) {
  const docs=Array.isArray(snapshot?.documents)?snapshot.documents:[];
  const nodes=docs[0]?.nodes||{}, strings=Array.isArray(snapshot?.strings)?snapshot.strings:[];
  const parents=Array.isArray(nodes.parentIndex)?nodes.parentIndex:[];
  const total=Math.min(MAX_NODES,Array.isArray(nodes.nodeName)?nodes.nodeName.length:0);
  const tags=Array.from({length:total},(_,i)=>nodeTag(nodes,strings,i));
  const siblingPositions=new Array(total).fill(0), counts=new Map();
  for(let i=0;i<total;i++) {
    if(!tags[i])continue;
    const parent=safeNum(parents[i]);
    const key=parent+':'+tags[i], ordinal=(counts.get(key)||0)+1;
    counts.set(key,ordinal);
    siblingPositions[i]=ordinal;
  }
  const forms=[],formByIndex=new Map(), labelsFor=new Set();
  for(let i=0;i<total;i++) {
    if(tags[i]==='LABEL') {
      const associated=attrs(nodes,strings,i).for;
      if(associated) labelsFor.add(associated);
    }
    if(tags[i]==='FORM') {
      const record={index:i,field_count:0,required_count:0,unlabeled_count:0,submit_count:0};
      forms.push(record);formByIndex.set(i,record);
    }
  }
  let fieldCount=0,requiredCount=0,unlabeledCount=0,disabledCount=0,unownedCount=0,submitCount=0;
  const types=Object.create(null), fields=[];
  for(let i=0;i<total;i++) {
    const tag=tags[i];
    if(!FIELDS.has(tag) && tag!=='BUTTON')continue;
    const a=attrs(nodes,strings,i);
    const rawType=tag==='INPUT' ? (a.type||'text').toLowerCase() : tag==='BUTTON'
      ? (a.type||'submit').toLowerCase() : tag.toLowerCase();
    const type=TYPES.has(rawType)?rawType:tag==='BUTTON'?'button':tag.toLowerCase()==='input'?'other':tag.toLowerCase();
    const formIndex=ancestorWithTag(i,parents,tags,'FORM');
    const form=formByIndex.get(formIndex);
    const isSubmit=type==='submit';
    if(isSubmit) {submitCount++; if(form) form.submit_count++;}
    if(!FIELDS.has(tag))continue;
    fieldCount++;if(form)form.field_count++;else unownedCount++;
    types[type]=(types[type]||0)+1;
    const required=Object.hasOwn(a,'required')||a['aria-required']==='true';
    const disabled=Object.hasOwn(a,'disabled');
    const labeled=Boolean(a['aria-label']?.trim()||a['aria-labelledby']?.trim()
      ||(a.id && labelsFor.has(a.id))||ancestorWithTag(i,parents,tags,'LABEL')>=0);
    if(required) {requiredCount++;if(form)form.required_count++;}
    if(disabled)disabledCount++;
    if(!labeled && type!=='hidden' && type!=='submit' && type!=='reset' && type!=='button') {
      unlabeledCount++;if(form)form.unlabeled_count++;
    }
    if(fields.length<MAX_FIELDS) {
      const autocomplete=typeof a.autocomplete==='string' ? a.autocomplete.trim().toLowerCase() : '';
      fields.push({selector:structuralSelector(i,parents,tags,siblingPositions),tag:tag.toLowerCase(),
        type,required,disabled,has_label:labeled,
        autocomplete:AUTOCOMPLETE.has(autocomplete)?autocomplete:null,
        form_index:formIndex>=0?forms.findIndex(f=>f.index===formIndex):null});
    }
  }
  return {form_count:forms.length,field_count:fieldCount,required_count:requiredCount,
    disabled_count:disabledCount,unlabeled_candidate_count:unlabeledCount,
    unowned_field_count:unownedCount,submit_count:submitCount,
    by_type:Object.fromEntries(Object.entries(types).sort((a,b)=>b[1]-a[1])),
    forms:forms.slice(0,MAX_FORMS).map(f=>({field_count:f.field_count,
      required_count:f.required_count,unlabeled_candidate_count:f.unlabeled_count,
      submit_count:f.submit_count})), fields,
    frames_omitted:Math.max(0,docs.length-1),
    truncated:total<(nodes.nodeName?.length||0)||fieldCount>MAX_FIELDS||forms.length>MAX_FORMS,
    note:'Native read-only DOMSnapshot; fields have structural selectors, type and label-presence flags only. No input values, raw attributes, names, label text, page text or URLs are returned. Selectors may become stale after re-render. Label candidates are heuristic; only the main frame is inspected.'};
}
export async function inspectFormMap(session) {
  const snapshot=await session.send('DOMSnapshot.captureSnapshot',{
    computedStyles:[],includePaintOrder:false,includeDOMRects:false,
  });
  return {action:'form_map',form_map:summarizeFormMap(snapshot)};
}
