#!/usr/bin/env python3
"""
Рисует тень корпуса заранее, отдельной картинкой.

Зачем не средствами браузера: CSS-тень по силуэту (drop-shadow) на телефоне
иногда рисуется по прямоугольнику картинки, а не по её силуэту — тень
получается квадратной. Готовая картинка так сломаться не может.

Тень строится из прозрачности корпуса: берём силуэт, заливаем внутренние
дырки (вырез экрана — не дырка в пластике, тень под ним есть), размываем и
сдвигаем в сторону, противоположную свету. Слоёв два:
  • контактный — короткий и плотный, у самой поверхности;
  • рассеянный — длинный и мягкий.

Запуск:
    python3 tools/makeshadow.py resources/img/skins/shell_cream.png \
                                resources/img/skins/shadow_cream.png
Печатает долю поля (pad), которую нужно прописать в src/skin.js.
"""
import sys
import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage

# всё в долях ширины картинки корпуса — тогда настройки не зависят от её размера
PAD      = 0.20      # запас вокруг, чтобы размытию было куда расходиться
CONTACT  = dict(blur=0.016, dx=0.008, dy=0.013, opacity=0.55)
AMBIENT  = dict(blur=0.062, dx=0.022, dy=0.038, opacity=0.40)
TINT     = (14, 10, 8)   # почти чёрный, чуть тёплый — так тень на дереве живее


def silhouette(alpha):
    """Внешний силуэт корпуса: мягкий край сохраняем, внутренние дырки заливаем."""
    solid = ndimage.binary_fill_holes(alpha > 16).astype(np.float32)
    return np.maximum(alpha.astype(np.float32) / 255.0, solid)


def layer(sil, W, H, pad, cfg):
    canvas = np.zeros((H + 2 * pad, W + 2 * pad), dtype=np.float32)
    dx, dy = int(round(cfg['dx'] * W)), int(round(cfg['dy'] * W))
    canvas[pad + dy: pad + dy + H, pad + dx: pad + dx + W] = sil
    img = Image.fromarray((canvas * 255).astype(np.uint8), 'L')
    img = img.filter(ImageFilter.GaussianBlur(cfg['blur'] * W))
    return np.asarray(img).astype(np.float32) / 255.0 * cfg['opacity']


def main():
    if len(sys.argv) < 3:
        raise SystemExit('Как запускать: python3 tools/makeshadow.py корпус.png тень.png')
    src, dst = sys.argv[1], sys.argv[2]
    a = np.asarray(Image.open(src).convert('RGBA'))
    H, W = a.shape[0], a.shape[1]
    sil = silhouette(a[:, :, 3])

    pad = int(round(PAD * W))
    c = layer(sil, W, H, pad, CONTACT)
    m = layer(sil, W, H, pad, AMBIENT)
    alpha = 1.0 - (1.0 - c) * (1.0 - m)          # складываем как два независимых слоя

    # тень размытая, мелкие детали в ней не нужны: храним вдвое меньше и в двух
    # каналах (яркость + прозрачность) — файл выходит в несколько раз легче
    out = np.zeros((H + 2 * pad, W + 2 * pad, 2), dtype=np.uint8)
    out[:, :, 0] = int(round(sum(TINT) / 3))
    out[:, :, 1] = np.clip(alpha * 255, 0, 255).astype(np.uint8)
    img = Image.fromarray(out, 'LA')
    img = img.resize((img.size[0] // 2, img.size[1] // 2), Image.LANCZOS)
    img.save(dst, optimize=True)

    print('тень: %d×%d, поле %d точек' % (img.size[0], img.size[1], pad))
    print('в src/skin.js:  shadow: { image: %r, pad: %.5f }'
          % (dst.split('resources/')[-1] and dst[dst.find('resources/'):], pad / W))


if __name__ == '__main__':
    main()
