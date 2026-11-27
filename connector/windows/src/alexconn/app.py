"""Alex Link: one process in the tray that pushes Outlook mail/calendar to Alex Tasks and
sends the mail the owner approved there.

  AlexLink.exe                       normal start (tray)
  AlexLink.exe --import-state DIR    copy state.json / outbox_state.json of the old
                                     script setup (DIR = its data folder), then exit
"""

import argparse
import logging
import shutil
import sys

import win32api
import win32con
import win32event
import winerror

from . import outlook_connector as oc
from . import settings
from .version import APP_NAME, MUTEX_NAME, VERSION

log = logging.getLogger("connector")


def message(text, error=False):
    flags = win32con.MB_RTLREADING | win32con.MB_RIGHT | win32con.MB_SETFOREGROUND
    flags |= win32con.MB_ICONERROR if error else win32con.MB_ICONINFORMATION
    win32api.MessageBox(0, text, APP_NAME, flags)


def import_state(src):
    from pathlib import Path
    src = Path(src)
    settings.ensure_dirs()
    copied = []
    for name in ("state.json", "outbox_state.json"):
        if (src / name).exists():
            target = settings.DATA_DIR / name
            if target.exists():
                shutil.copy2(target, target.with_suffix(".json.bak"))
            shutil.copy2(src / name, target)
            copied.append(name)
    log.info("imported state from the old setup: %s", copied or "nothing")
    return copied


def dpi_aware():
    """Sharp text on scaled displays; ui.dpi_scale() reads the system DPI."""
    import ctypes
    try:
        ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-2))  # SYSTEM_AWARE
    except (AttributeError, OSError):
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except (AttributeError, OSError):
            pass


def main(argv=None):
    dpi_aware()
    p = argparse.ArgumentParser(prog="AlexLink")
    p.add_argument("--import-state")
    a, _ = p.parse_known_args(argv)

    settings.ensure_dirs()
    oc.setup_logging(settings.LOCAL, verbose=False)  # LOCALAPPDATA\AlexLink\logs\connector.log

    mutex = win32event.CreateMutex(None, False, MUTEX_NAME)
    if win32api.GetLastError() == winerror.ERROR_ALREADY_EXISTS:
        if not a.import_state:
            message(f"{APP_NAME} כבר פועל. הסמל נמצא באזור ההודעות (ליד השעון).")
        return 0

    if a.import_state:
        copied = import_state(a.import_state)
        print("imported:", ", ".join(copied) or "nothing")
        return 0

    log.info("%s %s starting", APP_NAME, VERSION)
    from .ui import TrayApp
    from .worker import Engine

    tray = None
    engine = Engine(on_change=lambda **kw: tray and tray.notify(**kw))
    tray = TrayApp(engine)
    engine.start()
    if not engine.paired():
        tray.open_pairing()
    try:
        tray.loop()
    finally:
        engine.stop.set()
        log.info("%s stopped", APP_NAME)
        del mutex
    return 0


if __name__ == "__main__":
    sys.exit(main())
