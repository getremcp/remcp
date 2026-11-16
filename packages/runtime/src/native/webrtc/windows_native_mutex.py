"""Windows owner-session native WebRTC worker singleton.

A kernel mutex is held until process exit, including crashes. The Local
namespace scopes it to the interactive desktop session, and the default
process-token DACL is used. There is no lock file or remotely supplied name.
"""
import ctypes
from contextlib import contextmanager

MUTEX_NAME = r"Local\ReMCP-WebRTC-NativeScreenWorker"
ERROR_ALREADY_EXISTS = 183


@contextmanager
def exclusive_windows_capture(*, kernel=None, last_error=None):
    if kernel is None:
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.CreateMutexW.argtypes = [
            ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p]
        kernel.CreateMutexW.restype = ctypes.c_void_p
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        kernel.CloseHandle.restype = ctypes.c_int
    if last_error is None:
        last_error = ctypes.get_last_error
    handle = kernel.CreateMutexW(None, False, MUTEX_NAME)
    if not handle:
        raise PermissionError("native_screen_worker_unavailable")
    try:
        if last_error() == ERROR_ALREADY_EXISTS:
            raise PermissionError("native_screen_worker_busy")
        yield
    finally:
        kernel.CloseHandle(handle)
