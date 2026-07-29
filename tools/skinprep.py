#!/usr/bin/env python3
"""
Готовит фотографию корпуса к использованию в игре.

На вход — картинка, где экран тамагочи залит плоским пурпурным (#FF00FF).
На выходе:
  • та же картинка, но пурпурная область стала прозрачной (в неё будет
    смотреть игровой холст);
  • напечатанное описание скина: доли, по которым игра ставит холст на место.

Запуск:  python3 tools/skinprep.py вход.png resources/img/skins/wood.png [--ar 0.46]

--ar — нужное соотношение ширины к высоте (у айфона 17 это 402/874 = 0.46).
Если картинка другой формы, она будет достроена по краям, а не обрезана:
устройство останется целиком в кадре.
"""
import sys, json
from PIL import Image, ImageFilter
import numpy as np


def pad_to_ratio(img, target):
    """Дотягивает картинку до нужного соотношения, продлевая края наружу."""
    W, H = img.size
    cur = W / H
    if abs(cur - target) < 0.002:
        return img
    if cur > target:                       # слишком широкая — добавляем высоту
        newH = int(round(W / target))
        pad = newH - H
        top, bot = pad // 2, pad - pad // 2
        canvas = Image.new('RGBA', (W, newH))
        canvas.paste(img, (0, top))
        if top:
            strip = img.crop((0, 0, W, min(H, 40))).resize((W, top), Image.LANCZOS)
            canvas.paste(strip.filter(ImageFilter.GaussianBlur(12)), (0, 0))
        if bot:
            strip = img.crop((0, max(0, H - 40), W, H)).resize((W, bot), Image.LANCZOS)
            canvas.paste(strip.filter(ImageFilter.GaussianBlur(12)), (0, top + H))
        return canvas
    newW = int(round(H * target))          # слишком узкая — добавляем ширину
    pad = newW - W
    left, right = pad // 2, pad - pad // 2
    canvas = Image.new('RGBA', (newW, H))
    canvas.paste(img, (left, 0))
    if left:
        strip = img.crop((0, 0, min(W, 40), H)).resize((left, H), Image.LANCZOS)
        canvas.paste(strip.filter(ImageFilter.GaussianBlur(12)), (0, 0))
    if right:
        strip = img.crop((max(0, W - 40), 0, W, H)).resize((right, H), Image.LANCZOS)
        canvas.paste(strip.filter(ImageFilter.GaussianBlur(12)), (left + W, 0))
    return canvas


def cut_chroma(img):
    """Убирает сплошной зелёный фон вокруг корпуса.

    Край делаем мягким, а не «или да, или нет»: у пикселей на границе зелень
    подмешана частично, и если рубить порогом, силуэт получается зубчатым, а
    вокруг остаётся ядовитая кайма. Поэтому:
      • прозрачность считаем плавно по тому, насколько пиксель зелёный;
      • саму зелень из полупрозрачных пикселей вычитаем (это называется despill);
      • под полностью прозрачными обнуляем цвет, чтобы при уменьшении
        картинки браузер не подмешал зелёный обратно.
    """
    a = np.asarray(img).astype(np.float32)
    r, g, b = a[:, :, 0], a[:, :, 1], a[:, :, 2]

    # насколько пиксель «зеленее» всего остального
    spill = g - np.maximum(r, b)
    if (spill > 60).mean() < 0.02:
        return img, False

    LO, HI = 8.0, 55.0                       # ниже LO — корпус, выше HI — чистый фон
    alpha = 1.0 - np.clip((spill - LO) / (HI - LO), 0, 1)

    # despill: зелень в оставшихся пикселях опускаем до уровня соседних каналов
    keep = alpha > 0
    g2 = np.where(keep & (spill > 0), np.maximum(r, b) + np.minimum(spill, 6.0), g)

    out = np.zeros(a.shape, dtype=np.uint8)
    out[:, :, 0] = np.where(keep, r, 0).astype(np.uint8)
    out[:, :, 1] = np.where(keep, g2, 0).astype(np.uint8)
    out[:, :, 2] = np.where(keep, b, 0).astype(np.uint8)
    out[:, :, 3] = (alpha * 255).astype(np.uint8)
    return Image.fromarray(out, 'RGBA'), True


def trim(img):
    """Обрезает пустые поля вокруг корпуса."""
    alpha = np.asarray(img)[:, :, 3]
    ys, xs = np.where(alpha > 8)
    if not len(ys):
        return img
    pad = 4
    x0 = max(0, xs.min() - pad); x1 = min(img.size[0], xs.max() + 1 + pad)
    y0 = max(0, ys.min() - pad); y1 = min(img.size[1], ys.max() + 1 + pad)
    return img.crop((x0, y0, x1, y1))


def find_screen(img):
    """Ищет самое большое пятно пурпурного и возвращает его прямоугольник."""
    a = np.asarray(img.convert('RGB')).astype(np.int16)
    r, g, b = a[:, :, 0], a[:, :, 1], a[:, :, 2]
    # пурпурный: красный и синий высокие, зелёный низкий
    mask = (r > 140) & (b > 140) & (g < 110) & (abs(r - b) < 90)
    if not mask.any():
        raise SystemExit('Пурпурной области не нашлось. Экран должен быть залит #FF00FF.')

    ys, xs = np.where(mask)
    # отсекаем случайные одиночные пиксели: берём центральную массу
    x0, x1 = int(np.percentile(xs, 0.2)), int(np.percentile(xs, 99.8))
    y0, y1 = int(np.percentile(ys, 0.2)), int(np.percentile(ys, 99.8))
    return mask, (x0, y0, x1 + 1, y1 + 1)


def main():
    if len(sys.argv) < 3:
        raise SystemExit('Как запускать: python3 tools/skinprep.py вход.png выход.png [--ar 0.46]')
    src, dst = sys.argv[1], sys.argv[2]
    ar = None
    if '--ar' in sys.argv:
        ar = float(sys.argv[sys.argv.index('--ar') + 1])

    img = Image.open(src).convert('RGBA')

    if '--cutout' in sys.argv:
        img, done = cut_chroma(img)
        if not done:
            raise SystemExit('Зелёного фона не нашлось — корпус должен быть на сплошном #00FF00.')
        img = trim(img)
        print('корпус вырезан, обрезаны поля: %d×%d' % img.size)
    elif ar:
        before = img.size
        img = pad_to_ratio(img, ar)
        if img.size != before:
            print('картинку достроили по краям: %d×%d → %d×%d' % (*before, *img.size))
    W, H = img.size
    mask, (x0, y0, x1, y1) = find_screen(img)

    # пурпур — в прозрачность; края слегка размываем, чтобы не было зубцов
    a = np.asarray(img).copy()
    a[:, :, 3] = np.where(mask, 0, a[:, :, 3])
    # цвет под прозрачным делаем нейтральным, иначе по краю лезет пурпурная кайма
    a[:, :, 0] = np.where(mask, 0, a[:, :, 0])
    a[:, :, 1] = np.where(mask, 0, a[:, :, 1])
    a[:, :, 2] = np.where(mask, 0, a[:, :, 2])
    out = Image.fromarray(a, 'RGBA')
    out.save(dst)

    skin = {
        'image': dst.split('resources/')[-1] if 'resources/' in dst else dst,
        'w': W, 'h': H,
        'screen': {
            'x': round(x0 / W, 5), 'y': round(y0 / H, 5),
            'w': round((x1 - x0) / W, 5), 'h': round((y1 - y0) / H, 5),
        },
    }
    print('размер картинки: %d×%d, соотношение %.4f' % (W, H, W / H))
    print('экран в пикселях: x=%d y=%d ш=%d в=%d' % (x0, y0, x1 - x0, y1 - y0))
    print('экран в долях:', json.dumps(skin['screen'], ensure_ascii=False))
    print('\nописание для src/skin.js:')
    print(json.dumps(skin, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
