"""Native-Windows tests for the bundled screenshot skill.

Invoked by test-windows-runtime.py. Stage 1 (any interpreter) creates a fresh
uv venv, installs the skill editable plus pillow the way the kernel bootstrap
does (`uv pip install --editable`), then re-execs this file under the venv
python. Stage 2 runs the unittest suite: pure-part tests with injected grabs,
window and monitor lists, plus one real full-screen capture.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

if os.name != "nt":
    sys.exit("test-windows-screenshot.py exercises the native Windows skill only")

_REPO = Path(__file__).resolve().parents[1]
_SKILL_DIR = _REPO / "packages" / "coding-agent" / "skills" / "screenshot"
_VENV_MARKER = "PRIME_SCREENSHOT_TEST_PYTHON"


def _uv() -> str:
    # The parent harness may pass a pre-scrub location: its setUpModule replaces
    # PATH before spawning us, so PATH alone cannot be trusted here.
    override = os.environ.get("PRIME_SCREENSHOT_UV")
    if override:
        if Path(override).is_file():
            return override
        raise RuntimeError(f"PRIME_SCREENSHOT_UV points at a missing file: {override}")
    uv = shutil.which("uv")
    if uv:
        return uv
    for candidate in (
        Path(os.environ.get("LOCALAPPDATA", "")) / "hermes" / "bin" / "uv.exe",
        Path.home() / ".local" / "bin" / "uv.exe",
    ):
        if candidate.is_file():
            return str(candidate)
    raise RuntimeError(
        "uv not found: PRIME_SCREENSHOT_UV unset and no uv on PATH or in the "
        "known install locations")


if not os.environ.get(_VENV_MARKER):
    work = Path(tempfile.mkdtemp(prefix="prime-screenshot-test-"))
    venv_python = work / "venv" / "Scripts" / "python.exe"
    uv = _uv()

    def _run(args: list[str]) -> None:
        result = subprocess.run(args, capture_output=True, text=True)
        if result.returncode != 0:
            raise RuntimeError(f"{' '.join(args)} failed:\n{result.stdout}\n{result.stderr}")

    _run([uv, "venv", str(work / "venv")])
    # --no-deps: prime-agent-runtime is not published; tests inject its
    # touchpoints (_emit/_model_info) so rlm is never imported.
    _run([uv, "pip", "install", "--python", str(venv_python), "--no-deps", "--editable", str(_SKILL_DIR)])
    _run([uv, "pip", "install", "--python", str(venv_python), "pillow>=10.0.0"])

    env = dict(os.environ)
    env[_VENV_MARKER] = str(venv_python)
    result = subprocess.run([str(venv_python), str(Path(__file__).resolve())], env=env)
    sys.exit(result.returncode)

import base64
import io

import screenshot
from PIL import Image

_ATTACHMENT_MIME = "application/vnd.prime-agent.attachment+json"
_FAKE_MODEL = {"input": ["text", "image"], "id": "fake-vision"}


def _two_monitor_image() -> Image.Image:
    image = Image.new("RGB", (3840, 1080), (10, 20, 30))
    right = Image.new("RGB", (1920, 1080), (200, 100, 50))
    image.paste(right, (1920, 0))
    return image


class ScreenshotSkillTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self._tmp = Path(tempfile.mkdtemp(prefix="prime-screenshot-out-"))
        self.addCleanup(shutil.rmtree, self._tmp, True)
        self.emitted: list[dict] = []

    async def _capture(self, image: Image.Image, **kwargs):
        save = self._tmp / "shot.png"
        kwargs.setdefault("_origin", (0, 0))
        message = await screenshot.run(
            _grab=lambda: image,
            _emit=self.emitted.append,
            _model_info=_FAKE_MODEL,
            save=str(save),
            **kwargs,
        )
        return message, save

    def _payload(self, save: Path) -> dict:
        self.assertEqual(len(self.emitted), 1)
        payload = self.emitted[0][_ATTACHMENT_MIME]
        self.assertIn(payload["mime_type"], ("image/png", "image/jpeg"))
        raw = base64.b64decode(payload["data"])
        self.assertTrue(raw.startswith(b"\x89PNG") or raw.startswith(b"\xff\xd8\xff"))
        self.assertEqual(Path(payload["path"]), save)
        return payload

    async def test_full_screen_emits_attachment(self):
        message, save = await self._capture(Image.new("RGB", (2560, 1440), (1, 2, 3)))
        payload = self._payload(save)
        self.assertIn("full screen", message)
        self.assertIn("2560x1440", message)
        self.assertIn("attached as", message)
        # 2560 wide exceeds the 1200 attachment cap: expect a jpeg downscale.
        self.assertEqual(payload["mime_type"], "image/jpeg")

    async def test_monitor_crop_uses_second_monitor_rect(self):
        monitors = [(0, 0, 1920, 1080), (1920, 0, 3840, 1080)]
        message, save = await self._capture(_two_monitor_image(), monitor=2, _monitors=monitors)
        self.assertIn("monitor 2", message)
        with Image.open(save) as cropped:
            self.assertEqual(cropped.size, (1920, 1080))
            self.assertEqual(cropped.convert("RGB").getpixel((0, 0)), (200, 100, 50))

    async def test_region_in_virtual_screen_coordinates(self):
        # Secondary monitor left of the primary: virtual origin (-1920, 0) but
        # ImageGrab returns a 3840x1080 image whose (0,0) is the origin.
        image = _two_monitor_image()
        message, save = await self._capture(
            image, region=(-1920, 0, 100, 50), _origin=(-1920, 0)
        )
        self.assertIn("region 100x50+-1920+0", message)
        with Image.open(save) as cropped:
            self.assertEqual(cropped.size, (100, 50))
            self.assertEqual(cropped.convert("RGB").getpixel((0, 0)), (10, 20, 30))

    async def test_window_title_match_crops_frame(self):
        windows = [((30, 40, 230, 140), "Editor - notes.txt"), (999, "Other")]
        message, save = await self._capture(
            Image.new("RGB", (500, 400)), target="editor", _windows=windows
        )
        self.assertIn("window 'Editor - notes.txt'", message)
        with Image.open(save) as cropped:
            self.assertEqual(cropped.size, (200, 100))

    async def test_window_no_match_lists_titles(self):
        windows = [(1, "Alpha"), (2, "Beta")]
        with self.assertRaises(ValueError) as ctx:
            await self._capture(
                Image.new("RGB", (100, 100)), target="missing", _windows=windows
            )
        self.assertIn("Alpha", str(ctx.exception))
        self.assertIn("Beta", str(ctx.exception))

    async def test_monitor_out_of_range(self):
        with self.assertRaises(ValueError):
            await self._capture(
                Image.new("RGB", (100, 100)), monitor=3, _monitors=[(0, 0, 10, 10)]
            )

    async def test_region_must_be_positive(self):
        with self.assertRaises(ValueError):
            await self._capture(Image.new("RGB", (100, 100)), region=(0, 0, 0, 10))

    async def test_region_outside_grab_rejected(self):
        with self.assertRaises(ValueError):
            await self._capture(
                Image.new("RGB", (100, 100)), region=(500, 500, 10, 10), _origin=(0, 0)
            )

    async def test_non_vision_model_rejected(self):
        with self.assertRaises(RuntimeError) as ctx:
            await screenshot.run(
                _grab=lambda: Image.new("RGB", (10, 10)),
                _emit=self.emitted.append,
                _model_info={"input": ["text"], "id": "text-only"},
            )
        self.assertIn("does not support vision", str(ctx.exception))
        self.assertEqual(self.emitted, [])

    async def test_real_full_screen_capture(self):
        save = self._tmp / "real.png"
        message = await screenshot.run(
            _emit=self.emitted.append, _model_info=_FAKE_MODEL, save=str(save)
        )
        self.assertTrue(save.is_file())
        self.assertGreater(save.stat().st_size, 0)
        with Image.open(save) as captured:
            self.assertGreater(captured.size[0], 0)
            self.assertGreater(captured.size[1], 0)
        self._payload(save)
        self.assertIn("full screen", message)


if __name__ == "__main__":
    unittest.main()
