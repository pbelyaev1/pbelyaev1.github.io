#!/usr/bin/env python3
"""
Рисует заглушку вместо настоящей фотографии: деревянный стол, корпус-яйцо,
экран залит пурпурным, три кнопки. Нужна только чтобы проверить геометрию и
вёрстку до того, как появится настоящая картинка.
"""
from PIL import Image, ImageDraw, ImageFilter
import numpy as np, math, sys

W, H = 1206, 2622                      # айфон 17, 3x
out = sys.argv[1] if len(sys.argv) > 1 else '/tmp/placeholder.png'

# ---------- деревянный стол ----------
base = np.zeros((H, W, 3), dtype=np.float32)
rng = np.random.default_rng(7)
y = np.linspace(0, 1, H)[:, None]
x = np.linspace(0, 1, W)[None, :]
wood = 0.55 + 0.10 * np.sin(x * 40 + np.sin(y * 3) * 2) + 0.05 * np.sin(x * 130)
wood += rng.normal(0, 0.012, (H, W))
light = 1.15 - 0.55 * ((x - 0.35) ** 2 + (y - 0.30) ** 2)      # мягкий свет слева сверху
wood = np.clip(wood * light, 0, 1)
base[:, :, 0] = wood * 0.62
base[:, :, 1] = wood * 0.42
base[:, :, 2] = wood * 0.25
img = Image.fromarray((base * 255).astype(np.uint8), 'RGB').convert('RGBA')

d = ImageDraw.Draw(img)

# ---------- корпус ----------
CX, CY = W // 2, int(H * 0.50)
SW, SH = int(W * 0.66), int(W * 0.66 * 1.22)          # яйцо
box = [CX - SW // 2, CY - SH // 2, CX + SW // 2, CY + SH // 2]

shadow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
ImageDraw.Draw(shadow).ellipse([box[0] + 18, box[1] + 40, box[2] + 18, box[3] + 46],
                               fill=(0, 0, 0, 120))
img = Image.alpha_composite(img, shadow.filter(ImageFilter.GaussianBlur(34)))
d = ImageDraw.Draw(img)

d.ellipse(box, fill=(238, 232, 210, 255))                          # кремовый корпус
inner = [box[0] + int(SW * 0.10), box[1] + int(SH * 0.09),
         box[2] - int(SW * 0.10), box[3] - int(SH * 0.09)]
d.ellipse(inner, fill=(233, 116, 34, 255))                         # оранжевая вставка

# ---------- экран: строго прямоугольник, залит пурпурным ----------
sw = int(W * 0.395)
sh = int(sw * 1.02)
sx, sy = CX - sw // 2, CY - int(sh * 0.62)
d.rounded_rectangle([sx - 10, sy - 10, sx + sw + 10, sy + sh + 10],
                    radius=26, fill=(214, 100, 26, 255))
d.rounded_rectangle([sx, sy, sx + sw, sy + sh], radius=16, fill=(255, 0, 255, 255))

# ---------- кнопки ----------
br = int(W * 0.052)
by = CY + int(SH * 0.30)
gap = int(W * 0.155)
btns = []
for i, (bx, dy) in enumerate([(CX - gap, 0), (CX, int(br * 0.55)), (CX + gap, 0)]):
    cy = by + dy
    d.ellipse([bx - br, cy - br, bx + br, cy + br], fill=(228, 228, 224, 255))
    d.ellipse([bx - br + 6, cy - br + 6, bx + br - 6, cy + br - 6], fill=(240, 240, 236, 255))
    btns.append({'x': round((bx - br) / W, 5), 'y': round((cy - br) / H, 5),
                 'w': round(2 * br / W, 5), 'h': round(2 * br / H, 5)})

# ---------- реквизит по краям, чтобы было похоже на стол ----------
d.rounded_rectangle([int(W * 0.02), int(H * 0.63), int(W * 0.30), int(H * 0.92)],
                    radius=18, fill=(226, 222, 212, 255))
d.rounded_rectangle([int(W * 0.72), int(H * 0.08), int(W * 0.99), int(H * 0.26)],
                    radius=24, fill=(210, 208, 202, 255))

img.convert('RGB').save(out)
print('заглушка сохранена:', out)
print('кнопки в долях:')
for b in btns:
    print('   ', b)
