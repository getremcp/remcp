// Unified application task contract: all inputs are data, never selectors,
// shell commands, scripts, or unscoped keyboard/coordinate instructions.
export const APP_TASK_INTENTS=Object.freeze([
  'open','inspect','find','find_post','focus_control','set_control_text','focus_draft','edit_post',
]);

export function telegramPostReference(value) {
  if(typeof value!=='string'||value.length>256)throw new Error('A Telegram post requires an exact https://t.me/<channel>/<message_id> link');
  let url;
  try{url=new URL(value)}catch{throw new Error('Invalid Telegram post permalink')}
  if(url.protocol!=='https:'||url.hostname.toLowerCase()!=='t.me'||
    url.port||url.username||url.password||url.hash||
    (url.search&&url.search!=='?single'))
    throw new Error('Telegram post must use a plain trusted t.me permalink');
  const path=url.pathname.match(/^\/(?:([a-zA-Z][a-zA-Z0-9_]{3,31})|c\/([1-9]\d{0,18}))\/([1-9]\d{0,15})\/?$/);
  if(!path)throw new Error('Telegram post requires a public channel username or exact private channel and message IDs');
  const channel=path[1]||null;
  const privateChannel=path[2]||null;
  const messageId=path[3];
  const ref='https://t.me/'+(channel||'c/'+privateChannel)+'/'+messageId;
  return {url:ref,channel,private_channel:privateChannel,message_id:messageId};
}

export function validateAppTask(args={}) {
  const intent=String(args.intent||'');
  if(!APP_TASK_INTENTS.includes(intent))throw new Error('Unknown application intent');
  const app=String(args.app||'').trim();
  if(!app||app.length>80||!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(app))
    throw new Error('app must be a registered application id');
  if(args.query!=null && !['find','find_post'].includes(intent))throw new Error('query is only allowed with find/find_post');
  if(['focus_control','set_control_text'].includes(intent)){
    if(!/^local-[a-f0-9]{20}$/.test(app))
      throw new Error('Generic control actions require a discovered local app');
    if(!args.window_id||!Number.isSafeInteger(args.pid)||args.pid<=0)
      throw new Error('Generic control actions require an exact native window ID and PID');
    const printable=(v,max)=>typeof v==='string'&&v.length>0&&v.length<=max&&
      !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(v);
    if(!printable(args.control_id,180)||!printable(args.expected_name,180)||
      !printable(args.expected_role,70))
      throw new Error('Generic control actions require the exact observed ID, name and role');
    if(args.post_url||args.channel||args.query||args.target_id||
      (intent==='focus_control'&&(args.commit||args.replacement_text!=null||
        args.expected_text!=null||args.expected_value_token!=null)))
      throw new Error('Control action accepts only its exact semantic target');
    if(intent==='set_control_text'){
      // A local ValuePattern setter is not a general keystroke or submission
      // interface. One bounded single-line value, with optimistic CAS.
      const bounded=value=>typeof value==='string'&&value.length<=256&&
        !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value);
      const hasText=args.expected_text!=null;
      const hasToken=args.expected_value_token!=null;
      if(hasText===hasToken||
        (hasText&&!bounded(args.expected_text))||
        (hasToken&&(typeof args.expected_value_token!=='string'||
          !/^av1\.\d{10,13}\.[A-Za-z0-9_-]{43}$/.test(args.expected_value_token)))||
        !bounded(args.replacement_text)||!args.replacement_text.trim())
        throw new Error('Text action requires one exact old value or short-lived token, and bounded single-line replacement');
      if(args.commit!==true&&!args.dry_run)
        throw new Error('Text mutation requires explicit commit=true');
    }
  }else if(args.control_id!=null||args.expected_name!=null||args.expected_role!=null)
    throw new Error('Semantic control target is only for explicit local control actions');

  if(args.channel!=null && intent!=='find_post')throw new Error('channel is only allowed with find_post');
  if(args.post_url!=null && intent!=='edit_post')throw new Error('post_url is only allowed for intent=edit_post');
  if(args.replacement_text!=null&&!['edit_post','set_control_text'].includes(intent))throw new Error('replacement_text is only allowed for edit_post');
  if(args.expected_text!=null&&!['edit_post','set_control_text'].includes(intent))throw new Error('expected_text is only allowed for edit_post');
  if(args.expected_value_token!=null&&intent!=='set_control_text')
    throw new Error('expected_value_token is only supported for set_control_text');
  if(args.commit===true&&!['edit_post','set_control_text'].includes(intent))throw new Error('commit is only supported for edit_post');
  if(args.commit===true&&args.dry_run===true)throw new Error('commit and dry_run are mutually exclusive');
  if(args.target_id!=null&&(typeof args.target_id!=='string'||args.target_id.length>128))
    throw new Error('target_id must be a bounded browser target identifier');
  if(args.window_id!=null&&(typeof args.window_id!=='string'||args.window_id.length>180))
    throw new Error('window_id must be a bounded native window identifier');
  if(args.pid!=null&&(!Number.isSafeInteger(args.pid)||args.pid<=0))
    throw new Error('pid must be a positive integer');
  if(intent==='find_post') {
    if(!['telegram','telegram-web'].includes(app))
      throw new Error('find_post requires a registered Telegram application');
    // User-supplied text must remain data, never code or a UI selector.
    if(typeof args.query!=='string'||!args.query.trim()||args.query.length>256||
      /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(args.query))
      throw new Error('find_post requires a single-line 1–256 character query');
    const channel=args.channel==null?null:String(args.channel).replace(/^@/,'');
    if(channel!==null&&!/^[a-zA-Z][a-zA-Z0-9_]{3,31}$/.test(channel))
      throw new Error('channel must be an exact Telegram public username');
    return {intent,app,channel,query_length:args.query.trim().length};
  }
  if(intent!=='edit_post')return {intent,app};
  if(!['telegram','telegram-web'].includes(app))
    throw new Error('The edit_post adapter currently supports only registered Telegram applications');
  const post=args.post_url==null?null:telegramPostReference(args.post_url);
  const replacement=args.replacement_text;
  if(replacement!=null && (typeof replacement!=='string'||!replacement.trim()||
    Array.from(replacement).length>4096||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(replacement)))
    throw new Error('replacement_text must be 1–4096 printable characters; line breaks are allowed');
  if(args.expected_text!=null && (typeof args.expected_text!=='string'||Array.from(args.expected_text).length>4096))
    throw new Error('expected_text must be the exact bounded previously inspected post text');
  if(args.commit===true && (!post||typeof replacement!=='string'||typeof args.expected_text!=='string'))
    throw new Error('Commit requires an exact permalink, replacement_text and expected_text');
  return {intent,app,post,replacement_length:replacement==null?null:Array.from(replacement).length,
    commit:args.commit===true};
}
