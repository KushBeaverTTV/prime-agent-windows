---
name: screenshot
description: Capture the screen, one monitor, a window (by title substring) or a region on native Windows and load it into the model's context so the model can SEE the desktop or a GUI. Use it to debug GUIs, read dialogs and error boxes, or verify visual state. Requires a vision-capable model.
---

# Screenshot

Capture the interactive Windows desktop — the full virtual screen, one
monitor, a single window by title substring, or an arbitrary region — and
attach the image to the model's context the same way a pasted image is, so
the model can actually look at it.

## When to use this

- You need to see what is on screen: a GUI you launched, a dialog, an error
  box, a window's current state.
- Debugging a graphical application or verifying a visual change took effect.
- Reading UI text that is not reachable through files or process output.

## When NOT to use this

- The image already exists as a file: use `attach_image` instead of capturing
  the screen.
- You need pixel-level programmatic analysis (measuring, hashing,
  comparing): open the saved PNG with PIL in the kernel instead.

## Usage

Call the prepared `screenshot` import directly in the Python kernel:

```python
print(await screenshot())                              # all monitors, full virtual screen
print(await screenshot("Visual Studio Code"))          # first window whose title contains it
print(await screenshot(monitor=2))                     # one monitor, 1-based (primary is 1)
print(await screenshot(region=(0, 0, 800, 600)))       # x, y, width, height in virtual-screen pixels
print(await screenshot(save="C:/tmp/shot.png"))        # choose where the PNG is saved
```

The PNG is saved to the `save` path or to
`%TEMP%\prime-agent-screenshots\<timestamp>.png`, then resized/compressed and
attached to context like `attach_image` does.

## Platform

Windows only — it captures the interactive desktop of the session the agent
runs in. On other platforms `screenshot()` raises an error. Requires a
vision-capable model; it errors clearly otherwise.
