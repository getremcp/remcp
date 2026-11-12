using System;using System.Runtime.InteropServices;
public static class RMFG{
 [DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();
}
