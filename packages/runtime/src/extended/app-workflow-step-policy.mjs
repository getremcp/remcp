// Exact, allowlisted first steps inside known application guides.
// Never interpret user text as a program, selector, keyboard shortcut or click.
// Destructive actions, sending, payment and publishing are intentionally absent.
const rules = {
  compose_email: {
    open_compose:{ action:'invoke', roles:['button','menuitem'],
      names:['Compose','New message','New email','New mail','Write','Napisz','Nowa wiadomość','Написать','Новое письмо','Створити лист'] },
  },
  find_email: {
    set_search_query:{action:'set_query',roles:['searchbox','searchfield','textbox','textfield','entry','edit','text field','text'],
      names:['Search','Search in mail','Search mail','Search messages','Search emails','Search all mail','Szukaj','Szukaj w poczcie','Поиск','Поиск по почте','Пошук','Пошук у пошті']},
    focus_search:{ action:'focus', roles:['searchbox','searchfield','textbox','textfield','entry','edit','text field','text'],
      names:['Search','Search in mail','Search mail','Search messages','Search emails','Search all mail',
        'Szukaj','Szukaj w poczcie','Поиск','Поиск по почте','Пошук','Пошук у пошті'] },
  },
  find_conversation: {
    set_search_query:{action:'set_query',roles:['searchbox','searchfield','textbox','textfield','entry','edit','text field','text'],
      names:['Search','Search chats','Search conversations','Search messages','Find conversations','Szukaj','Поиск','Пошук']},
    focus_search:{ action:'focus', roles:['searchbox','searchfield','textbox','textfield','entry','edit','text field','text'],
      names:['Search','Search chats','Search conversations','Search messages','Find conversations',
        'Szukaj','Поиск','Пошук'] },
  },
  find_note: {
    set_search_query:{action:'set_query',roles:['searchbox','searchfield','textbox','textfield','entry','edit','text field','text'],
      names:['Search','Search notes','Find notes','Search text field','Szukaj','Поиск','Поиск заметок','Пошук']},
    focus_search:{ action:'focus', roles:['searchbox','searchfield','textbox','textfield','entry','edit','text field','text'],
      names:['Search','Search notes','Find notes','Search text field','Szukaj','Поиск','Поиск заметок','Пошук'] },
  },
  draft_chat: {
    focus_message:{ action:'focus', roles:['textbox','textfield','entry','edit','text field','text'],
      names:['Message','Type a message','Write a message','Message…','Message...',
        'Wpisz wiadomość','Сообщение','Напишите сообщение','Повідомлення','Напишіть повідомлення'] },
  },
};
const normalized = value => String(value||'').normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase('en-US');
export function guidedStepPolicy(guide,step) {
  if (typeof guide!=='string'||typeof step!=='string')return null;
  const policy=rules[guide]?.[step];
  return policy?{guide,step,action:policy.action,
    names:[...policy.names],roles:[...policy.roles]}:null;
}
export function guidedStepNames(guide) { return Object.keys(rules[guide]||{}); }
export function validateGuidedQuery(args,policy) {
  const needsQuery=policy?.action==='set_query';
  if (!needsQuery && args?.query!=null) throw new Error('query is only permitted with set_search_query');
  if (!needsQuery) return null;
  if (typeof args?.query!=='string') throw new Error('set_search_query requires a string query');
  const query=args.query.trim();
  // Never issue keyboard Enter, form submit or JS evaluate from untrusted text.
  // Reject multiline, control, bidi override and very large user input.
  if (!query || query.length>256 || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(query))
    throw new Error('Search query must be 1–256 single-line printable characters');
  return query;
}
export function chooseGuidedControl(controls,policy) {
  if (!policy) return {ok:false,reason:'unsupported_step'};
  const source=Array.isArray(controls)?controls:[];
  const validNames=new Set(policy.names.map(normalized));
  const roles=new Set(policy.roles);
  const candidates=source.filter(x=>
    x && x.enabled!==false && x.disabled!==true &&
    !x.password && !x.hidden && !x.offscreen &&
    validNames.has(normalized(x.name)) && roles.has(normalized(x.role)) &&
    !/password|secret|token|otp|recovery|passwd|api.?key/i.test(String(x.name||''))
  );
  if(candidates.length===0)return {ok:false,reason:'control_not_found'};
  if(candidates.length!==1)return {ok:false,reason:'ambiguous_controls',
    count:candidates.length};
  const candidate=candidates[0];
  return {ok:true,control:{
    name:String(candidate.name),role:String(candidate.role),
    ...(candidate.id?{id:String(candidate.id)}:{}),
    ...(candidate.selector?{selector:String(candidate.selector)}:{}),
  }};
}
export function guidedStepCatalog() {
  return Object.fromEntries(Object.keys(rules).map(guide=>[guide,guidedStepNames(guide)]));
}
