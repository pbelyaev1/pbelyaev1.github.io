/* ============================================================================
   Фотокорпус.

   Обычный корпус в игре нарисован средствами CSS: скруглённый прямоугольник
   с тенями. Фотореализма из него не выжать, поэтому здесь другой подход —
   поверх всего кладётся настоящая фотография сцены (стол, корпус, тени),
   у которой вырезана дырка на месте экрана. В эту дырку смотрит игровой холст.

   Слои снизу вверх:
       1. игровой холст (.graphics-wrapper) — переезжает в дырку;
       2. фотография (корпус + фон + тени, экран прозрачный);
       3. стекло: блик, внутренняя тень, пиксельная сетка;
       4. невидимые кнопки поверх нарисованных на фото.

   Ничего из старого не трогается: пока настройка выключена, файл только
   добавляет пункт в меню. Включение вешает класс на .root и переносит холст,
   выключение возвращает всё точно на место.
   ============================================================================ */
(function () {
  'use strict';

  const hasApp = () => typeof App !== 'undefined' && !!App;
  const LS_ON = 'tama_skin_on';
  const LS_ID = 'tama_skin_id';
  const LS_ZOOM = 'tama_skin_zoom';

  /* ---------------------------------------------------------------------- */
  /* Описание скинов. Доли считаются от размера картинки, поэтому геометрия
     не зависит от того, на каком экране всё это показывают.                 */
  /* ---------------------------------------------------------------------- */
  const SKINS = {
    wood: {
      name: 'деревянный стол',
      image: 'resources/img/skins/wood.png',
      w: 851, h: 1847,
      screen:  { x: 0.35958, y: 0.42122, w: 0.28202, h: 0.12777 },
      radius:  0.02,           // скругление углов экрана, доля от ширины экрана
      buttons: [
        { x: 0.36947, y: 0.57990, w: 0.06599, h: 0.02807 },   // левая
        { x: 0.46700, y: 0.59007, w: 0.06599, h: 0.02885 },   // средняя
        { x: 0.56454, y: 0.57990, w: 0.06599, h: 0.02807 },   // правая
      ],
      glare: 'left-top',
    },
  };

  const skinId = () => {
    const id = localStorage.getItem(LS_ID);
    return SKINS[id] ? id : 'wood';
  };
  const skin = () => SKINS[skinId()];
  const isOn = () => localStorage.getItem(LS_ON) === '1';
  /* Насколько приближена сцена. Единица — вся фотография целиком; больше —
     устройство крупнее, но края стола уходят за границы экрана. */
  const zoom = () => {
    const v = parseFloat(localStorage.getItem(LS_ZOOM));
    return v >= 1 && v <= 2 ? v : (skin().zoom || 1);
  };

  /* ---------------------------------------------------------------------- */
  /* Стили держим здесь же, чтобы не лезть в styles.css игры.                */
  /* ---------------------------------------------------------------------- */
  const CSS = `
.skin-layer{position:fixed;inset:0;overflow:hidden;z-index:2;pointer-events:none;
  background:#0b0b0d;}
.skin-stage{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
  width:calc(max(100vw, 100vh * var(--skin-ar)) * var(--skin-zoom, 1));
  height:calc(max(100vh, 100vw / var(--skin-ar)) * var(--skin-zoom, 1));}
.skin-photo{position:absolute;inset:0;width:100%;height:100%;object-fit:fill;
  display:block;user-select:none;-webkit-user-drag:none;}

/* дырка под экран: сюда переезжает игровой холст */
.skin-screen{position:absolute;overflow:hidden;pointer-events:auto;
  background:#000;
  left:calc(var(--sx) * 100%);top:calc(var(--sy) * 100%);
  width:calc(var(--sw) * 100%);height:calc(var(--sh) * 100%);
  border-radius:var(--srad);}

/* стекло поверх картинки: блик, внутренняя тень, сетка пикселей */
.skin-glass{position:absolute;pointer-events:none;
  left:calc(var(--sx) * 100%);top:calc(var(--sy) * 100%);
  width:calc(var(--sw) * 100%);height:calc(var(--sh) * 100%);
  border-radius:var(--srad);
  box-shadow:inset 0 2px 6px rgba(0,0,0,.55), inset 0 -1px 3px rgba(255,255,255,.10);}
.skin-glass:before{content:"";position:absolute;inset:0;border-radius:inherit;
  background:
    repeating-linear-gradient(to right, rgba(0,0,0,var(--grid-alpha)) 0 1px, transparent 1px var(--px)),
    repeating-linear-gradient(to bottom, rgba(0,0,0,var(--grid-alpha)) 0 1px, transparent 1px var(--px));
  mix-blend-mode:multiply;}
/* если на один игровой пиксель приходится меньше пары точек экрана, сетка
   превращается в грязь — тогда её просто не рисуем */
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
.root.skin-on .graphics-wrapper{
  position:absolute !important;inset:0 !important;
  width:100% !important;max-width:none !important;height:100% !important;
  transform:none !important;outline:0 !important;border-radius:0 !important;}
.root.skin-on .graphics-wrapper > .screen-wrapper{
  position:absolute !important;inset:0 !important;
  width:100% !important;height:100% !important;}
.root.skin-on .graphics-canvas{
  width:100% !important;height:100% !important;display:block !important;}
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

  function build() {
    const s = skin();
    const root = document.querySelector('.root');
    if (!root) return false;

    injectCss();

    layer = document.createElement('div');
    layer.className = 'skin-layer';
    layer.style.setProperty('--skin-ar', (s.w / s.h).toFixed(5));
    layer.style.setProperty('--skin-zoom', String(zoom()));

    const stage = document.createElement('div');
    stage.className = 'skin-stage';

    const screen = document.createElement('div');
    screen.className = 'skin-screen';
    screen.style.setProperty('--sx', s.screen.x);
    screen.style.setProperty('--sy', s.screen.y);
    screen.style.setProperty('--sw', s.screen.w);
    screen.style.setProperty('--sh', s.screen.h);
    screen.style.setProperty('--srad', (s.radius * 100 * s.screen.w).toFixed(2) + 'vw');

    const photo = document.createElement('img');
    photo.className = 'skin-photo';
    photo.src = s.image;
    photo.alt = '';

    const glass = document.createElement('div');
    glass.className = 'skin-glass';
    ['--sx', '--sy', '--sw', '--sh', '--srad'].forEach(v =>
      glass.style.setProperty(v, screen.style.getPropertyValue(v)));
    glass.style.setProperty('--glare-angle', s.glare === 'left-top' ? '145deg' : '215deg');

    /* холст ставим ПОД фотографию: он виден только через прозрачную дырку,
       и края выреза сами накрывают его — шва не видно */
    stage.appendChild(screen);
    stage.appendChild(photo);
    stage.appendChild(glass);

    (s.buttons || []).forEach((b, i) => {
      const btn = document.createElement('button');
      btn.className = 'skin-btn';
      btn.setAttribute('aria-label', ['левая кнопка', 'средняя кнопка', 'правая кнопка'][i] || 'кнопка');
      btn.style.setProperty('--bx', b.x);
      btn.style.setProperty('--by', b.y);
      btn.style.setProperty('--bw', b.w);
      btn.style.setProperty('--bh', b.h);
      btn.addEventListener('click', () => {
        try { App.handlers.shell_button(i); } catch (e) {}
      });
      stage.appendChild(btn);
    });

    layer.appendChild(stage);
    root.appendChild(layer);

    /* переносим холст в дырку, запомнив, откуда взяли */
    const gw = document.querySelector('.graphics-wrapper');
    if (gw) {
      home = gw.parentNode;
      homeNext = gw.nextSibling;
      screen.appendChild(gw);
    }

    root.classList.add('skin-on');
    sizeGrid();
    window.addEventListener('resize', sizeGrid);
    return true;
  }

  /* Сетка пикселей должна совпадать с настоящими пикселями холста: игра
     рисует 96×96, значит одна клетка — ширина экрана делить на 96. */
  function sizeGrid() {
    if (!layer) return;
    const screen = layer.querySelector('.skin-screen');
    const glass = layer.querySelector('.skin-glass');
    if (!screen || !glass) return;
    const canvas = screen.querySelector('canvas');
    const cells = (canvas && canvas.width) || 96;
    const px = screen.getBoundingClientRect().width / cells;
    glass.style.setProperty('--px', px.toFixed(3) + 'px');
    glass.style.setProperty('--grid-alpha', '.035');
    if (px < 2.2) glass.classList.add('no-grid'); else glass.classList.remove('no-grid');
  }

  function destroy() {
    const root = document.querySelector('.root');
    const gw = document.querySelector('.graphics-wrapper');
    if (gw && home) {
      if (homeNext && homeNext.parentNode === home) home.insertBefore(gw, homeNext);
      else home.appendChild(gw);
    }
    home = homeNext = null;
    window.removeEventListener('resize', sizeGrid);
    if (layer) layer.remove();
    layer = null;
    if (root) root.classList.remove('skin-on');
    // возвращаем игре её собственную вёрстку
    try { App.refreshUI(); } catch (e) {}
  }

  function apply() {
    if (isOn()) { if (!layer) build(); }
    else if (layer) destroy();
  }

  /* ---------------------------------------------------------------------- */
  /* Пункт в настройках                                                      */
  /* ---------------------------------------------------------------------- */
  /* Пункт переключается по кругу: выключено → вся сцена → крупно → выключено.
     Так не нужен ни второй пункт, ни консоль. */
  const STATES = [
    { on: false, zoom: 1,    label: 'выкл',        note: 'Вернули обычный корпус.' },
    { on: true,  zoom: 1,    label: 'вся сцена',   note: 'Стол виден целиком.' },
    { on: true,  zoom: 1.35, label: 'крупно',      note: 'Корпус ближе, края стола уходят за экран.' },
  ];
  const stateIndex = () => {
    if (!isOn()) return 0;
    return Math.abs(zoom() - 1) < 0.01 ? 1 : 2;
  };
  const label = () => 'фотокорпус: ' + STATES[stateIndex()].label;

  function menuItem() {
    return {
      icon: 'image',
      name: label(),
      onclick: (btn) => {
        const next = STATES[(stateIndex() + 1) % STATES.length];
        localStorage.setItem(LS_ON, next.on ? '1' : '0');
        localStorage.setItem(LS_ZOOM, String(next.zoom));
        if (layer) destroy();
        apply();
        btn.innerHTML = (App.getIcon ? App.getIcon('image', true) : '') + ' ' + label();
        try { App.displayPopup(next.note, 3000); } catch (e) {}
        return true;
      }
    };
  }

  /* Своего перехвата меню здесь нет: два независимых перехвата одного и того же
     App.displayList начинают спорить и список задваивается. Вместо этого просто
     кладём свой пункт в общий список, который разбирает sync.js. */
  window.TamaExtraMenu = window.TamaExtraMenu || [];
  if (!window.TamaExtraMenu.some(f => f.__tamaSkin)) {
    menuItem.__tamaSkin = true;
    window.TamaExtraMenu.push(menuItem);
  }

  /* Ждём, пока игра построит своё дерево, и только потом вмешиваемся. */
  (function waitGame(tries) {
    if (hasApp() && App.loadingEnded && document.querySelector('.graphics-wrapper')) {
      apply();
      return;
    }
    if (tries > 400) return;
    setTimeout(() => waitGame(tries + 1), 250);
  })(0);

  window.TamaSkin = {
    on: () => { localStorage.setItem(LS_ON, '1'); apply(); },
    off: () => { localStorage.setItem(LS_ON, '0'); apply(); },
    list: () => Object.keys(SKINS),
    use: id => { if (SKINS[id]) { localStorage.setItem(LS_ID, id); if (layer) { destroy(); build(); } } },
    zoom: n => {
      if (n) localStorage.setItem(LS_ZOOM, String(n)); else localStorage.removeItem(LS_ZOOM);
      if (layer) { destroy(); build(); }
      return zoom();
    },
    rect: () => {
      const el = layer && layer.querySelector('.skin-screen');
      return el ? el.getBoundingClientRect() : null;
    },
    skins: SKINS,
  };
})();
