"""Tray icon with a Hebrew menu, and the "חיבור לשרת" pairing window (plain Win32 via pywin32)."""

import ctypes
import datetime as dt
import logging
import os
import sys
import threading
import webbrowser
from pathlib import Path

import win32api
import win32con
import win32gui

from . import api, settings
from .version import APP_NAME

log = logging.getLogger("connector")

WM_TRAY = win32con.WM_USER + 20
WM_APP_REFRESH = win32con.WM_APP + 1
WM_APP_QUIT = win32con.WM_APP + 2
WM_APP_PAIRED = win32con.WM_APP + 3
WM_APP_ASK_ACTIVATE = win32con.WM_APP + 4
TPM_LAYOUTRTL = 0x8000
WS_EX_LAYOUTRTL = 0x00400000

ID_SYNC, ID_PAUSE_IN, ID_PAUSE_OUT, ID_SITE, ID_LOG, ID_PAIR, ID_EXIT, ID_ACTIVATE = range(1001, 1009)
BTN_MOVE, BTN_STAY = 101, 102
ID_CODE, ID_CONNECT, ID_MSG = 2001, 2002, 2003


def logged(fn):
    """Window-procedure handlers run without a console: log their errors instead of losing them."""
    def wrapper(*args):
        try:
            return fn(*args)
        except Exception:
            log.exception("UI handler %s failed", getattr(fn, "__name__", fn))
            return 0
    return wrapper


def resource_dir():
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    return Path(__file__).resolve().parents[2]  # connector/windows


def load_icon(name):
    path = resource_dir() / "icons" / f"{name}.ico"
    flags = win32con.LR_LOADFROMFILE | win32con.LR_DEFAULTSIZE
    try:
        return win32gui.LoadImage(0, str(path), win32con.IMAGE_ICON, 0, 0, flags)
    except Exception:
        return win32gui.LoadIcon(0, win32con.IDI_APPLICATION)


def dpi_scale():
    try:
        return ctypes.windll.user32.GetDpiForSystem() / 96.0
    except Exception:
        return 1.0


class TASKDIALOG_BUTTON(ctypes.Structure):
    _pack_ = 1
    _fields_ = [("nButtonID", ctypes.c_int), ("pszButtonText", ctypes.c_wchar_p)]


class TASKDIALOGCONFIG(ctypes.Structure):
    _pack_ = 1  # commctrl.h declares the task dialog structures with pshpack1
    _fields_ = [
        ("cbSize", ctypes.c_uint), ("hwndParent", ctypes.c_void_p), ("hInstance", ctypes.c_void_p),
        ("dwFlags", ctypes.c_int), ("dwCommonButtons", ctypes.c_int),
        ("pszWindowTitle", ctypes.c_wchar_p), ("pszMainIcon", ctypes.c_void_p),
        ("pszMainInstruction", ctypes.c_wchar_p), ("pszContent", ctypes.c_wchar_p),
        ("cButtons", ctypes.c_uint), ("pButtons", ctypes.POINTER(TASKDIALOG_BUTTON)),
        ("nDefaultButton", ctypes.c_int),
        ("cRadioButtons", ctypes.c_uint), ("pRadioButtons", ctypes.c_void_p),
        ("nDefaultRadioButton", ctypes.c_int),
        ("pszVerificationText", ctypes.c_wchar_p), ("pszExpandedInformation", ctypes.c_wchar_p),
        ("pszExpandedControlText", ctypes.c_wchar_p), ("pszCollapsedControlText", ctypes.c_wchar_p),
        ("pszFooterIcon", ctypes.c_void_p), ("pszFooter", ctypes.c_wchar_p),
        ("pfCallback", ctypes.c_void_p), ("lpCallbackData", ctypes.c_void_p),
        ("cxWidth", ctypes.c_uint),
    ]


TDF_ALLOW_DIALOG_CANCELLATION = 0x0008
TDF_RTL_LAYOUT = 0x2000
TD_INFORMATION_ICON = 0xFFFD  # MAKEINTRESOURCE(-3)


def choose(hwnd, title, text, buttons, default):
    """A Hebrew (RTL) question with own button labels; returns the chosen id, or None on cancel.
    buttons: [(id, label), ...]. Falls back to a Yes/No MessageBox without comctl32 v6."""
    try:
        fn = ctypes.windll.comctl32.TaskDialogIndirect
        arr = (TASKDIALOG_BUTTON * len(buttons))(*[TASKDIALOG_BUTTON(i, t) for i, t in buttons])
        cfg = TASKDIALOGCONFIG()
        cfg.cbSize = ctypes.sizeof(TASKDIALOGCONFIG)
        cfg.hwndParent = hwnd or None
        cfg.dwFlags = TDF_ALLOW_DIALOG_CANCELLATION | TDF_RTL_LAYOUT
        cfg.pszWindowTitle = APP_NAME
        cfg.pszMainIcon = TD_INFORMATION_ICON
        cfg.pszMainInstruction = title
        cfg.pszContent = text
        cfg.cButtons = len(buttons)
        cfg.pButtons = arr
        cfg.nDefaultButton = default
        chosen = ctypes.c_int(0)
        hr = fn(ctypes.byref(cfg), ctypes.byref(chosen), None, None)
        if hr != 0:
            raise OSError(f"TaskDialogIndirect 0x{hr & 0xFFFFFFFF:08x}")
        ids = [i for i, _ in buttons]
        return chosen.value if chosen.value in ids else None
    except (AttributeError, OSError) as e:
        log.info("task dialog unavailable (%s); using a message box", e)
    labels = " / ".join(f"{t}" for _, t in buttons[:2])
    flags = (win32con.MB_YESNO | win32con.MB_ICONQUESTION | win32con.MB_RTLREADING | win32con.MB_RIGHT
             | win32con.MB_SETFOREGROUND)
    if default == buttons[1][0]:
        flags |= win32con.MB_DEFBUTTON2
    ans = win32api.MessageBox(hwnd or 0, f"{title}\n\n{text}\n\n(כן / לא = {labels})", APP_NAME, flags)
    return buttons[0][0] if ans == win32con.IDYES else buttons[1][0]


def ui_font(scale, bold=False):
    lf = win32gui.LOGFONT()
    lf.lfFaceName = "Segoe UI"
    lf.lfHeight = -int(round(12 * scale))
    lf.lfWeight = 600 if bold else 400
    return win32gui.CreateFontIndirect(lf)


class TrayApp:
    def __init__(self, engine):
        self.engine = engine
        self.hinst = win32api.GetModuleHandle(None)
        self.icons = {c: load_icon(c) for c in ("green", "yellow", "red", "grey", "blue")}
        self.pair_window = None
        self.taskbar_created = win32gui.RegisterWindowMessage("TaskbarCreated")
        wc = win32gui.WNDCLASS()
        wc.hInstance = self.hinst
        wc.lpszClassName = "AlexLinkTray"
        wc.lpfnWndProc = {
            WM_TRAY: logged(self.on_tray),
            win32con.WM_COMMAND: logged(self.on_command),
            WM_APP_REFRESH: logged(self.on_refresh),
            WM_APP_QUIT: logged(self.on_quit),
            WM_APP_ASK_ACTIVATE: logged(self.on_ask_activate),
            win32con.WM_DESTROY: logged(self.on_destroy),
            self.taskbar_created: logged(self.on_taskbar_created),
        }
        win32gui.RegisterClass(wc)
        self.hwnd = win32gui.CreateWindow("AlexLinkTray", APP_NAME, 0, 0, 0, 0, 0, 0, 0,
                                          self.hinst, None)
        self.colour = None
        self.add_icon()

    # ---------------------------------------------------------------- icon

    def tip(self):
        _, text = self.engine.status()
        return f"{APP_NAME} — {text}"[:127]

    def add_icon(self):
        colour, _ = self.engine.status()
        self.colour = colour
        nid = (self.hwnd, 0, win32gui.NIF_ICON | win32gui.NIF_MESSAGE | win32gui.NIF_TIP,
               WM_TRAY, self.icons[colour], self.tip())
        win32gui.Shell_NotifyIcon(win32gui.NIM_ADD, nid)

    def refresh_icon(self):
        colour, _ = self.engine.status()
        self.colour = colour
        nid = (self.hwnd, 0, win32gui.NIF_ICON | win32gui.NIF_TIP, WM_TRAY, self.icons[colour], self.tip())
        try:
            win32gui.Shell_NotifyIcon(win32gui.NIM_MODIFY, nid)
        except Exception:
            pass

    def balloon(self, title, text):
        nid = (self.hwnd, 0, win32gui.NIF_INFO, WM_TRAY, self.icons[self.colour or "grey"], self.tip(),
               text[:255], 10, title[:63], win32gui.NIIF_INFO)
        try:
            win32gui.Shell_NotifyIcon(win32gui.NIM_MODIFY, nid)
        except Exception:
            pass

    # thread-safe: worker threads only post messages
    def notify(self, quit_app=False):
        try:
            win32gui.PostMessage(self.hwnd, WM_APP_QUIT if quit_app else WM_APP_REFRESH, 0, 0)
        except Exception:
            pass

    # ---------------------------------------------------------------- menu

    def show_menu(self):
        e = self.engine
        colour, text = e.status()
        p_in, p_out = settings.pause_state()
        menu = win32gui.CreatePopupMenu()
        grey = win32con.MF_STRING | win32con.MF_GRAYED
        if e.syncing:
            text += " · מסנכרן…"
        win32gui.AppendMenu(menu, grey, 0, f"מצב: {text}")
        last = e.last_sync_at.strftime("%d.%m %H:%M") if e.last_sync_at else "—"
        win32gui.AppendMenu(menu, grey, 0, f"סנכרון אחרון: {last}")
        if e.last_error:
            when, err = e.last_error
            win32gui.AppendMenu(menu, grey, 0, f"שגיאה אחרונה ({when:%H:%M}): {err[:70]}")
        win32gui.AppendMenu(menu, win32con.MF_SEPARATOR, 0, "")
        paired = e.paired()
        on = win32con.MF_STRING if paired else grey
        if paired and e.standby():
            win32gui.AppendMenu(menu, win32con.MF_STRING, ID_ACTIVATE, "העבר לכאן")
        else:
            win32gui.AppendMenu(menu, on, ID_SYNC, "סנכרן עכשיו")
        win32gui.AppendMenu(menu, on | (win32con.MF_CHECKED if p_in else 0), ID_PAUSE_IN, "השהה קליטת מיילים")
        win32gui.AppendMenu(menu, on | (win32con.MF_CHECKED if p_out else 0), ID_PAUSE_OUT, "השהה שליחת מיילים")
        win32gui.AppendMenu(menu, win32con.MF_SEPARATOR, 0, "")
        site = win32con.MF_STRING if e.cfg.get("site_url") else grey
        win32gui.AppendMenu(menu, site, ID_SITE, "פתח את Alex Tasks")
        win32gui.AppendMenu(menu, win32con.MF_STRING, ID_LOG, "פתח יומן")
        win32gui.AppendMenu(menu, win32con.MF_STRING, ID_PAIR,
                            "החלף שרת / חיבור מחדש" if paired else "חיבור לשרת…")
        win32gui.AppendMenu(menu, win32con.MF_SEPARATOR, 0, "")
        win32gui.AppendMenu(menu, win32con.MF_STRING, ID_EXIT, "יציאה")
        x, y = win32gui.GetCursorPos()
        try:
            win32gui.SetForegroundWindow(self.hwnd)
        except Exception:
            pass  # Windows may refuse; the menu still opens
        win32gui.TrackPopupMenu(menu, win32con.TPM_RIGHTALIGN | win32con.TPM_BOTTOMALIGN | TPM_LAYOUTRTL,
                                x, y, 0, self.hwnd, None)
        win32gui.PostMessage(self.hwnd, win32con.WM_NULL, 0, 0)
        win32gui.DestroyMenu(menu)

    # ---------------------------------------------------------------- handlers

    def on_tray(self, hwnd, msg, wparam, lparam):
        if lparam in (win32con.WM_RBUTTONUP, win32con.WM_LBUTTONUP):
            self.show_menu()
        elif lparam == win32con.WM_LBUTTONDBLCLK and not self.engine.paired():
            self.open_pairing()
        return 0

    def on_command(self, hwnd, msg, wparam, lparam):
        cmd = win32api.LOWORD(wparam)
        e = self.engine
        if cmd == ID_SYNC and not e.standby():
            e.sync_now()
            self.balloon(APP_NAME, "הסנכרון התחיל")
        elif cmd == ID_ACTIVATE and e.standby():
            self.confirm_activate()
        elif cmd == ID_PAUSE_IN:
            toggle_pause(ingest=True)
            e.sync_now()
        elif cmd == ID_PAUSE_OUT:
            toggle_pause(ingest=False)
            e.sync_now()
        elif cmd == ID_SITE and e.cfg.get("site_url"):
            webbrowser.open(e.cfg["site_url"])
        elif cmd == ID_LOG:
            path = settings.LOG_DIR / "connector.log"
            os.startfile(str(path if path.exists() else settings.LOG_DIR))
        elif cmd == ID_PAIR:
            self.open_pairing()
        elif cmd == ID_EXIT:
            self.on_quit(hwnd, msg, 0, 0)
        self.refresh_icon()
        return 0

    def on_refresh(self, hwnd, msg, wparam, lparam):
        self.refresh_icon()
        for title, text in self.engine.take_toasts():
            self.balloon(title, text)
        return 0

    # ---------------------------------------------------------------- active / standby

    def where_text(self):
        e = self.engine
        name = e.active_name() or "אחר"
        seen = e.active_seen()
        return f"Alex Link פעיל כרגע במחשב {name}" + (f" (נראה לאחרונה {seen})" if seen else "") + "."

    def confirm_activate(self):
        """Tray menu "העבר לכאן"."""
        ans = choose(self.hwnd, "להעביר את העבודה למחשב הזה?",
                     self.where_text() + "\nאחרי ההעברה המחשב השני יעבור למצב המתנה.",
                     [(BTN_MOVE, "העבר לכאן"), (BTN_STAY, "ביטול")], BTN_STAY)
        if ans == BTN_MOVE:
            log.info("owner moved the work to this computer (tray menu)")
            self.engine.activate_async()

    def on_ask_activate(self, hwnd, msg, wparam, lparam):
        """Right after pairing as standby."""
        if not self.engine.standby():
            return 0
        ans = choose(self.hwnd, self.where_text(), "להעביר את העבודה למחשב הזה?",
                     [(BTN_MOVE, "העבר לכאן"), (BTN_STAY, "השאר במצב המתנה")], BTN_STAY)
        if ans == BTN_MOVE:
            log.info("owner moved the work to this computer (after pairing)")
            self.engine.activate_async()
        else:
            log.info("owner kept this computer in standby")
        self.refresh_icon()
        return 0

    def on_taskbar_created(self, hwnd, msg, wparam, lparam):
        self.add_icon()  # Explorer restarted
        return 0

    def on_quit(self, hwnd, msg, wparam, lparam):
        log.info("exit requested")
        self.engine.stop.set()
        self.engine.sync_now()
        win32gui.DestroyWindow(self.hwnd)
        return 0

    def on_destroy(self, hwnd, msg, wparam, lparam):
        try:
            win32gui.Shell_NotifyIcon(win32gui.NIM_DELETE, (self.hwnd, 0))
        except Exception:
            pass
        win32gui.PostQuitMessage(0)
        return 0

    # ---------------------------------------------------------------- pairing

    def open_pairing(self):
        if self.pair_window and win32gui.IsWindow(self.pair_window.hwnd):
            win32gui.ShowWindow(self.pair_window.hwnd, win32con.SW_RESTORE)
            win32gui.SetForegroundWindow(self.pair_window.hwnd)
            return
        self.pair_window = PairWindow(self)

    def paired_ok(self, server_name):
        self.engine.reload()
        self.engine.sync_now(heartbeat=True)
        self.refresh_icon()
        if self.engine.standby():
            self.balloon(APP_NAME, f"מחובר לשרת {server_name} — במצב המתנה".strip())
            win32gui.PostMessage(self.hwnd, WM_APP_ASK_ACTIVATE, 0, 0)
        else:
            self.balloon(APP_NAME, f"מחובר לשרת {server_name}".strip())

    def loop(self):
        while True:
            ok, msg = win32gui.GetMessage(None, 0, 0)
            if ok in (0, -1):
                break
            pw = self.pair_window
            if pw and win32gui.IsWindow(pw.hwnd):
                try:
                    if win32gui.IsDialogMessage(pw.hwnd, msg):
                        continue
                except Exception:
                    pass
            win32gui.TranslateMessage(msg)
            win32gui.DispatchMessage(msg)


def toggle_pause(ingest):
    """Tray toggles use PAUSE_INGEST / PAUSE_SEND; a manual PAUSE (both) is split up when toggled."""
    if settings.PAUSE_FILE.exists():
        settings.PAUSE_FILE.unlink(missing_ok=True)
        settings.set_pause(settings.PAUSE_INGEST_FILE, not ingest)
        settings.set_pause(settings.PAUSE_SEND_FILE, ingest)
        return
    path = settings.PAUSE_INGEST_FILE if ingest else settings.PAUSE_SEND_FILE
    settings.set_pause(path, not path.exists())
    log.info("%s %s from the tray", "ingest" if ingest else "sending",
             "paused" if path.exists() else "resumed")


def pair_role(body):
    """(role, {'name', 'last_contact_at'}) from the /ingest/pair answer; no role = active."""
    role = "standby" if body.get("role") == "standby" else "active"
    dev = body.get("active_device") if isinstance(body.get("active_device"), dict) else {}
    if role == "active":
        return role, {}
    return role, {"name": str(dev.get("name") or ""), "last_contact_at": str(dev.get("last_contact_at") or "")}


class PairWindow:
    """One field for the code (alex://<host>:8130/XXXX-XXXX) and a "חיבור" button."""

    registered = False

    def __init__(self, tray):
        self.tray = tray
        self.result = None
        s = dpi_scale()
        self.s = s
        hinst = tray.hinst
        if not PairWindow.registered:
            wc = win32gui.WNDCLASS()
            wc.hInstance = hinst
            wc.lpszClassName = "AlexLinkPair"
            wc.hbrBackground = win32con.COLOR_WINDOW + 1
            wc.hCursor = win32gui.LoadCursor(0, win32con.IDC_ARROW)
            wc.hIcon = tray.icons["green"]
            wc.lpfnWndProc = logged(PairWindow._dispatch)
            win32gui.RegisterClass(wc)
            PairWindow.registered = True
        PairWindow.current = self
        w, h = int(480 * s), int(250 * s)
        sx, sy = win32api.GetSystemMetrics(0), win32api.GetSystemMetrics(1)
        style = win32con.WS_OVERLAPPED | win32con.WS_CAPTION | win32con.WS_SYSMENU | win32con.WS_MINIMIZEBOX
        self.hwnd = win32gui.CreateWindowEx(
            win32con.WS_EX_RTLREADING | win32con.WS_EX_RIGHT | win32con.WS_EX_APPWINDOW,
            "AlexLinkPair", f"{APP_NAME} — חיבור לשרת", style,
            (sx - w) // 2, (sy - h) // 2, w, h, 0, 0, hinst, None)
        self.font = ui_font(s)
        self.bold = ui_font(s, bold=True)
        cw = win32gui.GetClientRect(self.hwnd)[2]
        m = int(20 * s)
        rtl = win32con.WS_EX_RTLREADING | win32con.WS_EX_RIGHT

        def ctl(cls, text, x, y, cw_, ch, style_, ex=0, cid=0, font=None):
            hw = win32gui.CreateWindowEx(ex, cls, text, win32con.WS_CHILD | win32con.WS_VISIBLE | style_,
                                         x, y, cw_, ch, self.hwnd, cid, hinst, None)
            win32gui.SendMessage(hw, win32con.WM_SETFONT, font or self.font, 1)
            return hw

        ctl("STATIC", "חיבור המחשב אל Alex Tasks", m, m, cw - 2 * m, int(24 * s), win32con.SS_RIGHT,
            rtl, font=self.bold)
        ctl("STATIC", "צור קוד חיבור באתר (הגדרות ← מחשב Outlook ← חבר מחשב חדש), "
                      "העתק אותו והדבק כאן:",
            m, m + int(30 * s), cw - 2 * m, int(40 * s), win32con.SS_RIGHT, rtl)
        self.edit = ctl("EDIT", "", m, m + int(78 * s), cw - 2 * m, int(28 * s),
                        win32con.WS_TABSTOP | win32con.ES_AUTOHSCROLL | win32con.ES_LEFT,
                        win32con.WS_EX_CLIENTEDGE | win32con.WS_EX_LTRREADING, ID_CODE)
        self.button = ctl("BUTTON", "חיבור", cw - m - int(110 * s), m + int(118 * s), int(110 * s),
                          int(32 * s), win32con.WS_TABSTOP | win32con.BS_DEFPUSHBUTTON | win32con.BS_CENTER, rtl, ID_CONNECT)
        self.msg = ctl("STATIC", "", m, m + int(124 * s), cw - 2 * m - int(122 * s), int(44 * s),
                       win32con.SS_RIGHT, rtl, ID_MSG)
        self.msg_is_error = False
        win32gui.ShowWindow(self.hwnd, win32con.SW_SHOW)
        win32gui.SetForegroundWindow(self.hwnd)
        win32gui.SetFocus(self.edit)

    @staticmethod
    def _dispatch(hwnd, msg, wparam, lparam):
        self = getattr(PairWindow, "current", None)
        if self is not None and getattr(self, "hwnd", None) == hwnd:
            if msg == win32con.WM_COMMAND and win32api.LOWORD(wparam) in (ID_CONNECT, win32con.IDOK):
                self.connect()
                return 0
            if msg == win32con.WM_CTLCOLORSTATIC:
                win32gui.SetBkMode(wparam, win32con.TRANSPARENT)
                if lparam == self.msg and self.msg_is_error:
                    win32gui.SetTextColor(wparam, win32api.RGB(200, 30, 30))
                return win32gui.GetSysColorBrush(win32con.COLOR_WINDOW)
            if msg == WM_APP_PAIRED:
                self.finish()
                return 0
            if msg == win32con.WM_CLOSE:
                win32gui.DestroyWindow(hwnd)
                return 0
        return win32gui.DefWindowProc(hwnd, msg, wparam, lparam)

    def say(self, text, error=False):
        self.msg_is_error = error
        win32gui.SetWindowText(self.msg, text)
        win32gui.InvalidateRect(self.msg, None, True)

    def connect(self):
        text = win32gui.GetWindowText(self.edit).strip()
        try:
            server_url, code = settings.parse_code(text)
        except ValueError:
            self.say("הקוד לא תקין. הוא צריך להיראות כך: alex://…:8130/XXXX-XXXX", error=True)
            return
        win32gui.EnableWindow(self.button, False)
        self.say("מתחבר…")

        def work():
            try:
                self.result = ("ok", server_url, api.pair(server_url, code))
            except api.PairError as e:
                self.result = ("error", str(e))
            except Exception as e:  # unexpected; keep details in the log only
                log.exception("pairing failed")
                self.result = ("error", f"שגיאה לא צפויה: {type(e).__name__}")
            win32gui.PostMessage(self.hwnd, WM_APP_PAIRED, 0, 0)

        threading.Thread(target=work, daemon=True).start()

    def finish(self):
        res = self.result
        if not res or res[0] != "ok":
            win32gui.EnableWindow(self.button, True)
            self.say(res[1] if res else "שגיאה", error=True)
            return
        _, server_url, body = res
        settings.save_secret(body["token"], body["outbox_sign_key"])
        cfg = settings.load_config()
        changed_server = cfg.get("server_url") and cfg["server_url"] != server_url
        cfg.update({"server_url": server_url, "device_id": body.get("device_id", ""),
                    "server_name": body.get("server_name", "")})
        if body.get("site_url"):
            cfg["site_url"] = body["site_url"]
        if changed_server or not cfg.get("mail_since"):
            cfg["mail_since"] = (dt.datetime.now() - dt.timedelta(days=1)).replace(microsecond=0).isoformat()
        role, dev = pair_role(body)
        cfg.update({"role": role, "active_device_name": dev.get("name", ""),
                    "active_device_seen": dev.get("last_contact_at", "")})
        settings.save_config(cfg)
        log.info("paired with %s as device %s, role %s", body.get("server_name") or server_url,
                 body.get("device_id"), role)
        win32gui.DestroyWindow(self.hwnd)
        self.tray.paired_ok(body.get("server_name", ""))
