/* ============================================================================
   Синхронизация и уведомления.

   Что делает:
     • держит сохранение на сервере, чтобы играть с телефона и с компьютера;
     • заранее считает, когда питомцу что-то понадобится, и просит сервер
       прислать напоминание — даже если игра закрыта;
     • ничего не ломает, если сервер не настроен: тогда просто молчит.

   Всё настраивается прямо в игре: настройки → «сервер и уведомления».
   Консоль не нужна.
   ============================================================================ */
(function () {
  'use strict';

  const SYNC_SERVER = '';          // например: https://tama.твоё-имя.workers.dev

  const LS = {
    server: 'tama_sync_server',
    token:  'tama_sync_token',
    on:     'tama_sync_enabled',
  };
  const get = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const set = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };

  const server = () => (get(LS.server) || SYNC_SERVER || '').replace(/\/+$/, '');
  const token  = () => get(LS.token);
  const enabled = () => !!server() && get(LS.on) !== '0';

  const wait = ms => new Promise(r => setTimeout(r, ms));
  /* App объявлен через const — в window его нет, только в глобальной области */
  const hasApp = () => typeof App !== 'undefined' && !!App;

  async function api(path, opts = {}) {
    if (!server()) throw new Error('Сервер не задан');
    const t = token();
    let r;
    try {
      r = await fetch(server() + path, {
        ...opts,
        headers: {
          'content-type': 'application/json',
          ...(t ? { authorization: 'Bearer ' + t } : {}),
          ...(opts.headers || {})
        }
      });
    } catch (e) {
      throw new Error('Сервер не отвечает. Проверь адрес и что воркер задеплоен.');
    }
    let data = null;
    try { data = await r.json(); } catch (e) {}
    if (!r.ok && r.status !== 409) throw new Error((data && data.error) || ('Ошибка сервера ' + r.status));
    return { status: r.status, data };
  }

  /* ---------- когда питомцу что-то понадобится ----------
     Показатели в игре пересчитываются раз в секунду, поэтому время до нуля
     считается прямо: сколько осталось делим на расход в секунду.        */
  const BASE = { hunger: 0.0145, fun: 0.0235, sleep: 0.0034, bladder: 0.015 };
  const STAGE_MULT = { 0: 1.65, 1: 1.46, 2: 1.3 };   // малыш / ребёнок / подросток
  const REASON = {
    hunger:  'проголодался',
    fun:     'скучает и хочет поиграть',
    sleep:   'совсем сонный',
    bladder: 'просится в туалет'
  };

  function predictNextCall() {
    try {
      const p = App.pet, s = p && p.stats;
      if (!s || s.is_egg) return null;
      const stage = App.petDefinition && App.petDefinition.lifeStage;
      const mult = STAGE_MULT[stage] || 1;

      let best = null;
      for (const key of Object.keys(BASE)) {
        const cur = s['current_' + key];
        if (typeof cur !== 'number') continue;
        const perSec = BASE[key] * mult;
        if (perSec <= 0) continue;
        const secs = Math.max(0, cur) / perSec;
        if (best === null || secs < best.secs) best = { secs, key };
      }
      if (!best) return null;

      let at = Date.now() + best.secs * 1000;

      // ночью питомец спит и всё равно не отреагирует — переносим на утро
      const d = new Date(at), h = d.getHours();
      if (h >= 22 || h < 9) {
        const m = new Date(at);
        if (h >= 22) m.setDate(m.getDate() + 1);
        m.setHours(9, 30, 0, 0);
        at = m.getTime();
      }
      return { at: Math.round(at), reason: REASON[best.key] };
    } catch (e) { return null; }
  }

  /* ---------- обмен сохранением ---------- */
  let busy = false, lastPush = 0;

  async function pushSave(force) {
    if (!enabled() || !token() || busy) return { ok: false, msg: 'Синхронизация не настроена' };
    if (!force && Date.now() - lastPush < 60_000) return { ok: true, msg: 'Недавно уже отправляли' };
    busy = true;
    try {
      const code = await App.getSaveCode();
      const next = predictNextCall();
      const res = await api('/api/save', {
        method: 'PUT',
        body: JSON.stringify({
          save: code,
          last_time: Date.now(),
          next_call_at: next && next.at,
          call_reason: next && next.reason,
          pet_name: (App.petDefinition && App.petDefinition.name) || null
        })
      });
      if (res.status === 409) return { ok: false, msg: 'На сервере более свежее сохранение' };
      lastPush = Date.now();
      return { ok: true, msg: 'Сохранение отправлено' };
    } catch (e) {
      console.warn('[sync] не удалось отправить:', e.message);
      return { ok: false, msg: e.message };
    } finally { busy = false; }
  }

  /* кодируется как btoa(encodeURIComponent(json)) — раскручиваем в обратном порядке */
  function decodeSave(code) {
    const inner = String(code).replace(/^save:/, '').replace(/:endsave$/, '');
    return JSON.parse(decodeURIComponent(atob(inner)));
  }

  async function pullSave() {
    const res = await api('/api/save');
    return res.data;
  }

  async function applyRemoteSave() {
    const remote = await pullSave();
    if (!remote || !remote.save) return { ok: false, msg: 'На сервере пока нет сохранения' };
    let json;
    try { json = decodeSave(remote.save); }
    catch (e) { return { ok: false, msg: 'Сохранение на сервере повреждено' }; }
    App.loadFromJson(json, () => {
      popup('Загружено с сервера', 2000);
      setTimeout(() => location.reload(), 1500);
    });
    return { ok: true, msg: 'Загружаем…' };
  }

  /* ---------- уведомления ---------- */
  const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) ||
                      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = () => {
    try {
      return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    } catch (e) { return false; }
  };

  async function enableNotifications() {
    if (!('Notification' in window) || !('serviceWorker' in navigator)) {
      return { ok: false, msg: 'Этот браузер не умеет уведомления' };
    }
    if (isIOS() && !isStandalone()) {
      return { ok: false, msg: 'На айфоне сначала добавь игру на домашний экран и открой её оттуда' };
    }
    if (!server()) return { ok: false, msg: 'Сначала укажи адрес сервера' };
    if (!token() && !(await ensureAccount().catch(() => false))) {
      return { ok: false, msg: 'Сервер не отвечает' };
    }
    if (Notification.permission === 'denied') {
      return { ok: false, msg: 'Уведомления запрещены в настройках браузера для этого сайта' };
    }

    let perm;
    try { perm = await Notification.requestPermission(); }
    catch (e) { return { ok: false, msg: 'Не удалось спросить разрешение' }; }
    if (perm !== 'granted') return { ok: false, msg: 'Разрешение не выдано' };

    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      wait(10000).then(() => null)
    ]);
    if (!reg) return { ok: false, msg: 'Служебный процесс не запустился — перезагрузи страницу и попробуй снова' };

    let sub;
    try {
      sub = await reg.pushManager.getSubscription();
      if (!sub) {
        const { data } = await api('/api/vapid').catch(() => ({ data: null }));
        const key = (data && data.key) || window.TAMA_VAPID_PUBLIC;
        if (!key) return { ok: false, msg: 'Сервер не отдал ключ уведомлений (проверь секреты VAPID)' };
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: Uint8Array.from(
            atob(key.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
        });
      }
    } catch (e) {
      return { ok: false, msg: 'Подписка не удалась: ' + (e.message || e) };
    }

    const j = sub.toJSON();
    try {
      await api('/api/subscribe', { method: 'POST', body: JSON.stringify({ endpoint: j.endpoint, keys: j.keys }) });
    } catch (e) {
      return { ok: false, msg: e.message };
    }
    return { ok: true, msg: 'Уведомления включены' };
  }

  async function disableNotifications() {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg && await reg.pushManager.getSubscription();
      if (sub) await sub.unsubscribe();
    } catch (e) {}
    return { ok: true, msg: 'Уведомления отключены на этом устройстве' };
  }

  async function notificationState() {
    if (!('Notification' in window) || !('serviceWorker' in navigator)) return 'нет поддержки';
    if (Notification.permission === 'denied') return 'запрещены';
    if (Notification.permission !== 'granted') return 'выключены';
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg && await reg.pushManager.getSubscription();
      return sub ? 'включены' : 'выключены';
    } catch (e) { return 'выключены'; }
  }

  /* ---------- первый запуск ---------- */
  async function ensureAccount() {
    if (token()) return true;
    const { data } = await api('/api/register', { method: 'POST' });
    if (data && data.token) { set(LS.token, data.token); return true; }
    return false;
  }

  async function connect(url) {
    const clean = String(url || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(clean)) return { ok: false, msg: 'Адрес должен начинаться с https://' };
    const prev = get(LS.server);
    set(LS.server, clean);
    set(LS.on, '1');
    try {
      await ensureAccount();
      const st = (await api('/api/status')).data;
      await pushSave(true);
      return { ok: true, msg: 'Сервер подключён', status: st };
    } catch (e) {
      if (prev) set(LS.server, prev); else set(LS.server, '');
      return { ok: false, msg: e.message };
    }
  }

  async function boot() {
    if (!enabled()) return;
    try {
      await ensureAccount();
      const remote = await pullSave();
      const localTime = Number(await (window.idbKeyval ? idbKeyval.get('last_time') : 0)) || 0;
      if (remote && remote.save && remote.last_time && remote.last_time > localTime + 60_000) {
        // на сервере состояние свежее — предлагаем забрать
        const ask = () => App.displayConfirm(
          'На сервере сохранение <b>новее</b>, чем на этом устройстве.<br>Загрузить его? Текущий прогресс здесь будет заменён.',
          [
            { name: 'загрузить', onclick: () => { applyRemoteSave(); } },
            { name: 'нет', class: 'back-btn', onclick: () => { pushSave(true); } }
          ]
        );
        if (hasApp() && App.displayConfirm) { ask(); return; }
      }
      await pushSave(true);
    } catch (e) {
      console.warn('[sync] отключена:', e.message);
    }
  }

  /* отправляем при сворачивании и раз в несколько минут */
  document.addEventListener('visibilitychange', () => { if (document.hidden) pushSave(true); });
  window.addEventListener('pagehide', () => pushSave(true));
  setInterval(() => pushSave(false), 3 * 60 * 1000);

  setTimeout(boot, 6000);   // ждём, пока игра сама загрузится

  /* ======================================================================
     Экран настроек внутри игры
     ====================================================================== */

  function popup(text, ms) {
    if (hasApp() && App.displayPopup) return App.displayPopup(text, ms || 2500);
    console.log(text);
  }

  function icon(name) {
    return (hasApp() && App.getIcon) ? App.getIcon(name, true) : '';
  }

  function askServer(onDone) {
    App.displayPrompt(
      'Адрес сервера<br><small>вида https://имя.твой-логин.workers.dev</small>',
      [
        {
          name: 'сохранить',
          onclick: (value) => {
            const p = popup('Проверяем связь…', 60000);
            connect(value).then(res => {
              p && p.close && p.close();
              popup(res.ok
                ? 'Сервер подключён. Код для второго устройства: <b>' + ((res.status && res.status.link_code) || '—') + '</b>'
                : 'Не вышло: ' + res.msg, 6000);
              if (res.ok && onDone) onDone();
            });
          }
        },
        { name: 'отмена', class: 'back-btn', onclick: () => {} }
      ],
      server()
    );
  }

  function askLinkCode() {
    App.displayPrompt(
      'Код с первого устройства<br><small>6 символов</small>',
      [
        {
          name: 'привязать',
          onclick: (value) => {
            const p = popup('Проверяем код…', 60000);
            TamaSync.link(value).then(ok => {
              p && p.close && p.close();
              if (ok) {
                popup('Устройство привязано. Перезагружаем…', 2000);
                setTimeout(() => location.reload(), 1800);
              } else popup('Код не подошёл', 3000);
            });
          }
        },
        { name: 'отмена', class: 'back-btn', onclick: () => {} }
      ]
    );
  }

  function showLinkCode(code) {
    App.displayPrompt(
      'Код для второго устройства<br><small>введи его там в этом же разделе</small>',
      [
        {
          name: 'копировать',
          onclick: () => {
            try { navigator.clipboard.writeText(code); popup('Скопировано', 1500); } catch (e) {}
          }
        },
        { name: 'готово', class: 'back-btn', onclick: () => {} }
      ],
      code
    );
  }

  async function openMenu() {
    let st = null, err = null;
    if (server() && token()) {
      try { st = (await api('/api/status')).data; }
      catch (e) { err = e.message; }
    }
    const notif = await notificationState();

    let state;
    if (!server()) state = 'сервер не подключён';
    else if (err) state = 'нет связи: ' + err;
    else if (!enabled()) state = 'синхронизация приостановлена';
    else state = 'сервер на связи' + (st && st.has_save ? ', сохранение есть' : ', сохранения ещё нет');

    const next = predictNextCall();
    const nextText = next
      ? new Date(next.at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) +
        ' — ' + next.reason
      : 'пока не о чем напоминать';

    const online = !!server() && !err;

    const items = [
      { type: 'info', name: state },
      {
        icon: 'server',
        name: server() ? 'адрес сервера' : 'подключить сервер',
        onclick: (btn, list) => {
          askServer(() => { try { list.close(); } catch (e) {} openMenu(); });
          return true;
        }
      },
      {
        _ignore: !online || notif === 'запрещены' || notif === 'нет поддержки',
        icon: 'bell',
        name: 'уведомления: ' + (notif === 'включены' ? 'вкл' : 'выкл'),
        onclick: (btn, list) => {
          const again = () => { try { list.close(); } catch (e) {} openMenu(); };
          if (notif === 'включены') {
            disableNotifications().then(r => { popup(r.msg, 2500); again(); });
          } else {
            enableNotifications().then(r => {
              popup(r.msg, r.ok ? 2500 : 6000);
              again();
            });
          }
          return true;
        }
      },
      {
        _ignore: notif !== 'запрещены',
        type: 'info',
        name: 'Уведомления запрещены в настройках браузера для этого сайта — разреши их там и вернись сюда.'
      },
      {
        _ignore: !online || notif !== 'включены',
        icon: 'paper-plane',
        name: 'тест уведомления',
        onclick: () => {
          api('/api/test-push', { method: 'POST' })
            .then(({ data }) => popup(
              data && data.sent ? 'Отправлено — уведомление должно прийти' :
              'Подписки нет. Включи уведомления заново.', 5000))
            .catch(e => popup('Ошибка: ' + e.message, 5000));
          return true;
        }
      },
      { _ignore: !online, type: 'separator' },
      {
        _ignore: !online || !st,
        icon: 'link',
        name: 'код для связи',
        onclick: () => { showLinkCode((st && st.link_code) || ''); return true; }
      },
      {
        _ignore: !online,
        icon: 'right-to-bracket',
        name: 'ввести код',
        onclick: () => { askLinkCode(); return true; }
      },
      { _ignore: !online, type: 'separator' },
      {
        _ignore: !online,
        icon: 'cloud-arrow-up',
        name: 'отправить сейчас',
        onclick: () => {
          pushSave(true).then(r => popup(r.msg, 3000));
          return true;
        }
      },
      {
        _ignore: !online || !st || !st.has_save,
        icon: 'cloud-arrow-down',
        name: 'забрать с сервера',
        onclick: () => {
          App.displayConfirm(
            'Текущий прогресс на этом устройстве будет <b>заменён</b> тем, что лежит на сервере. Продолжить?',
            [
              { name: 'да', onclick: () => { applyRemoteSave().then(r => { if (!r.ok) popup(r.msg, 4000); }); } },
              { name: 'нет', class: 'back-btn', onclick: () => {} }
            ]
          );
          return true;
        }
      },
      {
        _ignore: !online || !enabled(),
        type: 'info',
        icon: 'clock',
        name: 'следующее напоминание: ' + nextText
      },
      {
        _ignore: !server(),
        icon: 'power-off',
        name: enabled() ? 'приостановить' : 'возобновить',
        onclick: (btn, list) => {
          set(LS.on, enabled() ? '0' : '1');
          popup(enabled() ? 'Синхронизация включена' : 'Синхронизация приостановлена', 2000);
          try { list.close(); } catch (e) {}
          openMenu();
          return true;
        }
      },
      {
        _ignore: !isIOS() || isStandalone(),
        type: 'info',
        name: 'На айфоне уведомления работают только если игра добавлена на домашний экран: «Поделиться» → «На экран Домой». Открывать её потом нужно оттуда.'
      }
    ];

    return App.displayList(items);
  }

  /* ---------- встраиваем пункт в настройки игры ---------- */
  function menuItem() {
    return {
      icon: 'cloud',
      name: 'синхронизация',
      onclick: () => { openMenu(); return true; }
    };
  }

  function inject(items) {
    const copy = items.slice();
    let at = copy.findIndex(it => typeof it.name === 'string' && /save management|управление сохранени/i.test(it.name));
    if (at === -1) at = copy.findIndex(it => typeof it.name === 'string' && /manual save|сохранить вручную/i.test(it.name));
    copy.splice(at === -1 ? 0 : at + 1, 0, menuItem());
    return copy;
  }

  function installMenuHook() {
    if (!hasApp() || !App.handlers || typeof App.handlers.open_settings !== 'function') return false;
    if (App.handlers.open_settings.__tamaSync) return true;

    const orig = App.handlers.open_settings;
    const patched = function () {
      const origList = App.displayList;
      let first = true;
      App.displayList = function (listItems, ...rest) {
        if (first) {
          first = false;
          App.displayList = origList;
          try { listItems = inject(listItems); } catch (e) { console.warn('[sync]', e); }
        }
        return origList.call(App, listItems, ...rest);
      };
      try { return orig.apply(this, arguments); }
      finally { App.displayList = origList; }
    };
    patched.__tamaSync = true;
    App.handlers.open_settings = patched;
    return true;
  }

  let tries = 0;
  const hookTimer = setInterval(() => {
    if (installMenuHook() || ++tries > 120) clearInterval(hookTimer);
  }, 500);
  installMenuHook();

  /* ---------- ручное управление из консоли ---------- */
  window.TamaSync = {
    setServer(url) { set(LS.server, String(url || '').replace(/\/+$/, '')); set(LS.on, '1');
                     console.log('Сервер задан. Перезагрузи страницу.'); },
    connect,
    async link(code) {
      try {
        const { data } = await api('/api/link', { method: 'POST', body: JSON.stringify({ code: String(code || '').trim() }) });
        if (data && data.token) { set(LS.token, data.token); set(LS.on, '1'); return true; }
      } catch (e) { console.warn(e.message); }
      return false;
    },
    async status() { const { data } = await api('/api/status'); console.log(data); return data; },
    async testPush() { const { data } = await api('/api/test-push', { method: 'POST' }); console.log(data); return data; },
    notifications: enableNotifications,
    menu: openMenu,
    push: () => pushSave(true),
    pull: pullSave,
    apply: applyRemoteSave,
    next: predictNextCall,
    off() { set(LS.on, '0'); console.log('Синхронизация выключена.'); }
  };
})();
