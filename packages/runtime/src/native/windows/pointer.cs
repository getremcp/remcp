using System;
using System.Runtime.InteropServices;

public static class RMMouse {
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,int d,UIntPtr i);

 // The worker must never inject into Winlogon/UAC or a different console.
 [DllImport("kernel32.dll")] private static extern uint GetCurrentProcessId();
 [DllImport("kernel32.dll")] private static extern uint WTSGetActiveConsoleSessionId();
 [DllImport("kernel32.dll")] private static extern bool ProcessIdToSessionId(uint id,out uint session);
 [DllImport("user32.dll",SetLastError=true)] private static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
 [DllImport("user32.dll")] private static extern bool CloseDesktop(IntPtr desktop);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
 private static extern bool GetUserObjectInformation(IntPtr handle,int index,System.Text.StringBuilder value,uint size,out uint needed);
 public static bool InteractiveDesktop() {
  uint session,active=WTSGetActiveConsoleSessionId();
  if(active==0||active==0xffffffff||!ProcessIdToSessionId(GetCurrentProcessId(),out session)||session!=active)return false;
  IntPtr desktop=OpenInputDesktop(0,false,1);
  if(desktop==IntPtr.Zero)return false;
  try {
   var name=new System.Text.StringBuilder(128);
   uint needed;
   return GetUserObjectInformation(desktop,2,name,(uint)(name.Capacity*2),out needed)
    && String.Equals(name.ToString(),"Default",StringComparison.OrdinalIgnoreCase);
  } finally {CloseDesktop(desktop);}
 }

 [StructLayout(LayoutKind.Sequential)] private struct MOUSEINPUT {
  public int dx,dy; public uint mouseData,dwFlags,time; public UIntPtr extra;
 }
 [StructLayout(LayoutKind.Sequential)] private struct KEYBDINPUT {
  public ushort vk,scan; public uint flags,time; public UIntPtr extra;
 }
 [StructLayout(LayoutKind.Sequential)] private struct HARDWAREINPUT {
  public uint message; public ushort low,high;
 }
 [StructLayout(LayoutKind.Explicit)] private struct INPUTUNION {
  [FieldOffset(0)] public MOUSEINPUT mouse;
  [FieldOffset(0)] public KEYBDINPUT keyboard;
  [FieldOffset(0)] public HARDWAREINPUT hardware;
 }
 [StructLayout(LayoutKind.Sequential)] private struct INPUT {
  public uint type; public INPUTUNION value;
 }
 [DllImport("user32.dll",SetLastError=true)]
 private static extern uint SendInput(uint count,INPUT[] inputs,int size);

 private static INPUT Key(ushort vk,ushort scan,uint flags) {
  INPUT input=new INPUT();
  input.type=1;
  input.value.keyboard.vk=vk;
  input.value.keyboard.scan=scan;
  input.value.keyboard.flags=flags;
  return input;
 }
 private static uint Extended(int vk) {
  return (vk>=0x21 && vk<=0x28) || vk==0x2d || vk==0x2e ? 1u : 0u;
 }
 private static uint Deliver(INPUT[] inputs) {
  return SendInput((uint)inputs.Length,inputs,Marshal.SizeOf(typeof(INPUT)));
 }

 private static INPUT Mouse(uint flag,int delta) {
  INPUT input=new INPUT();
  input.type=0;input.value.mouse.dwFlags=flag;input.value.mouse.mouseData=unchecked((uint)delta);
  return input;
 }
 public static bool SendMouseFlag(uint flag,int delta) {
  if(flag!=2&&flag!=4&&flag!=8&&flag!=16&&flag!=32&&flag!=64&&flag!=0x800&&flag!=0x1000)return false;
  if((flag==0x800||flag==0x1000)?(delta < -1200||delta > 1200):delta!=0)return false;
  return Deliver(new INPUT[]{Mouse(flag,delta)})==1;
 }
 public static bool SendMouseClick(uint down,uint up) {
  if(!((down==2&&up==4)||(down==8&&up==16)||(down==32&&up==64)))return false;
  uint sent=Deliver(new INPUT[]{Mouse(down,0),Mouse(up,0)});
  if(sent==1)Deliver(new INPUT[]{Mouse(up,0)});
  return sent==2;
 }

 // Send only Unicode keyboard events; no clipboard access or script evaluation.
 public static bool SendUnicodeText(string text) {
  if(String.IsNullOrEmpty(text)||text.Length>4096)return false;
  INPUT[] inputs=new INPUT[text.Length*2];
  for(int i=0;i<text.Length;i++){
   inputs[i*2]=Key(0,text[i],4);
   inputs[i*2+1]=Key(0,text[i],6);
  }
  uint sent=Deliver(inputs);
  if(sent==(uint)inputs.Length)return true;
  // Never replay partially accepted text. Best-effort release a pending key.
  if((sent&1u)!=0 && sent<(uint)inputs.Length)
   Deliver(new INPUT[]{inputs[(int)sent]});
  return false;
 }

 // The caller supplies only reviewed virtual key codes, not a SendKeys program.
 public static bool SendKeyChord(int[] keys) {
  if(keys==null||keys.Length<1||keys.Length>4)return false;
  INPUT[] inputs=new INPUT[keys.Length*2];
  for(int i=0;i<keys.Length;i++){
   int key=keys[i];
   if(key<1||key>255)return false;
   for(int j=0;j<i;j++)if(keys[j]==key)return false;
   inputs[i]=Key((ushort)key,0,Extended(key));
   inputs[inputs.Length-1-i]=Key((ushort)key,0,Extended(key)|2u);
  }
  uint sent=Deliver(inputs);
  if(sent==(uint)inputs.Length)return true;
  // Avoid leaving a modifier held if Windows accepted only part of the chord.
  int down=(int)Math.Min(sent,(uint)keys.Length);
  int released=sent>(uint)keys.Length?(int)sent-keys.Length:0;
  int remaining=down-released;
  if(remaining>0){
   INPUT[] ups=new INPUT[remaining];
   for(int i=0;i<remaining;i++){
    int key=keys[remaining-1-i];
    ups[i]=Key((ushort)key,0,Extended(key)|2u);
   }
   Deliver(ups);
  }
  return false;
 }
}
