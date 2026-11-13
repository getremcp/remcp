// Conservative default keybindings. Only reviewed, non-sending routes belong
// here; contextual/destructive workflows belong in app-guides.mjs instead.
// Sources: official VS Code, Slack, Mozilla Thunderbird, Blender, Outlook docs.
const cross=(windows,mac=windows,linux=windows)=>({win32:windows,darwin:mac,linux});
const guiDoc={
  new_document:cross('CTRL+N','CMD+N'),
  open_dialog:cross('CTRL+O','CMD+O'),
  find:cross('CTRL+F','CMD+F'),
};
const email={
  new_message:cross('CTRL+N','CMD+N'),
  search:cross('CTRL+K','CMD+K'),
};
const ide={
  quick_open:cross('CTRL+P','CMD+P'),
  problems:cross('CTRL+SHIFT+M','CMD+SHIFT+M'),
  debug_view:cross('CTRL+SHIFT+D','CMD+SHIFT+D'),
  go_to_symbol:cross('CTRL+SHIFT+O','CMD+SHIFT+O'),
  go_to_line:cross('CTRL+G','CTRL+G'),
};
const chromium={
  new_window:cross('CTRL+N','CMD+N'),
  reopen_tab:cross('CTRL+SHIFT+T','CMD+SHIFT+T'),
  bookmarks:cross('CTRL+SHIFT+O','CMD+OPTION+B'),
};
const overrides={
  vscode:ide,'vscode-insiders':ide,
  chrome:chromium,chromium,edge:chromium,brave:chromium,
  blender:{
    operator_search:cross('F3','F3'),
    open_dialog:cross('CTRL+O','CTRL+O'),
    save_as_dialog:cross('CTRL+SHIFT+S','CTRL+SHIFT+S'),
    // Viewport-specific "add", "edit mode" and transformations require
    // semantic context and are provided as guided, NOT blind shortcuts.
  },
  gimp:{new_document:cross('CTRL+N','CMD+N'),layers_dialog:cross('CTRL+L','CMD+L')},
  inkscape:{export_panel:cross('CTRL+SHIFT+E','CTRL+SHIFT+E')},
  photoshop:{new_document:cross('CTRL+N','CMD+N'),preferences:{win32:'CTRL+K',darwin:'CMD+K'}},
  'thunderbird':{
    new_message:email.new_message,
    quick_filter:cross('CTRL+SHIFT+K','CMD+SHIFT+K'),
    search:email.search,
  },
  outlook:{
    new_message:{win32:'CTRL+SHIFT+M',darwin:'CMD+N'},
    calendar:{win32:'CTRL+2'},
  },
  'apple-mail':{new_message:{darwin:'CMD+N'}},
  'evolution-mail':{new_message:{linux:'CTRL+N'}},
  slack:{
    compose:cross('CTRL+N','CMD+N'),
    search:cross('CTRL+G','CMD+G'),
    dm_list:cross('CTRL+SHIFT+2','CMD+SHIFT+K'),
  },
  discord:{switcher:cross('CTRL+K','CMD+K')},
  audacity:guiDoc, krita:guiDoc,
  'libreoffice-impress':guiDoc,'libreoffice-draw':guiDoc,
  'libreoffice-base':guiDoc,
  'apple-notes':{new_note:{darwin:'CMD+N'}},
  'apple-calendar':{new_event:{darwin:'CMD+N'}},
  'apple-reminders':{new_reminder:{darwin:'CMD+N'}},
  'nautilus':{location:{linux:'CTRL+L'},new_tab:{linux:'CTRL+T'}},
  'dolphin':{location:{linux:'CTRL+L'},new_tab:{linux:'CTRL+T'}},
  'thunar':{location:{linux:'CTRL+L'},new_tab:{linux:'CTRL+T'}},
  'preview':{find:{darwin:'CMD+F'},open_dialog:{darwin:'CMD+O'}},
  'obsidian':{command_palette:cross('CTRL+P','CMD+P'),quick_open:cross('CTRL+O','CMD+O')},
};
export function getAppRouteOverrides(appId){return overrides[appId] || {};}
