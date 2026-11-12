#!/usr/bin/env python
# 把 GIF 抽帧拼成一张网格图，让模型能"看到"动作（而不是只看第一帧）
import sys
from PIL import Image, ImageSequence

src, dst = sys.argv[1], sys.argv[2]
im = Image.open(src)
frames = []
for i, frame in enumerate(ImageSequence.Iterator(im)):
    frames.append(frame.convert("RGBA").copy())
    if len(frames) >= 9:
        break

if not frames:
    sys.exit(1)

cols = 3 if len(frames) > 4 else 2
rows = (len(frames) + cols - 1) // cols
w = max(f.width for f in frames)
h = max(f.height for f in frames)
scale = min(1.0, 360.0 / max(w, h))
tw, th = int(w * scale), int(h * scale)

canvas = Image.new("RGB", (tw * cols, th * rows), (24, 24, 24))
for idx, f in enumerate(frames):
    r, c = divmod(idx, cols)
    canvas.paste(f.convert("RGB").resize((tw, th), Image.LANCZOS), (c * tw, r * th))
canvas.save(dst, "PNG")
print(f"{len(frames)} frames -> {cols}x{rows}")
