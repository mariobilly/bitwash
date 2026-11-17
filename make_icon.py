"""Draws icon.png / icon.ico / static/icon.png: the app mark, a glowing sun dithered with a 4x4 Bayer matrix
(the same mark the window draws with core.js)."""
import math
import os

from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
TONES = ["#140A10", "#7A1206", "#E8401C", "#FF8A00", "#FFD84A"]
BAYER4 = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]]


def rgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


def mark(n=16):
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    px = img.load()
    for y in range(n):
        for x in range(n):
            d = math.hypot(x - (n - 1) / 2, y - (n - 1) / 2) / ((n - 1) / 2)
            if d > 1.04:
                continue
            v = max(0.0, min(1.0, 1.05 - d * 0.85 - (y / n) * 0.25))
            t = (BAYER4[y % 4][x % 4] + 0.5) / 16
            i = max(0, min(len(TONES) - 1, math.floor(v * (len(TONES) - 1) + t)))
            px[x, y] = rgb(TONES[i]) + (255,)
    return img


def main():
    small = mark(16)
    big = small.resize((256, 256), Image.NEAREST)
    # soft outer glow under the pixels, like the Halo Glow
    glow = big.filter(ImageFilter.GaussianBlur(10))
    out = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
    out.alpha_composite(glow)
    out.alpha_composite(big)
    out.save(os.path.join(HERE, "icon.png"))
    out.save(os.path.join(HERE, "static", "icon.png"))
    out.save(os.path.join(HERE, "icon.ico"), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("icon written")


if __name__ == "__main__":
    main()
