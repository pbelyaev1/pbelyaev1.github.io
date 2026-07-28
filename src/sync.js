/* ============================================================================
   Синхронизация и уведомления.

     • полное сохранение на сервере: питомец, настройки, комнаты, мебель,
       растения, животные, миссии, рекорды — всё, что игра вообще хранит;
     • обмен идёт сам: после каждого изменения игра отправляет состояние,
       второе устройство подхватывает его;
     • напоминания приходят тогда, когда питомцу действительно что-то нужно.

   Адрес сервера зашит ниже — игроку его вводить не надо.
   ============================================================================ */
(function () {
  'use strict';

  const SYNC_SERVER = 'https://ancient-snow-7a9e.pbelyaev12.workers.dev';

  const LS = {
    server: 'tama_sync_server',     // необязательное переопределение адреса
    token:  'tama_sync_token',
    device: 'tama_sync_device',
    hash:   'tama_sync_hash',
    active: 'tama_sync_last_active',
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

  function deviceId() {
    let d = get(LS.device);
    if (!d) {
      d = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
      set(LS.device, d);
    }
    return d;
  }

  function hashString(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(36);
  }

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
      throw new Error('Сервер не отвечает');
    }
    let data = null;
    try { data = await r.json(); } catch (e) {}
    if (!r.ok && r.status !== 409) throw new Error((data && data.error) || ('Ошибка сервера ' + r.status));
    return { status: r.status, data };
  }

  /* ======================================================================
     Что и когда понадобится питомцу

     Пока игра закрыта, показатели падают в 4 раза медленнее (множитель 0.25),
     а ночью — в 20 раз (0.05). Раньше здесь считалась скорость «как в игре»,
     поэтому напоминания приходили сильно раньше времени. Теперь состояние
     проигрывается вперёд шагами по минуте — ровно по правилам Pet.js.
     ====================================================================== */

  const HORIZON_HOURS = 72;
  const STEP_SEC = 60;

  const NEED_TEXT = {
    hunger:     { title: '{name} проголодался',        body: 'Пора покормить' },
    fun:        { title: '{name} скучает',             body: 'Хочет поиграть' },
    sleep:      { title: '{name} хочет спать',         body: 'Пора выключить свет' },
    toilet:     { title: '{name} просится в туалет',   body: 'Отведи его' },
    poop:       { title: 'У {name} грязно',            body: 'Надо убрать' },
    clean:      { title: '{name} испачкался',          body: 'Пора помыть' },
    sick:       { title: '{name} заболел',             body: 'Нужно лекарство' },
    danger:     { title: '{name} совсем плохо!',       body: 'Срочно зайди в игру' },
    misbehave:  { title: '{name} балуется',            body: 'Стоит поругать' },
    egg:        { title: 'Яйцо шевелится',             body: 'Кажется, скоро вылупится' },
  };

  function isSleepHourAt(date) {
    try { return App.isSleepHour(date.getHours()); }
    catch (e) { const h = date.getHours(); return h >= 21 || h < 8; }
  }

  /* ночью не будим: переносим на 9:30 утра */
  function shiftFromNight(ms) {
    const d = new Date(ms), h = d.getHours();
    if (h >= 22 || h < 9) {
      const m = new Date(ms);
      if (h >= 22) m.setDate(m.getDate() + 1);
      m.setHours(9, 30, 0, 0);
      return m.getTime();
    }
    return ms;
  }

  function collectNeeds() {
    if (!hasApp() || !App.pet || !App.pet.stats || !App.petDefinition) return [];
    const s = App.pet.stats;
    const name = App.petDefinition.name || 'Питомец';
    const found = {};
    const now = Date.now();

    const mark = (key, at) => { if (found[key] == null) found[key] = at; };

    if (s.is_dead) return [];
    if (s.is_egg) { mark('egg', now); return finish(found, name, now); }

    const has = n => { try { return !!App.petDefinition.hasTrait(n); } catch (e) { return false; } };
    const stage = App.petDefinition.lifeStage;
    const stageMult = ({ 0: 1.65, 1: 1.46, 2: 1.3 })[stage] || 1;

    const r = {
      hunger:  s.hunger_depletion_rate      * stageMult * (has('lightEater') ? 0.5 : 1)   * (has('voraciousHunger') ? 1.5 : 1),
      fun:     s.fun_depletion_rate         * stageMult * (has('chill') ? 0.5 : 1)        * (has('playBurnout') ? 1.5 : 1),
      sleep:   s.sleep_depletion_rate       * stageMult * (has('deepSleeper') ? 0.5 : 1)  * (has('restless') ? 1.5 : 1),
      bladder: s.bladder_depletion_rate     * stageMult * (has('ironBladder') ? 0.5 : 1)  * (has('tinyTank') ? 1.5 : 1),
      clean:   s.cleanliness_depletion_rate * stageMult * (has('selfCleaning') ? 0.5 : 1) * (has('dustMagnet') ? 1.5 : 1),
      health:  s.health_depletion_rate      * stageMult * (has('germGuardian') ? 0.5 : 1),
    };

    // пороги берём те же, по которым сама игра понимает, что питомец чего-то хочет
    const T = {
      hunger: s.hunger_min_desire != null ? s.hunger_min_desire : 40,
      fun:    s.fun_min_desire    != null ? s.fun_min_desire    : 35,
      sleep:  s.sleep_min_desire  != null ? s.sleep_min_desire  : 20,
      toilet: (s.max_bladder || 100) / 4,
      clean:  25,
      sick:   (s.max_health || 100) * 0.25,
      danger: (s.max_health || 100) * 0.1,
    };

    let hunger = s.current_hunger, fun = s.current_fun, sleep = s.current_sleep,
        bladder = s.current_bladder, clean = s.current_cleanliness, health = s.current_health,
        poop = s.has_poop_out || 0;
    /* Спящего питомца нельзя ни покормить, ни поиграть с ним: игра на это время
       отключает управление. Пока он спит — молчим, иначе получается «проголодался»
       про питомца, которого сам же уложил. */
    let sleeping = !!s.is_sleeping;
    const sleepMax = s.max_sleep || 100;
    const replenish = s.sleep_replenish_rate || 0.1;

    if (s.is_misbehaving) mark('misbehave', now);

    const steps = Math.round(HORIZON_HOURS * 3600 / STEP_SEC);
    for (let i = 0; i <= steps; i++) {
      const at = now + i * STEP_SEC * 1000;
      const night = isSleepHourAt(new Date(at));
      const mult = night ? 0.05 : 0.25;          // игра закрыта
      const dt = STEP_SEC;

      if (!sleeping) {
        if (hunger <= T.hunger) mark('hunger', at);
        if (fun <= T.fun) mark('fun', at);
        if (!night && sleep <= T.sleep) mark('sleep', at);
        if (bladder <= T.toilet) mark('toilet', at);
      }
      if (poop > 0) mark('poop', at);
      if (clean <= T.clean) mark('clean', at);
      if (health <= T.sick) mark('sick', at);
      if (health <= T.danger) mark('danger', at);

      // шаг вперёд
      hunger = Math.max(0, hunger - r.hunger * mult * dt);
      fun    = Math.max(0, fun    - r.fun    * mult * dt);
      clean  = Math.max(0, clean  - r.clean  * mult * dt);

      if (sleeping) {
        sleep = Math.min(sleepMax, sleep + replenish * (night ? 2 : 1) * dt);
        if (sleep >= sleepMax && !night) sleeping = false;      // выспался и проснулся
      } else if (night) {
        sleeping = true;                                        // ночью укладывается сам
      } else {
        sleep = Math.max(0, sleep - r.sleep * mult * dt);
        if (sleep <= 0) sleeping = true;                        // свалился от усталости
      }

      bladder -= r.bladder * mult * dt;
      if (bladder <= 0) {
        bladder = s.max_bladder || 100;
        if (!s.is_potty_trained) poop += 1;
      }
      // здоровье падает только когда грязно или лежат какашки
      if (poop > 0 || clean <= 25) {
        health = Math.max(0, health - r.health * (s.health_depletion_mult || 0.5) * mult * dt);
      }

      if (Object.keys(found).length >= 8) break;
    }

    return finish(found, name, now);
  }

  /* Если потребность уже назрела в момент, когда игру закрывали, напоминать
     сразу же незачем — человек только что всё видел сам. Даём отсрочку. */
  const GRACE = { danger: 5 * 60_000, sick: 15 * 60_000, poop: 25 * 60_000 };
  const GRACE_DEFAULT = 40 * 60_000;

  function finish(found, name, now) {
    return Object.keys(found).map(key => {
      const t = NEED_TEXT[key] || { title: '{name} зовёт', body: 'Кажется, ему что-то нужно' };
      let at = found[key];
      if (at <= now + 1000) at = now + (GRACE[key] != null ? GRACE[key] : GRACE_DEFAULT);
      return {
        key,
        at: shiftFromNight(at),
        title: t.title.replace('{name}', name),
        body: t.body
      };
    }).sort((a, b) => a.at - b.at);
  }

  /* ======================================================================
     Значок синхронизации в углу экрана
     ====================================================================== */
  let indicatorEl = null, indicatorTimer = null;

  function ensureIndicator() {
    if (indicatorEl && document.body.contains(indicatorEl)) return indicatorEl;
    const host = document.querySelector('.graphics-wrapper');
    if (!host) return null;
    if (!document.getElementById('tama-sync-style')) {
      const st = document.createElement('style');
      st.id = 'tama-sync-style';
      st.textContent = `
        .tama-sync-indicator {
          position: absolute; right: 4px; top: 4px;
          width: 18px; height: 18px;
          display: inline-flex; justify-content: center; align-items: center;
          border-radius: 100%; pointer-events: none; z-index: 999;
          font-size: 11px; line-height: 1; font-weight: bold; color: #fff;
          background: rgba(0, 0, 0, .5);
          opacity: 0; transform: scale(.7);
          transition: opacity .2s ease, transform .2s ease;
        }
        .tama-sync-indicator.on { opacity: .9; transform: scale(1); }
      `;
      document.head.appendChild(st);
    }
    indicatorEl = document.createElement('div');
    indicatorEl.className = 'tama-sync-indicator';
    host.appendChild(indicatorEl);
    return indicatorEl;
  }

  /* 'up' — отправляем, 'down' — забираем, 'done' — готово, null — спрятать */
  /* Простые символы, а не иконочный шрифт: если шрифт не подгрузился,
     значок всё равно будет виден. */
  const ICONS = { up: '↑', down: '↓', done: '✓' };
  let indicatorShownAt = 0;

  function indicator(state) {
    const el = ensureIndicator();
    if (!el) return;
    clearTimeout(indicatorTimer);
    if (!state) { el.classList.remove('on'); return; }

    // «готово» не проскакивает мгновенно: сначала даём разглядеть саму стрелку
    if (state === 'done') {
      const shown = Date.now() - indicatorShownAt;
      const delay = Math.max(0, 400 - shown);
      indicatorTimer = setTimeout(() => {
        el.innerHTML = ICONS.done;
        el.classList.add('on');
        indicatorTimer = setTimeout(() => el.classList.remove('on'), 900);
      }, delay);
      return;
    }

    indicatorShownAt = Date.now();
    el.innerHTML = ICONS[state] || ICONS.up;
    el.classList.add('on');
  }

  /* ======================================================================
     Обмен сохранением
     ====================================================================== */

  const VOLATILE = ['last_time', 'play_time'];   // меняются сами, на них реагировать не надо
  const MAX_SAVE = 3_500_000;                   // сервер принимает до 4 МБ

  /* Штатный App.getSaveCode выбрасывает оформление корпуса и моды — чтобы код
     сохранения, который пересылают руками, не разрастался. Нам пересылать
     руками ничего не надо, поэтому кладём всё; крупное отсекаем по размеру. */
  function encodeSave(obj) {
    return 'save:' + btoa(encodeURIComponent(JSON.stringify(obj))) + ':endsave';
  }

  async function buildSave() {
    const storage = await App.getDBItems();
    const full = Object.assign({}, storage);
    let code = encodeSave(full);
    if (code.length > MAX_SAVE) { delete full.mods; code = encodeSave(full); }
    if (code.length > MAX_SAVE) { delete full['shell_background_v2.2']; code = encodeSave(full); }
    const stable = {};
    Object.keys(full).sort().forEach(k => { if (!VOLATILE.includes(k)) stable[k] = full[k]; });
    return { code, hash: hashString(JSON.stringify(stable)) };
  }

  const IDLE_QUIET = 5 * 60 * 1000;    // столько ещё «считаемся играющими» после последнего касания
  const PULL_THROTTLE = 45 * 1000;     // не чаще, чем раз в столько, забираем с сервера
  let busy = false, lastPushAt = 0, lastPullAt = 0, pushTimer = null, applying = false;
  /* Последнее действие человека на этом устройстве. Живёт в localStorage:
     после перезагрузки страницы устройство не должно «забывать», что им
     только что пользовались, иначе главным станет то, где играли раньше. */
  let lastInteraction = Number(get(LS.active)) || 0;
  function touch() {
    lastInteraction = Date.now();
    set(LS.active, String(lastInteraction));
    schedulePush();
  }

  async function pushSave(force) {
    if (!enabled() || applying) return { ok: false, msg: 'Синхронизация выключена' };
    if (!hasApp() || !App.pet || !App.loadingEnded) return { ok: false, msg: 'Игра ещё не загрузилась' };
    if (busy) return { ok: false, msg: 'Уже отправляем' };
    busy = true;
    try {
      if (!token() && !(await ensureAccount())) return { ok: false, msg: 'Нет связи с сервером' };
      // Простаивающее устройство молчит: иначе его тиканье выглядит как
      // «новое состояние» и второе устройство бесконечно себя перезагружает.
      if (!force && !document.hidden && Date.now() - lastInteraction > IDLE_QUIET) {
        return { ok: true, msg: 'Устройство простаивает', skipped: true };
      }
      const { code, hash } = await buildSave();
      if (!force && hash === get(LS.hash)) return { ok: true, msg: 'Изменений нет', skipped: true };

      indicator('up');
      const res = await api('/api/save', {
        method: 'PUT',
        body: JSON.stringify({
          save: code,
          hash,
          last_time: Date.now(),
          device: deviceId(),
          active: lastInteraction,
          seen: document.visibilityState === 'visible' ? Date.now() : 0,
          needs: collectNeeds(),
          pet_name: (App.petDefinition && App.petDefinition.name) || null
        })
      });
      if (res.status === 409) {
        // мы отстали: на другом устройстве играли позже — забираем оттуда
        setTimeout(() => checkRemote(true), 600);
        return { ok: false, msg: 'На сервере более свежее состояние' };
      }
      set(LS.hash, hash);
      lastPushAt = Date.now();
      indicator('done');
      return { ok: true, msg: 'Отправлено на сервер' };
    } catch (e) {
      indicator(null);
      return { ok: false, msg: e.message };
    } finally { busy = false; }
  }

  function schedulePush() {
    if (!enabled() || pushTimer) return;
    const since = Date.now() - lastPushAt;
    const delay = Math.max(5000, 15000 - since);
    pushTimer = setTimeout(() => { pushTimer = null; pushSave(false); }, delay);
  }

  function decodeSave(code) {
    const inner = String(code).replace(/^save:/, '').replace(/:endsave$/, '');
    return JSON.parse(decodeURIComponent(atob(inner)));
  }

  /* ----------------------------------------------------------------------
     Живое применение состояния — без перезагрузки страницы.

     Игра держит состояние в объектах, которые можно обновить на месте:
     App.pet.stats и есть App.petDefinition.stats (один и тот же объект),
     а loadStats дописывает в него данные и заново готовит спрайт. Остальное
     (настройки, комнаты, мебель, растения, животные, миссии) пересобирается
     теми же функциями, которыми игра пользуется при обычной загрузке.

     Там, где на месте обновить нельзя — другой питомец, другой спрайт,
     открытое меню, питомец в отлучке — честно возвращаем false, и вызывающий
     перезагружает страницу как раньше.
     ---------------------------------------------------------------------- */
  function liveBlocker(json) {
    try {
      if (!hasApp() || !App.loadingEnded || !App.pet || !App.petDefinition) return 'игра ещё грузится';
      const inc = json.pet || {};
      const incStats = inc.stats || {};
      const cur = App.pet.stats;
      if (inc.sprite && inc.sprite !== App.petDefinition.sprite) return 'сменился спрайт';
      if (!!incStats.is_egg !== !!cur.is_egg) return 'яйцо/не яйцо';
      if (incStats.is_dead && !cur.is_dead) return 'питомец умер';
      if (cur.current_rabbit_hole && cur.current_rabbit_hole.name) return 'мы в отлучке';
      if (incStats.current_rabbit_hole && incStats.current_rabbit_hole.name) return 'там в отлучке';
      if (cur.is_at_parents || cur.is_at_vacation) return 'мы в гостях';
      if (incStats.is_at_parents || incStats.is_at_vacation) return 'там в гостях';
      if (App.pet.isDuringScriptedState && App.pet.isDuringScriptedState()) return 'идёт сценка';
      if (App.currentScene !== App.scene.home) return 'мы не дома';
      return null;
    } catch (e) { return 'ошибка проверки: ' + (e.message || e); }
  }

  function canApplyLive(json) {
    const blocker = liveBlocker(json);
    if (blocker) console.log('[sync] на месте нельзя:', blocker);
    return !blocker;
  }

  function applyLive(json) {
    if (!canApplyLive(json)) return false;
    try {
      // массивы Object.assign не укорачивает — чистим заранее
      const inc = json.pet || {};
      Object.keys(inc).forEach(k => {
        if (Array.isArray(inc[k]) && Array.isArray(App.petDefinition[k])) App.petDefinition[k].length = 0;
      });
      App.pet.loadStats(inc);

      if (json.settings) { Object.assign(App.settings, json.settings); App.applySettings(); }
      if (json['shell_background_v2.2']) App.setShellBackground(json['shell_background_v2.2']);
      if (json.records) App.records = json.records;
      if (json.ingame_events_history) App.gameEventsHistory = json.ingame_events_history;
      if (json.play_time != null) App.playTime = parseInt(json.play_time, 10) || 0;
      if (json.user_name != null) App.userName = json.user_name;
      if (json.user_id != null) App.userId = json.user_id;
      if (json.furniture) App.ownedFurniture = json.furniture;
      if (json.plants) App.plants = json.plants.map(p => new Plant(p));
      if (json.animals) {
        App.animals = Object.assign({}, json.animals, {
          list: (json.animals.list || []).map(a => new AnimalDefinition(a))
        });
      }
      if (json.missions && typeof Missions !== 'undefined') Missions.init(json.missions);
      if (json.room_customization) App.applyRoomCustomizations(json.room_customization);
      else App.reloadScene(true);
      if (App.handleFurnitureSpawn) App.handleFurnitureSpawn();
      return true;
    } catch (e) {
      console.warn('[sync] на месте не вышло, перезагружаемся:', e);
      return false;
    }
  }

  /* Полная замена состояния тем, что лежит на сервере.
     Свою функцию пишем потому, что штатная App.loadFromJson сбрасывает
     день рождения питомца и выбрасывает имя игрока — для импорта чужого
     сохранения это правильно, а для синхронизации своих же устройств нет. */
  async function applyRemote(remote) {
    if (!remote || !remote.save) return { ok: false, msg: 'На сервере пока нет сохранения' };
    let json;
    try { json = decodeSave(remote.save); }
    catch (e) { return { ok: false, msg: 'Сохранение на сервере повреждено' }; }
    if (!json || typeof json !== 'object' || !json.pet) return { ok: false, msg: 'Сохранение на сервере повреждено' };

    applying = true;
    const originalSave = App.save;
    try {
      App.save = () => {};                              // чтобы игра не переписала то, что кладём
      // Если отправитель обрезал что-то по размеру — не удаляем это у себя
      const keep = ['mods', 'shell_background_v2.2'];
      const incoming = Object.keys(json);
      for (const key of incoming) await window.idbKeyval.set(key, json[key]);
      for (const key of await window.idbKeyval.keys()) {
        if (!incoming.includes(key) && !keep.includes(key)) await window.idbKeyval.del(key);
      }
      // зеркало в localStorage — игра читает его как запасной вариант
      for (const key of incoming) {
        try { window.localStorage.setItem(key, JSON.stringify(json[key])); } catch (e) {}
      }
      const stable = {};
      Object.keys(json).sort().forEach(k => { if (!VOLATILE.includes(k)) stable[k] = json[k]; });
      set(LS.hash, hashString(JSON.stringify(stable)));

      const live = applyLive(json);
      if (live) {
        App.save = originalSave;      // возвращаем сохранение на место
        hookSave();
        applying = false;
        return { ok: true, live: true, msg: 'Обновлено с сервера' };
      }
      // на месте не получилось — оставляем сохранение выключенным до перезагрузки
      return { ok: true, live: false, msg: 'Загружено с сервера' };
    } catch (e) {
      App.save = originalSave;
      applying = false;
      return { ok: false, msg: 'Не удалось применить: ' + (e.message || e) };
    }
  }

  async function pullAndApply(silent) {
    indicator('down');
    let data, res;
    try {
      data = (await api('/api/save')).data;
      res = await applyRemote(data);
    } catch (e) {
      indicator(null);
      throw e;
    }
    if (res.ok && data && data.hash) set(LS.hash, data.hash);
    if (res.ok && res.live) { indicator('done'); return res; }
    if (res.ok) {
      if (!silent) popup('Забираю прогресс с другого устройства…', 2000);
      setTimeout(() => location.reload(), silent ? 400 : 1200);
    } else indicator(null);
    return res;
  }

  /* ---------- сторож: не играли ли только что на другом устройстве ----------
     Сравнивать «что новее» по времени сохранения нельзя: игра тикает сама
     по себе на обоих устройствах сразу. Ориентир — последнее действие
     человека. Кого трогали позже, тот и главный.                        */
  function otherIsAhead(data) {
    if (!data || !data.has_save || !data.hash) return false;
    if (data.hash === get(LS.hash)) return false;              // ровно то, что у нас уже есть
    const theirs = Number(data.active) || 0;
    if (!theirs) return false;
    return theirs > lastInteraction + 5000;                    // там играли позже, чем здесь
  }

  async function checkRemote(fromUser) {
    if (!enabled() || applying || busy || !token()) return;
    if (!hasApp() || !App.loadingEnded) return;
    if (!fromUser) {
      if (Date.now() - lastInteraction < 30000) return;         // здесь прямо сейчас играют
      if (Date.now() - lastPullAt < PULL_THROTTLE) return;
    }
    try {
      const { data } = await api('/api/meta');
      if (!otherIsAhead(data)) return;
      lastPullAt = Date.now();
      await pullAndApply(false);
    } catch (e) { /* тихо: сеть могла моргнуть */ }
  }

  /* ======================================================================
     Уведомления
     ====================================================================== */
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

    const reg = await Promise.race([navigator.serviceWorker.ready, wait(10000).then(() => null)]);
    if (!reg) return { ok: false, msg: 'Служебный процесс не запустился — перезагрузи страницу' };

    let sub;
    try {
      sub = await reg.pushManager.getSubscription();
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
    } catch (e) {
      return { ok: false, msg: 'Подписка не удалась: ' + (e.message || e) };
    }

    const j = sub.toJSON();
    try {
      await api('/api/subscribe', {
        method: 'POST',
        body: JSON.stringify({ endpoint: j.endpoint, keys: j.keys, device: deviceId() })
      });
    } catch (e) { return { ok: false, msg: e.message }; }
    return { ok: true, msg: 'Уведомления включены' };
  }

  async function disableNotifications() {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg && await reg.pushManager.getSubscription();
      if (sub) {
        await api('/api/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {});
        await sub.unsubscribe();
      }
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

  /* ======================================================================
     Запуск
     ====================================================================== */
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
      const { data } = await api('/api/meta');
      if (otherIsAhead(data)) {
        const res = await pullAndApply(false);
        if (res.ok) return;
      }
      await pushSave(true);
    } catch (e) {
      console.warn('[sync] недоступна:', e.message);
    }
  }

  /* ---------- когда отправлять и когда проверять ---------- */
  function hookSave() {
    if (!hasApp() || typeof App.save !== 'function' || App.save.__tamaSync) return false;
    const orig = App.save;
    const wrapped = function () {
      const out = orig.apply(this, arguments);
      schedulePush();
      return out;
    };
    wrapped.__tamaSync = true;
    App.save = wrapped;
    return true;
  }

  ['pointerdown', 'keydown', 'touchstart'].forEach(ev =>
    window.addEventListener(ev, touch, { passive: true, capture: true }));

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pushSave(true);
    else setTimeout(() => checkRemote(true), 800);
  });
  window.addEventListener('pagehide', () => pushSave(true));
  window.addEventListener('online', () => { pushSave(false); checkRemote(true); });

  setInterval(() => { if (document.visibilityState === 'visible') checkRemote(); }, 25000);
  setInterval(() => pushSave(false), 60000);

  setTimeout(() => { hookSave(); boot(); }, 6000);

  /* ======================================================================
     Экран в настройках игры
     ====================================================================== */

  function popup(text, ms) {
    if (hasApp() && App.displayPopup) return App.displayPopup(text, ms || 2500);
    console.log(text);
  }

  function askLinkCode(onDone) {
    App.displayPrompt(
      'Код с главного устройства<br><small>прогресс отсюда будет заменён</small>',
      [
        {
          name: 'привязать',
          onclick: (value) => {
            const p = popup('Проверяем код…', 60000);
            TamaSync.link(value).then(ok => {
              p && p.close && p.close();
              if (!ok) return popup('Код не подошёл', 3000);
              popup('Привязано. Забираю питомца…', 4000);
              pullAndApply(true).then(res => {
                if (!res.ok) { popup(res.msg, 4000); onDone && onDone(); }
              });
            });
          }
        },
        { name: 'отмена', class: 'back-btn', onclick: () => {} }
      ]
    );
  }

  function showLinkCode(code) {
    App.displayPrompt(
      'Код этого устройства<br><small>введи его на втором — и там будет этот же питомец</small>',
      [
        {
          name: 'копировать',
          onclick: () => { try { navigator.clipboard.writeText(code); popup('Скопировано', 1500); } catch (e) {} }
        },
        { name: 'готово', class: 'back-btn', onclick: () => {} }
      ],
      code
    );
  }

  const STAT_NAMES = [
    ['current_hunger', 'max_hunger', 'сытость'],
    ['current_fun', 'max_fun', 'настроение'],
    ['current_sleep', 'max_sleep', 'бодрость'],
    ['current_bladder', 'max_bladder', 'туалет'],
    ['current_cleanliness', 'max_cleanliness', 'чистота'],
    ['current_health', 'max_health', 'здоровье'],
  ];

  function openDiagnostics() {
    const s = hasApp() && App.pet && App.pet.stats;
    if (!s) return App.displayList([{ type: 'info', name: 'питомец ещё не загрузился' }]);

    const rows = STAT_NAMES.map(([cur, max, label]) => {
      const v = Math.round((s[cur] / (s[max] || 100)) * 100);
      return label + ': <b>' + v + '%</b>';
    });
    rows.push('спит: <b>' + (s.is_sleeping ? 'да' : 'нет') + '</b>');
    if (s.has_poop_out) rows.push('какашек: <b>' + s.has_poop_out + '</b>');
    if (s.is_misbehaving) rows.push('<b>балуется</b>');

    const needs = collectNeeds();
    const when = at => {
      const m = Math.round((at - Date.now()) / 60000);
      if (m <= 0) return 'сейчас';
      if (m < 60) return 'через ' + m + ' мин';
      return 'через ' + (m / 60).toFixed(1) + ' ч';
    };

    return App.displayList([
      { type: 'info', name: rows.join('<br>') },
      { type: 'separator' },
      needs.length
        ? { type: 'info', icon: 'bell', name: needs.map(n => n.body.toLowerCase() + ' — ' + when(n.at)).join('<br>') }
        : { type: 'info', icon: 'bell', name: 'напоминаний не запланировано' }
    ]);
  }

  async function openMenu() {
    let st = null, err = null;
    try {
      if (!token()) await ensureAccount();
      st = (await api('/api/status')).data;
    } catch (e) { err = e.message; }
    const notif = await notificationState();
    const online = !err;

    let state;
    if (err) state = 'нет связи с сервером';
    else if (!enabled()) state = 'синхронизация приостановлена';
    else state = 'сервер на связи' + (st && st.has_save ? ', сохранение есть' : ', сохранения ещё нет');

    const needs = collectNeeds();
    const soon = needs[0];
    const nextText = soon
      ? new Date(soon.at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) +
        ' — ' + soon.body.toLowerCase()
      : 'пока не о чем напоминать';

    const items = [
      { type: 'info', name: state },
      {
        _ignore: !online || notif === 'запрещены' || notif === 'нет поддержки',
        icon: 'bell',
        name: 'уведомления: ' + (notif === 'включены' ? 'вкл' : 'выкл'),
        onclick: (btn, list) => {
          const again = () => { try { list.close(); } catch (e) {} openMenu(); };
          if (notif === 'включены') disableNotifications().then(r => { popup(r.msg, 2500); again(); });
          else enableNotifications().then(r => { popup(r.msg, r.ok ? 2500 : 6000); again(); });
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
            .then(({ data }) => {
              if (!data || !data.total) return popup('Подписки нет. Включи уведомления заново.', 5000);
              const bad = (data.detail || []).filter(d => !d.ok);
              popup(bad.length
                ? 'Служба доставки ответила отказом: ' + bad.map(d => d.status).join(', ')
                : 'Отправлено, устройств: ' + data.sent + '. Если ничего не появилось — проверь разрешения уведомлений в самой системе.',
                6000);
            })
            .catch(e => popup('Ошибка: ' + e.message, 5000));
          return true;
        }
      },
      { _ignore: !online, type: 'separator' },
      {
        _ignore: !online || !st,
        icon: 'link',
        name: 'мой код',
        onclick: () => { showLinkCode((st && st.link_code) || ''); return true; }
      },
      {
        _ignore: !online,
        icon: 'right-to-bracket',
        name: 'ввести код',
        onclick: (btn, list) => {
          askLinkCode(() => { try { list.close(); } catch (e) {} });
          return true;
        }
      },
      { _ignore: !online, type: 'separator' },
      {
        _ignore: !online,
        icon: 'cloud-arrow-up',
        name: 'отправить сейчас',
        onclick: () => { pushSave(true).then(r => popup(r.msg, 3000)); return true; }
      },
      {
        _ignore: !online || !st || !st.has_save,
        icon: 'cloud-arrow-down',
        name: 'забрать с сервера',
        onclick: () => {
          App.displayConfirm(
            'Прогресс на этом устройстве будет <b>заменён</b> тем, что лежит на сервере. Продолжить?',
            [
              { name: 'да', onclick: () => { pullAndApply(false).then(r => { if (!r.ok) popup(r.msg, 4000); }); } },
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
        name: 'ближайшее напоминание: ' + nextText
      },
      {
        icon: 'heart-pulse',
        name: 'что с питомцем',
        onclick: () => { openDiagnostics(); return true; }
      },
      {
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

  /* ======================================================================
     Чистка лишнего

     Промо-окна оригинальной игры (Discord, оценка, «вышло обновление») и
     предупреждение «сохранение под угрозой» больше не нужны: состояние лежит
     на сервере. Правим не исходники игры, а поведение — так обновления
     оригинального проекта продолжат накатываться поверх без конфликтов.
     ====================================================================== */
  const NOISY_EVENT = /(notice|discord|rating_dialog|poll|sales_day|newsletter)/i;

  function hookNotices() {
    if (!hasApp()) return false;
    // предупреждение о хрупком хранилище: и правда просим браузер не удалять
    try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}
    App.isStoragePersistent = true;
    if (App.temp) App.temp.showStoragePersistentBadge = false;

    if (typeof App.addEvent !== 'function' || App.addEvent.__tamaSync) return true;
    const orig = App.addEvent;
    const wrapped = function (name) {
      if (NOISY_EVENT.test(String(name))) return false;   // окно просто не показываем
      return orig.apply(this, arguments);
    };
    wrapped.__tamaSync = true;
    App.addEvent = wrapped;
    return true;
  }

  /* успеть до того, как игра решит показать окно после загрузки */
  const noticeTimer = setInterval(hookNotices, 50);
  setTimeout(() => clearInterval(noticeTimer), 20000);
  hookNotices();

  const DROP_FROM_SETTINGS = /(save data is at risk|сохранение под угрозой|manual save|ручное сохранение)/i;

  /* ---------- пункт в настройках игры ---------- */
  function menuItem() {
    return {
      icon: 'cloud',
      name: 'синхронизация',
      onclick: () => { openMenu(); return true; }
    };
  }

  function inject(items) {
    const copy = items.filter(it => !(typeof it.name === 'string' && DROP_FROM_SETTINGS.test(it.name)));
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
    installMenuHook();
    hookSave();
    if (++tries > 120) clearInterval(hookTimer);
  }, 500);
  installMenuHook();

  /* ---------- на случай отладки из консоли ---------- */
  window.TamaSync = {
    setServer(url) { set(LS.server, String(url || '').replace(/\/+$/, '')); set(LS.on, '1'); },
    async link(code) {
      try {
        const { data } = await api('/api/link', { method: 'POST', body: JSON.stringify({ code: String(code || '').trim() }) });
        if (data && data.token) { set(LS.token, data.token); set(LS.on, '1'); set(LS.hash, ''); return true; }
      } catch (e) { console.warn(e.message); }
      return false;
    },
    async status() { const { data } = await api('/api/status'); console.log(data); return data; },
    async testPush() { const { data } = await api('/api/test-push', { method: 'POST' }); console.log(data); return data; },
    notifications: enableNotifications,
    menu: openMenu,
    push: () => pushSave(true),
    pull: () => pullAndApply(false),
    check: checkRemote,
    needs: collectNeeds,
    diag: openDiagnostics,
    why: liveBlocker,
    active: () => lastInteraction,
    off() { set(LS.on, '0'); },
    on() { set(LS.on, '1'); }
  };
})();
