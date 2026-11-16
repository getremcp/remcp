"""OS-authorized XDG ScreenCast grant for an isolated localhost-only proof.

The first capture requires the system picker. Persistent mode uses only
OS-issued restore tokens for a monitor that the owner already approved.
The OS may show the picker again when a token expires or is revoked.
"""
import asyncio
import os
import secrets
import threading

import gi
gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib

from portal_token_store import valid_token

SERVICE = "org.freedesktop.portal.Desktop"
DESKTOP = "/org/freedesktop/portal/desktop"
SCREENCAST = "org.freedesktop.portal.ScreenCast"
TIMEOUT_SECONDS = 45


class ScreenCastRequestTimeout(TimeoutError):
    """The desktop portal did not answer an owner-consent request in time."""



def unwrap(value):
    return value.unpack() if isinstance(value, GLib.Variant) else value


def stream_from_response(results):
    streams = unwrap(results.get("streams"))
    if not isinstance(streams, (tuple, list)) or len(streams) != 1:
        raise RuntimeError("Portal did not grant exactly one screen source")
    node_id, properties = streams[0]
    if type(node_id) is not int or not 0 < node_id < 2**32:
        raise RuntimeError("Invalid PipeWire node ID")
    source_type = unwrap(properties.get("source_type"))
    if type(source_type) is not int or source_type != 1:
        raise RuntimeError("Expected a verified monitor source from the OS portal")
    serial = unwrap(properties.get("pipewire-serial"))
    if type(serial) is not int or not 0 < serial < 2**64:
        serial = None
    return node_id, serial


def screen_source_options(remember=False, restore_token=None):
    """Create the portal's monitor-only grant request."""
    if restore_token is not None and (not remember or not valid_token(restore_token)):
        raise ValueError("Invalid ScreenCast restoration request")
    options = {"types": GLib.Variant("u", 1),
               "multiple": GLib.Variant("b", False),
               "cursor_mode": GLib.Variant("u", 2),
               "persist_mode": GLib.Variant("u", 2 if remember else 0)}
    if restore_token:
        options["restore_token"] = GLib.Variant("s", restore_token)
    return options


class ScreenCastGrant:
    def __init__(self, *, remember=False, restore_token=None):
        if restore_token is not None and (not remember or not valid_token(restore_token)):
            raise ValueError("Invalid ScreenCast restoration request")
        self.remember = remember
        self.restore_token = restore_token
        self.new_restore_token = None
        self.event_loop = asyncio.get_running_loop()
        self.connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self.glib_loop = GLib.MainLoop()
        self.glib_thread = threading.Thread(
            target=self.glib_loop.run, daemon=True, name="remcp-portal-response")
        self.glib_thread.start()
        self.session = None
        self.closed = False
        self.closed_event = asyncio.Event()
        self.fd = None
        self._closed_subscription = None
        self._pending_requests = {}

    async def _close_request(self, path):
        """Release an unfinished OS-owned dialog without granting permission."""
        try:
            await asyncio.to_thread(
                self.connection.call_sync, SERVICE, path,
                "org.freedesktop.portal.Request", "Close", None, None,
                Gio.DBusCallFlags.NONE, 3_000, None)
        except GLib.Error:
            # The request may have disappeared at the same moment it was closed.
            pass

    async def _request(self, method, signature, args, extras=None):
        if self.closed:
            raise RuntimeError("Portal already closed")
        token = "remcp_" + secrets.token_hex(12)
        opts = {"handle_token": GLib.Variant("s", token)}
        if extras:
            opts.update(extras)
        unique = self.connection.get_unique_name()
        if not unique or not unique.startswith(":"):
            raise RuntimeError("Missing session bus unique name")
        expected_path = ("/org/freedesktop/portal/desktop/request/" +
                         unique[1:].replace(".", "_") + "/" + token)
        future = self.event_loop.create_future()

        def response(_connection, _sender, path, _interface, _member, parameters, _data):
            if path != expected_path or future.done():
                return
            status, result = parameters.unpack()
            self.event_loop.call_soon_threadsafe(
                lambda: not future.done() and future.set_result((status, result)))

        subscription = self.connection.signal_subscribe(
            SERVICE, "org.freedesktop.portal.Request", "Response",
            expected_path, None, Gio.DBusSignalFlags.NONE, response, None)
        self._pending_requests[expected_path] = future
        answered = False
        try:
            params = GLib.Variant(signature, (*args, opts))
            reply = await asyncio.to_thread(
                self.connection.call_sync, SERVICE, DESKTOP, SCREENCAST, method,
                params, GLib.VariantType("(o)"), Gio.DBusCallFlags.NONE,
                15_000, None)
            if reply.unpack()[0] != expected_path:
                raise RuntimeError("Unexpected ScreenCast request path")
            try:
                status, result = await asyncio.wait_for(future, TIMEOUT_SECONDS)
            except asyncio.TimeoutError as error:
                raise ScreenCastRequestTimeout(
                    "ScreenCast system approval timed out") from error
            answered = True
            if status != 0:
                raise PermissionError("Screen sharing was declined or cancelled")
            return result
        finally:
            self._pending_requests.pop(expected_path, None)
            self.connection.signal_unsubscribe(subscription)
            if not answered:
                # A timeout, cancellation, or Stop must not leave a stale
                # permission picker that can approve a later session.
                await self._close_request(expected_path)

    async def start(self):
        if self.session or self.closed:
            raise RuntimeError("Portal grant already used")
        try:
            created = await self._request(
                "CreateSession", "(a{sv})", (),
                {"session_handle_token": GLib.Variant(
                    "s", "remcp_" + secrets.token_hex(12))})
            handle = unwrap(created.get("session_handle"))
            if not isinstance(handle, str) or not handle.startswith(
                    "/org/freedesktop/portal/desktop/session/"):
                raise RuntimeError("Invalid ScreenCast session handle")
            self.session = handle

            def session_closed(_conn, _sender, _path, _interface, _signal, _args, _data):
                self.event_loop.call_soon_threadsafe(self.closed_event.set)

            self._closed_subscription = self.connection.signal_subscribe(
                SERVICE, "org.freedesktop.portal.Session", "Closed",
                self.session, None, Gio.DBusSignalFlags.NONE,
                session_closed, None)
            await self._request("SelectSources", "(oa{sv})", (self.session,),
                                screen_source_options(self.remember, self.restore_token))
            # The desktop consent dialogue is displayed by the OS, not by
            # this application. Never bypass rejection or try X11 fallback.
            started = await self._request(
                "Start", "(osa{sv})", (self.session, ""))
            if self.closed:
                raise RuntimeError("Screen sharing was stopped during OS consent")
            node_id, serial = stream_from_response(started)
            token = unwrap(started.get("restore_token"))
            if self.remember and valid_token(token):
                self.new_restore_token = token
            result, fds = await asyncio.to_thread(
                self.connection.call_with_unix_fd_list_sync,
                SERVICE, DESKTOP, SCREENCAST, "OpenPipeWireRemote",
                GLib.Variant("(oa{sv})", (self.session, {})),
                GLib.VariantType("(h)"), Gio.DBusCallFlags.NONE,
                10_000, None, None)
            index = result.unpack()[0]
            if not fds or type(index) is not int or index < 0:
                raise RuntimeError("No portal-scoped PipeWire file descriptor")
            fd = fds.get(index)
            if not isinstance(fd, int) or fd < 0:
                raise RuntimeError("Invalid portal PipeWire descriptor")
            if self.closed:
                os.close(fd)
                raise RuntimeError("Screen sharing was stopped during negotiation")
            self.fd = fd
            return fd, node_id, serial
        except BaseException:
            await self.close()
            raise

    async def close(self):
        if self.closed:
            return
        self.closed = True
        self.closed_event.set()
        for future in tuple(self._pending_requests.values()):
            if not future.done():
                future.set_exception(PermissionError(
                    "Screen sharing stopped before OS approval"))
        if self._closed_subscription:
            self.connection.signal_unsubscribe(self._closed_subscription)
            self._closed_subscription = None
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None
        if self.session:
            try:
                await asyncio.to_thread(
                    self.connection.call_sync, SERVICE, self.session,
                    "org.freedesktop.portal.Session", "Close", None,
                    None, Gio.DBusCallFlags.NONE, 3_000, None)
            except GLib.Error:
                pass
            self.session = None
        self.glib_loop.quit()
        await asyncio.to_thread(self.glib_thread.join, 2)


def preflight_portal():
    """Safe read-only inspection. Does not create a session or prompt."""
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    reply = bus.call_sync(
        SERVICE, DESKTOP, "org.freedesktop.DBus.Properties", "Get",
        GLib.Variant("(ss)", (SCREENCAST, "AvailableSourceTypes")),
        GLib.VariantType("(v)"), Gio.DBusCallFlags.NONE, 5_000, None)
    sources = unwrap(reply.unpack()[0])
    return bool(type(sources) is int and sources & 1)


def portal_supports_persistence():
    """Check the desktop ScreenCast API version without requesting any frames."""
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    reply = bus.call_sync(
        SERVICE, DESKTOP, "org.freedesktop.DBus.Properties", "Get",
        GLib.Variant("(ss)", (SCREENCAST, "version")),
        GLib.VariantType("(v)"), Gio.DBusCallFlags.NONE, 5_000, None)
    version = unwrap(reply.unpack()[0])
    return type(version) is int and version >= 4
