// Owner-authorized remote desktop control uses the existing authenticated
// device RPC channel, independent of the video-only WebRTC SDP. No OS
// permission dialog is created here: device pairing grants persistent access.
// Never accept a raw tool name or arguments from an untrusted browser.
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&
  Object.getPrototypeOf(value)===Object.prototype;
const exact=(o,keys)=>Object.keys(o).length===keys.length&&
  keys.every(k=>Object.hasOwn(o,k));
const number=(v,min,max)=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max;
const seq=v=>Number.isSafeInteger(v)&&v>=1&&v<=2_147_483_647;
const text=v=>typeof v==='string'&&v.length<=4_096&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);
const clipboardText=v=>typeof v==='string'&&v.length<=65_536&&
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)&&new TextEncoder().encode(v).length<=65_536;
const shortcut=v=>typeof v==='string'&&v.length>=1&&v.length<=64&&
  /^[A-Za-z0-9+_-]+$/.test(v);
const coord=v=>number(v,0,1);
const knownButtons=new Set(['left','right','middle']);
const knownPointer=new Set(['move','click','double_click','right_click']);
export function parseWebRtcControlInput(o){
  if(!plain(o)||!seq(o.seq))return null;
  if(o.kind==='pointer'){
    if(!knownPointer.has(o.op)||!coord(o.x)||!coord(o.y))return null;
    const keys=o.op==='move'?['seq','kind','op','x','y']:
      ['seq','kind','op','x','y','button',...(o.click_count===undefined?[]:['click_count'])];
    if(o.click_count!==undefined&&(o.op!=='click'||![1,2].includes(o.click_count)))return null;
    if(!exact(o,keys))return null;
    if(o.op!=='move'&&!knownButtons.has(o.button))return null;
    if(o.op==='right_click'&&o.button!=='right')return null;
    return {...o};
  }
  if(o.kind==='drag'){
    if(!exact(o,['seq','kind','from_x','from_y','to_x','to_y','button'])||
       !coord(o.from_x)||!coord(o.from_y)||!coord(o.to_x)||!coord(o.to_y)||
       !knownButtons.has(o.button))return null;
    return {...o};
  }
  if(o.kind==='keyboard'){
    if(!exact(o,['seq','kind','shortcut'])||!shortcut(o.shortcut))return null;
    return {...o};
  }
  if(o.kind==='text'){
    if(!exact(o,['seq','kind','text'])||!text(o.text)||o.text.length===0)return null;
    return {...o};
  }
  if(o.kind==='scroll'){
    if(!exact(o,['seq','kind','dx','dy','x','y'])||
       !number(o.dx,-1_200,1_200)||!number(o.dy,-1_200,1_200)||
       !coord(o.x)||!coord(o.y))return null;
    return {...o};
  }
  if(o.kind==='clipboard'){
    if(o.op==='read'||o.op==='clear'){
      if(!exact(o,['seq','kind','op']))return null;
    }else if(o.op==='write'){
      if(!exact(o,['seq','kind','op','text'])||!clipboardText(o.text))return null;
    }else return null;
    return {...o};
  }
  return null;
}
export function primaryDisplay(displays){
  if(!Array.isArray(displays)||displays.length>32)return null;
  const d=displays.find(v=>v?.primary===true);
  if(!plain(d)||!number(d.x,-100_000,100_000)||!number(d.y,-100_000,100_000)||
     !number(d.width,1,16_384)||!number(d.height,1,16_384)||
     !Number.isInteger(d.x)||!Number.isInteger(d.y)||
     !Number.isInteger(d.width)||!Number.isInteger(d.height))return null;
  return {x:d.x,y:d.y,width:d.width,height:d.height};
}
export function toDeviceTool(input,display){
  if(!input)return null;
  if(input.kind==='keyboard')return {name:'keyboard',arguments:{shortcut:input.shortcut}};
  if(input.kind==='text')return {name:'type_text',arguments:{text:input.text,method:'auto'}};
  if(input.kind==='clipboard')return {name:'clipboard',arguments:{
    action:input.op,...(input.op==='write'?{text:input.text}:{})}};
  if(!display)return null;
  const x=display.x+Math.round(input.x*(display.width-1));
  const y=display.y+Math.round(input.y*(display.height-1));
  if(input.kind==='drag')return {name:'drag_drop',arguments:{
    from_x:display.x+Math.round(input.from_x*(display.width-1)),
    from_y:display.y+Math.round(input.from_y*(display.height-1)),
    to_x:display.x+Math.round(input.to_x*(display.width-1)),
    to_y:display.y+Math.round(input.to_y*(display.height-1)),
    button:input.button,hold_ms:120,duration_ms:160,
  }};
  if(input.kind==='pointer')return {name:'pointer',arguments:{
    action:input.op,x,y,...(input.op!=='move'?{button:input.button}:{}),
    ...(input.click_count===undefined?{}:{click_count:input.click_count})}};
  if(input.kind==='scroll')return {name:'scroll',arguments:{
    delta_x:input.dx,delta_y:input.dy,x,y}};
  return null;
}
export const REQUIRED_CONTROL_TOOLS=Object.freeze([
  'desktop_webrtc_control','pointer','drag_drop','keyboard','scroll',
  'type_text','clipboard','display_inventory',
]);
