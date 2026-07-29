#!/usr/bin/env python3
"""
Ищет на фотографии три круглые кнопки под экраном и печатает их доли
для описания скина. Кнопки отличает по цвету: они серые, то есть
насыщенность низкая, а яркость средняя — на кремовом корпусе это заметно.

Запуск: python3 tools/findbuttons.py фото.png
"""
import sys
import numpy as np
from PIL import Image


def main():
    path = sys.argv[1]
    img = Image.open(path).convert('RGB')
    W, H = img.size
    a = np.asarray(img).astype(np.float32)
    r, g, b = a[:, :, 0], a[:, :, 1], a[:, :, 2]
    mx, mn = a.max(2), a.min(2)
    sat = (mx - mn) / np.maximum(mx, 1)
    val = mx / 255.0

    # серое: мало насыщенности, средняя яркость
    mask = (sat < 0.13) & (val > 0.42) & (val < 0.82)

    # смотрим только нижнюю половину — там, где кнопки
    mask[: int(H * 0.40), :] = False
    mask[int(H * 0.95):, :] = False

    lbl = np.zeros(mask.shape, dtype=np.int32)
    blobs = []
    cur = 0
    visited = np.zeros_like(mask)
    ys, xs = np.where(mask)
    for y0, x0 in zip(ys, xs):
        if visited[y0, x0]:
            continue
        cur += 1
        stack = [(y0, x0)]
        visited[y0, x0] = True
        pts = []
        while stack:
            y, x = stack.pop()
            pts.append((y, x))
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                ny, nx = y + dy, x + dx
                if 0 <= ny < H and 0 <= nx < W and mask[ny, nx] and not visited[ny, nx]:
                    visited[ny, nx] = True
                    stack.append((ny, nx))
        if len(pts) < (W * H) * 0.00015:
            continue
        p = np.array(pts)
        y1, y2 = p[:, 0].min(), p[:, 0].max()
        x1, x2 = p[:, 1].min(), p[:, 1].max()
        w, h = x2 - x1 + 1, y2 - y1 + 1
        if w == 0 or h == 0:
            continue
        if not (0.6 < w / h < 1.7):          # кнопки примерно круглые
            continue
        blobs.append((x1, y1, w, h, len(pts)))

    blobs.sort(key=lambda t: -t[4])
    blobs = sorted(blobs[:3], key=lambda t: t[0])      # слева направо
    if len(blobs) != 3:
        print('нашлось пятен:', len(blobs), '— проверь глазами:')
    print('кнопки (слева направо):')
    for x1, y1, w, h, n in blobs:
        pad_x, pad_y = w * 0.22, h * 0.22               # область нажатия чуть шире самой кнопки
        print('        { x: %.5f, y: %.5f, w: %.5f, h: %.5f },   // %dpx' % (
            (x1 - pad_x) / W, (y1 - pad_y) / H,
            (w + 2 * pad_x) / W, (h + 2 * pad_y) / H, w))


if __name__ == '__main__':
    main()
