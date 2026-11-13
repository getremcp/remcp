// ReMCP application adapters: static, allowlisted launch targets and in-app navigation.
// A profile never executes arbitrary user-provided paths, commands or key sequences.
import { EXTRA_APP_PROFILES } from './app-profile-expansions.mjs';
import { getAppRouteOverrides } from './app-action-routes.mjs';
const both = (win, mac = win, linux = win) => ({win32:win, darwin:mac, linux});
const editor = {
  explorer:both('CTRL+SHIFT+E','CMD+SHIFT+E'),
  search:both('CTRL+SHIFT+F','CMD+SHIFT+F'),
  source_control:both('CTRL+SHIFT+G','CMD+SHIFT+G'),
  extensions:both('CTRL+SHIFT+X','CMD+SHIFT+X'),
  command_palette:both('CTRL+SHIFT+P','CMD+SHIFT+P'),
  settings:both('CTRL+,','CMD+,'),
  terminal:both('CTRL+`','CTRL+`'),
};
const document = {
  new_document:both('CTRL+N','CMD+N'),
  open_dialog:both('CTRL+O','CMD+O'),
  find:both('CTRL+F','CMD+F'),
  print_dialog:both('CTRL+P','CMD+P'),
};
const browser = {
  new_tab:both('CTRL+T','CMD+T'),
  address_bar:both('CTRL+L','CMD+L'),
  find:both('CTRL+F','CMD+F'),
  history:both('CTRL+H','CMD+Y'),
};
const mainBrowser = { ...browser, downloads:{win32:'CTRL+J',linux:'CTRL+J',darwin:'CMD+SHIFT+J'} };
function app(id,category,aliases,targets,processes={},routes={},launchArgs={}) {
  return { id, category, aliases, targets, processes, routes, launchArgs };
}

export const APP_PROFILES = Object.freeze([
  // Developer tools
  app('vscode','development',['VS Code','Visual Studio Code'],both('Visual Studio Code','Visual Studio Code','code'),
    both(['code','Code'],['Visual Studio Code','Code'],['code']),editor),
  app('vscode-insiders','development',['VS Code Insiders','Visual Studio Code Insiders'],
    both('Visual Studio Code - Insiders','Visual Studio Code - Insiders','code-insiders'),
    both(['code-insiders'],['Visual Studio Code - Insiders'],['code-insiders']),editor),
  app('visual-studio','development',['Visual Studio'],{win32:'Visual Studio'}, {win32:['devenv']},
    {search:{win32:'CTRL+Q'},solution_explorer:{win32:'CTRL+ALT+L'}}),
  app('intellij','development',['IntelliJ IDEA','IntelliJ'],both('IntelliJ IDEA','IntelliJ IDEA','idea'),
    both(['idea64','idea'],['IntelliJ IDEA'],['idea']),{find:both('CTRL+F','CMD+F')}),
  app('pycharm','development',['PyCharm'],both('PyCharm','PyCharm','pycharm'),
    both(['pycharm64','pycharm'],['PyCharm'],['pycharm']),{find:both('CTRL+F','CMD+F')}),
  app('webstorm','development',['WebStorm'],both('WebStorm','WebStorm','webstorm'),
    both(['webstorm64','webstorm'],['WebStorm'],['webstorm']),{find:both('CTRL+F','CMD+F')}),
  app('android-studio','development',['Android Studio'],both('Android Studio','Android Studio','android-studio'),
    both(['studio64','studio'],['Android Studio'],['studio']),{find:both('CTRL+F','CMD+F')}),
  app('postman','development',['Postman'],both('Postman','Postman','postman'),
    both(['Postman'],['Postman'],['postman'])),
  app('github-desktop','development',['GitHub Desktop'],{win32:'GitHub Desktop',darwin:'GitHub Desktop'},
    {win32:['GitHubDesktop'],darwin:['GitHub Desktop']}),
  // Browsers
  app('chrome','browsers',['Chrome','Google Chrome'],both('Google Chrome','Google Chrome','google-chrome'),
    both(['chrome'],['Google Chrome'],['chrome','google-chrome']),mainBrowser),
  app('chromium','browsers',['Chromium'],both('Chromium','Chromium','chromium'),
    both(['chromium'],['Chromium'],['chromium']),mainBrowser),
  app('firefox','browsers',['Firefox','Mozilla Firefox'],both('Firefox','Firefox','firefox'),
    both(['firefox'],['Firefox'],['firefox']),browser),
  app('edge','browsers',['Microsoft Edge','Edge'],both('Microsoft Edge','Microsoft Edge','microsoft-edge'),
    both(['msedge'],['Microsoft Edge'],['msedge','microsoft-edge']),mainBrowser),
  app('brave','browsers',['Brave','Brave Browser'],both('Brave','Brave Browser','brave-browser'),
    both(['brave'],['Brave Browser'],['brave-browser']),mainBrowser),
  app('opera','browsers',['Opera'],both('Opera','Opera','opera'),
    both(['opera'],['Opera'],['opera']),browser),
  app('safari','browsers',['Safari'],{darwin:'Safari'},{darwin:['Safari']},browser),
  // Office / productivity
  app('word','office',['Microsoft Word','Word'],{win32:'Microsoft Word',darwin:'Microsoft Word'},
    {win32:['WINWORD'],darwin:['Microsoft Word']},document),
  app('excel','office',['Microsoft Excel','Excel'],{win32:'Microsoft Excel',darwin:'Microsoft Excel'},
    {win32:['EXCEL'],darwin:['Microsoft Excel']},document),
  app('powerpoint','office',['Microsoft PowerPoint','PowerPoint'],{win32:'Microsoft PowerPoint',darwin:'Microsoft PowerPoint'},
    {win32:['POWERPNT'],darwin:['Microsoft PowerPoint']},document),
  app('onenote','office',['OneNote','Microsoft OneNote'],{win32:'OneNote',darwin:'Microsoft OneNote'},
    {win32:['ONENOTE'],darwin:['Microsoft OneNote']},{find:both('CTRL+F','CMD+F')}),
  app('outlook','office',['Microsoft Outlook','Outlook'],{win32:'Outlook',darwin:'Microsoft Outlook'},
    {win32:['OUTLOOK'],darwin:['Microsoft Outlook']},{search:both('CTRL+E','CMD+OPTION+F')}),
  app('libreoffice','office',['LibreOffice'],both('LibreOffice','LibreOffice','libreoffice'),
    both(['soffice','libreoffice'],['LibreOffice'],['soffice','libreoffice']),document),
  app('libreoffice-writer','office',['LibreOffice Writer'],both('LibreOffice Writer','LibreOffice','libreoffice'),
    both(['soffice'],['LibreOffice'],['soffice']),document,{linux:['--writer'],darwin:['--writer']}),
  app('libreoffice-calc','office',['LibreOffice Calc'],both('LibreOffice Calc','LibreOffice','libreoffice'),
    both(['soffice'],['LibreOffice'],['soffice']),document,{linux:['--calc'],darwin:['--calc']}),
  app('onlyoffice','office',['ONLYOFFICE','ONLYOFFICE Desktop Editors'],
    both('ONLYOFFICE Desktop Editors','ONLYOFFICE','onlyoffice-desktopeditors'),
    both(['DesktopEditors'],['ONLYOFFICE'],['DesktopEditors']),document),
  app('pages','office',['Pages','Apple Pages'],{darwin:'Pages'},{darwin:['Pages']},
    {find:{darwin:'CMD+F'},new_document:{darwin:'CMD+N'}}),
  app('numbers','office',['Numbers','Apple Numbers'],{darwin:'Numbers'},{darwin:['Numbers']},
    {find:{darwin:'CMD+F'},new_document:{darwin:'CMD+N'}}),
  app('keynote','office',['Keynote','Apple Keynote'],{darwin:'Keynote'},{darwin:['Keynote']},
    {new_document:{darwin:'CMD+N'}}),
  // Communication
  app('slack','communication',['Slack'],both('Slack','Slack','slack'),both(['slack'],['Slack'],['slack']),
    {switcher:both('CTRL+K','CMD+K')}),
  app('discord','communication',['Discord'],both('Discord','Discord','discord'),
    both(['Discord'],['Discord'],['discord']),{switcher:both('CTRL+K','CMD+K')}),
  app('telegram','communication',['Telegram','Telegram Desktop'],both('Telegram Desktop','Telegram','telegram-desktop'),
    both(['Telegram'],['Telegram'],['telegram-desktop']),{search:both('CTRL+F','CMD+F')}),
  app('teams','communication',['Microsoft Teams','Teams'],both('Microsoft Teams','Microsoft Teams','teams'),
    both(['ms-teams','Teams'],['Microsoft Teams'],['teams']),{search:both('CTRL+E','CMD+E')}),
  app('zoom','communication',['Zoom','Zoom Workplace'],both('Zoom Workplace','zoom.us','zoom'),
    both(['Zoom'],['zoom.us'],['zoom'])),
  app('thunderbird','communication',['Thunderbird','Mozilla Thunderbird'],both('Thunderbird','Thunderbird','thunderbird'),
    both(['thunderbird'],['Thunderbird'],['thunderbird']),{search:both('CTRL+K','CMD+K')}),
  app('signal','communication',['Signal','Signal Desktop'],both('Signal','Signal','signal-desktop'),
    both(['Signal'],['Signal'],['signal-desktop'])),
  // Media
  app('vlc','media',['VLC','VLC media player'],both('VLC media player','VLC','vlc'),
    both(['vlc'],['VLC'],['vlc']),{playlist:{win32:'CTRL+L',linux:'CTRL+L'},open_dialog:both('CTRL+O','CMD+O'),preferences:{win32:'CTRL+P',linux:'CTRL+P'}}),
  app('spotify','media',['Spotify'],both('Spotify','Spotify','spotify'),both(['Spotify'],['Spotify'],['spotify']),
    {search:{win32:'CTRL+L',linux:'CTRL+L'}}),
  app('obs','media',['OBS','OBS Studio'],both('OBS Studio','OBS','obs'),
    both(['obs64','obs'],['OBS'],['obs'])),
  app('mpv','media',['mpv'],{linux:'mpv',darwin:'mpv',win32:'mpv'},{linux:['mpv'],darwin:['mpv'],win32:['mpv']}),
  app('apple-music','media',['Apple Music','Music'],{darwin:'Music',win32:'Apple Music'},
    {darwin:['Music'],win32:['AppleMusic']}),
  app('quicktime','media',['QuickTime Player'],{darwin:'QuickTime Player'},{darwin:['QuickTime Player']},
    {open_dialog:{darwin:'CMD+O'}}),
  app('apple-photos','media',['Apple Photos','Photos'],{darwin:'Photos'},{darwin:['Photos']}),
  // Graphics, design and utilities
  app('gimp','graphics',['GIMP','GNU Image Manipulation Program'],both('GIMP','GIMP','gimp'),
    both(['gimp'],['GIMP'],['gimp']),{open_dialog:both('CTRL+O','CMD+O')}),
  app('inkscape','graphics',['Inkscape'],both('Inkscape','Inkscape','inkscape'),
    both(['inkscape'],['Inkscape'],['inkscape']),document),
  app('blender','graphics',['Blender'],both('Blender','Blender','blender'),
    both(['blender'],['Blender'],['blender'])),
  app('photoshop','graphics',['Adobe Photoshop','Photoshop'],{win32:'Adobe Photoshop',darwin:'Adobe Photoshop'},
    {win32:['Photoshop'],darwin:['Adobe Photoshop']},{open_dialog:both('CTRL+O','CMD+O')}),
  app('figma','graphics',['Figma'],{win32:'Figma',darwin:'Figma',linux:'figma-linux'},
    {win32:['Figma'],darwin:['Figma'],linux:['figma-linux']}),
  app('notepad-plus-plus','utilities',['Notepad++'],{win32:'Notepad++'},
    {win32:['notepad++']},{find:{win32:'CTRL+F'},new_document:{win32:'CTRL+N'}}),
  app('calculator','utilities',['Calculator','GNOME Calculator'],both('Calculator','Calculator','gnome-calculator'),
    both(['Calculator'],['Calculator'],['gnome-calculator'])),
  app('7zip','utilities',['7-Zip File Manager'],{win32:'7-Zip File Manager'},{win32:['7zFM']}),
  app('terminal','utilities',['Terminal','GNOME Terminal'],{darwin:'Terminal',linux:'gnome-terminal',win32:'Windows Terminal'},
    {darwin:['Terminal'],linux:['gnome-terminal'],win32:['WindowsTerminal']}),
  ...EXTRA_APP_PROFILES,
].map(profile => ({...profile,routes:{...profile.routes,...getAppRouteOverrides(profile.id)}})));

const byId = new Map(), byAlias = new Map();
for (const profile of APP_PROFILES) {
  if (byId.has(profile.id)) throw new Error(`Duplicate application id ${profile.id}`);
  byId.set(profile.id, profile);
  for (const raw of [profile.id,...profile.aliases]) {
    const key = raw.trim().toLowerCase();
    const existing = byAlias.get(key);
    if (existing && existing.id !== profile.id) throw new Error(`Ambiguous application alias: ${raw}`);
    byAlias.set(key,profile);
  }
}
export function findAppProfile(name) {
  return typeof name === 'string' ? byAlias.get(name.trim().toLowerCase()) || null : null;
}
export function resolveAppLaunchAlias(requested, platform = process.platform) {
  if (typeof requested !== 'string') return null;
  const name = requested.trim();
  if (!name || /[\\/]/.test(name) || name.startsWith('.')) return null;
  const profile = findAppProfile(name);
  const target = profile?.targets?.[platform];
  if (!target) return null;
  const extra = profile.launchArgs[platform];
  return { id:profile.id, requested:name, target, ...(extra?.length ? {args:[...extra]} : {}) };
}
export function listAppProfiles(platform = process.platform, category = null) {
  return APP_PROFILES.filter(x => x.targets[platform] && (!category || x.category === category)).map(x => ({
    id:x.id, category:x.category, name:x.aliases[0],
    destinations:['launch',...Object.keys(x.routes).filter(key => x.routes[key]?.[platform])],
  }));
}
