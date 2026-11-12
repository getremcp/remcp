using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public sealed class ReMcpOwnedJob : IDisposable {
  [StructLayout(LayoutKind.Sequential)] struct Limits {
    public long ProcessTime, JobTime; public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveLimit;
    public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct Io {
    public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public Limits Basic; public Io Counters;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
    public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
  }
  [StructLayout(LayoutKind.Sequential)] struct Startup {
    public uint Size; public IntPtr Reserved, Desktop, Title;
    public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
    public ushort Show, ReservedSize; public IntPtr ReservedData, In, Out, Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct StartupEx {
    public Startup Basic; public IntPtr Attributes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
    public IntPtr Process, Thread; public uint Pid, Tid;
  }
  [StructLayout(LayoutKind.Sequential)] struct Security {
    public int Size; public IntPtr Descriptor;
    [MarshalAs(UnmanagedType.Bool)] public bool Inherit;
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr security, IntPtr name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, uint size, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr key, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupEx startup, out ProcessInfo info);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFileW(string name, uint access, uint share, ref Security security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  IntPtr job, process;
  int stop;
  static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static void Close(IntPtr handle) { if (handle != IntPtr.Zero && handle != new IntPtr(-1)) CloseHandle(handle); }
  public ReMcpOwnedJob() {
    job = CreateJobObjectW(IntPtr.Zero, IntPtr.Zero);
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      var limits = new ExtendedLimits();
      limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE; no breakaway allowed.
      Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)));
    } catch { Dispose(); throw; }
  }
  public uint Start(string application, string command, string cwd, string log) {
    var security = new Security { Size=Marshal.SizeOf(typeof(Security)), Inherit=true };
    IntPtr output=IntPtr.Zero, input=IntPtr.Zero, list=IntPtr.Zero, handles=IntPtr.Zero, jobs=IntPtr.Zero;
    bool initialized = false;
    try {
      output = CreateFileW(log, 4, 7, ref security, 4, 0x80, IntPtr.Zero); // append, OPEN_ALWAYS
      Check(output != new IntPtr(-1));
      input = CreateFileW("NUL", 0x80000000, 7, ref security, 3, 0x80, IntPtr.Zero);
      Check(input != new IntPtr(-1));
      IntPtr size = IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
      Check(size != IntPtr.Zero);
      list = Marshal.AllocHGlobal(size);
      Check(InitializeProcThreadAttributeList(list, 2, 0, ref size)); initialized = true;
      handles = Marshal.AllocHGlobal(IntPtr.Size * 2);
      Marshal.WriteIntPtr(handles, input); Marshal.WriteIntPtr(handles, IntPtr.Size, output);
      Check(UpdateProcThreadAttribute(list, 0, new IntPtr(0x20002), handles, new IntPtr(IntPtr.Size * 2), IntPtr.Zero, IntPtr.Zero));
      jobs = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobs, job);
      Check(UpdateProcThreadAttribute(list, 0, new IntPtr(0x2000D), jobs, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
      var startup = new StartupEx();
      startup.Basic.Size = (uint)Marshal.SizeOf(startup);
      startup.Basic.Flags = 0x100; // STARTF_USESTDHANDLES
      startup.Basic.In = input; startup.Basic.Out = output; startup.Basic.Error = output;
      startup.Attributes = list;
      ProcessInfo info;
      // JOB_LIST attaches before execution, avoiding a suspended-but-unassigned orphan window.
      Check(CreateProcessW(application, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero,
        true, 0x08080000, IntPtr.Zero, cwd, ref startup, out info));
      process = info.Process; Close(info.Thread);
      return info.Pid;
    } finally {
      if (initialized) DeleteProcThreadAttributeList(list);
      if (list != IntPtr.Zero) Marshal.FreeHGlobal(list);
      if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
      if (jobs != IntPtr.Zero) Marshal.FreeHGlobal(jobs);
      Close(input); Close(output);
    }
  }
  public uint Wait() {
    var reader = new Thread(() => {
      // EOF is ownership loss: only Node owns the write end of this private pipe.
      try { Console.ReadLine(); } catch { } finally { Interlocked.Exchange(ref stop, 1); }
    });
    reader.IsBackground = true; reader.Start();
    while (Volatile.Read(ref stop) == 0) {
      uint state = WaitForSingleObject(process, 50);
      if (state == 0) break;
      if (state != 258) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    Check(TerminateJobObject(job, 1));
    var timer = Stopwatch.StartNew();
    while (true) {
      Accounting info;
      Check(QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
      if (info.ActiveProcesses == 0) break;
      if (timer.ElapsedMilliseconds >= 7000) throw new TimeoutException("Owned job did not become empty");
      Thread.Sleep(20);
    }
    uint code; Check(GetExitCodeProcess(process, out code)); return code;
  }
  public void Dispose() { Close(job); job=IntPtr.Zero; Close(process); process=IntPtr.Zero; }
}
