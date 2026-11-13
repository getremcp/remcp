// Allowlisted OS-level GUI navigation. Route names, never caller-provided commands,
// URIs or arguments, determine the operation. Linux panels vary by desktop shell.
const win = {
  settings:['uri','ms-settings:'],
  display:['uri','ms-settings:display'], sound:['uri','ms-settings:sound'],
  network:['uri','ms-settings:network-status'], wifi:['uri','ms-settings:network-wifi'],
  network_advanced:['uri','ms-settings:network-advancedsettings'],
  ethernet:['uri','ms-settings:network-ethernet'], vpn:['uri','ms-settings:network-vpn'],
  proxy:['uri','ms-settings:network-proxy'],
  bluetooth:['uri','ms-settings:bluetooth'], updates:['uri','ms-settings:windowsupdate'],
  storage:['uri','ms-settings:storagesense'], apps:['uri','ms-settings:appsfeatures'],
  storage_recommendations:['uri','ms-settings:storagerecommendations'],
  optional_features:['uri','ms-settings:optionalfeatures'],
  recovery:['uri','ms-settings:recovery'], system_about:['uri','ms-settings:about'],
  developer_settings:['uri','ms-settings:developers'],
  default_apps:['uri','ms-settings:defaultapps'], startup:['uri','ms-settings:startupapps'],
  privacy:['uri','ms-settings:privacy'], camera:['uri','ms-settings:privacy-webcam'],
  microphone:['uri','ms-settings:privacy-microphone'],
  accounts:['uri','ms-settings:accounts'], date_time:['uri','ms-settings:dateandtime'],
  power:['uri','ms-settings:powersleep'], printers:['uri','ms-settings:printers'],
  taskbar:['uri','ms-settings:taskbar'], personalization:['uri','ms-settings:personalization'],
  accessibility:['uri','ms-settings:easeofaccess-display'],
  accessibility_keyboard:['uri','ms-settings:easeofaccess-keyboard'],
  accessibility_mouse:['uri','ms-settings:easeofaccess-mouse'],
  accessibility_narrator:['uri','ms-settings:easeofaccess-narrator'],
  advanced_display:['uri','ms-settings:display-advanced'],
  night_light:['uri','ms-settings:nightlight'],
  sound_devices:['uri','ms-settings:sound-devices'],
  microphone_properties:['uri','ms-settings:sound-defaultinputproperties'],
  notifications:['uri','ms-settings:notifications'],
  remote_desktop:['uri','ms-settings:remotedesktop'],
  clipboard:['uri','ms-settings:clipboard'],
  keyboard:['uri','ms-settings:typing'],
  mouse:['uri','ms-settings:mousetouchpad'],
  security:['uri','windowsdefender:'],
  control_panel:['launch','control.exe'],
  file_manager:['launch','explorer.exe'], task_manager:['launch','Taskmgr.exe'],
  device_manager:['launch','devmgmt.msc'], services:['launch','services.msc'],
  // Windows Start is a shell-level state, not a standalone executable.
  start_menu:['key','CTRL+ESC'],
};
const mac = {
  settings:['launch','System Settings'],
  control_center:['uri','x-apple.systempreferences:com.apple.ControlCenter-Settings.extension'],
  file_manager:['launch','Finder'], task_manager:['launch','Activity Monitor'],
  terminal:['launch','Terminal'], disk_utility:['launch','Disk Utility'],
  app_store:['launch','App Store'], spotlight:['key','CMD+SPACE'],
  // Extension identifiers are version-dependent. Return unverified state after activation.
  display:['uri','x-apple.systempreferences:com.apple.Displays-Settings.extension'],
  network:['uri','x-apple.systempreferences:com.apple.Network-Settings.extension'],
  wifi:['uri','x-apple.systempreferences:com.apple.wifi-settings-extension'],
  bluetooth:['uri','x-apple.systempreferences:com.apple.BluetoothSettings'],
  sound:['uri','x-apple.systempreferences:com.apple.Sound-Settings.extension'],
  updates:['uri','x-apple.systempreferences:com.apple.Software-Update-Settings.extension'],
  privacy:['uri','x-apple.systempreferences:com.apple.preference.security'],
  accessibility:['uri','x-apple.systempreferences:com.apple.Accessibility-Settings.extension'],
  accounts:['uri','x-apple.systempreferences:com.apple.Users-Groups-Settings.extension'],
  power:['uri','x-apple.systempreferences:com.apple.Battery-Settings.extension'],
  printers:['uri','x-apple.systempreferences:com.apple.Print-Scan-Settings.extension'],
  date_time:['uri','x-apple.systempreferences:com.apple.Date-Time-Settings.extension'],
  keyboard:['uri','x-apple.systempreferences:com.apple.Keyboard-Settings.extension'],
  mouse:['uri','x-apple.systempreferences:com.apple.Mouse-Settings.extension'],
  storage:['uri','x-apple.systempreferences:com.apple.settings.Storage'],
  startup:['uri','x-apple.systempreferences:com.apple.LoginItems-Settings.extension'],
};
const gnome = {
  settings:'', display:'display', sound:'sound', network:'network',
  wifi:'wifi', bluetooth:'bluetooth', privacy:'privacy',
  accessibility:'universal-access', apps:'applications', power:'power',
  date_time:'datetime', keyboard:'keyboard', mouse:'mouse',
  accounts:'user-accounts', printers:'printers', background:'background',
  notifications:'notifications', online_accounts:'online-accounts',
  sharing:'sharing', search:'search', default_apps:'default-apps',
  // GNOME panel names vary across versions. Unknown panels remain unavailable.
};
const kde = {
  settings:'', display:'kcm_kscreen', sound:'kcm_pulseaudio',
  network:'kcm_networkmanagement', wifi:'kcm_networkmanagement',
  bluetooth:'bluedevilglobal', keyboard:'kcm_keyboard',
  mouse:'kcm_mouse', power:'powerdevilprofilesconfig',
  apps:'kcm_componentchooser',
  accessibility:'kcm_access', printers:'kcm_printer_manager',
};
const linuxSpecial = {
  file_manager:['chooser',['nautilus','dolphin','thunar','nemo','pcmanfm']],
  task_manager:['chooser',['gnome-system-monitor','plasma-systemmonitor','xfce4-taskmanager']],
  terminal:['chooser',['gnome-terminal','konsole','xfce4-terminal','xterm']],
  app_store:['chooser',['gnome-software','plasma-discover']],
  disks:['chooser',['gnome-disks']],
  settings:['desktop_settings',''],
};
export const SYSTEM_ROUTES = Object.freeze({ win32:win, darwin:mac, linux:linuxSpecial });
export function systemRouteIds(platform = process.platform) {
  if (platform === 'linux') return [...new Set([...Object.keys(gnome),...Object.keys(kde),...Object.keys(linuxSpecial)])].sort();
  return Object.keys(SYSTEM_ROUTES[platform] || {}).sort();
}
export function resolveSystemRoute(destination, platform = process.platform, desktop = '') {
  if (typeof destination !== 'string' || !/^[a-z][a-z0-9_]*$/.test(destination)) return null;
  if (platform !== 'linux') {
    const entry = SYSTEM_ROUTES[platform]?.[destination];
    return entry ? {destination,platform,method:entry[0],value:entry[1]} : null;
  }
  if (destination in linuxSpecial && destination !== 'settings') {
    const entry = linuxSpecial[destination];
    return {destination,platform,method:entry[0],value:entry[1]};
  }
  const isKde = /kde|plasma/i.test(desktop);
  const candidates = isKde ? [['kde',kde],['gnome',gnome]] : [['gnome',gnome],['kde',kde]];
  for (const [shell,routes] of candidates) {
    if (!Object.hasOwn(routes,destination)) continue;
    const panel = routes[destination];
    return {destination,platform,method:'desktop_panel',shell,panel};
  }
  if (destination === 'settings') return {destination,platform,method:'desktop_panel',shell:isKde?'kde':'gnome',panel:''};
  return null;
}
