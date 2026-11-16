"""Bounded GStreamer RGB -> PyAV bridge for the isolated WebRTC experiment.

Requires distro gi.repository (Gst 1.0), GStreamer videoconvert/appsink and
PyAV. Supports a synthetic test pattern; a real PipeWire source is accepted
only as an fd and node granted by XDG ScreenCast portal.
"""
import asyncio
import time
from fractions import Fraction

import gi
gi.require_version("Gst", "1.0")
from gi.repository import Gst
from av import VideoFrame

# The default keeps today's bounded 720p CPU/bandwidth envelope. Sharper
# 1080p is an explicit experimental local-worker opt-in, capped at 8 fps to
# avoid an unbounded increase in pixel/encoder work on portable computers.
VIDEO_PROFILES = {"balanced": (1280, 720, 15), "sharp": (1920, 1080, 8)}
WIDTH, HEIGHT, FPS = VIDEO_PROFILES["balanced"]
FRAME_BYTES = WIDTH * HEIGHT * 3
Gst.init(None)


class GstFrameBridge:
    def __init__(self, *, test_pattern=False, fd=None, node_id=None, serial=None,
                 video_profile="balanced"):
        if type(video_profile) is not str or video_profile not in VIDEO_PROFILES:
            raise ValueError("Unsupported bounded capture video profile")
        self.width, self.height, self.fps = VIDEO_PROFILES[video_profile]
        self.frame_bytes = self.width * self.height * 3
        if test_pattern:
            if fd is not None or node_id is not None or serial is not None:
                raise ValueError("Synthetic source cannot use a portal fd")
            head = "videotestsrc is-live=true pattern=ball"
        else:
            if not isinstance(fd, int) or fd < 0:
                raise ValueError("A portal-granted PipeWire fd is required")
            if not isinstance(node_id, int) or not 0 < node_id < 2**32:
                raise ValueError("A portal-granted PipeWire node ID is required")
            if serial is not None and (not isinstance(serial, int) or not 0 < serial < 2**64):
                raise ValueError("Invalid PipeWire serial")
            head = "pipewiresrc name=consented_capture do-timestamp=true"
        self.pipeline = Gst.parse_launch(
            f"{head} ! queue max-size-buffers=2 leaky=downstream ! "
            "videoconvert ! videoscale name=consent_scale add-borders=true ! videorate ! "
            f"video/x-raw,format=RGB,width={self.width},height={self.height},"
            f"framerate={self.fps}/1 ! "
            "appsink name=frame_sink max-buffers=2 drop=true sync=false")
        self.sink = self.pipeline.get_by_name("frame_sink")
        if self.sink is None:
            raise RuntimeError("GStreamer appsink unavailable")
        self.sink.set_property("enable-last-sample", False)
        self._running = False
        self._last_rgb = None
        if not test_pattern:
            source = self.pipeline.get_by_name("consented_capture")
            source.set_property("fd", fd)
            source.set_property("keepalive-time", 250)
            source.set_property("on-disconnect", 2)
            if serial is not None:
                source.set_property("target-object", str(serial))
            else:
                source.set_property("path", str(node_id))

    def start(self):
        if self._running:
            return
        if self.pipeline.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
            self.close()
            raise RuntimeError("GStreamer capture pipeline refused to start")
        self._running = True

    def _sample(self):
        if not self._running:
            raise RuntimeError("Capture is not active")
        # Wayland compositors may emit frames only when a monitor changes.
        # Re-send the last OS-approved pixels at normal WebRTC cadence.
        wait_ns = 10 * Gst.SECOND if self._last_rgb is None else 120 * Gst.MSECOND
        sample = self.sink.emit("try-pull-sample", wait_ns)
        if sample is None:
            message = self.pipeline.get_bus().pop_filtered(
                Gst.MessageType.ERROR | Gst.MessageType.EOS)
            if message and message.type == Gst.MessageType.ERROR:
                error, _debug = message.parse_error()
                raise RuntimeError("GStreamer capture failed: " + str(error))
            if message and message.type == Gst.MessageType.EOS:
                raise RuntimeError("OS capture stream ended")
            if self._last_rgb is None:
                raise RuntimeError("No video frames received from capture source")
        else:
            caps = sample.get_caps().get_structure(0)
            width, height = caps.get_value("width"), caps.get_value("height")
            if (width, height) != (self.width, self.height):
                raise RuntimeError("Unexpected capture frame dimensions")
            buffer = sample.get_buffer()
            mapped, info = buffer.map(Gst.MapFlags.READ)
            if not mapped:
                raise RuntimeError("Cannot map frame")
            try:
                raw = bytes(info.data)
            finally:
                buffer.unmap(info)
            if len(raw) < self.frame_bytes or len(raw) > self.frame_bytes + self.height * 256:
                raise RuntimeError("Invalid or oversized capture buffer")
            stride = len(raw) // self.height
            if stride < self.width * 3 or stride > self.width * 3 + 256:
                raise RuntimeError("Unexpected video stride")
            self._last_rgb = b"".join(
                raw[y * stride:y * stride + self.width * 3] for y in range(self.height))
        frame = VideoFrame(self.width, self.height, format="rgb24")
        plane = frame.planes[0]
        if plane.line_size == self.width * 3:
            plane.update(self._last_rgb)
        else:
            packed = bytearray(plane.buffer_size)
            for y in range(self.height):
                packed[y * plane.line_size:y * plane.line_size + self.width * 3] = (
                    self._last_rgb[y * self.width * 3:(y + 1) * self.width * 3])
            plane.update(bytes(packed))
        return frame

    async def get_frame(self):
        return await asyncio.to_thread(self._sample)

    def close(self):
        self._running = False
        self._last_rgb = None
        self.pipeline.set_state(Gst.State.NULL)


class GstVideoTrack:
    """Wraps a capture bridge as an aiortc VideoStreamTrack without device I/O."""

    def __new__(cls, bridge):
        from aiortc import VideoStreamTrack

        class Track(VideoStreamTrack):
            def __init__(self):
                super().__init__()
                self.started = time.monotonic()
                self.bridge = bridge

            async def recv(self):
                frame = await self.bridge.get_frame()
                frame.pts = int((time.monotonic() - self.started) * 90000)
                frame.time_base = Fraction(1, 90000)
                return frame

        return Track()
