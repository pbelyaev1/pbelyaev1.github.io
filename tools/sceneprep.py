#!/usr/bin/env python3
"""
Обмеряет готовую сцену — фотографию, на которой тамагочи снят целиком, а его
экран залит сплошным пурпурным (#FF00FF).

Что делает:
  • находит четырёхугольник экрана и печатает его углы в пикселях фотографии;
  • находит три кнопки под экраном и печатает их доли;
  • считает, какого размера получится игровой экран на айфоне, и подбирает
    набор масштабов для меню;
  • сохраняет фотографию в JPEG.

Углы ищутся не по крайним точкам (у экрана скруглённые углы, они бы соврали),
а по четырём прямым: слева и справа края описываются линией x = a·y + b,
сверху и снизу — y = c·x + d. Линии строятся по средним 80 % края, где
скругления уже не мешают, и пересекаются между собой. Так работает и с
наклонённым экраном.

Запуск:
    python3 tools/sceneprep.py сцена.png resources/img/skins/scene_имя.jpg
"""
import sys
import json
import numpy as np
from PIL import Image
from scipy import ndimage

PHONE_W, PHONE_H = 402.0, 874.0      # айфон 17 в точках
NATURAL = 192.0                      # штатный размер игрового экрана


def magenta_mask(a):
    """Сплошной пурпурный: красный и синий высокие, зелёный низкий."""
    r, g, b = a[:, :, 0], a[:, :, 1], a[:, :, 2]
    m = (r > 120) & (b > 120) & (g < 130) & (np.minimum(r, b) - g > 60)
    if not m.any():
        raise SystemExit('Пурпурной области не нашлось. Экран должен быть залит #FF00FF.')
    lbl, n = ndimage.label(m)
    sizes = ndimage.sum(np.ones_like(lbl), lbl, range(1, n + 1))
    big = lbl == int(np.argmax(sizes)) + 1
    return ndimage.binary_fill_holes(ndimage.binary_closing(big, np.ones((7, 7))))


def fit_line(xs, ys):
    """Прямая по точкам, устойчиво: считаем, потом отбрасываем выбросы."""
    for _ in range(2):
        k, b = np.polyfit(ys, xs, 1)
        d = np.abs(xs - (k * ys + b))
        keep = d <= max(1.5, 2.5 * d.std())
        if keep.sum() < 8:
            break
        xs, ys = xs[keep], ys[keep]
    return np.polyfit(ys, xs, 1)      # x = k·y + b


def quad_from_mask(m, trim=0.10):
    """Четыре угла: пересечения четырёх прямых, описывающих края."""
    ys, xs = np.where(m)
    y0, y1, x0, x1 = ys.min(), ys.max(), xs.min(), xs.max()

    # левый и правый края: по строкам, без скруглённых концов
    rows = np.arange(int(y0 + (y1 - y0) * trim), int(y1 - (y1 - y0) * trim) + 1)
    lx, rx, ry = [], [], []
    for y in rows:
        r = np.where(m[y])[0]
        if len(r) < 4:
            continue
        lx.append(r.min()); rx.append(r.max()); ry.append(y)
    lx, rx, ry = np.array(lx, float), np.array(rx, float), np.array(ry, float)
    kl, bl = fit_line(lx, ry)          # x = kl·y + bl
    kr, br = fit_line(rx, ry)

    # верхний и нижний края: по столбцам
    cols = np.arange(int(x0 + (x1 - x0) * trim), int(x1 - (x1 - x0) * trim) + 1)
    ty, by, tx = [], [], []
    for x in cols:
        c = np.where(m[:, x])[0]
        if len(c) < 4:
            continue
        ty.append(c.min()); by.append(c.max()); tx.append(x)
    ty, by, tx = np.array(ty, float), np.array(by, float), np.array(tx, float)
    kt, bt = fit_line(ty, tx)          # y = kt·x + bt
    kb, bb = fit_line(by, tx)

    def cross(kx, bx, ky, by_):
        """x = kx·y + bx  и  y = ky·x + by_"""
        # подставляем: x = kx·(ky·x + by_) + bx
        x = (kx * by_ + bx) / (1 - kx * ky)
        return x, ky * x + by_

    return [cross(kl, bl, kt, bt), cross(kr, br, kt, bt),
            cross(kr, br, kb, bb), cross(kl, bl, kb, bb)]


def find_buttons(a, quad):
    """Три кнопки под экраном: ищем ряд из трёх похожих круглых пятен.

    Цвет кнопок у каждой сцены свой, поэтому не подбираем его руками, а делим
    цвета полосы под экраном на несколько групп и проверяем каждую: годится та,
    в которой нашлись ровно три похожих по размеру круглых пятна, вытянутых в
    ряд по горизонтали.
    """
    from scipy.cluster.vq import kmeans2
    H, W, _ = a.shape
    xs = [p[0] for p in quad]; ys = [p[1] for p in quad]
    qw = max(xs) - min(xs); qh = max(ys) - min(ys)
    y0, y1 = int(max(ys)), int(min(H, max(ys) + qh * 0.75))
    x0, x1 = int(max(0, min(xs) - qw * 0.15)), int(min(W, max(xs) + qw * 0.15))
    band = a[y0:y1, x0:x1].reshape(-1, 3)
    if len(band) < 100:
        return []
    sample = band[:: max(1, len(band) // 20000)]
    centers, _ = kmeans2(sample.astype(np.float64), 7, minit='++', seed=1)
    lab = np.argmin(((band[:, None, :] - centers[None]) ** 2).sum(2), axis=1)
    lab = lab.reshape(y1 - y0, x1 - x0)

    best = None
    for c in range(len(centers)):
        m = lab == c
        if m.mean() > 0.5 or m.sum() < 300:
            continue
        l2, n2 = ndimage.label(ndimage.binary_fill_holes(m))
        blobs = []
        for i in range(1, n2 + 1):
            by_, bx_ = np.where(l2 == i)
            w, h = bx_.max() - bx_.min() + 1, by_.max() - by_.min() + 1
            if len(by_) < 200 or not (0.55 < w / h < 1.8):
                continue
            if len(by_) / (w * h) < 0.6:            # должно быть похоже на круг
                continue
            blobs.append((bx_.min(), by_.min(), w, h, len(by_)))
        if len(blobs) < 3:
            continue
        blobs.sort(key=lambda t: -t[4])
        three = sorted(blobs[:3], key=lambda t: t[0])
        areas = [t[4] for t in three]
        if max(areas) > 2.2 * min(areas):
            continue
        spread = three[2][0] + three[2][2] - three[0][0]
        if spread < qw * 0.4:
            continue
        score = spread * min(areas)
        if best is None or score > best[0]:
            best = (score, three)
    if not best:
        return []
    out = []
    for bx_, by_, w, h, _ in best[1]:
        px, py = w * 0.18, h * 0.18
        out.append({'x': round((x0 + bx_ - px) / W, 5), 'y': round((y0 + by_ - py) / H, 5),
                    'w': round((w + 2 * px) / W, 5), 'h': round((h + 2 * py) / H, 5)})
    return out


def ladder(quad, W, H):
    """Набор масштабов для меню: 100 %, «весь кадр» и одна ступень крупнее."""
    qw = np.hypot(quad[1][0] - quad[0][0], quad[1][1] - quad[0][1])
    k_cover = max(PHONE_W / W, PHONE_H / H)
    whole = qw * k_cover / NATURAL        # какой масштаб даёт кадр целиком
    steps = [1.00]
    if abs(whole - 1) > 0.04:
        steps.append(round(whole, 2))
    steps.append(round(max(steps) + 0.15, 2))
    return steps, whole, qw / W


def main():
    if len(sys.argv) < 3:
        raise SystemExit('Как запускать: python3 tools/sceneprep.py сцена.png выход.jpg')
    src, dst = sys.argv[1], sys.argv[2]
    img = Image.open(src).convert('RGB')
    W, H = img.size
    a = np.asarray(img).astype(np.float32)

    m = magenta_mask(a)
    quad = quad_from_mask(m)
    quad = [(round(x), round(y)) for x, y in quad]

    # раздвигаем на две точки наружу: наложение должно закрыть экран целиком
    cx = sum(p[0] for p in quad) / 4.0
    cy = sum(p[1] for p in quad) / 4.0
    grow = 1.0 + 4.0 / max(1.0, np.hypot(quad[1][0] - quad[0][0], quad[1][1] - quad[0][1]))
    quad = [(round(cx + (x - cx) * grow), round(cy + (y - cy) * grow)) for x, y in quad]

    buttons = find_buttons(a, quad)
    steps, whole, share = ladder(quad, W, H)

    img.save(dst, quality=92, optimize=True, progressive=True)

    name = dst.rsplit('/', 1)[-1].replace('scene_', '').replace('.jpg', '')
    print('фотография: %d × %d, соотношение %.4f (у айфона 0.4615)' % (W, H, W / H))
    print('экран занимает %.1f %% ширины кадра (нужно от 47.6 %%)' % (share * 100))
    print('весь кадр целиком помещается при масштабе %.0f %%' % (whole * 100))
    if not buttons:
        print('!! кнопки не нашлись — размечу вручную')
    print('\n    %s: {' % name)
    print("      name: '%s'," % name)
    print("      kind: 'scene',")
    print("      image: '%s'," % dst[dst.find('resources/'):])
    print('      w: %d, h: %d,' % (W, H))
    print('      quad: %s,' % json.dumps([list(p) for p in quad]).replace('[[', '[[').replace('], [', '], ['))
    print('      radius: 0.030,')
    print('      buttons: [')
    for b in buttons:
        print('        { x: %.5f, y: %.5f, w: %.5f, h: %.5f },' % (b['x'], b['y'], b['w'], b['h']))
    print('      ],')
    print('      zooms: %s,' % json.dumps(steps))
    print('    },')


if __name__ == '__main__':
    main()
