"""Libei sender and input protocol for the ReMCP Wayland Portal helper.

Keep the sender in the same OS process as the portal: the EIS file descriptor
cannot be transported to Node without changing SCM_RIGHTS and grant semantics.
"""
import ctypes
import select
import time

EI_CAP_POINTER = 1 << 0
EI_CAP_POINTER_ABSOLUTE = 1 << 1
EI_CAP_KEYBOARD = 1 << 2
EI_CAP_SCROLL = 1 << 4
EI_CAP_BUTTON = 1 << 5
EI_EVENT_CONNECT = 1
EI_EVENT_DISCONNECT = 2
EI_EVENT_SEAT_ADDED = 3
EI_EVENT_SEAT_REMOVED = 4
EI_EVENT_DEVICE_ADDED = 5
EI_EVENT_DEVICE_REMOVED = 6
EI_EVENT_DEVICE_PAUSED = 7
EI_EVENT_DEVICE_RESUMED = 8

class EiSender:
    def __init__(self, fd):
        self.lib = ctypes.CDLL("libei.so.1")
        c_void_p = ctypes.c_void_p
        self.lib.ei_new_sender.argtypes = [c_void_p]
        self.lib.ei_new_sender.restype = c_void_p
        self.lib.ei_configure_name.argtypes = [c_void_p, ctypes.c_char_p]
        self.lib.ei_setup_backend_fd.argtypes = [c_void_p, ctypes.c_int]
        self.lib.ei_setup_backend_fd.restype = ctypes.c_int
        self.lib.ei_get_fd.argtypes = [c_void_p]
        self.lib.ei_get_fd.restype = ctypes.c_int
        self.lib.ei_dispatch.argtypes = [c_void_p]
        self.lib.ei_get_event.argtypes = [c_void_p]
        self.lib.ei_get_event.restype = c_void_p
        self.lib.ei_event_get_type.argtypes = [c_void_p]
        self.lib.ei_event_get_type.restype = ctypes.c_int
        self.lib.ei_event_get_seat.argtypes = [c_void_p]
        self.lib.ei_event_get_seat.restype = c_void_p
        self.lib.ei_event_get_device.argtypes = [c_void_p]
        self.lib.ei_event_get_device.restype = c_void_p
        self.lib.ei_event_unref.argtypes = [c_void_p]
        self.lib.ei_event_unref.restype = c_void_p
        self.lib.ei_device_ref.argtypes = [c_void_p]
        self.lib.ei_device_ref.restype = c_void_p
        self.lib.ei_device_unref.argtypes = [c_void_p]
        self.lib.ei_device_unref.restype = c_void_p
        self.lib.ei_device_has_capability.argtypes = [c_void_p, ctypes.c_int]
        self.lib.ei_device_has_capability.restype = ctypes.c_bool
        self.lib.ei_device_get_region_at.argtypes = [c_void_p, ctypes.c_double, ctypes.c_double]
        self.lib.ei_device_get_region_at.restype = c_void_p
        self.lib.ei_region_convert_point.argtypes = [c_void_p, ctypes.POINTER(ctypes.c_double), ctypes.POINTER(ctypes.c_double)]
        self.lib.ei_region_convert_point.restype = ctypes.c_bool
        self.lib.ei_device_start_emulating.argtypes = [c_void_p, ctypes.c_uint32]
        self.lib.ei_device_stop_emulating.argtypes = [c_void_p]
        self.lib.ei_device_keyboard_key.argtypes = [c_void_p, ctypes.c_uint32, ctypes.c_bool]
        self.lib.ei_device_pointer_motion.argtypes = [c_void_p, ctypes.c_double, ctypes.c_double]
        self.lib.ei_device_pointer_motion_absolute.argtypes = [c_void_p, ctypes.c_double, ctypes.c_double]
        self.lib.ei_device_button_button.argtypes = [c_void_p, ctypes.c_uint32, ctypes.c_bool]
        self.lib.ei_device_scroll_discrete.argtypes = [c_void_p, ctypes.c_int32, ctypes.c_int32]
        self.lib.ei_device_frame.argtypes = [c_void_p, ctypes.c_uint64]
        self.lib.ei_now.argtypes = [c_void_p]
        self.lib.ei_now.restype = ctypes.c_uint64
        self.lib.ei_unref.argtypes = [c_void_p]
        self.lib.ei_unref.restype = c_void_p
        self.lib.ei_seat_has_capability.argtypes = [c_void_p, ctypes.c_int]
        self.lib.ei_seat_has_capability.restype = ctypes.c_bool
        # ei_seat_bind_capabilities is varargs: keep argtypes unset.
        self.lib.ei_seat_bind_capabilities.restype = None

        self.ei = self.lib.ei_new_sender(None)
        if not self.ei:
            raise RuntimeError("ei_new_sender failed")
        self.lib.ei_configure_name(self.ei, b"ReMCP")
        rc = int(self.lib.ei_setup_backend_fd(self.ei, fd))
        if rc < 0:
            raise RuntimeError(f"ei_setup_backend_fd failed ({rc})")
        self.fd = int(self.lib.ei_get_fd(self.ei))
        if self.fd < 0:
            raise RuntimeError("ei_get_fd failed")
        self.devices = {}
        self.sequence = 1
        self.connected = False
        self.pointer_device_key = None
        self.pointer_position = None
        # A press/release pair must stay on the same emulated device even if
        # absolute motion crosses an EIS region and changes pointer_device_key.
        self.button_device_keys = {}

    def _device_key(self, ptr):
        return int(ptr or 0)

    def _remember_device(self, ptr):
        key = self._device_key(ptr)
        if not key:
            return None
        if key not in self.devices:
            retained = self.lib.ei_device_ref(ptr)
            self.devices[key] = {"ptr": retained, "resumed": False, "emulating": False}
        return self.devices[key]

    def _drop_device(self, ptr):
        key = self._device_key(ptr)
        state = self.devices.pop(key, None)
        if key == self.pointer_device_key:
            self.pointer_device_key = None
            self.pointer_position = None
        for button, device_key in list(self.button_device_keys.items()):
            if device_key == key:
                self.button_device_keys.pop(button, None)
        if state:
            if state["emulating"]:
                try:
                    self.lib.ei_device_stop_emulating(state["ptr"])
                except Exception:
                    pass
            self.lib.ei_device_unref(state["ptr"])

    def _bind_seat(self, seat):
        caps = [EI_CAP_POINTER, EI_CAP_POINTER_ABSOLUTE, EI_CAP_KEYBOARD, EI_CAP_SCROLL, EI_CAP_BUTTON]
        args = [ctypes.c_void_p(seat)]
        args.extend(ctypes.c_int(cap) for cap in caps if self.lib.ei_seat_has_capability(seat, cap))
        args.append(ctypes.c_void_p())
        self.lib.ei_seat_bind_capabilities(*args)

    def process_events(self):
        self.lib.ei_dispatch(self.ei)
        while True:
            event = self.lib.ei_get_event(self.ei)
            if not event:
                break
            try:
                event_type = int(self.lib.ei_event_get_type(event))
                if event_type == EI_EVENT_CONNECT:
                    self.connected = True
                elif event_type == EI_EVENT_DISCONNECT:
                    raise RuntimeError("EIS server disconnected")
                elif event_type == EI_EVENT_SEAT_ADDED:
                    seat = self.lib.ei_event_get_seat(event)
                    if seat:
                        self._bind_seat(seat)
                elif event_type == EI_EVENT_DEVICE_ADDED:
                    device = self.lib.ei_event_get_device(event)
                    if device:
                        self._remember_device(device)
                elif event_type == EI_EVENT_DEVICE_RESUMED:
                    device = self.lib.ei_event_get_device(event)
                    state = self._remember_device(device)
                    if state:
                        state["resumed"] = True
                        if not state["emulating"]:
                            self.lib.ei_device_start_emulating(state["ptr"], self.sequence)
                            self.sequence = (self.sequence + 1) & 0xFFFFFFFF or 1
                            state["emulating"] = True
                elif event_type == EI_EVENT_DEVICE_PAUSED:
                    device = self.lib.ei_event_get_device(event)
                    key = self._device_key(device)
                    state = self.devices.get(key)
                    if state:
                        state["resumed"] = False
                        state["emulating"] = False
                    for button, device_key in list(self.button_device_keys.items()):
                        if device_key == key:
                            self.button_device_keys.pop(button, None)
                elif event_type == EI_EVENT_DEVICE_REMOVED:
                    self._drop_device(self.lib.ei_event_get_device(event))
            finally:
                self.lib.ei_event_unref(event)

    def wait_ready(self, timeout_s=10.0):
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            if (
                self.connected
                and self.capability_ready(EI_CAP_KEYBOARD)
                and self.capability_ready(EI_CAP_POINTER)
                and self.capability_ready(EI_CAP_BUTTON)
                and self.capability_ready(EI_CAP_SCROLL)
            ):
                return
            readable, _, _ = select.select([self.fd], [], [], min(0.1, max(0.0, deadline - time.monotonic())))
            if readable:
                self.process_events()
        raise TimeoutError(f"EIS devices did not become ready; capabilities={self.capabilities()}")

    def capability_ready(self, cap):
        return any(state["resumed"] and self.lib.ei_device_has_capability(state["ptr"], cap) for state in self.devices.values())

    def capabilities(self):
        names = {
            EI_CAP_POINTER: "pointer",
            EI_CAP_POINTER_ABSOLUTE: "pointer_absolute",
            EI_CAP_KEYBOARD: "keyboard",
            EI_CAP_SCROLL: "scroll",
            EI_CAP_BUTTON: "button",
        }
        return {name: self.capability_ready(cap) for cap, name in names.items()}

    def device_for(self, cap):
        for state in self.devices.values():
            if state["resumed"] and state["emulating"] and self.lib.ei_device_has_capability(state["ptr"], cap):
                return state["ptr"]
        raise RuntimeError(f"no resumed EIS device with capability {cap}")

    def _absolute_motion_for_device(self, device, x, y):
        if not self.lib.ei_device_has_capability(device, EI_CAP_POINTER_ABSOLUTE):
            return None
        region = self.lib.ei_device_get_region_at(device, float(x), float(y))
        if not region:
            return None
        motion_x = ctypes.c_double(float(x))
        motion_y = ctypes.c_double(float(y))
        if not self.lib.ei_region_convert_point(region, ctypes.byref(motion_x), ctypes.byref(motion_y)):
            raise RuntimeError(f"failed to convert desktop coordinate ({x}, {y}) into the selected EIS region")
        return motion_x.value, motion_y.value

    def device_for_absolute(self, x, y):
        candidates = []

        # Preserve pointer identity across absolute motion whenever the current
        # device still covers the destination. This is required for pointer
        # capture during drags: switching EIS devices mid-gesture can drop the
        # captured pointer before its button release is observed.
        preferred = self.devices.get(self.pointer_device_key)
        if preferred and preferred["resumed"] and preferred["emulating"]:
            device = preferred["ptr"]
            if self.lib.ei_device_has_capability(device, EI_CAP_POINTER_ABSOLUTE):
                candidates.append(device)
                converted = self._absolute_motion_for_device(device, x, y)
                if converted is not None:
                    return device, converted[0], converted[1]

        for state in self.devices.values():
            if not state["resumed"] or not state["emulating"]:
                continue
            device = state["ptr"]
            if preferred and self._device_key(device) == self.pointer_device_key:
                continue
            if not self.lib.ei_device_has_capability(device, EI_CAP_POINTER_ABSOLUTE):
                continue
            candidates.append(device)
            converted = self._absolute_motion_for_device(device, x, y)
            if converted is not None:
                return device, converted[0], converted[1]
        if candidates:
            raise RuntimeError(f"no absolute-pointer EIS region contains desktop coordinate ({x}, {y})")
        raise RuntimeError("no resumed EIS device with absolute-pointer capability")

    def device_for_pointer_context(self, cap):
        state = self.devices.get(self.pointer_device_key)
        if (
            state
            and state["resumed"]
            and state["emulating"]
            and self.lib.ei_device_has_capability(state["ptr"], cap)
        ):
            return state["ptr"]
        if self.pointer_position is not None:
            x, y = self.pointer_position
            for candidate in self.devices.values():
                if not candidate["resumed"] or not candidate["emulating"]:
                    continue
                device = candidate["ptr"]
                if not self.lib.ei_device_has_capability(device, cap):
                    continue
                if self.lib.ei_device_get_region_at(device, float(x), float(y)):
                    return device
        return self.device_for(cap)

    def remember_pointer(self, device, position=None):
        self.pointer_device_key = self._device_key(device)
        self.pointer_position = position

    def frame(self, device):
        self.lib.ei_device_frame(device, self.lib.ei_now(self.ei))

    def command(self, payload):
        op = str(payload.get("op") or "")
        if op == "key":
            device = self.device_for(EI_CAP_KEYBOARD)
            self.lib.ei_device_keyboard_key(device, int(payload["keycode"]), bool(payload.get("pressed")))
            self.frame(device)
        elif op == "motion":
            device = self.device_for(EI_CAP_POINTER)
            self.lib.ei_device_pointer_motion(device, float(payload.get("dx", 0)), float(payload.get("dy", 0)))
            self.remember_pointer(device)
            self.frame(device)
        elif op == "motion_absolute":
            x = float(payload["x"])
            y = float(payload["y"])
            device, motion_x, motion_y = self.device_for_absolute(x, y)
            self.lib.ei_device_pointer_motion_absolute(device, motion_x, motion_y)
            self.remember_pointer(device, (x, y))
            self.frame(device)
        elif op == "button":
            button = int(payload["button"])
            pressed = bool(payload.get("pressed"))
            if pressed:
                device = self.device_for_pointer_context(EI_CAP_BUTTON)
                self.button_device_keys[button] = self._device_key(device)
            else:
                key = self.button_device_keys.pop(button, None)
                state = self.devices.get(key) if key else None
                if (
                    state
                    and state["resumed"]
                    and state["emulating"]
                    and self.lib.ei_device_has_capability(state["ptr"], EI_CAP_BUTTON)
                ):
                    device = state["ptr"]
                else:
                    device = self.device_for_pointer_context(EI_CAP_BUTTON)
            self.lib.ei_device_button_button(device, button, pressed)
            self.frame(device)
        elif op == "scroll":
            device = self.device_for_pointer_context(EI_CAP_SCROLL)
            self.lib.ei_device_scroll_discrete(device, int(payload.get("dx", 0)), int(payload.get("dy", 0)))
            self.frame(device)
        elif op == "ping":
            pass
        elif op == "close":
            return False
        else:
            raise ValueError(f"unsupported EIS operation: {op}")
        return True

    def close(self):
        for state in list(self.devices.values()):
            if state["emulating"]:
                try:
                    self.lib.ei_device_stop_emulating(state["ptr"])
                except Exception:
                    pass
            try:
                self.lib.ei_device_unref(state["ptr"])
            except Exception:
                pass
        self.devices.clear()
        self.button_device_keys.clear()
        if self.ei:
            self.lib.ei_unref(self.ei)
            self.ei = None
