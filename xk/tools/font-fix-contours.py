#!/usr/bin/env python3
"""站酷小薇体有 26 个字（回、吃、查、画、鱼……）的轮廓方向不对：洞和外圈同向，浏览器按非零规则填成实心方块。
按嵌套深度重定方向后另存。用法：python3 xk/tools/font-fix-contours.py 原.woff2 新.woff2 apply（不带 apply 只列出有问题的字）
需要 fonttools、brotli。字体是 OFL 1.1，没有保留字体名，改过的版本照常叫原名、随 OFL 文本分发。
"""
import sys
from fontTools.ttLib import TTFont
def area(p): return sum(p[i][0]*p[(i+1)%len(p)][1]-p[(i+1)%len(p)][0]*p[i][1] for i in range(len(p)))/2
def inside(pt, poly):
    x, y = pt; c = False
    for i in range(len(poly)):
        (x1, y1), (x2, y2) = poly[i], poly[i-1]
        if (y1 > y) != (y2 > y) and x < (x2-x1)*(y-y1)/(y2-y1)+x1: c = not c
    return c
src, dst, apply = sys.argv[1], sys.argv[2], len(sys.argv) > 3
f = TTFont(src); glyf = f['glyf']; bad = []
for name in f.getGlyphOrder():
    g = glyf[name]
    if g.isComposite() or g.numberOfContours < 2: continue
    coords, ends, flags = g.getCoordinates(glyf)
    cs, s = [], 0
    for e in ends: cs.append((s, e)); s = e + 1
    polys = [list(coords[a:b+1]) for a, b in cs]
    want = []
    for i, p in enumerate(polys):
        depth = sum(1 for j, q in enumerate(polys) if j != i and abs(area(q)) > abs(area(p)) and all(inside(pt, q) for pt in p))
        want.append(-1 if depth % 2 == 0 else 1)
    flip = [i for i, p in enumerate(polys) if (area(p) > 0) != (want[i] > 0)]
    if not flip: continue
    bad.append(name)
    if apply:
        # 反转要翻的那几个轮廓：坐标、开 / 关曲线标志一起倒序（起点保持不变）
        newc, newf = [], []
        for i, (a, b) in enumerate(cs):
            pc, pf = list(coords[a:b+1]), list(flags[a:b+1])
            if i in flip: pc = [pc[0]] + pc[1:][::-1]; pf = [pf[0]] + pf[1:][::-1]
            newc += pc; newf += pf
        g.coordinates[:] = newc; g.flags = bytearray(newf)
print(len(bad), "".join(chr(int(n[3:], 16)) for n in bad if n.startswith("uni")))
if apply: f.flavor = "woff2"; f.save(dst)
