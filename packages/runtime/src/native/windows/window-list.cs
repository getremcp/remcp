using System.Collections.Generic;
using System.Text;
using System;using System.Runtime.InteropServices;
public static class RM {
 [StructLayout(LayoutKind.Sequential)] public struct RECT{public int Left,Top,Right,Bottom;}
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
}

public static class RemcpWindowInventory {
 [StructLayout(LayoutKind.Sequential)]
 public struct RECT { public int Left,Top,Right,Bottom; }
 public sealed class Row {
  public long Handle; public int Pid; public string Title;
  public bool Active,Minimized,Maximized;
  public int X,Y,Width,Height;
 }
 private delegate bool EnumCallback(IntPtr hwnd,IntPtr param);
 [DllImport("user32.dll")] private static extern bool EnumWindows(EnumCallback cb,IntPtr param);
 [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
 [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hwnd);
 [DllImport("user32.dll")] private static extern bool IsZoomed(IntPtr hwnd);
 [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd,out RECT rect);
 [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]
 private static extern int GetWindowText(IntPtr hwnd,StringBuilder text,int size);
 public static Row[] Read() {
  var rows=new List<Row>(); int visited=0; bool overflow=false;
  IntPtr foreground=GetForegroundWindow();
  bool complete=EnumWindows((hwnd,param)=>{
   if(++visited>3000){overflow=true;return false;}
   if(!IsWindowVisible(hwnd))return true;
   RECT bounds;
   if(!GetWindowRect(hwnd,out bounds))return true;
   int width=bounds.Right-bounds.Left,height=bounds.Bottom-bounds.Top;
   if(width<=0||height<=0)return true;
   uint owner;
   GetWindowThreadProcessId(hwnd,out owner);
   if(owner==0||owner>int.MaxValue)return true;
   var title=new StringBuilder(513);
   GetWindowText(hwnd,title,title.Capacity);
   rows.Add(new Row{
    Handle=hwnd.ToInt64(),Pid=(int)owner,Title=title.ToString(),
    Active=(hwnd==foreground),Minimized=IsIconic(hwnd),Maximized=IsZoomed(hwnd),
    X=bounds.Left,Y=bounds.Top,Width=width,Height=height
   });
   if(rows.Count>=500){overflow=true;return false;}
   return true;
  },IntPtr.Zero);
  if(overflow||!complete)throw new InvalidOperationException("Windows inventory incomplete or safety bound exceeded");
  return rows.ToArray();
 }
}
