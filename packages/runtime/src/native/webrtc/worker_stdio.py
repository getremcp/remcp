#!/usr/bin/env python3
"""Opt-in local aiortc screen worker for one ReMCP device session.

Only newline-delimited JSON on stdin/stdout. No listener, no HTTP, no
automatic OS permission bypass. On Linux, portal mode uses GNOME's
ScreenCast consent and PipeWire frames. Synthetic is QA-only.
"""
import argparse
import asyncio
from contextlib import contextmanager
try:
    import fcntl
except ImportError:  # Windows uses a process-held local kernel mutex.
    fcntl = None
import json
import logging
import os
import re
import stat
import sys
import time

from native_platform_capture import NativeDesktopCapture, native_source_allowed
from windows_parent_watch import guard_agent_process
from aiortc import RTCConfiguration, RTCIceServer, RTCPeerConnection, RTCSessionDescription
from session_lease import ViewerLease, NEGOTIATION_SECONDS
from synthetic_track import SyntheticVideoTrack

LOG = logging.getLogger("remcp-webrtc-worker")
SESSION_ID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\Z", re.I)
MAX_LINE = 70_000
MAX_SDP = 60_000
NATIVE_LOCK_NAME = "remcp-webrtc-native-worker.lock"
NATIVE_ICE_NAME = "remcp-webrtc-turn.json"
MAX_NATIVE_ICE_BYTES = 4096
TURN_URL = re.compile(r"(turns?):([a-z0-9.-]+):([0-9]{1,5})\?transport=(udp|tcp)\Z")
TURN_USER = re.compile(r"([0-9]{10}):[0-9a-f]{32}\Z")
TURN_CREDENTIAL = re.compile(r"[-A-Za-z0-9+/]{27}=\Z")
DNS_LABEL = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z")


def parse_private_ice_config(value, now_seconds=None):
    """Reject arbitrary relay URLs/expired credentials before OS capture."""
    if value is None:
        return []
    if type(value) is not dict or set(value) != {
            "iceServers", "expiresAt", "ttlSeconds"}:
        raise ValueError("invalid_private_ice_config")
    ttl = value["ttlSeconds"]
    if type(ttl) is not int or not 120 <= ttl <= 900:
        raise ValueError("invalid_private_ice_config")
    expiry = value["expiresAt"]
    if type(expiry) is not int:
        raise ValueError("invalid_private_ice_config")
    now = time.time() if now_seconds is None else now_seconds
    if not 60 <= expiry - int(now) <= 900:
        raise ValueError("invalid_private_ice_config")
    servers = value["iceServers"]
    if type(servers) is not list or len(servers) != 1:
        raise ValueError("invalid_private_ice_config")
    entry = servers[0]
    if type(entry) is not dict or set(entry) != {"urls", "username", "credential"}:
        raise ValueError("invalid_private_ice_config")
    urls, username, credential = (entry["urls"], entry["username"],
                                  entry["credential"])
    if (type(urls) is not list or not 1 <= len(urls) <= 4
            or any(type(url) is not str for url in urls)
            or len(set(urls)) != len(urls)
            or type(username) is not str or not TURN_USER.fullmatch(username)
            or int(username[:10]) != expiry or type(credential) is not str
            or not TURN_CREDENTIAL.fullmatch(credential)):
        raise ValueError("invalid_private_ice_config")
    for url in urls:
        match = TURN_URL.fullmatch(url) if type(url) is str and len(url) <= 280 else None
        if not match:
            raise ValueError("invalid_private_ice_config")
        scheme, host, port_text, transport = match.groups()
        labels = host.split(".")
        if (len(labels) < 2 or len(host) > 253
                or any(not DNS_LABEL.fullmatch(label) for label in labels)
                or all(label.isdigit() for label in labels)
                or labels[-1] in ("local", "localhost")
                or not 1 <= int(port_text) <= 65535
                or (scheme == "turns" and transport != "tcp")):
            raise ValueError("invalid_private_ice_config")
    return [RTCIceServer(urls=urls, username=username, credential=credential)]


def read_private_ice_config(runtime_dir=None, now_seconds=None):
    """Read optional short-lived TURN credentials only from native owner files.

    Never accept a relay destination or credential through the device RPC.
    The private runtime directory and file are opened without following
    symlinks; malformed/expired data rejects an Offer before media starts.
    """
    if sys.platform == "win32":
        # File-based TURN is Linux/macOS-only until native Windows ACL and
        # credential provisioning are verified; never trust a copied JSON file.
        return []
    directory = native_runtime_directory(runtime_dir)
    if not directory or not os.path.isabs(directory):
        raise ValueError("invalid_private_ice_config")
    directory_fd = None
    file_fd = None
    try:
        directory_fd = os.open(directory,
                               os.O_RDONLY | os.O_DIRECTORY |
                               os.O_NOFOLLOW | os.O_CLOEXEC)
        info = os.fstat(directory_fd)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or (
                info.st_mode & 0o077):
            raise ValueError("invalid_private_ice_config")
        try:
            file_fd = os.open(NATIVE_ICE_NAME,
                              os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC,
                              dir_fd=directory_fd)
        except FileNotFoundError:
            return []
        info = os.fstat(file_fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_nlink != 1 or info.st_mode & 0o077
                or not 2 <= info.st_size <= MAX_NATIVE_ICE_BYTES):
            raise ValueError("invalid_private_ice_config")
        data = os.read(file_fd, MAX_NATIVE_ICE_BYTES + 1)
        if len(data) != info.st_size:
            raise ValueError("invalid_private_ice_config")
        return parse_private_ice_config(json.loads(data), now_seconds)
    except (OSError, ValueError, UnicodeError):
        raise ValueError("invalid_private_ice_config") from None
    finally:
        if file_fd is not None:
            os.close(file_fd)
        if directory_fd is not None:
            os.close(directory_fd)


def native_runtime_directory(runtime_dir=None, platform=None, env=None):
    if runtime_dir is not None:
        return runtime_dir
    target = platform or sys.platform
    variables = env if env is not None else os.environ
    if target == "darwin":
        home = variables.get("HOME")
        if not home or not os.path.isabs(home):
            raise PermissionError("native_runtime_directory_required")
        return os.path.join(home, "Library", "Application Support",
                            "ReMCP", "webrtc-runtime")
    return variables.get("XDG_RUNTIME_DIR")


@contextmanager
def exclusive_native_worker(runtime_dir=None):
    """Owner-only native capture singleton; independent of the agent process.

    The lock is never unlinked, to avoid inode replacement races. It is only
    an extra native singleton: Redis fencing and OS capture consent remain
    independent production requirements.
    """
    if sys.platform == "win32":
        from windows_native_mutex import exclusive_windows_capture
        with exclusive_windows_capture():
            yield
        return
    directory = native_runtime_directory(runtime_dir)
    if not directory or not os.path.isabs(directory):
        raise PermissionError("native_runtime_directory_required")
    if sys.platform == "darwin" and runtime_dir is None:
        os.makedirs(directory, mode=0o700, exist_ok=True)
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    directory_fd = os.open(directory, flags)
    lock_fd = None
    try:
        info = os.fstat(directory_fd)
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
                or info.st_mode & 0o077):
            raise PermissionError("unsafe_native_runtime_directory")
        lock_fd = os.open(NATIVE_LOCK_NAME,
                          os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC,
                          0o600, dir_fd=directory_fd)
        info = os.fstat(lock_fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_nlink != 1 or info.st_mode & 0o077):
            raise PermissionError("unsafe_native_worker_lock")
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise PermissionError("native_screen_worker_busy") from error
        try:
            yield
        finally:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
    finally:
        if lock_fd is not None:
            os.close(lock_fd)
        os.close(directory_fd)


class ScreenWorker:
    def __init__(self, source, video_profile="balanced"):
        if video_profile not in ("economy", "balanced", "smooth", "sharp"):
            raise ValueError("Unsupported bounded capture video profile")
        self.source = source
        self.video_profile = video_profile
        self.lease = None
        self.peer = None
        self.bridge = None
        self.grant = None
        self.native_capture = None
        self.guard_task = None
        self.watch_task = None
        self.native_watch_task = None
        self.generation = None
        self.last_stopped_id = None
        self.private_ice_sid = None
        self.private_ice_config = None
        self.closed = False
        self.pending = set()

    def current(self, sid):
        return (self.generation == sid and not self.closed and
                self.lease is not None and self.lease.matches(sid))

    def set_windows_private_ice(self, sid, config, platform=None):
        if (sys.platform if platform is None else platform) != "win32":
            raise ValueError("invalid_private_ice_config")
        return self.set_private_ice(sid, config, platform="win32")

    def set_private_ice(self, sid, config, platform=None):
        """Private stdio configuration from a preverified local owner file.

        Not part of the device RPC. No plaintext credential in environment,
        command-line arguments, logs or acknowledgements.
        """
        target = sys.platform if platform is None else platform
        if target not in ("win32", "darwin", "linux") or not isinstance(sid, str) or not SESSION_ID.fullmatch(sid):
            raise ValueError("invalid_private_ice_config")
        if self.generation is not None or self.peer is not None or self.private_ice_sid:
            raise ValueError("screen_busy")
        parse_private_ice_config(config)
        self.private_ice_sid = sid
        self.private_ice_config = config

    async def stop(self, sid=None):
        if sid is not None and self.generation != sid:
            # A disconnected peer may have already completed native cleanup.
            # A repeated Stop is safe only for that exact completed session.
            return (self.generation is None and sid == self.last_stopped_id
                    and self.peer is None and self.bridge is None
                    and self.grant is None and self.native_capture is None)
        stopped_id = self.generation
        self.closed = True
        self.generation = None
        self.private_ice_sid = None
        self.private_ice_config = None
        if self.lease:
            self.lease.revoke()
        self.lease = None
        for task in (self.guard_task, self.watch_task, self.native_watch_task):
            if task and task is not asyncio.current_task():
                task.cancel()
        self.guard_task = None
        self.watch_task = None
        self.native_watch_task = None
        pc, self.peer = self.peer, None
        bridge, self.bridge = self.bridge, None
        grant, self.grant = self.grant, None
        native, self.native_capture = self.native_capture, None
        try:
            if native:
                native.close()
        finally:
            if pc:
                await pc.close()
            if bridge:
                bridge.close()
            if grant:
                await grant.close()
        if stopped_id is not None:
            self.last_stopped_id = stopped_id
        return True

    async def expire(self, sid):
        while self.current(sid):
            remaining = self.lease.remaining()
            if remaining <= 0:
                break
            await asyncio.sleep(min(remaining, 2))
        if self.generation == sid:
            await self.stop(sid)

    async def monitor_grant(self, sid, grant):
        await grant.closed_event.wait()
        await self.stop(sid)

    async def monitor_native_permission(self, sid):
        while self.current(sid):
            await asyncio.sleep(2)
            if not self.current(sid):
                return
            from native_platform_capture import native_permission_granted
            if not native_permission_granted():
                await self.stop(sid)
                return

    async def offer(self, sid, sdp, profile=None):
        if profile is not None:
            from video_profiles import video_profile
            video_profile(profile)
            self.video_profile = profile
        if self.generation is not None or self.peer is not None:
            raise ValueError("screen_busy")
        if not isinstance(sid, str) or not SESSION_ID.fullmatch(sid):
            raise ValueError("invalid_session")
        if not isinstance(sdp, str) or len(sdp.encode()) > MAX_SDP:
            raise ValueError("invalid_sdp")
        media = [line for line in sdp.splitlines() if line.startswith("m=")]
        if len(media) != 1 or not media[0].startswith("m=video "):
            raise ValueError("view_only_video_required")
        if self.private_ice_sid is not None:
            if self.private_ice_sid != sid:
                raise ValueError("invalid_private_ice_session")
            try:
                ice_servers = parse_private_ice_config(self.private_ice_config)
            finally:
                self.private_ice_sid = None
                self.private_ice_config = None
        else:
            ice_servers = read_private_ice_config()
        self.generation = sid
        self.last_stopped_id = None
        self.closed = False
        self.lease = ViewerLease(sid, idle_seconds=NEGOTIATION_SECONDS)
        pc = RTCPeerConnection(configuration=RTCConfiguration(iceServers=ice_servers))
        self.peer = pc

        @pc.on("connectionstatechange")
        async def connection_changed():
            if pc.connectionState in ("failed", "closed") and self.generation == sid:
                await self.stop(sid)

        try:
            await pc.setRemoteDescription(RTCSessionDescription(sdp=sdp, type="offer"))
            if not self.current(sid):
                raise ValueError("session_cancelled")
            if self.source == "synthetic":
                track = SyntheticVideoTrack()
            elif native_source_allowed(self.source):
                self.native_capture = NativeDesktopCapture(self.source, profile=self.video_profile)
                track = self.native_capture.track
            else:
                from gst_frames import GstFrameBridge, GstVideoTrack
                if self.source == "portal":
                    from portal_capture import ScreenCastGrant
                    from portal_token_store import PortalTokenStore
                    store = (PortalTokenStore()
                             if os.environ.get("REMCP_WEBRTC_USE_PORTAL_GRANT") == "1"
                             else None)
                    if store:
                        async with store.exclusive():
                            if not self.current(sid):
                                raise ValueError("session_cancelled")
                            restored = store.load()
                            def store_replacement(token):
                                if token:
                                    store.save(token)
                                else:
                                    store.forget()
                            grant = ScreenCastGrant(
                                remember=True, restore_token=restored,
                                token_received=store_replacement)
                            self.grant = grant
                            fd, node_id, serial = await grant.start()
                    else:
                        grant = ScreenCastGrant()
                        self.grant = grant
                        fd, node_id, serial = await grant.start()
                    if not self.current(sid):
                        raise ValueError("session_cancelled")
                    self.bridge = GstFrameBridge(fd=fd,node_id=node_id,serial=serial,
                                                 video_profile=self.video_profile)
                    self.watch_task = asyncio.create_task(self.monitor_grant(sid,grant))
                else:
                    self.bridge = GstFrameBridge(test_pattern=True,
                                                 video_profile=self.video_profile)
                self.bridge.start()
                track = GstVideoTrack(self.bridge)
            pc.addTrack(track)
            description = await pc.createAnswer()
            await pc.setLocalDescription(description)
            if not self.current(sid) or not self.lease.activate(sid):
                raise ValueError("session_cancelled")
            self.guard_task = asyncio.create_task(self.expire(sid))
            if self.native_capture is not None:
                self.native_watch_task = asyncio.create_task(
                    self.monitor_native_permission(sid))
            return {"ok": True, "type": "answer", "sessionId": sid,
                    "sdp": pc.localDescription.sdp}
        except BaseException:
            await self.stop(sid)
            raise

    async def handle(self, request):
        request_id = request.get("requestId")
        if type(request_id) is not int or not 0 <= request_id <= 2147483647:
            return
        op = request.get("op")
        sid = request.get("session_id")
        result = {"requestId": request_id}
        try:
            if op == "offer":
                answer = await self.offer(sid,request.get("sdp"),request.get("video_profile"))
                result.update(answer)
            elif op == "ice-config":
                self.set_private_ice(sid,request.get("config"))
                result.update(ok=True,sessionId=sid)
            elif op == "heartbeat":
                if not self.current(sid):
                    raise ValueError("unknown_or_expired_session")
                self.lease.heartbeat(sid)
                result.update(ok=True,sessionId=sid)
            elif op == "stop":
                if not await self.stop(sid):
                    raise ValueError("unknown_session")
                result.update(ok=True,sessionId=sid)
            else:
                raise ValueError("invalid_operation")
        except (ValueError, PermissionError) as error:
            result.update(ok=False,error=type(error).__name__)
        except asyncio.CancelledError:
            result.update(ok=False,error="Cancelled")
        except Exception as error:
            LOG.warning("Worker request failed: %s",type(error).__name__)
            result.update(ok=False,error="WorkerFailed")
        print(json.dumps(result,ensure_ascii=True,separators=(",",":")),flush=True)

    async def run(self):
        try:
            while True:
                # Keep a bounded reader: a malformed oversized line must never
                # consume an unlimited amount of memory or become SDP output.
                line = await asyncio.to_thread(sys.stdin.buffer.readline,MAX_LINE+1)
                if not line:
                    break
                if len(line)>MAX_LINE or not line.endswith(b"\n"):
                    break
                try:
                    request=json.loads(line)
                    if not isinstance(request,dict):
                        continue
                except (ValueError,UnicodeDecodeError):
                    continue
                task=asyncio.create_task(self.handle(request))
                self.pending.add(task)
                task.add_done_callback(self.pending.discard)
        finally:
            await self.stop()
            for task in self.pending:
                task.cancel()
            if self.pending:
                await asyncio.gather(*self.pending,return_exceptions=True)


async def main():
    parser=argparse.ArgumentParser()
    default_source = ("avfoundation" if sys.platform == "darwin" else
                      "gdigrab" if sys.platform == "win32" else "portal")
    parser.add_argument("--source",choices=["synthetic","gst-test","portal",
                                          "avfoundation","gdigrab","x11"],
                        default=default_source)
    parser.add_argument("--video-profile",choices=["economy","balanced","smooth","sharp"],
                        default="balanced",help="Bounded resolution/frame-rate profile")
    args=parser.parse_args()
    if args.source in ("synthetic","gst-test"):
        if (sys.platform != "linux" or os.environ.get(
                "REMCP_WEBRTC_ALLOW_TEST_SOURCE") != "1"):
            raise SystemExit("Test video source requires Linux QA opt-in")
    elif args.source == "portal":
        if sys.platform != "linux":
            raise SystemExit("Portal source requires Linux")
    elif not native_source_allowed(args.source):
        raise SystemExit("Native screen source does not match this OS")
    # Node ownership makes native capture fail closed on unexpected agent exit.
    # Only the trusted Windows Node bridge supplies its own PID; on other OS
    # platforms the parent-process guard is inert.
    with guard_agent_process():
        with exclusive_native_worker():
            await ScreenWorker(args.source,video_profile=args.video_profile).run()


if __name__=="__main__":
    asyncio.run(main())
