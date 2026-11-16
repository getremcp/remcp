"""Explicit Linux QA-only frames; never selected by a production profile."""
from aiortc import VideoStreamTrack
from av import VideoFrame
WIDTH, HEIGHT = 640, 360

class SyntheticVideoTrack(VideoStreamTrack):
    def __init__(self):
        super().__init__()
        self.frames_sent = 0

    async def recv(self):
        pts, time_base = await self.next_timestamp()
        frame = VideoFrame(width=WIDTH, height=HEIGHT, format="yuv420p")
        self.frames_sent += 1
        brightness = 32 + ((self.frames_sent * 5) % 155)
        frame.planes[0].update(bytes([brightness]) * frame.planes[0].buffer_size)
        frame.planes[1].update(bytes([110]) * frame.planes[1].buffer_size)
        frame.planes[2].update(bytes([180]) * frame.planes[2].buffer_size)
        frame.pts = pts
        frame.time_base = time_base
        return frame

