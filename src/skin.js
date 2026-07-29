/* ============================================================================
   Фотокорпус.

   Обычный корпус в игре нарисован средствами CSS: скруглённый прямоугольник
   с тенями. Фотореализма из него не выжать, поэтому здесь другой подход —
   настоящая фотография, у которой на месте экрана вырезана дырка.

   Два вида скинов:

   • «сцена» (scene) — одна фотография, где корпус уже лежит на столе.
     Максимально достоверно, но корпус и фон не разъединить.

   • «части» (parts) — отдельно корпус с прозрачным фоном, отдельно фон.
     Их можно смешивать как угодно, менять размер корпуса и его положение.
     Тень корпуса рисуется по его же силуэту, поэтому повторяет форму.

   Важно: игровой холст НЕ растягивается под дырку. Он остаётся своего
   штатного размера 192×192, как в обычном режиме, и целиком масштабируется
   одним преобразованием. Иначе меню и текст верстаются по другой ширине и
   разъезжаются.
   ============================================================================ */
(function () {
  'use strict';

  const hasApp = () => typeof App !== 'undefined' && !!App;
  const LS_ON    = 'tama_skin_on';
  const LS_SHELL = 'tama_skin_shell';
  const LS_BG    = 'tama_skin_bg';
  const LS_SIZE  = 'tama_skin_size';       // доля ширины экрана, которую занимает корпус
  const LS_Y     = 'tama_skin_y';          // положение корпуса по вертикали, доля высоты
  const LS_TRY   = 'tama_skin_building';   // сборка началась, но ещё не подтвердилась
  /* Метка текущего запуска страницы. Нужна, чтобы отличить «сборка оборвалась
     в прошлый раз» от «пересобираем прямо сейчас, второй раз подряд». */
  const RUN = Math.random().toString(36).slice(2) + Date.now().toString(36);

  const NATURAL = 192;                     // штатный размер игрового экрана в точках

  /* ---------------------------------------------------------------------- */
  /* Корпуса. Доли считаются от размера картинки корпуса.                    */
  /* ---------------------------------------------------------------------- */
  const SHELLS = {
    /* Раздельный корпус: ложится на любой фон, размер настраивается. */
    cream: {
      name: 'кремовый',
      type: 'parts',
      image: 'resources/img/skins/shell_cream.png',
      w: 892, h: 1110,
      size: 0.82, offsetY: 0.5,
      screen:  { x: 0.25561, y: 0.31081, w: 0.48318, h: 0.38829 },
      radius:  0.045,
      buttons: [
        { x: 0.26677, y: 0.79555, w: 0.13238, h: 0.09989 },   // левая
        { x: 0.43294, y: 0.83178, w: 0.13076, h: 0.09859 },   // средняя
        { x: 0.59749, y: 0.79665, w: 0.13238, h: 0.09859 },   // правая
      ],
      light: 'left-top',
    },
    /* Склеенная сцена: корпус уже лежит на столе одной фотографией.
       Тень и отражения физически верные, но размер не поменять. */
    scene_wood: {
      name: 'стол одной сценой',
      type: 'scene',
      image: 'resources/img/skins/wood.png',
      w: 851, h: 1847,
      screen:  { x: 0.35958, y: 0.42122, w: 0.28202, h: 0.12777 },
      radius:  0.02,
      buttons: [
        { x: 0.36947, y: 0.57990, w: 0.06599, h: 0.02807 },
        { x: 0.46700, y: 0.59007, w: 0.06599, h: 0.02885 },
        { x: 0.56454, y: 0.57990, w: 0.06599, h: 0.02807 },
      ],
      light: 'left-top',
    },
  };

  /* Фоны — только для корпусов вида «части». */
  const BACKGROUNDS = {
    wood: { name: 'деревянный стол', image: 'resources/img/skins/bg_wood.jpg', light: 'left-top' },
    none: { name: 'без фона', image: null, light: 'left-top' },
  };

  const shellId = () => {
    const id = localStorage.getItem(LS_SHELL);
    return SHELLS[id] ? id : Object.keys(SHELLS)[0];
  };
  const bgId = () => {
    const id = localStorage.getItem(LS_BG);
    return BACKGROUNDS[id] ? id : Object.keys(BACKGROUNDS)[0];
  };
  const shell = () => SHELLS[shellId()];
  const background = () => BACKGROUNDS[bgId()];
  const isOn = () => localStorage.getItem(LS_ON) === '1';

  const num = (key, def, lo, hi) => {
    const v = parseFloat(localStorage.getItem(key));
    return (v >= lo && v <= hi) ? v : def;
  };
  const shellSize = () => num(LS_SIZE, shell().size || 0.78, 0.3, 1.6);
  const shellY    = () => num(LS_Y, shell().offsetY || 0.5, 0.2, 0.8);

  /* ---------------------------------------------------------------------- */
  const CSS = `
.skin-layer{position:fixed;inset:0;overflow:hidden;z-index:2;background:#0b0b0d;
  /* события ловим: и игровой экран, и кнопки лежат внутри этого же слоя,
     а касания по фону нужны для аварийного выхода тремя касаниями */
  pointer-events:auto;}

/* фон отдельной картинкой (для корпусов вида «части») */
.skin-bg{position:absolute;inset:0;background:50% 50% / cover no-repeat;}

/* сцена: картинка целиком, растянутая по правилу cover, чтобы доли на ней
   оставались долями независимо от формы экрана телефона */
.skin-stage{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
  width:max(100vw, calc(100vh * var(--skin-ar)));
  height:max(100vh, calc(100vw / var(--skin-ar)));}
.skin-stage > img{position:absolute;inset:0;width:100%;height:100%;display:block;
  user-select:none;-webkit-user-drag:none;}

/* корпус: то, относительно чего считаются экран и кнопки */
.skin-device{position:absolute;}
.skin-device.as-scene{inset:0;}
.skin-device.as-parts{
  left:50%;top:calc(var(--dev-y) * 100%);
  width:calc(var(--dev-size) * 100%);
  /* высоту задаём соотношением сторон из описания, а НЕ размером картинки:
     иначе не загрузившаяся картинка обнуляет высоту, вырез схлопывается,
     и вместо игры остаётся чёрный экран без выхода */
  aspect-ratio:var(--dev-ar);
  transform:translate(-50%,-50%);}
.skin-device.as-parts > .skin-shell{position:absolute;inset:0;
  display:block;width:100%;height:100%;
  user-select:none;-webkit-user-drag:none;
  /* тень идёт по силуэту корпуса, а не по прямоугольнику: сначала короткая
     и плотная у самой поверхности, потом длинная и мягкая */
  filter:drop-shadow(var(--sh1)) drop-shadow(var(--sh2));}

/* дырка под экран */
.skin-screen{position:absolute;overflow:hidden;pointer-events:auto;background:#000;
  left:calc(var(--sx) * 100%);top:calc(var(--sy) * 100%);
  width:calc(var(--sw) * 100%);height:calc(var(--sh) * 100%);
  border-radius:var(--srad);}
/* внутри — коробка штатного размера, целиком уменьшенная под дырку */
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
    repeating-linear-gradient(to right, rgba(0,0,0,var(--grid-alpha,.035)) 0 1px, transparent 1px var(--px)),
    repeating-linear-gradient(to bottom, rgba(0,0,0,var(--grid-alpha,.035)) 0 1px, transparent 1px var(--px));
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

/* пока фотокорпус включён, старый корпус и обои не участвуют */
.root.skin-on > .dom-shell,
.root.skin-on > .bg-pattern,
.root.skin-on > .background-canvas{display:none !important;}
/* холст остаётся своего штатного размера — масштабирует его .skin-fit */
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
  let layer = null, home = null, homeNext = null;

  function setVars(el, s) {
    el.style.setProperty('--sx', s.screen.x);
    el.style.setProperty('--sy', s.screen.y);
    el.style.setProperty('--sw', s.screen.w);
    el.style.setProperty('--sh', s.screen.h);
  }

  function build() {
    const s = shell();
    const bg = background();
    const root = document.querySelector('.root');
    if (!root) return false;

    injectCss();

    layer = document.createElement('div');
    layer.className = 'skin-layer';

    let host;                                  // куда класть корпус
    const device = document.createElement('div');
    device.className = 'skin-device ' + (s.type === 'scene' ? 'as-scene' : 'as-parts');

    if (s.type === 'scene') {
      const stage = document.createElement('div');
      stage.className = 'skin-stage';
      stage.style.setProperty('--skin-ar', (s.w / s.h).toFixed(5));
      const photo = document.createElement('img');
      photo.src = s.image;
      photo.alt = '';
      stage.appendChild(device);
      stage.appendChild(photo);
      layer.appendChild(stage);
      host = stage;
      /* картинка лежит ПОВЕРХ корпуса-контейнера: холст виден только через
         прозрачную дырку, края выреза сами накрывают его */
      device.style.zIndex = '0';
      photo.style.zIndex = '1';
    } else {
      const back = document.createElement('div');
      back.className = 'skin-bg';
      if (bg.image) back.style.backgroundImage = `url(${bg.image})`;
      layer.appendChild(back);

      const img = document.createElement('img');
      img.className = 'skin-shell';
      img.src = s.image;
      img.alt = '';
      device.appendChild(img);
      device.style.setProperty('--dev-size', shellSize());
      device.style.setProperty('--dev-y', shellY());
      device.style.setProperty('--dev-ar', (s.w / s.h).toFixed(5));
      img.addEventListener('error', () => failSafe('картинка корпуса не загрузилась'));
      const left = (s.light || 'left-top') === 'left-top';
      device.style.setProperty('--sh1', (left ? '6px' : '-6px') + ' 8px 10px rgba(0,0,0,.45)');
      device.style.setProperty('--sh2', (left ? '18px' : '-18px') + ' 34px 42px rgba(0,0,0,.32)');
      layer.appendChild(device);
      host = device;
    }

    const screen = document.createElement('div');
    screen.className = 'skin-screen';
    setVars(screen, s);
    screen.style.setProperty('--srad', (s.radius * 100 * s.screen.w).toFixed(2) + 'vw');

    const fit = document.createElement('div');
    fit.className = 'skin-fit';
    screen.appendChild(fit);

    const glass = document.createElement('div');
    glass.className = 'skin-glass';
    setVars(glass, s);
    glass.style.setProperty('--srad', screen.style.getPropertyValue('--srad'));
    glass.style.setProperty('--glare-angle', (s.light || 'left-top') === 'left-top' ? '145deg' : '215deg');

    device.appendChild(screen);
    device.appendChild(glass);

    (s.buttons || []).forEach((b, i) => {
      const btn = document.createElement('button');
      btn.className = 'skin-btn';
      btn.setAttribute('aria-label', ['левая кнопка', 'средняя кнопка', 'правая кнопка'][i] || 'кнопка');
      btn.style.setProperty('--bx', b.x);
      btn.style.setProperty('--by', b.y);
      btn.style.setProperty('--bw', b.w);
      btn.style.setProperty('--bh', b.h);
      btn.addEventListener('click', () => { try { App.handlers.shell_button(i); } catch (e) {} });
      device.appendChild(btn);
    });

    root.appendChild(layer);

    const gw = document.querySelector('.graphics-wrapper');
    if (gw) {
      home = gw.parentNode;
      homeNext = gw.nextSibling;
      fit.appendChild(gw);
    }

    root.classList.add('skin-on');
    refit();
    window.addEventListener('resize', refit);
    const anyImg = layer.querySelector('img');
    if (anyImg) {
      anyImg.addEventListener('load', refit);
      anyImg.addEventListener('error', () => failSafe('картинка не загрузилась'));
    }

    /* Аварийный выход без меню: три быстрых касания по фону возвращают
       обычный корпус. Нужен на случай, если картинка не пришла и меню не
       видно — иначе из чёрного экрана в приложении не выбраться. */
    let taps = [];
    layer.addEventListener('pointerdown', (e) => {
      // касания по самому экрану и по кнопкам — это игра, их не считаем
      if (e.target.closest && e.target.closest('.skin-screen, .skin-btn')) { taps = []; return; }
      const now = Date.now();
      taps = taps.filter(t => now - t < 1200);
      taps.push(now);
      if (taps.length >= 3) { taps = []; failSafe('три касания подряд'); }
    }, true);

    /* Через секунду проверяем, что получилось что-то работоспособное. */
    setTimeout(verifyOrFail, 1000);
    return true;
  }

  /* Выключить фотокорпус и вернуть обычный вид. Ничего не ломает: настройка
     просто выключается, игра продолжает работать. */
  function failSafe(why) {
    if (!layer && localStorage.getItem(LS_ON) !== '1') return;
    console.warn('[skin] фотокорпус выключен: ' + why);
    localStorage.setItem(LS_ON, '0');
    localStorage.removeItem(LS_TRY);
    if (layer) destroy();
    try { App.displayPopup('Фотокорпус выключен: ' + why, 4000); } catch (e) {}
  }

  /* Экран должен быть виден и не схлопнут. Если нет — уходим в обычный вид. */
  function verifyOrFail() {
    if (!layer) return;
    const scr = layer.querySelector('.skin-screen');
    const r = scr && scr.getBoundingClientRect();
    if (!r || r.width < 24 || r.height < 24) {
      failSafe('не получилось разместить экран');
      return;
    }
    localStorage.removeItem(LS_TRY);      // всё сложилось, метку снимаем
  }

  /* Подгоняем масштаб экрана и шаг пиксельной сетки. */
  function refit() {
    if (!layer) return;
    const screen = layer.querySelector('.skin-screen');
    const fit = layer.querySelector('.skin-fit');
    const glass = layer.querySelector('.skin-glass');
    if (!screen || !fit) return;
    const r = screen.getBoundingClientRect();
    if (!r.width) return;
    /* берём меньшую сторону: игровой экран квадратный, растягивать его нельзя */
    const k = Math.min(r.width, r.height) / NATURAL;
    fit.style.setProperty('--fit', k.toFixed(4));

    if (glass) {
      const canvas = fit.querySelector('canvas');
      const cells = (canvas && canvas.width) || 96;
      const px = (NATURAL * k) / cells;
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

  function apply() {
    if (!isOn()) { if (layer) destroy(); return; }

    /* Метка осталась от ДРУГОГО запуска страницы — значит тогда сборка так и
       не дошла до проверки, всё и сломалось. Второй раз в ту же яму не лезем.
       Метка от текущего запуска — это просто пересборка, она в порядке. */
    const mark = localStorage.getItem(LS_TRY);
    if (mark && mark !== RUN) {
      localStorage.removeItem(LS_TRY);
      failSafe('в прошлый раз не получилось');
      return;
    }
    localStorage.setItem(LS_TRY, RUN);
    if (layer) destroy();
    build();
  }

  /* ---------------------------------------------------------------------- */
  /* Пункты в настройках                                                     */
  /* ---------------------------------------------------------------------- */
  function toggleItem() {
    return {
      icon: 'image',
      name: 'фотокорпус: ' + (isOn() ? 'вкл' : 'выкл'),
      onclick: (btn) => {
        const now = !isOn();
        localStorage.setItem(LS_ON, now ? '1' : '0');
        apply();
        btn.innerHTML = (App.getIcon ? App.getIcon('image', true) : '') +
                        ' фотокорпус: ' + (now ? 'вкл' : 'выкл');
        try {
          App.displayPopup(now
            ? 'Корпус и стол теперь фотография. Выключается здесь же.'
            : 'Вернули обычный корпус.', 3000);
        } catch (e) {}
        return true;
      }
    };
  }

  /* Размер корпуса — только у скинов из отдельных частей: у сцены корпус
     нарисован прямо на фотографии, отдельно его не подвинуть. */
  const SIZES = [0.62, 0.72, 0.82, 0.92, 1.05];
  function sizeItem() {
    if (!isOn() || shell().type === 'scene') return null;
    return {
      icon: 'up-right-and-down-left-from-center',
      name: 'размер корпуса: ' + Math.round(shellSize() * 100) + '%',
      onclick: (btn) => {
        const i = SIZES.findIndex(v => Math.abs(v - shellSize()) < 0.005);
        const next = SIZES[((i < 0 ? 0 : i) + 1) % SIZES.length];
        localStorage.setItem(LS_SIZE, String(next));
        apply();
        btn.innerHTML = (App.getIcon ? App.getIcon('up-right-and-down-left-from-center', true) : '') +
                        ' размер корпуса: ' + Math.round(next * 100) + '%';
        return true;
      }
    };
  }

  function bgItem() {
    const ids = Object.keys(BACKGROUNDS);
    if (!isOn() || shell().type === 'scene' || ids.length < 2) return null;
    return {
      icon: 'panorama',
      name: 'фон: ' + background().name,
      onclick: (btn) => {
        const next = ids[(ids.indexOf(bgId()) + 1) % ids.length];
        localStorage.setItem(LS_BG, next);
        apply();
        btn.innerHTML = (App.getIcon ? App.getIcon('panorama', true) : '') +
                        ' фон: ' + BACKGROUNDS[next].name;
        return true;
      }
    };
  }

  function shellItem() {
    const ids = Object.keys(SHELLS);
    if (!isOn() || ids.length < 2) return null;
    return {
      icon: 'egg',
      name: 'корпус: ' + shell().name,
      onclick: (btn) => {
        const next = ids[(ids.indexOf(shellId()) + 1) % ids.length];
        localStorage.setItem(LS_SHELL, next);
        apply();
        btn.innerHTML = (App.getIcon ? App.getIcon('egg', true) : '') +
                        ' корпус: ' + SHELLS[next].name;
        return true;
      }
    };
  }

  /* Своего перехвата меню здесь нет: два независимых перехвата одного и того
     же App.displayList спорят и список задваивается. Кладём пункты в общий
     список, который разбирает sync.js. */
  window.TamaExtraMenu = window.TamaExtraMenu || [];
  [toggleItem, shellItem, bgItem, sizeItem].forEach(make => {
    if (window.TamaExtraMenu.some(f => f.__skin === make.name)) return;
    make.__skin = make.name;
    window.TamaExtraMenu.push(make);
  });

  /* Аварийный выключатель через адрес: pbelyaev1.github.io/?noskin
     Пригодится, если приложение открыть в обычном браузере. */
  try {
    if (/[?&#]noskin/.test(location.search + location.hash)) {
      localStorage.setItem(LS_ON, '0');
      localStorage.removeItem(LS_TRY);
    }
  } catch (e) {}

  /* Ждём, пока игра построит своё дерево, и только потом вмешиваемся. */
  (function waitGame(tries) {
    if (hasApp() && App.loadingEnded && document.querySelector('.graphics-wrapper')) { apply(); return; }
    if (tries > 400) return;
    setTimeout(() => waitGame(tries + 1), 250);
  })(0);

  window.TamaSkin = {
    on:  () => { localStorage.setItem(LS_ON, '1'); apply(); },
    off: () => { localStorage.setItem(LS_ON, '0'); apply(); },
    shell: id => { if (SHELLS[id]) { localStorage.setItem(LS_SHELL, id); apply(); } return shellId(); },
    bg:    id => { if (BACKGROUNDS[id]) { localStorage.setItem(LS_BG, id); apply(); } return bgId(); },
    size:  v  => { if (v) localStorage.setItem(LS_SIZE, String(v)); apply(); return shellSize(); },
    y:     v  => { if (v) localStorage.setItem(LS_Y, String(v)); apply(); return shellY(); },
    off2:  () => failSafe('вручную'),
    rect:  () => { const el = layer && layer.querySelector('.skin-screen'); return el ? el.getBoundingClientRect() : null; },
    shells: SHELLS, backgrounds: BACKGROUNDS,
  };
})();
