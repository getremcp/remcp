"""Finite screen encoding budgets shared by all native capture backends."""
VIDEO_PROFILES = {
    "economy": (854, 480, 24),
    "balanced": (1280, 720, 15),
    "smooth": (1280, 720, 30),
    "sharp": (1920, 1080, 24),
}


def video_profile(name):
    if type(name) is not str or name not in VIDEO_PROFILES:
        raise ValueError("Unsupported bounded capture video profile")
    return VIDEO_PROFILES[name]
