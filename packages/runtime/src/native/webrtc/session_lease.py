"""Session-bound, bounded viewer liveness for the localhost WebRTC proof.

No network, OS input or capture permissions are handled here. Every
renewal must prove possession of the same per-attempt session identifier;
an old browser can never keep alive or stop a newer viewer by mistake.
"""
import re
import secrets
import time

SESSION_ID_PATTERN = re.compile(r"[A-Za-z0-9_-]{32,128}\Z")
IDLE_SECONDS = 45
NEGOTIATION_SECONDS = 64  # 45s portal picker plus bounded video negotiation
MAX_SESSION_SECONDS = 10 * 60


def valid_session_id(value):
    return type(value) is str and SESSION_ID_PATTERN.fullmatch(value) is not None


class ViewerLease:
    def __init__(self, session_id, *, clock=time.monotonic,
                 idle_seconds=IDLE_SECONDS, max_seconds=MAX_SESSION_SECONDS):
        if not valid_session_id(session_id):
            raise ValueError("Invalid viewer session identifier")
        if idle_seconds <= 0 or max_seconds <= idle_seconds:
            raise ValueError("Invalid viewer lifetime limits")
        self.id = session_id
        self.clock = clock
        self.born = clock()
        self.last_seen = self.born
        self.idle_seconds = idle_seconds
        self.max_seconds = max_seconds
        self.revoked = False

    def remaining(self):
        if self.revoked:
            return 0
        return max(0, min(self.born + self.max_seconds,
                          self.last_seen + self.idle_seconds) - self.clock())

    def owns(self, session_id):
        # Owner may Stop even when the lease expired but its expiry task
        # has not yet closed the media pipeline.
        return (valid_session_id(session_id) and
                secrets.compare_digest(self.id, session_id))

    def matches(self, session_id):
        return self.owns(session_id) and self.remaining() > 0

    def heartbeat(self, session_id):
        if not self.matches(session_id):
            return False
        self.last_seen = self.clock()
        return True

    def activate(self, session_id, idle_seconds=IDLE_SECONDS):
        """Move a consent-pending lease to the shorter active idle deadline.

        The absolute lifetime remains anchored to the original offer, and
        revoked or expired consent cannot be activated afterwards.
        """
        if not 0 < idle_seconds < self.max_seconds:
            raise ValueError("Invalid active viewer idle limit")
        if not self.matches(session_id):
            return False
        self.last_seen = self.clock()
        self.idle_seconds = idle_seconds
        return True

    def revoke(self):
        self.revoked = True
