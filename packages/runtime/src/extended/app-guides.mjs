// Human-readable, non-executing action recipes for common desktop workflows.
import { guidedStepNames } from './app-workflow-step-policy.mjs';
// These are NOT autonomous macros: target controls and effects must be verified
// with native Accessibility, browser DOM or app-specific APIs at execution time.
const recipe=(id,title,steps,{safety='review',tools=['ui_snapshot','ui_find','ui_action','wait_for_ui'],note='',source=null}={})=>({
  id,title,execution:'guided',safety,tools,steps,note,...(source?{reference:source}:{}),
});
const inspectWeb=recipe('inspect_web','Inspect the current web application',[
  'Identify the intended browser tab and its current origin via browser_tabs.',
  'Verify the signed-in account/workspace when visibly available, using browser_snapshot rather than guesses.',
  'Use real DOM element roles and labels; do not assume a button remains in the same location across updates.',
],{safety:'read_only',tools:['browser_tabs','browser_snapshot']});
const inspect=recipe('inspect_app','Inspect the current app window',[
  'Call list_windows or ui_snapshot for the actual application and focus state.',
  'Identify the desired native window and controls by their current roles, names and values.',
  'Read the relevant screen state; do not guess control labels or coordinates.',
  'For browser page content prefer browser_snapshot/browser_action over OS chrome.',
],{safety:'read_only',tools:['list_windows','ui_snapshot','browser_snapshot']});
const mail=[
  recipe('find_email','Find an email message',[
    'Open the mail view and inspect the live search field or use the app-specific registered search shortcut.',
    'Enter the requested sender, subject or time range in that visible field.',
    'Wait for results and verify the matching sender, subject and date before opening.',
  ],{safety:'read_only'}),
  recipe('compose_email','Prepare an email draft',[
    'Locate New Message/Compose using the current Accessibility tree or a registered shortcut.',
    'Fill only the requested recipient, subject and body via semantic field targeting.',
    'Verify recipient(s), attachment names, subject and draft text against the request.',
    'Save or leave as a draft. Sending is separate and only permitted when explicitly instructed by the user.',
  ],{note:'Never infer recipient addresses, silently send or bypass account sign-in.'}),
  recipe('email_attachment','Attach a file to a draft',[
    'Locate the currently open draft and inspect recipient/subject before changing it.',
    'Find the Attach control, open the native file picker and select the specified allowed file.',
    'Verify the file name and upload completion in the draft UI.',
    'Do not send the draft as part of attachment handling.',
  ],{note:'Treat attachments and recipients as private data.'}),
];
const messenger=[
  recipe('find_conversation','Find a conversation',[
    'Inspect actual application sidebar and locate the search or switcher control.',
    'Search by the explicitly requested user, group or channel name.',
    'Verify conversation title and participant/context, then open the matching item.',
  ],{safety:'read_only'}),
  recipe('draft_chat','Prepare a chat message',[
    'Locate and verify the intended conversation using the live UI.',
    'Focus the actual message editor and type only the text supplied or approved by the user.',
    'Verify the conversation recipient and message text. Do not press Enter or Send without explicit send intent.',
  ],{note:'Do not send to an ambiguous recipient.'}),
  recipe('share_attachment','Prepare an attachment in chat',[
    'Verify recipient/channel before opening the attachment picker.',
    'Select the user-specified permitted file and inspect the draft attachment preview.',
    'Stop before Send unless the user explicitly asked to send.',
  ]),
];
const meetings=[
  recipe('meeting_join','Join a scheduled call',[
    'Find the meeting from the requested invitation or native calendar UI.',
    'Inspect the join screen and any microphone, camera and screen-sharing status.',
    'Join only with requested microphone/camera choices; never enable screen sharing by guess.',
    'Verify the in-call interface and visible participants.',
  ],{note:'Operating-system camera/microphone consent still applies.'}),
  recipe('meeting_chat','Inspect meeting chat',[
    'Open the actual meeting chat pane via visible UI controls.',
    'Verify the meeting title and context; read only requested content.',
    'Do not post chat messages without explicit send intent.',
  ],{safety:'read_only'}),
];
const browsers=[
  recipe('navigate_site','Navigate to a requested website',[
    'Discover active browser tabs via browser_tabs and select the intended tab.',
    'Navigate only to the user-specified trusted URL using browser tools.',
    'Wait for the actual page to render, then inspect browser_snapshot and verify the site/domain.',
  ],{tools:['browser_tabs','browser_snapshot','browser_action','browser_wait']}),
  recipe('fill_form','Fill an online form',[
    'Inspect live page DOM/Accessibility and match each requested input by label and role.',
    'Enter provided values, then inspect the resulting field values and validation errors.',
    'Do not submit a transaction, payment or public post unless requested explicitly.',
  ],{tools:['browser_snapshot','browser_action','browser_wait']}),
  recipe('download_file','Download a file',[
    'Use the browser DOM to identify the intended download link or button.',
    'Check the target page and filename; trigger only the requested download.',
    'Verify completion and the final path through file tools, not a guessed browser UI state.',
  ],{tools:['browser_snapshot','browser_action','browser_wait','get_file_info']}),
];
const code=[
  recipe('navigate_project','Find code in a project',[
    'Verify the selected repository/workspace and inspect its current branch/status.',
    'Use the IDE Quick Open/search palette where available; prefer find_in_files or code search for exact matching.',
    'Inspect the matching source and dependencies before editing.',
  ],{safety:'read_only',tools:['ui_snapshot','start_search','read_file','start_process']}),
  recipe('edit_source','Edit source code',[
    'Confirm the repository/worktree, changed files and existing user edits.',
    'Prefer deterministic edit_block/apply_patch to unstable coordinate typing.',
    'Run focused tests, inspect diff and verify no unrelated files changed.',
  ],{tools:['read_file','edit_block','apply_patch','start_process']}),
  recipe('debug_project','Debug an application',[
    'Review the reported issue, process logs and active workspace.',
    'Inspect real debugger controls if available; use non-destructive diagnostic commands.',
    'Change only the intended files, reproduce the issue and re-run targeted tests.',
  ],{tools:['ui_snapshot','event_log','start_process','read_file']}),
];
const documents=[
  recipe('create_document','Create or edit a document',[
    'Inspect the open document, confirm its filename and any existing unsaved edits.',
    'Prefer structured local document edit tools for supported formats; otherwise use labeled fields in the app.',
    'Save to the explicitly requested location and verify file content or the resulting document title.',
  ],{tools:['ui_snapshot','read_document','edit_document','get_file_info']}),
  recipe('export_pdf','Export a document as PDF',[
    'Verify the source document and the destination path with the user request.',
    'Open the native Export/Save As dialog using a verified app menu or accessibility control.',
    'Choose PDF if actually offered, export, then verify the resulting file with file tools.',
  ],{note:'Do not overwrite existing files without the user instruction.'}),
  recipe('print_preview','Inspect printing options',[
    'Open the print dialog or preview only; inspect target printer, pages and layout.',
    'Report what is selected and await explicit intent before triggering actual printing.',
  ],{note:'Opening a print dialog is not permission to print.'}),
];
const notes=[
  recipe('create_note','Create a note or task',[
    'Identify the intended notebook/project/account via the actual app UI.',
    'Use a verified New Note/Task control and enter the user-provided title and content.',
    'Check the saved note/task is in the expected location; do not share it automatically.',
  ]),
  recipe('find_note','Find a saved note',[
    'Use the app search UI or its verified quick-open shortcut.',
    'Match the actual result title and content before opening or editing.',
  ],{safety:'read_only'}),
];
const graphics=[
  recipe('open_asset','Open a graphic or design asset',[
    'Locate the actual File/Open UI and select the specified permitted path.',
    'Wait for render/import and verify the canvas/project filename.',
  ]),
  recipe('edit_layers','Edit layers or artwork',[
    'Inspect selected layer, canvas, object and active tool using app UI.',
    'Choose only controls matched by actual Accessibility names; otherwise request a screenshot to locate them.',
    'Apply requested changes and verify the result; preserve the original file when required.',
  ]),
  recipe('export_asset','Export an image/design asset',[
    'Inspect the native export panel and selected artwork/page/artboard.',
    'Set requested dimensions, format and destination from actual app controls.',
    'Export only after verifying options; inspect output file and dimensions.',
  ]),
];
const blender=[
  recipe('blender_search','Search Blender commands',[
    'Focus the real Blender window and identify whether a relevant editor/viewport is active.',
    'Use the registered F3 operator-search shortcut, then find the requested command.',
    'Verify its name before executing; never guess a destructive operation from search results.',
  ],{note:'Blender custom keymaps may differ.',source:'https://docs.blender.org/manual/en/latest/interface/keymap/index.html'}),
  recipe('blender_add_object','Add an object to a Blender scene',[
    'Verify the active scene, object mode, viewport focus and target collection.',
    'Open Blender operator search (F3) or Add menu only when the correct 3D viewport is focused.',
    'Choose the requested mesh/object by visible name, not a hardcoded menu position.',
    'Verify it appears in the Outliner, and save to a requested project path.',
  ],{note:'Do not blindly send Shift+A or Tab without verifying viewport context.'}),
  recipe('blender_render','Render a Blender scene',[
    'Inspect active scene, engine, camera, resolution, output path and selected GPU/CPU configuration.',
    'Start render only when specifically requested; render cost and machine load may be substantial.',
    'Verify render status and resulting image/video using native app state and files.',
  ],{note:'Do not silently overwrite render outputs.'}),
];
const media=[
  recipe('open_media','Open a video or audio project',[
    'Identify app timeline/playlist/file-open control in the current UI.',
    'Open the specifically requested file/project and verify its name and duration.',
  ]),
  recipe('edit_timeline','Edit a video/audio timeline',[
    'Verify selected clip, track, time position and zoom before changing anything.',
    'Use semantic controls/known editor commands where available; otherwise inspect a screenshot.',
    'Check the resulting timeline and avoid overwriting source media.',
  ]),
  recipe('export_media','Export encoded video/audio',[
    'Inspect timeline range, encoder/codec, bitrate, output path and estimated work.',
    'Begin exporting only when explicitly requested and monitor progress/cancellation.',
    'Check final output with file metadata or media probing tools.',
  ]),
];
const security=[
  recipe('security_review','Review security settings',[
    'Inspect the actual policy, app permissions or status page without exposing secrets.',
    'Report findings and proposed changes separately.',
    'Do not disable protections, reveal passwords or alter encryption settings without explicit instruction.',
  ],{safety:'read_only'}),
];
const files=[
  recipe('find_file','Locate a local file',[
    'Use ReMCP file search/read-only inventory first, respecting permitted roots.',
    'Open the requested location in the native file manager only if it improves navigation.',
    'Verify exact path, file type and current folder before actions.',
  ],{safety:'read_only',tools:['list_directory','start_search','get_file_info','ui_snapshot']}),
  recipe('organize_files','Organize files and folders',[
    'Identify source and destination paths and inspect for name collisions or symlinks.',
    'Prefer file-manager native file tools over drag/drop guesses.',
    'Check result and preserve a recovery option for moves/overwrites.',
  ],{tools:['get_file_info','move_file','copy_file','ui_snapshot']}),
];
const sets={
  mail:new Set(['outlook','thunderbird','apple-mail','evolution-mail','geary']),
  meeting:new Set(['zoom','teams','facetime']),
  messaging:new Set(['slack','discord','telegram','signal','whatsapp','viber','wechat','line','kakaotalk','element','mattermost','zulip','rocket-chat','wire','session-messenger','apple-messages','facebook-messenger']),
  ide:new Set(['vscode','vscode-insiders','cursor','windsurf','zed','sublime-text','notepad-plus-plus','visual-studio','intellij','pycharm','webstorm','android-studio','xcode','eclipse','netbeans','clion','rider','goland','datagrip','dbeaver','kate','geany']),
  note:new Set(['notion','obsidian','joplin','evernote','standard-notes','todoist','ticktick','microsoft-todo','onenote','apple-notes','apple-reminders']),
  files:new Set(['google-drive','onedrive','dropbox','nextcloud-desktop','nautilus','dolphin','thunar','double-commander','total-commander','filezilla','winscp','peazip','7zip','7zip','the-unarchiver','winrar']),
  docs:new Set(['word','excel','powerpoint','libreoffice','libreoffice-writer','libreoffice-calc','libreoffice-impress','libreoffice-draw','libreoffice-base','onlyoffice','wps-office','openoffice','pages','numbers','keynote','adobe-acrobat','acrobat-reader','foxit-reader','pdf-expert','preview']),
};
export function appGuidesFor(profile,platform) {
  if (!profile || !profile.targets?.[platform]) return [];
  const id=profile.id;
  if(profile.category==='web') {
    const family=profile.webFamily;
    const guides=[inspectWeb];
    if(family==='mail')guides.push(...mail);
    else if(family==='messaging')guides.push(...messenger);
    else if(family==='meeting')guides.push(...meetings);
    else if(family==='documents')guides.push(...documents);
    else if(family==='notes'||family==='calendar')guides.push(...notes);
    else if(family==='graphics')guides.push(...graphics);
    else if(family==='files')guides.push(...files);
    else if(family==='coding')guides.push(...code);
    else guides.push(...browsers);
    return guides.map(g=>({...g,steps:[...g.steps],safe_steps:guidedStepNames(g.id),
      tools:['browser_tabs','browser_snapshot','browser_action','browser_wait'],
      note:[g.note, 'Web service only: use browser DOM on the verified '+profile.host+' origin, not native desktop shortcuts. Never submit or send without explicit user intent.'].filter(Boolean).join(' ')}));
  }
  const guides=[inspect];
  if (sets.mail.has(id)) guides.push(...mail);
  else if (sets.messaging.has(id)) guides.push(...messenger);
  else if (sets.meeting.has(id)) guides.push(...meetings);
  else if (sets.ide.has(id)) guides.push(...code);
  else if (sets.note.has(id)) guides.push(...notes);
  else if (sets.files.has(id)) guides.push(...files);
  else if (sets.docs.has(id)) guides.push(...documents);
  else if (profile.category==='browsers') guides.push(...browsers);
  else if (id==='blender') guides.push(graphics[0],...blender);
  else if (profile.category==='graphics') guides.push(...graphics);
  else if (profile.category==='media') guides.push(...media);
  else if (profile.category==='security') guides.push(...security);
  else if (profile.category==='office') guides.push(...documents);
  else if (profile.category==='communication') guides.push(...messenger);
  else if (profile.category==='development') guides.push(...code);
  else if (profile.category==='utilities') guides.push(...files);
  // Build fresh outward-facing rows: callers cannot mutate the shared recipes.
  return guides.map(g=>({...g,steps:[...g.steps],tools:[...g.tools],safe_steps:guidedStepNames(g.id)}));
}
export function findAppGuide(profile,platform,guideId) {
  return appGuidesFor(profile,platform).find(x=>x.id===guideId) || null;
}
