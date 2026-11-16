"""Owner-local X11 capture; no remote display, shell command or image files."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from fractions import Fraction
import os
from pathlib import Path
import re
import stat
import time

from aiortc import VideoStreamTrack
import av


def x11_owner_display(env=None, uid=None):
    """Require the logged-in owner's local X server and private authority file."""
    env = os.environ if env is None else env
    uid = os.getuid() if uid is None else uid
    if env.get("WAYLAND_DISPLAY") or env.get("XDG_SESSION_TYPE") == "wayland":
        return None
    display = env.get("DISPLAY", "")
    if not re.fullmatch(r":[0-9]{1,3}(?:\.[0-9]{1,2})?", display):
        return None
    authority = env.get("XAUTHORITY") or str(Path(env.get("HOME", "")) / ".Xauthority")
    try:
        path = Path(authority)
        info = path.lstat()
        if (not path.is_absolute() or not stat.S_ISREG(info.st_mode)
                or info.st_uid != uid or info.st_mode & 0o077):
            return None
    except (OSError, ValueError):
        return None
    return display


def bounded_primary_monitor(monitor):
    keys = ("left", "top", "width", "height")
    if not isinstance(monitor, dict) or any(type(monitor.get(k)) is not int for k in keys):
        raise ValueError("invalid_x11_monitor")
    region = {k: monitor[k] for k in keys}
    if (not -100000 <= region["left"] <= 100000
            or not -100000 <= region["top"] <= 100000
            or not 1 <= region["width"] <= 8192
            or not 1 <= region["height"] <= 8192
            or region["width"] * region["height"] > 8388608):
        raise ValueError("x11_monitor_exceeds_capture_limit")
    return region


class X11VideoTrack(VideoStreamTrack):
    """Six fps, one native connection owned and closed on one capture thread."""

    def __init__(self, *, display=None, factory=None):
        super().__init__()
        self.display = display or x11_owner_display()
        if not self.display:
            raise PermissionError("x11_owner_display_unavailable")
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="remcp-x11")
        self.capture = None
        self.region = None
        self.deadline = 0
        self.pts = 0
        self.closed = False
        try:
            self.pool.submit(self._open, factory).result(timeout=5)
        except BaseException:
            self.stop()
            raise

    def _open(self, factory):
        if factory is None:
            from mss import MSS
            factory = MSS
        self.capture = factory(display=self.display, with_cursor=True)
        self.region = bounded_primary_monitor(self.capture.primary_monitor)

    def _grab(self):
        if self.closed or self.capture is None:
            raise RuntimeError("x11_capture_stopped")
        # Re-read the primary geometry: resolution changes cannot silently map
        # input against a stale monitor or produce unbounded pixel buffers.
        self.region = bounded_primary_monitor(self.capture.primary_monitor)
        image = self.capture.grab(self.region)
        width, height = self.region["width"], self.region["height"]
        raw = image.bgra
        if image.width != width or image.height != height or len(raw) != width * height * 4:
            raise ValueError("invalid_x11_frame")
        frame = av.VideoFrame(width=width, height=height, format="bgra")
        plane = frame.planes[0]
        if plane.line_size == width * 4:
            plane.update(raw)
        else:
            padded = bytearray(plane.buffer_size)
            row_bytes = width * 4
            for row in range(height):
                padded[row * plane.line_size:row * plane.line_size + row_bytes] = raw[row * row_bytes:(row + 1) * row_bytes]
            plane.update(padded)
        return frame

    async def recv(self):
        if self.closed:
            raise RuntimeError("x11_capture_stopped")
        await asyncio.sleep(max(0, self.deadline - time.monotonic()))
        self.deadline = time.monotonic() + 1 / 6
        frame = await asyncio.get_running_loop().run_in_executor(self.pool, self._grab)
        if self.closed:
            raise RuntimeError("x11_capture_stopped")
        frame.pts, frame.time_base = self.pts, Fraction(1, 90000)
        self.pts += 15000
        return frame

    def _close(self):
        capture, self.capture = self.capture, None
        if capture is not None:
            capture.close()

    def stop(self):
        if self.closed:
            return
        self.closed = True
        super().stop()
        # Queue native cleanup behind the last grab; the Node Stop fence still
        # waits for this worker process to exit before acknowledging Stop.
        self.pool.submit(self._close)
        self.pool.shutdown(wait=False, cancel_futures=False)
