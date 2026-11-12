using System;using System.Runtime.InteropServices;
public static class RMDisplay{
 [StructLayout(LayoutKind.Sequential)]public struct POINT{public int X;public int Y;public POINT(int x,int y){X=x;Y=y;}}
 [DllImport("user32.dll")]public static extern uint GetDpiForSystem();
 [DllImport("user32.dll")]public static extern IntPtr MonitorFromPoint(POINT pt,uint flags);
 [DllImport("Shcore.dll")]public static extern int GetDpiForMonitor(IntPtr monitor,int type,out uint x,out uint y);
 public static uint DpiAt(int x,int y){
  uint fallback=GetDpiForSystem();
  try{IntPtr h=MonitorFromPoint(new POINT(x,y),2);uint dx,dy;if(h!=IntPtr.Zero&&GetDpiForMonitor(h,0,out dx,out dy)==0&&dx>0)return dx;}catch{}
  return fallback;
 }
}
