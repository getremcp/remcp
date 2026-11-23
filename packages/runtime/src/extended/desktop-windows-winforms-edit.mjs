// Narrow, audited Win32 bridge for UIA Pane-backed WinForms EDIT controls.
// Never fall back to keystrokes, coordinates, clipboard or arbitrary HWNDs.
export const winFormsEditInterop = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class RMWinFormsEdit {
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int index);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  static extern int GetClassName(IntPtr h, StringBuilder text, int capacity);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="SendMessageTimeoutW")]
  static extern IntPtr MsgNumber(IntPtr h,uint msg,IntPtr wp,IntPtr lp,
    uint flags,uint timeout,out IntPtr result);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="SendMessageTimeoutW")]
  static extern IntPtr MsgGet(IntPtr h,uint msg,IntPtr wp,StringBuilder lp,
    uint flags,uint timeout,out IntPtr result);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="SendMessageTimeoutW")]
  static extern IntPtr MsgSet(IntPtr h,uint msg,IntPtr wp,string lp,
    uint flags,uint timeout,out IntPtr result);

  // Root HWND, process owner, actual native class and edit-style must match
  // the fresh UI Automation element. Unknown properties always reject.
  public static bool IsOrdinary(IntPtr edit,IntPtr root,uint owner,
      string reportedClass,bool uiaPassword) {
    if(uiaPassword||edit==IntPtr.Zero||root==IntPtr.Zero||
       !IsWindow(edit)||!IsWindow(root)||string.IsNullOrEmpty(reportedClass))
      return false;
    var cls=new StringBuilder(256);
    if(GetClassName(edit,cls,cls.Capacity)==0||
       !cls.ToString().Equals(reportedClass,StringComparison.Ordinal)||
       !reportedClass.StartsWith("WindowsForms10.EDIT.",StringComparison.Ordinal))
      return false;
    uint pid;
    GetWindowThreadProcessId(edit,out pid);
    if(pid!=owner||GetAncestor(edit,2)!=root) return false;
    int style=GetWindowLong(edit,-16);
    // ES_PASSWORD, WS_DISABLED, WS_CHILD respectively.
    return style!=0&&(style&0x20)==0&&(style&0x08000000)==0&&
      (style&0x40000000)!=0;
  }

  public static bool Writable(IntPtr edit){
    return IsWindow(edit)&&(GetWindowLong(edit,-16)&0x800)==0; // ES_READONLY
  }

  // Never read arbitrary amounts of text, or return text to the caller's
  // JSON action result. The host application remains the source of truth.
  public static string Read(IntPtr edit){
    if(!IsWindow(edit)) return null;
    IntPtr len;
    if(MsgNumber(edit,0x000E,IntPtr.Zero,IntPtr.Zero,2,400,out len)
       ==IntPtr.Zero||len.ToInt64()<0||len.ToInt64()>256) return null;
    var text=new StringBuilder((int)len+2);
    IntPtr result;
    if(MsgGet(edit,0x000D,(IntPtr)text.Capacity,text,2,400,out result)
       ==IntPtr.Zero) return null;
    return text.ToString();
  }

  public static bool Write(IntPtr edit,IntPtr root,uint owner,
      string reportedClass,bool uiaPassword,string expected,string value){
    // Re-validate identity and optimistic CAS in the same call that writes.
    if(!IsOrdinary(edit,root,owner,reportedClass,uiaPassword)||
       !Writable(edit)||expected==null||
       !string.Equals(Read(edit),expected,StringComparison.Ordinal)||
       string.IsNullOrEmpty(value)||value.Length>256) return false;
    foreach(char c in value)
      if(c<32||c==127||c==0x202A||c==0x202B||c==0x202C||
         c==0x202D||c==0x202E||c>=0x2066&&c<=0x2069)
        return false;
    IntPtr result;
    return MsgSet(edit,0x000C,IntPtr.Zero,value,2,400,out result)
       !=IntPtr.Zero && result!=IntPtr.Zero;
  }
}
'@
`;
