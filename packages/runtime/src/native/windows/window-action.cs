using System;using System.Runtime.InteropServices;
public static class RM {
 [StructLayout(LayoutKind.Sequential)] public struct RECT{public int Left,Top,Right,Bottom;}
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int c);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,IntPtr p);
 [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from,uint to,bool attach);
 [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
 [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int cx,int cy,uint flags);
 [DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int pid);
 [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int h2,bool r);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
 public static bool FocusWindow(IntPtr h){
  uint current=GetCurrentThreadId(),target=GetWindowThreadProcessId(h,IntPtr.Zero);
  IntPtr fg=GetForegroundWindow();uint foreground=fg==IntPtr.Zero?0:GetWindowThreadProcessId(fg,IntPtr.Zero);
  bool attachTarget=false,attachForeground=false;
  try{
   if(target!=0&&current!=target)attachTarget=AttachThreadInput(current,target,true);
   if(foreground!=0&&current!=foreground&&foreground!=target)attachForeground=AttachThreadInput(current,foreground,true);
   ShowWindow(h,9);AllowSetForegroundWindow(-1);BringWindowToTop(h);
   // HWND_TOP preserves the window's existing topmost status.
   SetWindowPos(h,IntPtr.Zero,0,0,0,0,0x0001|0x0002|0x0010|0x0040);
   return SetForegroundWindow(h);
  }finally{
   if(attachForeground)AttachThreadInput(current,foreground,false);
   if(attachTarget)AttachThreadInput(current,target,false);
  }
 }
}
