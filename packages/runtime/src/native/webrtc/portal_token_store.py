"""Owner-only storage for an OS-issued ScreenCast restore token.

A restore token is a bearer capability for the already-approved monitor. It
must never be printed, shared over HTTP, or committed. The owning desktop user
can remove it at any time; doing so forces the next OS consent dialogue.
"""
import asyncio
from contextlib import asynccontextmanager
import os
try:
    import fcntl
except ImportError:  # The Windows worker ships this POSIX-only module too.
    fcntl = None
import secrets
import stat
from pathlib import Path

MAX_TOKEN_BYTES = 16384


def valid_token(token):
    return (type(token) is str and 0 < len(token.encode("utf-8")) <= MAX_TOKEN_BYTES
            and not any(ord(ch) < 32 or ord(ch) == 127 for ch in token))


class PortalTokenStore:
    def __init__(self, path=None):
        self.path = Path(path or (
            Path.home() / ".local/state/remcp/live-desktop-portal/grant.token"
        )).expanduser()
        if not self.path.is_absolute():
            raise ValueError("Portal token file path must be absolute")

    def _check_directory(self):
        folder = self.path.parent
        folder.mkdir(parents=True, mode=0o700, exist_ok=True)
        mode = folder.lstat()
        if not stat.S_ISDIR(mode.st_mode) or mode.st_uid != os.getuid() or (
                stat.S_IMODE(mode.st_mode) & 0o077):
            raise PermissionError("Portal token directory must be private to the owner")
        return folder

    @asynccontextmanager
    async def exclusive(self, timeout_seconds=90):
        """Serialize OS one-use restore-token redemption across workers.

        Keep this reservation from load() through ScreenCast.Start() and
        save()/forget(), not for the duration of the video stream. No consent
        is bypassed; GNOME still owns the initial grant and any revocation.
        """
        if fcntl is None:
            raise OSError("Portal token reservation is supported on POSIX only")
        folder = self._check_directory()
        lock_path = folder / ("." + self.path.name + ".lock")
        fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        locked = False
        try:
            info = os.fstat(fd)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                    or stat.S_IMODE(info.st_mode) & 0o077 or info.st_nlink != 1):
                raise PermissionError("Portal token lock is not owner-only")
            deadline = asyncio.get_running_loop().time() + timeout_seconds
            while True:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    locked = True
                    break
                except BlockingIOError:
                    if asyncio.get_running_loop().time() >= deadline:
                        raise TimeoutError("Waiting for an authorized ScreenCast grant timed out")
                    await asyncio.sleep(0.1)
            yield self
        finally:
            if locked:
                fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)

    def load(self):
        self._check_directory()
        try:
            fd = os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError:
            return None
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or (
                    stat.S_IMODE(info.st_mode) & 0o077) or info.st_nlink != 1 or (
                    info.st_size > MAX_TOKEN_BYTES):
                raise PermissionError("Portal token file is not owner-only")
            raw = os.read(fd, MAX_TOKEN_BYTES + 1)
            token = raw.decode("utf-8")
            if not valid_token(token):
                raise ValueError("Invalid saved portal token")
            return token
        finally:
            os.close(fd)

    def save(self, token):
        if not valid_token(token):
            raise ValueError("Invalid portal restore token")
        folder = self._check_directory()
        name = "." + self.path.name + "." + secrets.token_hex(10)
        tmp = folder / name
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(token.encode("utf-8"))
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(tmp, self.path)
        finally:
            if tmp.exists():
                tmp.unlink()

    def forget(self):
        self._check_directory()
        # Unlinking a symlink here only removes that link; it never follows it.
        self.path.unlink(missing_ok=True)
