/* ============================================================================
   Фотокорпус.

   Корпус в игре нарисован средствами CSS — фотореализма из него не выжать.
   Здесь два способа заменить его фотографией.

   1. ГОТОВАЯ СЦЕНА (kind: 'scene'). Одна настоящая фотография: корпус, стол,
      свет, тень и глубина резкости уже сняты вместе. Игровой холст
      накладывается точно в четырёхугольник экрана на фото — проективным
      преобразованием, поэтому наклон корпуса учитывается. Выглядит лучше
      всего, зато экран получается только такой, какой он на фотографии.

   2. КОРПУС ИЗ ЧАСТЕЙ. Картинка корпуса с прозрачным фоном лежит поверх
      отдельной картинки фона, на месте экрана — дырка, тень рисуется по
      силуэту. Фоны и корпуса сочетаются как угодно, размер экрана любой.

      Слои снизу вверх: фон → тень → корпус → игровой холст в вырезе →
      стекло (блик, внутренняя тень, пиксельная сетка) → невидимые кнопки.

   В ОБОИХ случаях игровой холст НЕ растягивается под вырез: он остаётся
   штатного размера 192×192, а преобразование применяется целиком. Иначе меню
   и текст верстаются по другой ширине и разъезжаются.

   Всё управление — в одном пункте настроек «фотокорпус», который открывает
   свой экран. В общем списке настроек игры добавляется ровно одна строка.
   ============================================================================ */
(function () {
  'use strict';

  const hasApp = () => typeof App !== 'undefined' && !!App;

  const LS_ON    = 'tama_skin_on';
  const LS_SHELL = 'tama_skin_shell';
  const LS_BG    = 'tama_skin_bg';
  const LS_ZOOM  = 'tama_skin_zoom';       // масштаб игрового экрана: 1 = как без корпуса
  const LS_Y     = 'tama_skin_y';          // положение корпуса по вертикали, доля высоты
  const LS_TRY   = 'tama_skin_building';   // сборка началась, но ещё не подтвердилась

  /* Метка текущего запуска страницы: отличает «сборка оборвалась в прошлый
     раз» от «пересобираем прямо сейчас, второй раз подряд». */
  const RUN = Math.random().toString(36).slice(2) + Date.now().toString(36);

  const NATURAL = 192;                     // штатный размер игрового экрана в точках

  /* ---------------------------------------------------------------------- */
  /* Корпуса. Доли считаются от размера картинки корпуса, поэтому геометрия
     не зависит от размера экрана телефона.                                  */
  /* ---------------------------------------------------------------------- */
  const SHELLS = {
    cream: {
      name: 'кремовый',
      image: 'resources/img/skins/shell_cream.png',
      w: 793, h: 1042,
      offsetY: 0.5,
      /* вырез на единицу шире настоящего с каждой стороны: так он гарантированно
         накрывает полупрозрачную кромку, и мимо не просвечивает фон */
      screen:  { x: 0.23455, y: 0.30422, w: 0.53216, h: 0.40499 },
      radius:  0.030,                      // скругление углов экрана, доля от его ширины
      /* тень нарисована заранее, tools/makeshadow.py; pad — поле вокруг корпуса
         на картинке тени, доля от ширины корпуса */
      shadow:  { image: 'resources/img/skins/shadow_cream.png', pad: 0.20050 },
      buttons: [
        { x: 0.24762, y: 0.76777, w: 0.11259, h: 0.08154 },   // левая
        { x: 0.43677, y: 0.80190, w: 0.11259, h: 0.08430 },   // средняя
        { x: 0.62691, y: 0.76681, w: 0.11440, h: 0.08154 },   // правая
      ],
      light: 'left-top',                   // откуда свет: по нему строим тень и блик
    },
  };

  /* ---------------------------------------------------------------------- */
  /* Готовые сцены. Здесь корпус, стол, свет и тень — одна настоящая
     фотография, ничего не собирается из частей. Игровой экран накладывается
     ровно в четырёхугольник экрана на фото, с учётом перспективы.

     quad — углы экрана на фотографии, в её пикселях, по часовой стрелке
     начиная с левого верхнего. buttons — доли от размера фотографии.       */
  /* ---------------------------------------------------------------------- */
  const SCENES = {
    desk: {
      name: 'фото на столе',
      kind: 'scene',
      image: 'resources/img/skins/scene_desk.jpg',
      w: 852, h: 1846,
      /* углы на пару точек шире настоящего экрана: наложение должно закрыть
         его целиком, иначе по краю проглядывает картинка с фотографии */
      quad: [[296, 862], [564, 863], [565, 1125], [295, 1124]],
      radius: 0.030,
      buttons: [
        { x: 0.36854, y: 0.61810, w: 0.06103, h: 0.02817 },   // левая
        { x: 0.47418, y: 0.63109, w: 0.06103, h: 0.02871 },   // средняя
        { x: 0.57981, y: 0.61864, w: 0.06103, h: 0.02817 },   // правая
      ],
      zooms: [1.00, 0.80, 0.65],
    },
  };

  /* Сцена идёт первой: для нового телефона это вид по умолчанию — он
     реалистичнее, чем корпус, собранный из частей. */
  const ALL = Object.assign({}, SCENES, SHELLS);
  const isScene = s => s && s.kind === 'scene';

  const BACKGROUNDS = {
    wood: { name: 'дерево', image: 'resources/img/skins/bg_wood.jpg' },
    none: { name: 'нет',    image: null },
  };

  /* Масштаб игрового экрана. 1 = ровно 192 точки, как в режиме без фотокорпуса:
     корпус подгоняется под экран, а не наоборот. */
  const ZOOMS = [1.00, 0.92, 0.85, 1.08];
  const SPOTS = [
    { v: 0.40, name: 'выше' },
    { v: 0.50, name: 'центр' },
    { v: 0.60, name: 'ниже' },
  ];

  /* ---------------------------------------------------------------------- */
  const get = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const set = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
  const drop = k => { try { localStorage.removeItem(k); } catch (e) {} };

  const shellId = () => (ALL[get(LS_SHELL)] ? get(LS_SHELL) : Object.keys(ALL)[0]);
  const bgId    = () => (BACKGROUNDS[get(LS_BG)] ? get(LS_BG) : Object.keys(BACKGROUNDS)[0]);
  const shell      = () => ALL[shellId()];
  const background = () => BACKGROUNDS[bgId()];
  const isOn = () => get(LS_ON) === '1';

  const num = (key, def, lo, hi) => {
    const v = parseFloat(get(key));
    return (v >= lo && v <= hi) ? v : def;
  };
  const zooms     = () => shell().zooms || ZOOMS;
  const zoom      = () => num(LS_ZOOM, zooms()[0], 0.4, 2);
  const shellY    = () => num(LS_Y, shell().offsetY || 0.5, 0.2, 0.8);
  /* Сколько получилось на самом деле: на узком экране корпус может не влезть
     в запрошенный масштаб, и врать об этом в меню не надо. */
  let doneZoom = 1;
  const spotName  = () => {
    const y = shellY();
    const found = SPOTS.find(s => Math.abs(s.v - y) < 0.02);
    return found ? found.name : Math.round(y * 100) + '%';
  };

  /* ---------------------------------------------------------------------- */
  const CSS = `
.skin-layer{position:fixed;inset:0;overflow:hidden;z-index:2;background:#101014;
  /* события ловим здесь: и экран, и кнопки лежат внутри этого же слоя */
  pointer-events:auto;}

.skin-bg{position:absolute;inset:0;background:50% 50% / cover no-repeat;}

/* корпус: то, относительно чего считаются экран и кнопки.
   Ширину ставит скрипт (в точках), исходя из нужного размера игрового экрана. */
.skin-device{position:absolute;left:50%;top:calc(var(--dev-y) * 100%);
  /* высоту задаём соотношением сторон из описания, а НЕ размером картинки:
     иначе не загрузившаяся картинка обнуляет высоту, вырез схлопывается,
     и вместо игры остаётся чёрный экран без выхода */
  aspect-ratio:var(--dev-ar);
  transform:translate(-50%,-50%);}
.skin-shell{position:absolute;inset:0;display:block;width:100%;height:100%;
  user-select:none;-webkit-user-drag:none;}

/* Тень — отдельная картинка, нарисованная по силуэту корпуса заранее.
   Раньше её рисовал сам браузер (filter: drop-shadow), но на телефоне он
   иногда берёт вместо силуэта прямоугольник картинки, и тень получается
   квадратной. Готовая картинка так сломаться не может. */
.skin-shadow{position:absolute;display:block;pointer-events:none;
  /* поле вокруг корпуса на картинке тени одинаковое со всех сторон, но по
     вертикали его доля другая — считаем от высоты корпуса */
  left:calc(var(--shpx) * -100%);top:calc(var(--shpy) * -100%);
  width:calc((1 + 2 * var(--shpx)) * 100%);height:auto;}

/* вырез под экран */
.skin-screen{position:absolute;overflow:hidden;pointer-events:auto;background:#000;
  left:calc(var(--sx) * 100%);top:calc(var(--sy) * 100%);
  width:calc(var(--sw) * 100%);height:calc(var(--sh) * 100%);
  border-radius:var(--srad);}
/* внутри — коробка штатного размера, целиком уменьшенная под вырез */
.skin-fit{position:absolute;left:50%;top:50%;
  width:${NATURAL}px;height:${NATURAL}px;
  transform:translate(-50%,-50%) scale(var(--fit, 1));
  transform-origin:50% 50%;}

/* стекло */
.skin-glass{position:absolute;pointer-events:none;
  left:calc(var(--sx) * 100%);top:calc(var(--sy) * 100%);
  width:calc(var(--sw) * 100%);height:calc(var(--sh) * 100%);
  border-radius:var(--srad);
  box-shadow:inset 0 2px 6px rgba(0,0,0,.55), inset 0 -1px 3px rgba(255,255,255,.10);}
.skin-glass:before{content:"";position:absolute;inset:0;border-radius:inherit;
  background:
    repeating-linear-gradient(to right, rgba(0,0,0,.035) 0 1px, transparent 1px var(--px)),
    repeating-linear-gradient(to bottom, rgba(0,0,0,.035) 0 1px, transparent 1px var(--px));
  mix-blend-mode:multiply;}
.skin-glass.no-grid:before{display:none;}
.skin-glass:after{content:"";position:absolute;inset:0;border-radius:inherit;
  background:linear-gradient(var(--glare-angle),
    rgba(255,255,255,.26) 0%, rgba(255,255,255,.10) 26%,
    rgba(255,255,255,0) 46%, rgba(255,255,255,0) 100%);}

/* готовая сцена: одна фотография, на которой уже есть и корпус, и стол,
   и свет, и тень. Экран накладывается в четырёхугольник экрана на фото. */
.skin-scene{position:absolute;overflow:hidden;}
.skin-photo{position:absolute;inset:0;width:100%;height:100%;display:block;
  user-select:none;-webkit-user-drag:none;}
/* коробка штатного размера 192×192, вписанная в четырёхугольник экрана.
   Преобразование ставит скрипт: это проекция, а не простое уменьшение. */
.skin-warp{position:absolute;left:0;top:0;width:${NATURAL}px;height:${NATURAL}px;
  transform-origin:0 0;overflow:hidden;background:#111018;
  /* сглаживаем края наложения, чтобы не выпирал угол поверх бортика */
  border-radius:var(--wrad, 0);}
/* Стекло у сцены скромнее, чем у корпуса из частей: свет и отражения уже есть
   на фотографии, от нас нужно только посадить наложение внутрь бортика —
   тень по краю и еле заметный тёплый налёт, чтобы экран не был «наклейкой». */
.skin-warp:after{content:"";position:absolute;inset:0;pointer-events:none;
  border-radius:inherit;
  background:linear-gradient(155deg, rgba(255,244,225,.16) 0%,
    rgba(255,240,220,.05) 22%, rgba(0,0,0,0) 45%, rgba(0,0,0,.05) 100%);
  box-shadow:inset 0 0 0 1px rgba(0,0,0,.18),
             inset 0 3px 7px rgba(0,0,0,.34), inset 0 -2px 5px rgba(0,0,0,.18);}

.skin-btn{position:absolute;pointer-events:auto;background:transparent;border:0;padding:0;
  border-radius:50%;-webkit-tap-highlight-color:transparent;
  left:calc(var(--bx) * 100%);top:calc(var(--by) * 100%);
  width:calc(var(--bw) * 100%);height:calc(var(--bh) * 100%);}
.skin-btn:active{background:rgba(0,0,0,.18);box-shadow:inset 0 2px 6px rgba(0,0,0,.35);}

/* пока фотокорпус включён, обычный корпус и обои не участвуют */
.root.skin-on > .dom-shell,
.root.skin-on > .bg-pattern,
.root.skin-on > .background-canvas{display:none !important;}
/* холст остаётся штатного размера — уменьшает его .skin-fit */
.root.skin-on .graphics-wrapper{
  position:absolute !important;left:0 !important;top:0 !important;
  width:${NATURAL}px !important;max-width:${NATURAL}px !important;
  transform:none !important;outline:0 !important;border-radius:0 !important;}
`;

  function injectCss() {
    if (document.getElementById('skin-css')) return;
    const el = document.createElement('style');
    el.id = 'skin-css';
    el.textContent = CSS;
    document.head.appendChild(el);
  }

  /* ---------------------------------------------------------------------- */
  /* Сборка и разборка слоя                                                  */
  /* ---------------------------------------------------------------------- */
  let layer = null, home = null, homeNext = null;

  /* Холст переезжает в указанную коробку; откуда взяли — запоминаем. */
  function moveCanvasInto(box) {
    const gw = document.querySelector('.graphics-wrapper');
    if (!gw) return;
    home = gw.parentNode;
    homeNext = gw.nextSibling;
    box.appendChild(gw);
  }

  function addButtons(host, list) {
    (list || []).forEach((b, i) => {
      const btn = document.createElement('button');
      btn.className = 'skin-btn';
      btn.setAttribute('aria-label', ['левая кнопка', 'средняя кнопка', 'правая кнопка'][i] || 'кнопка');
      ['--bx', '--by', '--bw', '--bh'].forEach((v, j) =>
        btn.style.setProperty(v, b[['x', 'y', 'w', 'h'][j]]));
      btn.addEventListener('click', () => { try { App.handlers.shell_button(i); } catch (e) {} });
      host.appendChild(btn);
    });
  }

  function build() {
    return isScene(shell()) ? buildScene() : buildParts();
  }

  /* ---------------------------------------------------------------------- */
  /* Готовая сцена: одна фотография + игровой экран в перспективе            */
  /* ---------------------------------------------------------------------- */
  function buildScene() {
    const s = shell();
    const root = document.querySelector('.root');
    if (!root) return false;

    injectCss();

    layer = document.createElement('div');
    layer.className = 'skin-layer';

    const scene = document.createElement('div');
    scene.className = 'skin-scene';

    const photo = document.createElement('img');
    photo.className = 'skin-photo';
    photo.src = s.image;
    photo.alt = '';
    photo.addEventListener('load', refit);
    photo.addEventListener('error', () => failSafe('фотография не загрузилась'));
    scene.appendChild(photo);

    const warp = document.createElement('div');
    warp.className = 'skin-warp';
    scene.appendChild(warp);

    addButtons(scene, s.buttons);
    layer.appendChild(scene);
    root.appendChild(layer);
    moveCanvasInto(warp);

    root.classList.add('skin-on');
    refit();
    window.addEventListener('resize', refit);
    setTimeout(verifyOrFail, 1000);
    return true;
  }

  /* Проекция квадрата 0..NATURAL на четырёхугольник экрана на фотографии.
     Возвращает восемь чисел a..h: x' = (ax+by+c)/(gx+hy+1), y' = (dx+ey+f)/…
     Решается система 8×8 обычным методом Гаусса — восемь строк, по две на
     каждый угол. */
  function homography(quad, size, k) {
    const dst = quad.map(p => [p[0] * k, p[1] * k]);
    const src = [[0, 0], [size, 0], [size, size], [0, size]];
    const M = [], v = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i], [X, Y] = dst[i];
      M.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); v.push(X);
      M.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); v.push(Y);
    }
    for (let c = 0; c < 8; c++) {
      let p = c;
      for (let r2 = c + 1; r2 < 8; r2++) if (Math.abs(M[r2][c]) > Math.abs(M[p][c])) p = r2;
      if (Math.abs(M[p][c]) < 1e-12) return null;
      [M[c], M[p]] = [M[p], M[c]]; [v[c], v[p]] = [v[p], v[c]];
      const d = M[c][c];
      for (let j = c; j < 8; j++) M[c][j] /= d;
      v[c] /= d;
      for (let r2 = 0; r2 < 8; r2++) {
        if (r2 === c || !M[r2][c]) continue;
        const f = M[r2][c];
        for (let j = c; j < 8; j++) M[r2][j] -= f * M[c][j];
        v[r2] -= f * v[c];
      }
    }
    return v;      // [a,b,c,d,e,f,g,h]
  }

  /* Ставим сцену по месту и накладываем игровой экран на экран фотографии. */
  function fitScene() {
    if (!layer) return;
    const s = shell();
    const scene = layer.querySelector('.skin-scene');
    const warp = layer.querySelector('.skin-warp');
    if (!scene || !warp) return;

    const lr = layer.getBoundingClientRect();
    const vw = lr.width || 1, vh = lr.height || 1;

    /* ширина экрана на фотографии, в её пикселях — по верхнему краю */
    const q = s.quad;
    const quadW = Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]);

    /* сколько нужно увеличить фотографию, чтобы игровой экран вышел нужного
       размера; и сколько нужно, чтобы фотография закрыла экран телефона без
       щелей — берём большее */
    const kWant  = NATURAL * zoom() / quadW;
    const kCover = Math.max(vw / s.w, vh / s.h);
    const k = Math.max(kWant, kCover);

    const sw = s.w * k, sh = s.h * k;
    const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4;
    const cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
    /* держим экран фотографии в середине телефона, но без щелей по краям */
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const left = clamp(vw / 2 - cx * k, vw - sw, 0);
    const top  = clamp(vh / 2 - cy * k, vh - sh, 0);

    scene.style.width = sw.toFixed(2) + 'px';
    scene.style.height = sh.toFixed(2) + 'px';
    scene.style.left = left.toFixed(2) + 'px';
    scene.style.top = top.toFixed(2) + 'px';

    const H = homography(q, NATURAL, k);
    if (!H) { failSafe('не получилось разместить экран'); return; }
    const [a, b, c, d, e, f, g, h] = H;
    warp.style.transform = 'matrix3d(' +
      [a, d, 0, g, b, e, 0, h, 0, 0, 1, 0, c, f, 0, 1]
        .map(n => (Math.abs(n) < 1e-9 ? 0 : +n.toFixed(8))).join(',') + ')';
    warp.style.setProperty('--wrad', ((s.radius || 0) * NATURAL).toFixed(2) + 'px');

    doneZoom = quadW * k / NATURAL;
  }

  /* ---------------------------------------------------------------------- */
  /* Корпус из частей: картинка корпуса поверх картинки фона                 */
  /* ---------------------------------------------------------------------- */
  function buildParts() {
    const s = shell();
    const bg = background();
    const root = document.querySelector('.root');
    if (!root) return false;

    injectCss();

    layer = document.createElement('div');
    layer.className = 'skin-layer';

    const back = document.createElement('div');
    back.className = 'skin-bg';
    if (bg.image) back.style.backgroundImage = `url(${bg.image})`;
    layer.appendChild(back);

    const device = document.createElement('div');
    device.className = 'skin-device';
    device.style.setProperty('--dev-y', shellY());
    device.style.setProperty('--dev-ar', (s.w / s.h).toFixed(5));

    const left = (s.light || 'left-top') === 'left-top';

    if (s.shadow && s.shadow.image) {
      const sh = document.createElement('img');
      sh.className = 'skin-shadow';
      sh.src = s.shadow.image;
      sh.alt = '';
      const pad = s.shadow.pad || 0;
      sh.style.setProperty('--shpx', pad.toFixed(5));
      sh.style.setProperty('--shpy', (pad * s.w / s.h).toFixed(5));
      /* если картинки тени нет — просто не будет тени, игру это не касается */
      sh.addEventListener('error', () => sh.remove());
      device.appendChild(sh);
    }

    const img = document.createElement('img');
    img.className = 'skin-shell';
    img.src = s.image;
    img.alt = '';
    img.addEventListener('load', refit);
    img.addEventListener('error', () => failSafe('картинка корпуса не загрузилась'));
    device.appendChild(img);

    const screen = document.createElement('div');
    screen.className = 'skin-screen';
    ['x', 'y', 'w', 'h'].forEach((k, i) =>
      screen.style.setProperty(['--sx', '--sy', '--sw', '--sh'][i], s.screen[k]));
    /* скругление ставит refit(): оно считается от получившейся ширины выреза */
    screen.style.setProperty('--srad', '0px');

    const fit = document.createElement('div');
    fit.className = 'skin-fit';
    screen.appendChild(fit);

    const glass = document.createElement('div');
    glass.className = 'skin-glass';
    ['--sx', '--sy', '--sw', '--sh', '--srad'].forEach(v =>
      glass.style.setProperty(v, screen.style.getPropertyValue(v)));
    glass.style.setProperty('--glare-angle', left ? '145deg' : '215deg');

    device.appendChild(screen);
    device.appendChild(glass);

    addButtons(device, s.buttons);

    layer.appendChild(device);
    root.appendChild(layer);
    moveCanvasInto(fit);

    root.classList.add('skin-on');
    refit();
    window.addEventListener('resize', refit);

    setTimeout(verifyOrFail, 1000);
    return true;
  }

  /* Размер корпуса считается ОТ игрового экрана, а не наоборот: сначала
     решаем, сколько точек должен занимать экран, потом растим под него корпус.
     При масштабе 100 % экран получается ровно 192 точки — столько же, сколько
     в режиме без фотокорпуса, и вся вёрстка меню совпадает точка в точку. */
  function fitDevice() {
    if (!layer) return;
    const s = shell();
    const device = layer.querySelector('.skin-device');
    if (!device) return;
    const ar = s.w / s.h;                          // ширина к высоте
    /* вырез квадратный в пикселях картинки; на всякий случай берём меньшую
       сторону — растягивать квадратный игровой экран нельзя */
    const holeShare = Math.min(s.screen.w, s.screen.h / ar);
    const want = NATURAL * zoom();                 // сколько точек должен занять экран
    let devW = want / holeShare;

    /* Если корпус в таком размере не влезает в экран телефона — уменьшаем. Но
       сначала разрешаем ему немного выйти за края по бокам: обещание «экран
       такой же, как без фотокорпуса» важнее, чем целиком видное яйцо, а
       фотография, срезанная по краям, выглядит просто как крупный план. */
    const BLEED = 1.08;
    const lr = layer.getBoundingClientRect();
    const room = Math.min(
      lr.width  ? lr.width * BLEED / devW : 1,
      lr.height ? (lr.height - 8) / (devW / ar) : 1
    );
    if (room < 1) devW *= room;

    device.style.width = devW.toFixed(2) + 'px';
    doneZoom = devW * holeShare / NATURAL;
  }

  /* Подгоняем масштаб экрана и шаг пиксельной сетки. */
  function refit() {
    if (!layer) return;
    if (isScene(shell())) { fitScene(); return; }
    fitDevice();
    const screen = layer.querySelector('.skin-screen');
    const fit = layer.querySelector('.skin-fit');
    const glass = layer.querySelector('.skin-glass');
    if (!screen || !fit) return;
    const r = screen.getBoundingClientRect();
    if (!r.width) return;
    /* берём меньшую сторону: игровой экран квадратный, растягивать нельзя */
    const k = Math.min(r.width, r.height) / NATURAL;
    fit.style.setProperty('--fit', k.toFixed(4));

    /* скругление выреза — доля от его ширины, в точках */
    const srad = (shell().radius || 0) * r.width;
    screen.style.setProperty('--srad', srad.toFixed(2) + 'px');
    if (glass) glass.style.setProperty('--srad', srad.toFixed(2) + 'px');

    if (glass) {
      const canvas = fit.querySelector('canvas');
      const px = (NATURAL * k) / ((canvas && canvas.width) || 96);
      glass.style.setProperty('--px', px.toFixed(3) + 'px');
      if (px < 2.2) glass.classList.add('no-grid'); else glass.classList.remove('no-grid');
    }
  }

  function destroy() {
    const root = document.querySelector('.root');
    const gw = document.querySelector('.graphics-wrapper');
    if (gw && home) {
      if (homeNext && homeNext.parentNode === home) home.insertBefore(gw, homeNext);
      else home.appendChild(gw);
    }
    home = homeNext = null;
    window.removeEventListener('resize', refit);
    if (layer) layer.remove();
    layer = null;
    if (root) root.classList.remove('skin-on');
    try { App.refreshUI(); } catch (e) {}
  }

  /* Выключить фотокорпус и вернуть обычный вид. */
  function failSafe(why) {
    if (!layer && !isOn()) return;
    console.warn('[skin] фотокорпус выключен: ' + why);
    set(LS_ON, '0');
    drop(LS_TRY);
    if (layer) destroy();
    try { App.displayPopup('Фотокорпус выключен: ' + why, 4000); } catch (e) {}
  }

  /* Экран должен быть виден и не схлопнут. Если нет — уходим в обычный вид. */
  function verifyOrFail() {
    if (!layer) return;
    const scr = layer.querySelector('.skin-screen, .skin-warp');
    const r = scr && scr.getBoundingClientRect();
    if (!r || r.width < 24 || r.height < 24) { failSafe('не получилось разместить экран'); return; }
    drop(LS_TRY);
  }

  function apply() {
    if (!isOn()) { if (layer) destroy(); return; }

    /* Метка осталась от ДРУГОГО запуска страницы — значит тогда сборка так и
       не дошла до проверки. Второй раз в ту же яму не лезем. */
    const mark = get(LS_TRY);
    if (mark && mark !== RUN) { drop(LS_TRY); failSafe('в прошлый раз не получилось'); return; }

    set(LS_TRY, RUN);
    if (layer) destroy();
    build();
  }

  /* ---------------------------------------------------------------------- */
  /* Свой экран настроек. В общем списке игры — ровно одна строка.           */
  /* ---------------------------------------------------------------------- */
  /* Экран собирается заново только когда меняется состав пунктов — то есть
     при включении и выключении. Остальные пункты правят свою подпись на
     месте: если закрывать и открывать список на каждое нажатие, игра успевает
     закрыть и наш новый экран тоже. */
  /* Показываем то, что получилось. Если корпус пришлось уменьшить, потому что
     он не влезал в экран телефона, — так и пишем, а не рисуем желаемое. */
  function zoomLabel() {
    const want = Math.round(zoom() * 100);
    const got = layer ? Math.round(doneZoom * 100) : want;
    return Math.abs(got - want) > 2 ? got + '% (предел)' : want + '%';
  }

  function relabel(btn, icon, text) {
    btn.innerHTML = (hasApp() && App.getIcon ? App.getIcon(icon, true) : '') + ' ' + text;
  }

  function openScreen() {
    if (!hasApp()) return;
    const shellIds = Object.keys(ALL), bgIds = Object.keys(BACKGROUNDS);
    const on = isOn();
    /* У готовой сцены фон, положение и тень уже внутри фотографии — этих
       пунктов для неё нет, состав списка другой. */
    const scene = isScene(shell());
    const reopen = (list) => setTimeout(() => {
      try { if (list && list.close) list.close(); } catch (e) {}
      openScreen();
    }, 220);

    const items = [
      {
        icon: on ? 'toggle-on' : 'toggle-off',
        name: on ? 'выключить' : 'включить',
        onclick: (btn, list) => {
          set(LS_ON, on ? '0' : '1');
          drop(LS_TRY);
          apply();
          /* состав пунктов поменялся — пересобираем экран, но не сразу:
             дадим игре закончить со старым списком */
          reopen(list);
          return true;
        }
      },
      { _ignore: !on, type: 'separator' },
      {
        _ignore: !on,
        icon: 'egg',
        name: 'корпус: ' + shell().name,
        onclick: (btn, list) => {
          if (shellIds.length < 2) {
            try { App.displayPopup('Другие корпуса появятся, когда добавим картинки.', 3000); } catch (e) {}
            return true;
          }
          set(LS_SHELL, shellIds[(shellIds.indexOf(shellId()) + 1) % shellIds.length]);
          drop(LS_ZOOM); drop(LS_Y);        // у нового корпуса свои значения по умолчанию
          apply();
          /* у сцены и у корпуса из частей разный состав пунктов */
          if (isScene(shell()) !== scene) reopen(list);
          else relabel(btn, 'egg', 'корпус: ' + shell().name);
          return true;
        }
      },
      {
        _ignore: !on || scene,
        icon: 'panorama',
        name: 'фон: ' + background().name,
        onclick: (btn) => {
          set(LS_BG, bgIds[(bgIds.indexOf(bgId()) + 1) % bgIds.length]);
          apply();
          relabel(btn, 'panorama', 'фон: ' + background().name);
          return true;
        }
      },
      {
        _ignore: !on,
        icon: 'up-right-and-down-left-from-center',
        name: 'экран: ' + zoomLabel(),
        onclick: (btn) => {
          const list2 = zooms();
          const i = list2.findIndex(v => Math.abs(v - zoom()) < 0.005);
          set(LS_ZOOM, String(list2[((i < 0 ? 0 : i) + 1) % list2.length]));
          apply();
          relabel(btn, 'up-right-and-down-left-from-center', 'экран: ' + zoomLabel());
          return true;
        }
      },
      {
        _ignore: !on || scene,
        icon: 'arrows-up-down',
        name: 'положение: ' + spotName(),
        onclick: (btn) => {
          const i = SPOTS.findIndex(p => Math.abs(p.v - shellY()) < 0.02);
          set(LS_Y, String(SPOTS[((i < 0 ? 1 : i) + 1) % SPOTS.length].v));
          apply();
          relabel(btn, 'arrows-up-down', 'положение: ' + spotName());
          return true;
        }
      },
      { _ignore: !on, type: 'separator' },
      {
        _ignore: !on || scene,
        type: 'info',
        name: '<small>Экран 100 % — ровно такой же, как без фотокорпуса: корпус подгоняется под экран.<br><br>Если картинка не загрузится, фотокорпус выключится сам и напишет причину.</small>'
      },
      {
        _ignore: !on || !scene,
        type: 'info',
        name: '<small>Это одна настоящая фотография: корпус, стол, свет и тень уже на ней, игра наложена в экран с учётом наклона.<br><br>100 % — экран ровно как без фотокорпуса. Меньше — видно больше стола, но и текст мельче.<br><br>Вернуться к прежнему корпусу — пунктом «корпус» выше.</small>'
      },
      {
        _ignore: on,
        type: 'info',
        name: '<small>Корпус и стол станут фотографией. Игра работает как обычно, выключить можно здесь же.</small>'
      },
    ].filter(it => !it._ignore);

    /* Третий довод — заголовок экрана: без него игра берёт подпись кнопки,
       которой экран открыли, и после переключения он становится «включить». */
    App.displayList(items, null, 'фотокорпус');
  }

  /* Пункт в общем списке настроек. Своего перехвата меню здесь нет: список
     собирает sync.js, а мы кладём в него одну строку. */
  function menuItem() {
    return {
      icon: 'image',
      name: 'фотокорпус',
      onclick: () => { openScreen(); return true; }
    };
  }
  window.TamaExtraMenu = window.TamaExtraMenu || [];
  if (!window.TamaExtraMenu.some(f => f.__skin)) {
    menuItem.__skin = true;
    window.TamaExtraMenu.push(menuItem);
  }

  /* Аварийный выключатель через адрес: pbelyaev1.github.io/?noskin */
  try {
    if (/[?&#]noskin/.test(location.search + location.hash)) { set(LS_ON, '0'); drop(LS_TRY); }
  } catch (e) {}

  /* Ждём, пока игра построит своё дерево, и только потом вмешиваемся. */
  (function waitGame(tries) {
    if (hasApp() && App.loadingEnded && document.querySelector('.graphics-wrapper')) { apply(); return; }
    if (tries > 400) return;
    setTimeout(() => waitGame(tries + 1), 250);
  })(0);

  window.TamaSkin = {
    on:    () => { set(LS_ON, '1'); drop(LS_TRY); apply(); },
    off:   () => failSafe('вручную'),
    menu:  openScreen,
    shell: id => { if (ALL[id]) { set(LS_SHELL, id); apply(); } return shellId(); },
    bg:    id => { if (BACKGROUNDS[id]) { set(LS_BG, id); apply(); } return bgId(); },
    zoom:  v  => { if (v) set(LS_ZOOM, String(v)); apply(); return doneZoom; },
    size:  v  => { if (v) set(LS_ZOOM, String(v)); apply(); return doneZoom; },   // старое имя
    y:     v  => { if (v) set(LS_Y, String(v)); apply(); return shellY(); },
    rect:  () => { const el = layer && layer.querySelector('.skin-screen, .skin-warp'); return el ? el.getBoundingClientRect() : null; },
    shells: ALL, scenes: SCENES, backgrounds: BACKGROUNDS,
  };
})();
