"""Dependency and capture backend inventory. Does not request permission or capture."""
import sys
import argparse
import av
import aiortc
source = {"darwin": "avfoundation", "win32": "gdigrab"}.get(sys.platform)
if source and source not in av.formats_available:
    raise SystemExit("Installed PyAV wheel has no native screen backend")
parser = argparse.ArgumentParser()
parser.add_argument('--source', choices=['x11','portal','avfoundation','gdigrab'])
args = parser.parse_args()
if args.source == 'x11':
    if sys.platform != 'linux':
        raise SystemExit('X11 source requires Linux')
    import mss
elif sys.platform == "linux":
    sys.path.append("/usr/lib/python3/dist-packages")
    import gi
    gi.require_version("Gst", "1.0")
    from gi.repository import Gst
    Gst.init(None)
    if Gst.ElementFactory.find("pipewiresrc") is None:
        raise SystemExit("Install the distribution GStreamer PipeWire plugin before enabling screen media")
print("MEDIA_DEPENDENCIES_READY capture_started=false")
