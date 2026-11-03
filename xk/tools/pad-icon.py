#!/usr/bin/env python3
"""平板 App 的启动图标：照手机小克的样子（奶白 #FFF7EE 圆角底 + 前景），从主人给的 pad/app_icon_fg.png 生成各密度的 ic_launcher.png。
用法：python3 xk/tools/pad-icon.py <解压后的 xiaoke-art 目录>
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw

SRC = Path(sys.argv[1]) / "pad" / "app_icon_fg.png"
OUT = Path(__file__).resolve().parents[1] / "pad" / "res"
SIZES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}

fg = Image.open(SRC).convert("RGBA")
for d, n in SIZES.items():
    big = n * 4   # 先画大再缩，圆角边缘平滑
    bg = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    ImageDraw.Draw(bg).rounded_rectangle([0, 0, big - 1, big - 1], radius=int(big * 0.23), fill=(255, 247, 238, 255))
    # 前景图里花和平板只占中间 60%，放大 1.3 倍让它和手机图标里的花一样大
    s = int(big * 1.3)
    f = fg.resize((s, s), Image.LANCZOS)
    off = (big - s) // 2
    bg.alpha_composite(f.crop((-off, -off, -off + big, -off + big)))
    p = OUT / f"mipmap-{d}" / "ic_launcher.png"
    p.parent.mkdir(parents=True, exist_ok=True)
    bg.resize((n, n), Image.LANCZOS).save(p, optimize=True)
    print(p.relative_to(OUT.parents[1]), n)
