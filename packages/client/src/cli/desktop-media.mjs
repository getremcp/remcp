import {desktopMediaEnvironment,installDesktopMedia} from './desktop-media-install.mjs';
export {desktopMediaEnvironment,installDesktopMedia} from './desktop-media-install.mjs';
import {configDir} from './env.mjs';
import {loadConfig,saveConfig} from './config.mjs';
import {restartPersistentServiceIfInstalled} from './service.mjs';
import {localRuntimeEntry} from '../agent-update.mjs';

export async function manageDesktopMedia(action='status',flags={}){
  const cfg=loadConfig();
  if(action==='status'){
    const env=desktopMediaEnvironment(cfg.desktopMedia,localRuntimeEntry(cfg.runtime));
    console.log(JSON.stringify({enabled:cfg.desktopMedia?.enabled===true,available:Boolean(env.REMCP_WEBRTC_WORKER_SCRIPT),
      screenPermission:'Granted separately by the OS at capture time'},null,2));return;
  }
  if(action==='off'){
    saveConfig({...cfg,desktopMedia:{...cfg.desktopMedia,enabled:false}});
    restartPersistentServiceIfInstalled(cfg,{deferLinux:true,deferWindows:true});return;
  }
  if(action!=='install')throw new Error('Usage: remcp desktop [status|install --python <absolute path>|off]');
  const profile=await installDesktopMedia({python:flags.python,runtimeEntry:localRuntimeEntry(cfg.runtime),directory:configDir});
  const latest=loadConfig();
  if(latest.deviceId!==cfg.deviceId||latest.deviceToken!==cfg.deviceToken)throw new Error('Pairing changed during media installation');
  saveConfig({...latest,desktopMedia:profile});
  console.log('Optional screen media installed. Capture still requires explicit Start and OS permission.');
  restartPersistentServiceIfInstalled(latest,{deferLinux:true,deferWindows:true});
}
