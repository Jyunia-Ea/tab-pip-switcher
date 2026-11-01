#!/usr/bin/env python3
"""生成 Tab PiP Studio 扩展图标（16/48/128，纯标准库 PNG 写入，4x 超采样抗锯齿）。

设计：品牌青色圆角方块 + 白色 PiP 窗口字形（大窗 + 右下角小窗）。
用法：python3 tools/gen_icons.py
"""

import struct
import zlib
import os
import math

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")

BG_TOP = (18, 130, 118)      # #128276
BG_BOTTOM = (13, 94, 89)     # #0d5e59
GLYPH = (255, 255, 255)


def write_png(path, size, pixels):
    """pixels: 2D list of (r,g,b,a)."""
    raw = bytearray()
    for y in range(size):
        raw.append(0)  # filter: none
        for x in range(size):
            r, g, b, a = pixels[y][x]
            raw += bytes((r, g, b, a))
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        c += struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        return c
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def rounded_rect_alpha(px, py, x0, y0, x1, y1, r):
    """1 if inside rounded rect else 0."""
    if px < x0 or px > x1 or py < y0 or py > y1:
        return 0
    # 圆角区域判断
    cx = max(x0 + r, min(px, x1 - r))
    cy = max(y0 + r, min(py, y1 - r))
    dx, dy = px - cx, py - cy
    if dx * dx + dy * dy <= r * r:
        return 1
    # 非圆角角落的直角区域：距离最近的圆角中心 <= r
    if px < x0 + r and py < y0 + r:
        return 1 if (px - (x0 + r)) ** 2 + (py - (y0 + r)) ** 2 <= r * r else 0
    if px > x1 - r and py < y0 + r:
        return 1 if (px - (x1 - r)) ** 2 + (py - (y0 + r)) ** 2 <= r * r else 0
    if px < x0 + r and py > y1 - r:
        return 1 if (px - (x0 + r)) ** 2 + (py - (y1 - r)) ** 2 <= r * r else 0
    if px > x1 - r and py > y1 - r:
        return 1 if (px - (x1 - r)) ** 2 + (py - (y1 - r)) ** 2 <= r * r else 0
    return 1


def rect_alpha(px, py, x0, y0, x1, y1):
    return 1 if x0 <= px <= x1 and y0 <= py <= y1 else 0


def make_icon(size):
    SS = 4  # 超采样
    S = size * SS
    pixels = [[(0, 0, 0, 0)] * S for _ in range(S)]

    # 背景：圆角方块（微渐变）
    radius = size * 0.20 * SS
    x0b, y0b = size * 0.04 * SS, size * 0.04 * SS
    x1b, y1b = size * 0.96 * SS, size * 0.96 * SS
    for y in range(S):
        for x in range(S):
            a = rounded_rect_alpha(x, y, x0b, y0b, x1b, y1b, radius)
            if a:
                t = (y - y0b) / max(1, (y1b - y0b))
                r = int(BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t)
                g = int(BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t)
                b = int(BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t)
                pixels[y][x] = (r, g, b, 255)

    # 字形：大窗口（描边）+ 标题栏 + 右下角小窗
    stroke = max(2, round(size * 0.055 * SS))
    if size >= 48:
        # 大窗口
        wx0, wy0, wx1, wy1 = size * 0.20 * SS, size * 0.22 * SS, size * 0.80 * SS, size * 0.72 * SS
        for y in range(S):
            for x in range(S):
                inside = rect_alpha(x, y, wx0 + stroke, wy0 + stroke, wx1 - stroke, wy1 - stroke)
                if inside:
                    continue
                on_frame = rect_alpha(x, y, wx0, wy0, wx1, wy1)
                if on_frame:
                    pixels[y][x] = (*GLYPH, 255)
        # 标题栏
        for y in range(S):
            for x in range(S):
                if rect_alpha(x, y, wx0, wy0, wx1, wy0 + size * 0.13 * SS):
                    pixels[y][x] = (*GLYPH, 255)
        # 右下角小窗（实心）
        sx0, sy0, sx1, sy1 = size * 0.52 * SS, size * 0.48 * SS, size * 0.84 * SS, size * 0.76 * SS
        for y in range(S):
            for x in range(S):
                if rect_alpha(x, y, sx0, sy0, sx1, sy1):
                    pixels[y][x] = (*GLYPH, 255)
    else:
        # 小尺寸简化：小窗 + 大窗轮廓
        wx0, wy0, wx1, wy1 = size * 0.22 * SS, size * 0.24 * SS, size * 0.78 * SS, size * 0.72 * SS
        for y in range(S):
            for x in range(S):
                inside = rect_alpha(x, y, wx0 + stroke, wy0 + stroke, wx1 - stroke, wy1 - stroke)
                if inside:
                    continue
                if rect_alpha(x, y, wx0, wy0, wx1, wy1):
                    pixels[y][x] = (*GLYPH, 255)
        sx0, sy0, sx1, sy1 = size * 0.50 * SS, size * 0.46 * SS, size * 0.82 * SS, size * 0.74 * SS
        for y in range(S):
            for x in range(S):
                if rect_alpha(x, y, sx0, sy0, sx1, sy1):
                    pixels[y][x] = (*GLYPH, 255)

    # 降采样（简单平均，带 alpha 加权）
    out = []
    for y in range(size):
        row = []
        for x in range(size):
            acc = [0.0, 0.0, 0.0, 0.0]
            for dy in range(SS):
                for dx in range(SS):
                    r, g, b, a = pixels[y * SS + dy][x * SS + dx]
                    w = a / 255.0
                    acc[0] += r * w
                    acc[1] += g * w
                    acc[2] += b * w
                    acc[3] += w
            n = SS * SS
            a = round(acc[3] / n * 255)
            if a == 0:
                row.append((0, 0, 0, 0))
            else:
                row.append((
                    round(acc[0] / max(1e-6, acc[3])),
                    round(acc[1] / max(1e-6, acc[3])),
                    round(acc[2] / max(1e-6, acc[3])),
                    a,
                ))
        out.append(row)
    return out


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in (16, 48, 128):
        p = os.path.join(OUT_DIR, f"icon{size}.png")
        write_png(p, size, make_icon(size))
        print("生成", p, os.path.getsize(p), "bytes")


if __name__ == "__main__":
    main()
