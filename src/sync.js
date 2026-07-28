/* ============================================================================
   Синхронизация и уведомления.

   Что делает:
     • держит сохранение на сервере, чтобы играть с телефона и с компьютера;
     • заранее считает, когда питомцу что-то понадобится, и просит сервер
       прислать напоминание — даже если игра закрыта;
     • ничего не ломает, если сервер не настроен: тогда просто молчит.

   Настройка: впиши адрес своего сервера в SYNC_SERVER ниже (или задай
   через настройки игры — значение сохранится в браузере).
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
  const enabled = () => server() && get(LS.on) !== '0';

  async function api(path, opts = {}) {
    const t = token();
    const r = await fetch(server() + path, {
      ...opts,
      headers: {
        'content-type': 'application/json',
        ...(t ? { authorization: 'Bearer ' + t } : {}),
        ...(opts.headers || {})
      }
    });
    let data = null;
    try { data = await r.json(); } catch (e) {}
    if (!r.ok && r.status !== 409) throw new Error((data && data.error) || ('HTTP ' + r.status));
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
    if (!enabled() || !token() || busy) return;
    if (!force && Date.now() - lastPush < 60_000) return;     // не чаще раза в минуту
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
      if (res.status === 409) console.warn('[sync] на сервере более свежее сохранение');
      else lastPush = Date.now();
    } catch (e) {
      console.warn('[sync] не удалось отправить:', e.message);
    } finally { busy = false; }
  }

  function decodeSave(code) {
    const inner = String(code).replace(/^save:/, '').replace(/:endsave$/, '');
    return JSON.parse(decodeURIComponent(escape(atob(inner))));
  }

  async function pullSave() {
    const res = await api('/api/save');
    return res.data;
  }

  /* ---------- уведомления ---------- */
  async function enableNotifications() {
    if (!('Notification' in window) || !('serviceWorker' in navigator)) {
      return { ok: false, msg: 'Браузер не умеет уведомления' };
    }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return { ok: false, msg: 'Разрешение не выдано' };

    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const { data } = await api('/api/vapid').catch(() => ({ data: null }));
      const key = (data && data.key) || window.TAMA_VAPID_PUBLIC;
      if (!key) return { ok: false, msg: 'Сервер не отдал ключ уведомлений' };
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: Uint8Array.from(
          atob(key.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
      });
    }
    const j = sub.toJSON();
    await api('/api/subscribe', { method: 'POST', body: JSON.stringify({ endpoint: j.endpoint, keys: j.keys }) });
    return { ok: true, msg: 'Уведомления включены' };
  }

  /* ---------- первый запуск ---------- */
  async function ensureAccount() {
    if (token()) return true;
    const { data } = await api('/api/register', { method: 'POST' });
    if (data && data.token) { set(LS.token, data.token); return true; }
    return false;
  }

  async function boot() {
    if (!enabled()) return;
    try {
      await ensureAccount();
      const remote = await pullSave();
      const localTime = Number(await (window.idbKeyval ? idbKeyval.get('last_time') : 0)) || 0;
      if (remote && remote.save && remote.last_time && remote.last_time > localTime + 60_000) {
        // на сервере состояние свежее — предлагаем забрать
        const ok = confirm(
          'На сервере сохранение новее этого устройства.\n' +
          'Загрузить его? Текущий прогресс здесь будет заменён.'
        );
        if (ok) {
          App.loadFromJson(decodeSave(remote.save), () => location.reload());
          return;
        }
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

  /* ---------- ручное управление из консоли и настроек ---------- */
  window.TamaSync = {
    setServer(url) { set(LS.server, String(url || '').replace(/\/+$/, '')); set(LS.on, '1');
                     console.log('Сервер задан. Перезагрузи страницу.'); },
    async link(code) {
      const { data } = await api('/api/link', { method: 'POST', body: JSON.stringify({ code }) });
      if (data && data.token) { set(LS.token, data.token); console.log('Устройство привязано. Перезагрузи страницу.'); }
      else console.warn('Код не подошёл');
    },
    async status() { const { data } = await api('/api/status'); console.log(data); return data; },
    async testPush() { const { data } = await api('/api/test-push', { method: 'POST' }); console.log(data); return data; },
    notifications: enableNotifications,
    push: () => pushSave(true),
    pull: pullSave,
    next: predictNextCall,
    off() { set(LS.on, '0'); console.log('Синхронизация выключена.'); }
  };
})();
