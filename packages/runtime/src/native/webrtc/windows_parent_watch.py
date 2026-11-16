"""Win32 fail-closed lifecycle watch for the ReMCP native screen worker.

No custom DLL, driver or executable: ctypes calls Windows kernel32. When
the originating *Node agent* process exits, the private native worker exits
immediately, releasing MediaPlayer/FFmpeg, mutex and DTLS keys. Unlike a
PyInstaller onefile bootstrapper, the Node agent PID is the actual owner.
This mitigates agent crashes but is not a Windows Job Object guarantee.
"""
from contextlib import contextmanager
import ctypes
import os
import re
import sys
import threading

SYNCHRONIZE = 0x00100000
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
WAIT_OBJECT_0 = 0
WAIT_TIMEOUT = 0x102
WAIT_FAILED = 0xFFFFFFFF
MAX_PARENT_PID = 0xFFFFFFFF


def parse_agent_pid(env):
    value = env.get("REMCP_WEBRTC_AGENT_PID")
    if not isinstance(value, str) or not re.fullmatch(r"[1-9][0-9]{0,9}", value):
        raise PermissionError("trusted_agent_pid_required")
    pid = int(value)
    if not 4 <= pid <= MAX_PARENT_PID:
        raise PermissionError("trusted_agent_pid_required")
    return pid


class WindowsProcessAPI:
    """Narrow, strongly typed OS handle wrapper; never accepts arbitrary PID."""

    def __init__(self):
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = (ctypes.c_ulong, ctypes.c_int,
                                       ctypes.c_ulong)
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.GetProcessId.argtypes = (ctypes.c_void_p,)
        kernel.GetProcessId.restype = ctypes.c_ulong
        kernel.WaitForSingleObject.argtypes = (ctypes.c_void_p, ctypes.c_ulong)
        kernel.WaitForSingleObject.restype = ctypes.c_ulong
        kernel.CloseHandle.argtypes = (ctypes.c_void_p,)
        kernel.CloseHandle.restype = ctypes.c_int
        self.kernel = kernel

    def open(self, pid):
        return self.kernel.OpenProcess(
            SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, False, pid)

    def pid(self, handle):
        return self.kernel.GetProcessId(handle)

    def wait(self, handle, milliseconds):
        return self.kernel.WaitForSingleObject(handle, milliseconds)

    def close(self, handle):
        self.kernel.CloseHandle(handle)


@contextmanager
def guard_agent_process(env=None, platform=None, api=None,
                        exit_process=os._exit):
    """Open the Node process handle and watch for its kernel exit.

    Must be acquired *before* opening native screen pixels. Windows PID is
    provided exclusively by the trusted bridge, never by an incoming RPC.
    Missing/dead/inaccessible parent fails closed. The watchdog sleeps inside
    the Windows kernel for up to 500 ms per check, not a polling shell.
    """
    target = sys.platform if platform is None else platform
    if target != "win32":
        yield
        return
    variables = os.environ if env is None else env
    parent_pid = parse_agent_pid(variables)
    api = WindowsProcessAPI() if api is None else api
    handle = api.open(parent_pid)
    if not handle:
        raise PermissionError("trusted_agent_process_unavailable")
    stop = threading.Event()
    monitor = None
    try:
        if api.pid(handle) != parent_pid or api.wait(handle, 0) != WAIT_TIMEOUT:
            raise PermissionError("trusted_agent_process_unavailable")

        def watch():
            while not stop.is_set():
                outcome = api.wait(handle, 500)
                if stop.is_set():
                    return
                if outcome != WAIT_TIMEOUT:
                    # Any dead/unqueryable parent immediately revokes media.
                    # os._exit terminates Python and its FFmpeg threads.
                    exit_process(92)
                    return

        monitor = threading.Thread(
            target=watch, name="remcp-webrtc-agent-lifetime", daemon=True)
        monitor.start()
        yield
    finally:
        stop.set()
        if monitor is not None:
            monitor.join(timeout=2)
        api.close(handle)
