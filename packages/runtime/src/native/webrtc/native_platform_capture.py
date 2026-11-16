"""Fail-closed, in-process macOS/Windows desktop capture for aiortc.

FFmpeg/PyAV is loaded inside the isolated stdio worker. No OS permission
bypass, external capture process, camera, microphone or user-selected input.
The single user-approved desktop is the only permitted native media source.
"""
import ctypes
import sys

from aiortc import VideoStreamTrack


def native_source_allowed(source, platform=None):
    target = platform or sys.platform
    return ((target == "darwin" and source == "avfoundation")
            or (target == "win32" and source == "gdigrab"))


def native_permission_granted(platform=None, *, mac_framework=None,
                              windows_kernel=None, windows_user32=None):
    """Preflight native consent/session without prompting or capturing pixels."""
    target = platform or sys.platform
    if target == "darwin":
        try:
            framework = mac_framework or ctypes.CDLL(
                "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
            method = framework.CGPreflightScreenCaptureAccess
            try:
                method.restype = ctypes.c_bool
            except AttributeError:
                pass  # Python test double, not a ctypes function.
            return bool(method())
        except (OSError, AttributeError, ValueError):
            return False
    if target == "win32":
        try:
            kernel = windows_kernel or ctypes.WinDLL("kernel32", use_last_error=True)
            active = kernel.WTSGetActiveConsoleSessionId()
            process_id = kernel.GetCurrentProcessId()
            session_id = ctypes.c_ulong(0)
            ok = kernel.ProcessIdToSessionId(process_id, ctypes.byref(session_id))
            if (not ok or session_id.value == 0 or
                    session_id.value != active or active == 0xFFFFFFFF):
                return False
            if windows_kernel is not None and windows_user32 is None:
                return True  # Pure session checker in injected unit tests.
            from ctypes import wintypes
            user32 = windows_user32 or ctypes.WinDLL("user32", use_last_error=True)
            if windows_user32 is None:
                user32.OpenInputDesktop.argtypes = [
                    wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
                user32.OpenInputDesktop.restype = wintypes.HANDLE
                user32.CloseDesktop.argtypes = [wintypes.HANDLE]
                user32.CloseDesktop.restype = wintypes.BOOL
                user32.GetUserObjectInformationW.argtypes = [
                    wintypes.HANDLE, wintypes.INT, ctypes.c_void_p,
                    wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
                user32.GetUserObjectInformationW.restype = wintypes.BOOL
            desktop = user32.OpenInputDesktop(0, False, 0x0001)
            if not desktop:
                return False
            try:
                # Screen capture must never follow UAC/lock-screen desktops.
                name = ctypes.create_unicode_buffer(64)
                required = wintypes.DWORD(0)
                if not user32.GetUserObjectInformationW(
                        desktop, 2, name, ctypes.sizeof(name),
                        ctypes.byref(required)):
                    return False
                return name.value.casefold() == "default"
            finally:
                user32.CloseDesktop(desktop)
        except (OSError, AttributeError, ValueError):
            return False
    return False


def bound_video_frame(frame, max_width=1280, max_height=800):
    """Reduce encoded screen area without distorting its native aspect ratio."""
    factor = min(1.0, max_width / frame.width, max_height / frame.height)
    if factor >= 1.0:
        return frame
    width = max(2, (int(frame.width * factor) // 2) * 2)
    height = max(2, (int(frame.height * factor) // 2) * 2)
    resized = frame.reformat(width=width, height=height, format="yuv420p")
    resized.pts = frame.pts
    resized.time_base = frame.time_base
    return resized


class PermissionGuardedDesktopTrack(VideoStreamTrack):
    """Per-frame native screen permission guard around an aiortc video track.

    Rechecks the interactive Windows desktop (or macOS screen entitlement)
    before touching the source, and after awaiting the native frame. If a lock
    or revocation happens while FFmpeg is blocked reading pixels, no sampled
    frame can proceed to the encoder after that observed revocation.
    """

    def __init__(self, source_track, platform, permission_check=native_permission_granted):
        super().__init__()
        self.source_track = source_track
        self.platform = platform
        self.permission_check = permission_check

    def require_permission(self):
        try:
            granted = bool(self.permission_check(self.platform))
        except Exception:
            granted = False
        if not granted:
            self.stop()
            raise PermissionError("native_screen_permission_revoked")

    async def recv(self):
        self.require_permission()
        frame = await self.source_track.recv()
        self.require_permission()
        return bound_video_frame(frame)

    def stop(self):
        super().stop()
        if self.source_track is not None:
            source, self.source_track = self.source_track, None
            source.stop()


class NativeDesktopCapture:
    """One trusted screen source and stoppable aiortc MediaPlayer video track."""

    def __init__(self, source, *, platform=None, media_player_cls=None,
                 permission_check=native_permission_granted):
        target = platform or sys.platform
        if not native_source_allowed(source, target):
            raise ValueError("invalid_native_screen_source")
        if not permission_check(target):
            raise PermissionError("native_screen_permission_or_session_unavailable")
        real_media_player = media_player_cls is None
        if real_media_player:
            from aiortc.contrib.media import MediaPlayer
            media_player_cls = MediaPlayer
        if source == "avfoundation":
            input_name = "Capture screen 0:none"
            options = {"framerate": "6", "pixel_format": "nv12"}
        else:
            input_name = "desktop"
            options = {"framerate": "6", "draw_mouse": "1"}
        self.player = media_player_cls(input_name, format=source, options=options)
        raw_track = getattr(self.player, "video", None)
        if raw_track is None:
            raise RuntimeError("native_video_track_unavailable")
        if getattr(self.player, "audio", None) is not None:
            raw_track.stop()
            self.player.audio.stop()
            raise RuntimeError("native_audio_track_forbidden")
        if real_media_player:
            self.track = PermissionGuardedDesktopTrack(
                raw_track, target, permission_check=permission_check)
        else:
            self.track = raw_track

    def close(self):
        if self.track is not None:
            track, self.track = self.track, None
            track.stop()
