using System;
using System.Runtime.InteropServices;
public static class RMAcc {
 [DllImport("oleacc.dll")]
 public static extern int AccessibleObjectFromWindow(IntPtr hwnd,uint dwId,ref Guid riid,[MarshalAs(UnmanagedType.Interface)] out object ppvObject);
 public static object FromWindow(IntPtr hwnd) {
  Guid iid=new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");
  object value=null;
  int hr=AccessibleObjectFromWindow(hwnd,0xFFFFFFFCu,ref iid,out value);
  if(hr<0) Marshal.ThrowExceptionForHR(hr);
  return value;
 }
}
