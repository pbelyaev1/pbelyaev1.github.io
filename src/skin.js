/* ============================================================================
   Фотокорпус.

   Корпус в игре нарисован средствами CSS — фотореализма из него не выжать.
   Здесь другой подход: отдельная картинка корпуса с прозрачным фоном лежит
   поверх отдельной картинки фона, а на месте экрана у корпуса вырезана дырка,
   в которую смотрит игровой холст.

   Слои снизу вверх:
       1. фон — картинка на весь экран;
       2. корпус — картинка с прозрачным фоном, тень рисуется по его силуэту;
       3. игровой холст — в вырезе экрана;
       4. стекло: блик, внутренняя тень, пиксельная сетка;
       5. невидимые кнопки поверх нарисованных на корпусе.

   Игровой холст НЕ растягивается под вырез: он остаётся штатного размера
   192×192 и целиком уменьшается одним преобразованием. Иначе меню и текст
   верстаются по другой ширине и разъезжаются.

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

  const shellId = () => (SHELLS[get(LS_SHELL)] ? get(LS_SHELL) : Object.keys(SHELLS)[0]);
  const bgId    = () => (BACKGROUNDS[get(LS_BG)] ? get(LS_BG) : Object.keys(BACKGROUNDS)[0]);
  const shell      = () => SHELLS[shellId()];
  const background = () => BACKGROUNDS[bgId()];
  const isOn = () => get(LS_ON) === '1';

  const num = (key, def, lo, hi) => {
    const v = parseFloat(get(key));
    return (v >= lo && v <= hi) ? v : def;
  };
  const zoom      = () => num(LS_ZOOM, 1, 0.5, 2);
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

  function build() {
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

    (s.buttons || []).forEach((b, i) => {
      const btn = document.createElement('button');
      btn.className = 'skin-btn';
      btn.setAttribute('aria-label', ['левая кнопка', 'средняя кнопка', 'правая кнопка'][i] || 'кнопка');
      ['--bx', '--by', '--bw', '--bh'].forEach((v, j) =>
        btn.style.setProperty(v, b[['x', 'y', 'w', 'h'][j]]));
      btn.addEventListener('click', () => { try { App.handlers.shell_button(i); } catch (e) {} });
      device.appendChild(btn);
    });

    layer.appendChild(device);
    root.appendChild(layer);

    /* переносим холст в вырез, запомнив, откуда взяли */
    const gw = document.querySelector('.graphics-wrapper');
    if (gw) {
      home = gw.parentNode;
      homeNext = gw.nextSibling;
      fit.appendChild(gw);
    }

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
    const scr = layer.querySelector('.skin-screen');
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
    const shellIds = Object.keys(SHELLS), bgIds = Object.keys(BACKGROUNDS);
    const on = isOn();

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
          setTimeout(() => {
            try { if (list && list.close) list.close(); } catch (e) {}
            openScreen();
          }, 220);
          return true;
        }
      },
      { _ignore: !on, type: 'separator' },
      {
        _ignore: !on,
        icon: 'egg',
        name: 'корпус: ' + shell().name,
        onclick: (btn) => {
          if (shellIds.length < 2) {
            try { App.displayPopup('Другие корпуса появятся, когда добавим картинки.', 3000); } catch (e) {}
            return true;
          }
          set(LS_SHELL, shellIds[(shellIds.indexOf(shellId()) + 1) % shellIds.length]);
          drop(LS_ZOOM); drop(LS_Y);        // у нового корпуса свои значения по умолчанию
          apply();
          relabel(btn, 'egg', 'корпус: ' + shell().name);
          return true;
        }
      },
      {
        _ignore: !on,
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
          const i = ZOOMS.findIndex(v => Math.abs(v - zoom()) < 0.005);
          set(LS_ZOOM, String(ZOOMS[((i < 0 ? 0 : i) + 1) % ZOOMS.length]));
          apply();
          relabel(btn, 'up-right-and-down-left-from-center', 'экран: ' + zoomLabel());
          return true;
        }
      },
      {
        _ignore: !on,
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
        _ignore: !on,
        type: 'info',
        name: '<small>Экран 100 % — ровно такой же, как без фотокорпуса: корпус подгоняется под экран.<br><br>Если картинка не загрузится, фотокорпус выключится сам и напишет причину.</small>'
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
    shell: id => { if (SHELLS[id]) { set(LS_SHELL, id); apply(); } return shellId(); },
    bg:    id => { if (BACKGROUNDS[id]) { set(LS_BG, id); apply(); } return bgId(); },
    zoom:  v  => { if (v) set(LS_ZOOM, String(v)); apply(); return doneZoom; },
    size:  v  => { if (v) set(LS_ZOOM, String(v)); apply(); return doneZoom; },   // старое имя
    y:     v  => { if (v) set(LS_Y, String(v)); apply(); return shellY(); },
    rect:  () => { const el = layer && layer.querySelector('.skin-screen'); return el ? el.getBoundingClientRect() : null; },
    shells: SHELLS, backgrounds: BACKGROUNDS,
  };
})();
