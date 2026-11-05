import assert from 'node:assert/strict';
import test from 'node:test';
import {resolveLinuxDisplayInventory,displayInventoryAvailable} from
  '../src/extended/desktop-linux-displays.mjs';

const display=[{name:'eDP-1',primary:true,x:0,y:0,width:1440,height:900,
  scale:1,backend:'mutter'}];

test('systemd-managed GNOME session discovers Mutter when graphical env is missing',async()=>{
  const called=[];
  const actual=await resolveLinuxDisplayInventory({
    wayland:false,
    env:{
      DBUS_SESSION_BUS_ADDRESS:'unix:path=/run/user/1000/bus',
      XDG_RUNTIME_DIR:'/run/user/1000',
    },
    mutterProbe:async(opts)=>{called.push(opts);return display;},
    commandExistsFn:()=>false,
  });
  assert.deepEqual(actual,display);
  assert.deepEqual(called,[{allowUnknownSession:true}]);
  assert.equal(await displayInventoryAvailable({
    wayland:false,
    env:{DBUS_SESSION_BUS_ADDRESS:'unix:path=/run/user/1000/bus',
      XDG_RUNTIME_DIR:'/run/user/1000'},
    mutterProbe:async()=>display,
    commandExistsFn:()=>false,
  }),true);
});

test('headless Linux without a session bus must not probe or invent a display',async()=>{
  let mutterCalled=false;
  const actual=await resolveLinuxDisplayInventory({
    wayland:false,
    env:{},
    mutterProbe:async()=>{mutterCalled=true;return display;},
    commandExistsFn:()=>false,
  });
  assert.equal(actual,null);
  assert.equal(mutterCalled,false);
});

test('X11 session still uses real xrandr without a speculative Mutter probe',async()=>{
  let mutterCalled=false;
  const actual=await resolveLinuxDisplayInventory({
    wayland:false,
    env:{DISPLAY:':0',DBUS_SESSION_BUS_ADDRESS:'unix:path=/run/user/1000/bus'},
    mutterProbe:async()=>{mutterCalled=true;return display;},
    commandExistsFn:name=>name==='xrandr',
    runFileFn:async()=>({code:0,stdout:'HDMI-1 connected primary 1920x1080+0+0\n',stderr:''}),
  });
  assert.equal(actual?.[0]?.name,'HDMI-1');
  assert.equal(actual?.[0]?.backend,'xrandr');
  assert.equal(mutterCalled,false);
});

test('explicit Wayland probe remains first choice',async()=>{
  const called=[];
  const actual=await resolveLinuxDisplayInventory({
    wayland:true,
    env:{XDG_SESSION_TYPE:'wayland'},
    mutterProbe:async(opts)=>{called.push(opts);return display;},
    commandExistsFn:()=>false,
  });
  assert.deepEqual(actual,display);
  assert.equal(called.length,1);
});

test('managed display fallback does not override an explicitly selected TTY or X11 session',async()=>{
  for(const type of ['tty','x11']){
    let mutterCalls=0;
    const actual=await resolveLinuxDisplayInventory({
      wayland:false,
      env:{
        XDG_SESSION_TYPE:type,
        DBUS_SESSION_BUS_ADDRESS:'unix:path=/run/user/1000/bus',
        XDG_RUNTIME_DIR:'/run/user/1000',
      },
      mutterProbe:async()=>{
        mutterCalls++;
        return display;
      },
      commandExistsFn:()=>false,
    });
    assert.equal(actual,null,'explicit '+type+' must not inherit a Mutter display');
    assert.equal(mutterCalls,0,'explicit '+type+' must not invoke Mutter');
  }
});
