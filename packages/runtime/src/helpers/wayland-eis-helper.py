#!/usr/bin/env python3
"""ReMCP XDG RemoteDesktop + libei sender helper.

Owns the portal session and EIS file descriptor in one process so SCM_RIGHTS never
has to cross Node's net.Socket implementation. JSON-lines are used only between
this helper and the local ReMCP runtime.
"""
import json
import os
import select
import sys
import time

from wayland_eis_sender import EiSender

try:
    import gi
    gi.require_version("Gio", "2.0")
    from gi.repository import Gio, GLib
except Exception as exc:
    print(json.dumps({"ready": False, "kind": "unsupported", "error": f"PyGObject/Gio unavailable: {exc}"}), flush=True)
    sys.exit(78)

PORTAL_NAME = "org.freedesktop.portal.Desktop"
PORTAL_PATH = "/org/freedesktop/portal/desktop"
REMOTE_IFACE = "org.freedesktop.portal.RemoteDesktop"
REQUEST_IFACE = "org.freedesktop.portal.Request"
SESSION_IFACE = "org.freedesktop.portal.Session"
DEVICE_TYPES = 1 | 2  # keyboard | pointer in the portal API

def emit(payload):
    sys.stdout.write(json.dumps(payload, separators=(",", ":"), ensure_ascii=False) + "\n")
    sys.stdout.flush()


def deep_unwrap(value):
    if isinstance(value, GLib.Variant):
        return deep_unwrap(value.unpack())
    if isinstance(value, dict):
        return {str(k): deep_unwrap(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [deep_unwrap(v) for v in value]
    return value


def token(prefix):
    return f"{prefix}_{os.getpid()}_{time.monotonic_ns()}".replace("-", "_")


class Portal:
    def __init__(self, timeout_ms):
        self.timeout_ms = timeout_ms
        self.conn = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self.context = GLib.MainContext.default()
        self.responses = {}
        self.session = None
        self.subscription = self.conn.signal_subscribe(
            PORTAL_NAME,
            REQUEST_IFACE,
            "Response",
            None,
            None,
            Gio.DBusSignalFlags.NONE,
            self._on_response,
        )

    def _on_response(self, _conn, _sender, object_path, _iface, _signal, params, _data=None):
        try:
            response, results = params.unpack()
            self.responses[object_path] = (int(response), deep_unwrap(results))
        except Exception as exc:
            self.responses[object_path] = (2, {"error": str(exc)})

    def _wait_response(self, request_path):
        deadline = time.monotonic() + self.timeout_ms / 1000.0
        while time.monotonic() < deadline:
            while self.context.pending():
                self.context.iteration(False)
            if request_path in self.responses:
                response, results = self.responses.pop(request_path)
                if response == 1:
                    raise RuntimeError("portal request cancelled")
                if response != 0:
                    raise RuntimeError(f"portal request denied (response {response})")
                return results
            self.context.iteration(False)
            time.sleep(0.01)
        raise TimeoutError(f"portal request timed out after {self.timeout_ms} ms")

    def request(self, method, params):
        reply = self.conn.call_sync(
            PORTAL_NAME,
            PORTAL_PATH,
            REMOTE_IFACE,
            method,
            params,
            GLib.VariantType.new("(o)"),
            Gio.DBusCallFlags.NONE,
            min(self.timeout_ms, 10000),
            None,
        )
        request_path = reply.unpack()[0]
        return self._wait_response(request_path)

    def open(self, restore_token="", parent_window=""):
        create_opts = {
            "handle_token": GLib.Variant("s", token("create")),
            "session_handle_token": GLib.Variant("s", token("session")),
        }
        created = self.request("CreateSession", GLib.Variant("(a{sv})", (create_opts,)))
        self.session = created.get("session_handle")
        if not isinstance(self.session, str) or not self.session.startswith("/"):
            raise RuntimeError("portal returned no session handle")

        select_opts = {
            "handle_token": GLib.Variant("s", token("select")),
            "types": GLib.Variant("u", DEVICE_TYPES),
            "persist_mode": GLib.Variant("u", 2),
        }
        if restore_token:
            select_opts["restore_token"] = GLib.Variant("s", restore_token)
        self.request("SelectDevices", GLib.Variant("(oa{sv})", (self.session, select_opts)))

        start_opts = {"handle_token": GLib.Variant("s", token("start"))}
        started = self.request("Start", GLib.Variant("(osa{sv})", (self.session, parent_window or "", start_opts)))
        devices = int(started.get("devices", 0))
        if devices & DEVICE_TYPES != DEVICE_TYPES:
            raise RuntimeError(f"portal did not grant keyboard and pointer access (devices={devices})")
        return devices, str(started.get("restore_token") or "")

    def connect_eis(self):
        if not self.session:
            raise RuntimeError("portal session is not open")
        reply, fd_list = self.conn.call_with_unix_fd_list_sync(
            PORTAL_NAME,
            PORTAL_PATH,
            REMOTE_IFACE,
            "ConnectToEIS",
            GLib.Variant("(oa{sv})", (self.session, {})),
            GLib.VariantType.new("(h)"),
            Gio.DBusCallFlags.NONE,
            min(self.timeout_ms, 10000),
            None,
            None,
        )
        handle = int(reply.unpack()[0])
        fd = fd_list.get(handle)
        if fd < 0:
            raise RuntimeError("ConnectToEIS returned an invalid file descriptor")
        return fd

    def close(self):
        if self.session:
            try:
                self.conn.call_sync(
                    PORTAL_NAME,
                    self.session,
                    SESSION_IFACE,
                    "Close",
                    None,
                    None,
                    Gio.DBusCallFlags.NONE,
                    3000,
                    None,
                )
            except Exception:
                pass
            self.session = None
        try:
            self.conn.signal_unsubscribe(self.subscription)
        except Exception:
            pass


def main():
    timeout_ms = max(1000, min(120000, int(os.environ.get("REMCP_EIS_TIMEOUT_MS", "30000"))))
    restore_token = os.environ.get("REMCP_EIS_RESTORE_TOKEN", "")
    parent_window = os.environ.get("REMCP_EIS_PARENT_WINDOW", "")
    portal = None
    sender = None
    try:
        portal = Portal(timeout_ms)
        devices, new_restore_token = portal.open(restore_token, parent_window)
        eis_fd = portal.connect_eis()
        sender = EiSender(eis_fd)
        sender.wait_ready(min(10.0, timeout_ms / 1000.0))
        emit({
            "ready": True,
            "backend": "xdg-eis",
            "devices": devices,
            "restore_token": new_restore_token,
            "capabilities": sender.capabilities(),
        })

        running = True
        while running:
            readable, _, _ = select.select([sys.stdin, sender.fd], [], [], 0.5)
            if sender.fd in readable:
                sender.process_events()
            if sys.stdin in readable:
                line = sys.stdin.readline()
                if line == "":
                    break
                request = None
                try:
                    request = json.loads(line)
                    request_id = request.get("id")
                    running = sender.command(request)
                    emit({"id": request_id, "ok": True, "capabilities": sender.capabilities()})
                except Exception as exc:
                    emit({"id": request.get("id") if isinstance(request, dict) else None, "ok": False, "error": str(exc)})
    except OSError as exc:
        emit({"ready": False, "kind": "unsupported", "error": f"libei unavailable: {exc}"})
        return 78
    except Exception as exc:
        emit({"ready": False, "kind": "runtime", "error": str(exc)})
        return 1
    finally:
        if sender:
            sender.close()
        if portal:
            portal.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
