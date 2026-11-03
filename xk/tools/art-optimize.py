#!/usr/bin/env python3
"""把 GPT 交来的原图（xiaoke-art/）缩成 App 用的 WebP，放进 gateway/web/xk-art/。

原图 49 MB，直接进 APK 太大；按界面上实际显示的最大尺寸（含 3 倍屏）缩小再转 WebP。
设定图和界面参考图只给人看，不进 App。原图包在仓库 xiaoke-art-2026-11-01（第 1 版）、xiaoke-art-v2-2026-11-02（第 2 版）、xiaoke-art-overlay-2026-11-03（悬浮窗）分支。
用法：python3 xk/tools/art-optimize.py <解压后的 xiaoke-art 目录>
"""
import sys
from pathlib import Path
from PIL import Image

SRC = Path(sys.argv[1])
OUT = Path(__file__).resolve().parents[2] / "gateway" / "web" / "xk-art"

# 目录或文件 → 最长边像素
SIZES = {
    "xiaoke": 640, "hachimi": 640, "xiaoyu": 640,
    "icon/notify_flower.png": 96, "icon": 384, "group/trio.png": 1600, "group": 768,
    "deco/splash.png": 1080, "deco/ribbon_divider.png": 1200,
    "deco/paper_light.png": 512, "deco/paper_dark.png": 512,
    "deco/petal": 128, "deco": 512,
    # 第 2 版（前端重构）
    "me": 1200, "health": 384, "onboard": 1080, "state": 512,
    "diary/paper": 512, "diary": 640, "help": 768,
    # 悬浮窗（#32）：小圆片屏上约 56dp，3 倍屏 168px，留点余量
    "overlay/permission.png": 768, "overlay": 256,
}
SKIP = ("00_ref_sheet", "ui-ref/", "preview_")


def size_for(rel: str) -> int:
    for key in sorted(SIZES, key=len, reverse=True):
        if rel.startswith(key):
            return SIZES[key]
    raise SystemExit(f"没定尺寸：{rel}")


total = 0
for f in sorted(SRC.rglob("*.png")):
    rel = f.relative_to(SRC).as_posix()
    if any(s in rel for s in SKIP):
        continue
    im = Image.open(f)
    m = size_for(rel)
    if max(im.size) > m:
        im.thumbnail((m, m), Image.LANCZOS)
    dst = OUT / Path(rel).with_suffix(".webp")
    dst.parent.mkdir(parents=True, exist_ok=True)
    # 纸纹要无缝拼接，用无损，免得接缝处出色差
    lossless = rel.startswith("deco/paper") or rel.startswith("diary/paper")
    im.save(dst, "WEBP", quality=86, method=6, lossless=lossless)
    total += dst.stat().st_size
    print(f"{rel} → {dst.relative_to(OUT)} {im.size[0]}x{im.size[1]} {dst.stat().st_size // 1024} KB")
print(f"共 {total / 1024 / 1024:.1f} MB")
