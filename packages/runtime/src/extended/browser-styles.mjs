// Scoped, read-only Chrome CSS/box model summary. Filter raw styles locally:
// Never return selector, custom properties, images, text or background URLs.
import { validSelector } from './browser-listeners.mjs';

const ENUMS = {
  display:new Set(['none','block','inline','inline-block','flex','inline-flex','grid','inline-grid','contents','table','table-cell','flow-root','list-item']),
  position:new Set(['static','relative','absolute','fixed','sticky']),
  visibility:new Set(['visible','hidden','collapse']),
  overflowX:new Set(['visible','hidden','clip','scroll','auto']),
  overflowY:new Set(['visible','hidden','clip','scroll','auto']),
  pointerEvents:new Set(['auto','none']),
  boxSizing:new Set(['content-box','border-box']),
  whiteSpace:new Set(['normal','nowrap','pre','pre-wrap','pre-line','break-spaces']),
};
const STYLE_FIELDS = {
  display:'display',position:'position',visibility:'visibility',
  'overflow-x':'overflowX','overflow-y':'overflowY',
  'pointer-events':'pointerEvents','box-sizing':'boxSizing','white-space':'whiteSpace'
};
const LENGTHS=['font-size','line-height','padding-top','padding-right','padding-bottom','padding-left',
  'margin-top','margin-right','margin-bottom','margin-left','width','height'];
function rounded(value) {return Number.isFinite(value) ? Math.round(Math.max(-100000,Math.min(100000,value))*100)/100 : null;}
function lengthPx(value) {
  if(typeof value!=='string')return null;
  const m=/^(-?\d+(?:\.\d+)?)px$/.exec(value.trim());
  return m?rounded(Number(m[1])):null;
}
export function summarizeComputedStyle(raw) {
  const all=new Map((Array.isArray(raw)?raw:[])
    .filter(item=>typeof item?.name==='string'&&typeof item?.value==='string')
    .map(item=>[item.name,item.value]));
  const result={};
  for(const [css,key] of Object.entries(STYLE_FIELDS)) {
    const value=all.get(css);
    if(ENUMS[key].has(value))result[key]=value;
  }
  for(const css of LENGTHS) {
    const value=lengthPx(all.get(css));
    if(value!=null)result[css.replaceAll('-','_')+'_px']=value;
  }
  const opacity=Number(all.get('opacity'));
  if(all.has('opacity')&&Number.isFinite(opacity)&&opacity>=0&&opacity<=1)result.opacity=rounded(opacity);
  const zi=all.get('z-index');
  if(zi==='auto')result.z_index='auto';
  else if(typeof zi==='string'&&/^-?\d+$/.test(zi)) {
    const num=rounded(Number(zi));
    if(num!=null)result.z_index=num;
  }
  return result;
}
function rect(quad) {
  if(!Array.isArray(quad)||quad.length!==8||quad.some(v=>typeof v!=='number'||!Number.isFinite(v)))return null;
  const xs=[quad[0],quad[2],quad[4],quad[6]];
  const ys=[quad[1],quad[3],quad[5],quad[7]];
  const minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
  return {x:rounded(minX),y:rounded(minY),width:rounded(maxX-minX),height:rounded(maxY-minY)};
}
export function summarizeBoxModel(model) {
  if(!model||typeof model!=='object')return null;
  const border=rect(model.border),content=rect(model.content);
  if(!border)return null;
  return {border,content,content_width_px:rounded(model.width),content_height_px:rounded(model.height)};
}
export async function inspectScopedStyles(session,selectorValue) {
  const selector=validSelector(selectorValue,350,true);
  await session.send('DOM.enable');
  try {
    await session.send('CSS.enable');
    const {root}=await session.send('DOM.getDocument',{depth:0,pierce:false});
    if(!Number.isSafeInteger(root?.nodeId)||root.nodeId<=0)throw new Error('CDP document root unavailable');
    const {nodeId}=await session.send('DOM.querySelector',{nodeId:root.nodeId,selector});
    if(!Number.isSafeInteger(nodeId)||nodeId<=0)return {action:'styles',found:false};
    const [styles,box]=await Promise.all([
      session.send('CSS.getComputedStyleForNode',{nodeId}),
      session.send('DOM.getBoxModel',{nodeId}).catch(()=>null)
    ]);
    return {action:'styles',found:true,style:summarizeComputedStyle(styles.computedStyle),
      box:summarizeBoxModel(box?.model),
      note:'Scoped native CSS/box-model audit. Values are limited to allowlisted enums, pixel dimensions and numbers. It excludes raw CSS, selector, background URLs and page text. Border geometry is axis-aligned after transforms; inspect a screenshot only for visual details.'};
  } finally {
    await Promise.allSettled([session.send('CSS.disable'),session.send('DOM.disable')]);
  }
}
