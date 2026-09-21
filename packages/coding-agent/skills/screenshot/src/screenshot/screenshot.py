"""Capture the screen on native Windows and attach it to the model's context."""

from __future__ import annotations

import base64
import io
import os
import tempfile
import time
from pathlib import Path

# Keep in sync with ATTACHMENT_DISPLAY_MIME in src/core/kernel/index.ts.
_ATTACHMENT_DISPLAY_MIME = "application/vnd.prime-agent.attachment+json"

# Same caps as the attach-image skill so emitted attachments stay small enough
# for daemon clients to render and replay without megabytes of base64.
_MAX_ATTACHMENT_DATA_CHARS = 350_000
_MAX_ATTACHMENT_DIMENSION = 1200
_JPEG_QUALITIES = (82, 72, 60, 48, 36)

_SM_XVIRTUALSCREEN = 76
_SM_YVIRTUALSCREEN = 77
_DWMWA_EXTENDED_FRAME_BOUNDS = 9
_MONITORINFOF_PRIMARY = 1
_MAX_LISTED_TITLES = 15

Rect = tuple[int, int, int, int]


def _require_windows() -> None:
    if os.name != "nt":
        raise RuntimeError("screenshot() is available on native Windows only")


# ---------------------------------------------------------------------------
# Win32 enumeration (Windows only; pure helpers below take the results as data)
# ---------------------------------------------------------------------------


def _virtual_screen_origin() -> tuple[int, int]:
    _require_windows()
    import ctypes

    user32 = ctypes.windll.user32
    return user32.GetSystemMetrics(_SM_XVIRTUALSCREEN), user32.GetSystemMetrics(_SM_YVIRTUALSCREEN)


def _enum_monitors() -> list[Rect]:
    """All monitor rectangles in virtual-screen coordinates, primary first."""
    _require_windows()
    import ctypes
    from ctypes import wintypes

    class MONITORINFO(ctypes.Structure):
        _fields_ = [
            ("cbSize", wintypes.DWORD),
            ("rcMonitor", wintypes.RECT),
            ("rcWork", wintypes.RECT),
            ("dwFlags", wintypes.DWORD),
        ]

    user32 = ctypes.windll.user32
    rects: list[tuple[Rect, bool]] = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HMONITOR, wintypes.HDC, ctypes.POINTER(wintypes.RECT), wintypes.LPARAM)
    def _callback(hmon, _hdc, rect_ptr, _lparam):
        info = MONITORINFO()
        info.cbSize = ctypes.sizeof(MONITORINFO)
        if user32.GetMonitorInfoW(hmon, ctypes.byref(info)):
            r = info.rcMonitor
            rects.append(((r.left, r.top, r.right, r.bottom), bool(info.dwFlags & _MONITORINFOF_PRIMARY)))
        return True

    user32.EnumDisplayMonitors(None, None, _callback, 0)
    rects.sort(key=lambda item: not item[1])
    return [rect for rect, _primary in rects]


def _enum_windows() -> list[tuple[int, str]]:
    """Visible top-level windows as (hwnd, title) pairs."""
    _require_windows()
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    windows: list[tuple[int, str]] = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def _callback(hwnd, _lparam):
        if user32.IsWindowVisible(hwnd):
            length = user32.GetWindowTextLengthW(hwnd)
            if length > 0:
                buffer = ctypes.create_unicode_buffer(length + 1)
                user32.GetWindowTextW(hwnd, buffer, length + 1)
                if buffer.value:
                    windows.append((hwnd, buffer.value))
        return True

    user32.EnumWindows(_callback, 0)
    return windows


def _window_frame_rect(hwnd: int) -> Rect:
    """Extended (DWM) frame bounds, falling back to GetWindowRect."""
    _require_windows()
    import ctypes
    from ctypes import wintypes

    rect = wintypes.RECT()
    try:
        result = ctypes.windll.dwmapi.DwmGetWindowAttribute(
            hwnd, _DWMWA_EXTENDED_FRAME_BOUNDS, ctypes.byref(rect), ctypes.sizeof(rect)
        )
        if result == 0:
            return rect.left, rect.top, rect.right, rect.bottom
    except (AttributeError, OSError):
        pass
    if not ctypes.windll.user32.GetWindowRect(hwnd, ctypes.byref(rect)):
        raise RuntimeError(f"could not read the bounds of window {hwnd}")
    return rect.left, rect.top, rect.right, rect.bottom


def _default_grab():
    _require_windows()
    from PIL import ImageGrab

    return ImageGrab.grab(all_screens=True)


# ---------------------------------------------------------------------------
# Pure helpers (injected inputs; unit-testable without a display)
# ---------------------------------------------------------------------------


def _pick_monitor_rect(monitors: list[Rect], monitor: int) -> Rect:
    if monitor < 1 or monitor > len(monitors):
        raise ValueError(
            f"monitor {monitor} is out of range; {len(monitors)} monitor(s) detected "
            f"(1 is the primary display)"
        )
    return monitors[monitor - 1]


def _match_window(windows: list[tuple[int, str]], target: str) -> tuple[int, str]:
    needle = target.casefold()
    for hwnd, title in windows:
        if needle in title.casefold():
            return hwnd, title
    listed = "; ".join(repr(title) for _hwnd, title in windows[:_MAX_LISTED_TITLES]) or "none"
    raise ValueError(
        f"no visible window title contains {target!r}. Visible windows (up to "
        f"{_MAX_LISTED_TITLES}): {listed}"
    )


def _normalize_region(region: tuple[int, int, int, int]) -> Rect:
    x, y, width, height = region
    if width <= 0 or height <= 0:
        raise ValueError(f"region width and height must be positive, got {region}")
    return x, y, x + width, y + height


def _to_local(box: Rect, origin: tuple[int, int]) -> Rect:
    """Convert virtual-screen coordinates into the grabbed image's frame."""
    left, top, right, bottom = box
    return left - origin[0], top - origin[1], right - origin[0], bottom - origin[1]


def _clamp(box: Rect, size: tuple[int, int]) -> Rect:
    left, top, right, bottom = box
    left, top = max(0, left), max(0, top)
    right, bottom = min(size[0], right), min(size[1], bottom)
    if right <= left or bottom <= top:
        raise ValueError(f"capture rectangle {box} lies outside the {size[0]}x{size[1]} screen grab")
    return left, top, right, bottom


def _base64_chars(data: bytes) -> int:
    return ((len(data) + 2) // 3) * 4


def _encode_jpeg(image, quality: int) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=quality, optimize=True, progressive=True)
    return buffer.getvalue()


def _attachment_payload(image, path: Path) -> tuple[dict, str]:
    """Resize/compress like attach_image; return (payload, "WxH mime" note)."""
    from PIL import Image
    original_width, original_height = image.size
    scale = min(1.0, _MAX_ATTACHMENT_DIMENSION / max(original_width, original_height))
    target_width = max(1, round(original_width * scale))
    target_height = max(1, round(original_height * scale))

    png_data = path.read_bytes()
    if max(image.size) <= _MAX_ATTACHMENT_DIMENSION and _base64_chars(png_data) <= _MAX_ATTACHMENT_DATA_CHARS:
        return (
            {"mime_type": "image/png", "data": base64.b64encode(png_data).decode("ascii"), "path": str(path)},
            f"{original_width}x{original_height} image/png",
        )

    rgb = image.convert("RGB")
    last_data = b""
    while target_width >= 1 and target_height >= 1:
        resized = rgb.resize((target_width, target_height), Image.Resampling.LANCZOS)
        for quality in _JPEG_QUALITIES:
            candidate = _encode_jpeg(resized, quality)
            last_data = candidate
            if _base64_chars(candidate) <= _MAX_ATTACHMENT_DATA_CHARS:
                return (
                    {
                        "mime_type": "image/jpeg",
                        "data": base64.b64encode(candidate).decode("ascii"),
                        "path": str(path),
                    },
                    f"{target_width}x{target_height} image/jpeg",
                )
        next_width = max(1, int(target_width * 0.75))
        next_height = max(1, int(target_height * 0.75))
        if next_width == target_width and next_height == target_height:
            break
        target_width, target_height = next_width, next_height

    raise ValueError(
        f"screenshot could not be compressed below {_MAX_ATTACHMENT_DATA_CHARS // 1000}KB "
        f"base64 (smallest was {_base64_chars(last_data) // 1000}KB)"
    )


# ---------------------------------------------------------------------------
# entry point
# ---------------------------------------------------------------------------


async def run(
    target: str | None = None,
    *,
    monitor: int | None = None,
    region: tuple[int, int, int, int] | None = None,
    save: str | None = None,
    _grab=None,
    _emit=None,
    _model_info=None,
    _windows: list[tuple[int, str]] | None = None,
    _monitors: list[Rect] | None = None,
    _origin: tuple[int, int] | None = None,
) -> str:
    """Capture the screen and attach the image to the model's context.

    Captures the interactive Windows desktop so the model can SEE it — a GUI,
    dialog, error box, or window state. Not for images that already exist on
    disk (use attach_image) and not for programmatic pixel analysis (open the
    saved PNG with PIL instead).

    Args:
        target: Case-insensitive substring of a visible window title to capture
            (e.g. "Visual Studio Code").
        monitor: 1-based monitor index to capture; 1 is the primary display.
        region: (x, y, width, height) in virtual-screen coordinates.
        save: Where to write the PNG. Default %TEMP%\\prime-agent-screenshots\\
            <timestamp>.png.

    Returns:
        A short confirmation with the captured size, source, save path, and the
        dimensions/mime of the attached image.

    Raises:
        RuntimeError: Off Windows, or if the current model cannot accept images.
        ValueError: No window title matches, the monitor index is out of range,
            or the region is invalid.
    """
    _require_windows()

    model_info = _model_info
    if model_info is None:
        from rlm import host_request

        model_info = await host_request("model.info")
    if "image" not in model_info.get("input", []):
        model_id = model_info.get("id") or "the current model"
        raise RuntimeError(
            f"{model_id} does not support vision. "
            "Tell the user to switch to a vision-capable model to capture screenshots."
        )

    grab = _grab or _default_grab
    image = grab()

    origin = _origin if _origin is not None else _virtual_screen_origin()
    describe = "full screen"
    box: Rect | None = None
    if region is not None:
        box = _normalize_region(region)
        describe = f"region {region[2]}x{region[3]}+{region[0]}+{region[1]}"
    elif monitor is not None:
        monitors = _monitors if _monitors is not None else _enum_monitors()
        box = _pick_monitor_rect(monitors, monitor)
        describe = f"monitor {monitor}"
    elif target is not None:
        windows = _windows if _windows is not None else _enum_windows()
        hwnd, title = _match_window(windows, target)
        # Tests may inject rect tuples in place of real hwnds.
        box = hwnd if isinstance(hwnd, tuple) else _window_frame_rect(hwnd)
        describe = f"window '{title}'"

    if box is not None:
        image = image.crop(_clamp(_to_local(box, origin), image.size))

    if save:
        out_path = Path(save).expanduser()
        out_path.parent.mkdir(parents=True, exist_ok=True)
    else:
        out_dir = Path(tempfile.gettempdir()) / "prime-agent-screenshots"
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / f"{time.strftime('%Y%m%d-%H%M%S')}.png"
    image.save(out_path, format="PNG")

    payload, attached_note = _attachment_payload(image, out_path)
    emit = _emit
    if emit is None:
        from rlm import emit as emit
    emit(
        {
            _ATTACHMENT_DISPLAY_MIME: payload,
            "text/plain": f"Loaded screenshot into context: {out_path}",
        }
    )

    return f"screenshot {image.size[0]}x{image.size[1]} ({describe}) saved {out_path}; attached as {attached_note}"
