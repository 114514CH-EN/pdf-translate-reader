"""Windows notification-area icon for the packaged app (no console window any more).

Left click / double click: open the reader. Right click: open the reader, open the
pet edition, open the log, quit. Pure ctypes — no extra dependency. Every failure
is swallowed: without a tray icon the app still works and can be closed from
设置 → 数据与安全 → 退出程序.
"""
from __future__ import annotations

import os
import sys
import threading

WM_DESTROY, WM_COMMAND, WM_CLOSE, WM_NULL = 0x0002, 0x0111, 0x0010, 0x0000
WM_LBUTTONUP, WM_LBUTTONDBLCLK, WM_RBUTTONUP, WM_CONTEXTMENU = 0x0202, 0x0203, 0x0205, 0x007B
WM_TRAY = 0x8000 + 1  # WM_APP + 1
NIM_ADD, NIM_MODIFY, NIM_DELETE = 0, 1, 2
NIF_MESSAGE, NIF_ICON, NIF_TIP, NIF_INFO = 1, 2, 4, 0x10
MF_STRING, MF_SEPARATOR = 0x0, 0x800
TPM_RIGHTBUTTON, TPM_RETURNCMD, TPM_NONOTIFY = 0x0002, 0x0100, 0x0080
ID_OPEN, ID_PET, ID_LOG, ID_QUIT = 1, 2, 3, 4

_state: dict = {}


def start(title: str, on_open, on_pet, on_quit, log_path: str | None = None, hint: str | None = None) -> bool:
    """Show the icon (in its own thread). Returns False when not on Windows."""
    if os.name != "nt":
        return False
    ready = threading.Event()
    t = threading.Thread(target=_run, args=(title, on_open, on_pet, on_quit, log_path, hint, ready),
                         name="tray", daemon=True)
    t.start()
    ready.wait(5)
    return bool(_state.get("ok"))


def stop() -> None:
    """Remove the icon (otherwise a dead icon stays until the mouse moves over it)."""
    try:
        import ctypes

        nid, hwnd = _state.get("nid"), _state.get("hwnd")
        if nid is not None:
            ctypes.windll.shell32.Shell_NotifyIconW(NIM_DELETE, ctypes.byref(nid))
            _state["nid"] = None
        if hwnd:
            ctypes.windll.user32.PostMessageW(hwnd, WM_CLOSE, 0, 0)
    except Exception:
        pass


def _run(title, on_open, on_pet, on_quit, log_path, hint, ready) -> None:
    try:
        import ctypes
        from ctypes import wintypes as wt

        user32, shell32, kernel32 = ctypes.windll.user32, ctypes.windll.shell32, ctypes.windll.kernel32
        LRESULT = ctypes.c_ssize_t
        WNDPROC = ctypes.WINFUNCTYPE(LRESULT, wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM)

        class WNDCLASSW(ctypes.Structure):
            _fields_ = [("style", wt.UINT), ("lpfnWndProc", WNDPROC), ("cbClsExtra", ctypes.c_int),
                        ("cbWndExtra", ctypes.c_int), ("hInstance", wt.HINSTANCE), ("hIcon", wt.HICON),
                        ("hCursor", wt.HANDLE), ("hbrBackground", wt.HANDLE), ("lpszMenuName", wt.LPCWSTR),
                        ("lpszClassName", wt.LPCWSTR)]

        class GUID(ctypes.Structure):
            _fields_ = [("a", wt.DWORD), ("b", wt.WORD), ("c", wt.WORD), ("d", ctypes.c_ubyte * 8)]

        class NOTIFYICONDATAW(ctypes.Structure):
            _fields_ = [("cbSize", wt.DWORD), ("hWnd", wt.HWND), ("uID", wt.UINT), ("uFlags", wt.UINT),
                        ("uCallbackMessage", wt.UINT), ("hIcon", wt.HICON), ("szTip", wt.WCHAR * 128),
                        ("dwState", wt.DWORD), ("dwStateMask", wt.DWORD), ("szInfo", wt.WCHAR * 256),
                        ("uVersion", wt.UINT), ("szInfoTitle", wt.WCHAR * 64), ("dwInfoFlags", wt.DWORD),
                        ("guidItem", GUID), ("hBalloonIcon", wt.HICON)]

        user32.DefWindowProcW.argtypes = [wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM]
        user32.DefWindowProcW.restype = LRESULT
        user32.CreateWindowExW.argtypes = [wt.DWORD, wt.LPCWSTR, wt.LPCWSTR, wt.DWORD, ctypes.c_int, ctypes.c_int,
                                           ctypes.c_int, ctypes.c_int, wt.HWND, wt.HMENU, wt.HINSTANCE, wt.LPVOID]
        user32.CreateWindowExW.restype = wt.HWND
        user32.RegisterClassW.argtypes = [ctypes.POINTER(WNDCLASSW)]
        user32.PostMessageW.argtypes = [wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM]
        user32.AppendMenuW.argtypes = [wt.HMENU, wt.UINT, ctypes.c_size_t, wt.LPCWSTR]
        user32.CreatePopupMenu.restype = wt.HMENU
        user32.TrackPopupMenu.argtypes = [wt.HMENU, wt.UINT, ctypes.c_int, ctypes.c_int, ctypes.c_int, wt.HWND, wt.LPVOID]
        user32.TrackPopupMenu.restype = ctypes.c_int
        user32.DestroyMenu.argtypes = [wt.HMENU]
        user32.SetForegroundWindow.argtypes = [wt.HWND]
        user32.DestroyWindow.argtypes = [wt.HWND]
        user32.GetMessageW.argtypes = [ctypes.POINTER(wt.MSG), wt.HWND, wt.UINT, wt.UINT]
        user32.RegisterWindowMessageW.argtypes = [wt.LPCWSTR]
        user32.RegisterWindowMessageW.restype = wt.UINT
        user32.LoadIconW.argtypes = [wt.HINSTANCE, wt.LPCWSTR]
        user32.LoadIconW.restype = wt.HICON
        shell32.ExtractIconW.argtypes = [wt.HINSTANCE, wt.LPCWSTR, wt.UINT]
        shell32.ExtractIconW.restype = wt.HICON
        shell32.Shell_NotifyIconW.argtypes = [wt.DWORD, ctypes.POINTER(NOTIFYICONDATAW)]
        kernel32.GetModuleHandleW.argtypes = [wt.LPCWSTR]
        kernel32.GetModuleHandleW.restype = wt.HINSTANCE

        hinst = kernel32.GetModuleHandleW(None)
        icon = shell32.ExtractIconW(hinst, sys.executable, 0)
        if not icon or icon == 1:
            icon = user32.LoadIconW(None, ctypes.cast(32512, wt.LPCWSTR))  # IDI_APPLICATION
        taskbar_created = user32.RegisterWindowMessageW("TaskbarCreated")

        def safe(fn) -> None:
            try:
                fn()
            except Exception:
                pass

        def menu(hwnd) -> None:
            m = user32.CreatePopupMenu()
            user32.AppendMenuW(m, MF_STRING, ID_OPEN, "打开阅读器")
            user32.AppendMenuW(m, MF_STRING, ID_PET, "打开桌宠版")
            if log_path:
                user32.AppendMenuW(m, MF_SEPARATOR, 0, None)
                user32.AppendMenuW(m, MF_STRING, ID_LOG, "查看运行日志")
            user32.AppendMenuW(m, MF_SEPARATOR, 0, None)
            user32.AppendMenuW(m, MF_STRING, ID_QUIT, "退出")
            pt = wt.POINT()
            user32.GetCursorPos(ctypes.byref(pt))
            user32.SetForegroundWindow(hwnd)  # or the menu does not close when clicking elsewhere
            cmd = user32.TrackPopupMenu(m, TPM_RIGHTBUTTON | TPM_RETURNCMD | TPM_NONOTIFY, pt.x, pt.y, 0, hwnd, None)
            user32.PostMessageW(hwnd, WM_NULL, 0, 0)
            user32.DestroyMenu(m)
            if cmd == ID_OPEN:
                safe(on_open)
            elif cmd == ID_PET:
                safe(on_pet)
            elif cmd == ID_LOG and log_path:
                safe(lambda: os.startfile(log_path))  # noqa: S606 — the app's own log file
            elif cmd == ID_QUIT:
                stop()
                safe(on_quit)

        def proc(hwnd, msg, wparam, lparam):
            if msg == WM_TRAY:
                if lparam in (WM_LBUTTONUP, WM_LBUTTONDBLCLK):
                    safe(on_open)
                elif lparam in (WM_RBUTTONUP, WM_CONTEXTMENU):
                    safe(lambda: menu(hwnd))
                return 0
            if msg == taskbar_created and _state.get("nid") is not None:  # Explorer restarted: put the icon back
                shell32.Shell_NotifyIconW(NIM_ADD, ctypes.byref(_state["nid"]))
                return 0
            if msg == WM_DESTROY:
                user32.PostQuitMessage(0)
                return 0
            return user32.DefWindowProcW(hwnd, msg, wparam, lparam)

        wndproc = WNDPROC(proc)
        cls = WNDCLASSW()
        cls.lpfnWndProc = wndproc
        cls.hInstance = hinst
        cls.lpszClassName = "PDFTranslateTray"
        user32.RegisterClassW(ctypes.byref(cls))
        hwnd = user32.CreateWindowExW(0, cls.lpszClassName, title, 0, 0, 0, 0, 0, None, None, hinst, None)
        if not hwnd:
            raise OSError("CreateWindowExW failed")

        nid = NOTIFYICONDATAW()
        nid.cbSize = ctypes.sizeof(NOTIFYICONDATAW)
        nid.hWnd = hwnd
        nid.uID = 1
        nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP
        nid.uCallbackMessage = WM_TRAY
        nid.hIcon = icon
        nid.szTip = title[:127]
        if hint:  # first start: say where the program went
            nid.uFlags |= NIF_INFO
            nid.szInfo = hint[:255]
            nid.szInfoTitle = title[:63]
            nid.dwInfoFlags = 1  # NIIF_INFO
        ok = bool(shell32.Shell_NotifyIconW(NIM_ADD, ctypes.byref(nid)))
        nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP
        _state.update(ok=ok, nid=nid if ok else None, hwnd=hwnd, keep=(wndproc, cls))
        print(f"[tray] {'ready' if ok else 'icon could not be added'}", flush=True)
        ready.set()

        msg = wt.MSG()
        while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
            user32.TranslateMessage(ctypes.byref(msg))
            user32.DispatchMessageW(ctypes.byref(msg))
    except Exception as e:  # noqa: BLE001
        _state["ok"] = False
        try:
            print(f"[tray] unavailable: {e!r}", flush=True)
        except Exception:
            pass
        ready.set()
