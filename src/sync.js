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
    sound:  'tama_sound_in_silent',
    on:     'tama_sync_enabled',
    reset:  'tama_reset_pending',   // «питомца сбросили, дело ещё не доведено до конца»
    gen:    'tama_sync_gen',        // поколение питомца: растёт при каждом сбросе
  };
  const get = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const set = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
  const drop = k => { try { localStorage.removeItem(k); } catch (e) {} };

  const server = () => (get(LS.server) || SYNC_SERVER || '').replace(/\/+$/, '');
  /* Полный сброс стирает localStorage целиком, а сказать серверу «забудь меня»
     надо уже после этого — поэтому держим последний токен ещё и в памяти. */
  let lastToken = null;
  const token  = () => { const t = get(LS.token); if (t) lastToken = t; return t; };
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

     Игра пересчитывает показатели ДВА раза в секунду (Pet.think: «think twice
     a second»), и офлайн-догон делает то же самое: iterations = секунды × 2.
     Раньше здесь считался один тик в секунду — прогноз выходил ровно вдвое
     оптимистичнее реальности. Плюс пока игра закрыта, расход умножается на
     0.25, а ночью на 0.05. Теперь это настройка settings.offlineSpeed:
     по умолчанию 1 — жизнь в закрытой игре идёт ровно как в открытой.
     ====================================================================== */

  const HORIZON_HOURS = 72;
  const STEP_SEC = 60;

  /* short — для случая, когда назрело несколько дел сразу: тогда сервер
     соберёт из них одно уведомление, а не пришлёт четыре подряд. */
  const NEED_TEXT = {
    dead:        { title: '{name} умер',              body: 'Можно воскресить',        short: 'умер' },
    danger:      { title: '{name} совсем плохо!',     body: 'Срочно зайди в игру',     short: 'совсем плохо' },
    sick:        { title: '{name} заболел',           body: 'Нужно лекарство',         short: 'заболел' },
    hunger:      { title: '{name} проголодался',      body: 'Пора покормить',          short: 'голоден' },
    toilet:      { title: '{name} просится в туалет', body: 'Отведи его',              short: 'просится в туалет' },
    poop:        { title: 'У {name} грязно',          body: 'Надо убрать',             short: 'надо убрать' },
    fun:         { title: '{name} скучает',           body: 'Хочет поиграть',          short: 'скучает' },
    sleep:       { title: '{name} хочет спать',       body: 'Пора выключить свет',     short: 'хочет спать' },
    clean:       { title: '{name} испачкался',        body: 'Пора помыть',             short: 'надо помыть' },
    misbehave:   { title: '{name} балуется',          body: 'Стоит поругать',          short: 'балуется' },
    home:        { title: '{name} вернулся домой',    body: 'Занятие закончилось',     short: 'вернулся домой' },
    ageup:       { title: '{name} готов повзрослеть', body: 'Загляни — он изменится',  short: 'готов повзрослеть' },
    egg:         { title: 'Яйцо ждёт',                body: 'Оно вылупится, когда откроешь игру', short: 'яйцо ждёт' },
    plant_ready: { title: 'Урожай готов',             body: 'Пора собирать',           short: 'урожай готов' },
    plant_water: { title: 'Растения хотят пить',      body: 'Пора полить',             short: 'полить растения' },
    plant_dying: { title: 'Растение погибает',        body: 'Полей, пока не поздно',   short: 'растение погибает' },
    animal:      { title: 'Животное заскучало',       body: 'Покорми и поиграй',       short: 'животное скучает' },
  };

  function isSleepHourAt(date) {
    try { return App.isSleepHour(date.getHours()); }
    catch (e) { const h = date.getHours(); return h >= 21 || h < 8; }
  }

  /* Что важнее чего. Заодно решает ничьи: если два дела назрели к одному
     времени, первым показываем и отправляем то, что серьёзнее. */
  const PRIORITY = Object.keys(NEED_TEXT);
  const rank = k => { const i = PRIORITY.indexOf(k); return i < 0 ? 99 : i; };



  /* События, которые не выводятся из показателей питомца: возвращение
     с занятия, взросление, огород, животные. У всех есть точное время. */
  function collectWorldEvents(mark, now) {
    const s = App.pet.stats;

    // питомец ушёл на занятие — известно, когда вернётся
    try {
      const hole = s.current_rabbit_hole;
      if (hole && hole.name && hole.endTime) mark('home', hole.endTime);
    } catch (e) {}

    // автоматическое взросление
    try {
      if (App.settings.automaticAging) {
        const next = App.petDefinition.getNextAutomaticBirthdayDate();
        if (next) {
          const at = next.valueOf ? next.valueOf() : +next;
          if (at) mark('ageup', at);
        }
      }
    } catch (e) {}

    // огород
    try {
      const GROWN = (typeof Plant !== 'undefined' && Plant.AGE) ? Plant.AGE.grown : 2;
      const DEAD = (typeof Plant !== 'undefined' && Plant.AGE) ? Plant.AGE.dead : 3;
      for (const p of App.plants || []) {
        if (p.age === DEAD) continue;
        const d = p.getStatDurations ? p.getStatDurations() : null;
        if (!d) continue;
        if (p.age >= GROWN) mark('plant_ready', now);
        else mark('plant_ready', p.lastGrowthTime + d.growthDelay * (GROWN - p.age));
        mark('plant_water', p.lastWatered + d.wateredDuration);
        mark('plant_dying', p.lastWatered + d.wateredDuration + d.deathDuration);
      }
    } catch (e) {}

    // животные: счастье падает со 100 до нуля за 48 часов, дальше зверь уходит
    try {
      const perSec = 100 / (48 * 3600);
      for (const a of (App.animals && App.animals.list) || []) {
        const h = a.stats && a.stats.current_happiness;
        if (typeof h !== 'number') continue;
        mark('animal', now + Math.max(0, (h - 20)) / perSec * 1000);
      }
    } catch (e) {}
  }

  /* Кто считает жизнь питомца, пока игра закрыта: браузер (прогноз) или сервер. */
  const serverSim = () => {
    try { return App.settings.simOnServer !== false; } catch (e) { return false; }
  };

  /* Дополнительное замедление, пока игра закрыта. По умолчанию 1 — закрытая
     игра идёт с той же скоростью, что открытая. */
  function offlineSpeed() {
    try {
      const v = App.settings.offlineSpeed;
      if (typeof v === 'number' && v >= 0) return v;
    } catch (e) {}
    return 1;
  }

  /* Общая скорость жизни: действует ВЕЗДЕ — и в открытой игре, и в закрытой,
     и на сервере. Ту же величину читает Pet.statsManager. */
  const LIFE_DEFAULT = 0.3;
  function lifeSpeed() {
    try {
      const v = App.settings.lifeSpeed;
      if (typeof v === 'number' && v > 0) return v;
    } catch (e) {}
    return LIFE_DEFAULT;
  }

  /* С какой скоростью тратит показатели сервер. Он считает за закрытую игру,
     поэтому обе настройки перемножаются. Отправляем это в старом поле speed —
     тогда уже установленный воркер поймёт настройку без переустановки. */
  const serverSpeed = () => lifeSpeed() * offlineSpeed();

  /* Всё, что нужно серверу, чтобы продолжить жизнь питомца с этой точки. */
  function simSnapshot() {
    try {
      const snap = {
        stats: JSON.parse(JSON.stringify(App.pet.stats)),
        traits: (App.petDefinition.traits || []).slice(),
        stage: App.petDefinition.lifeStage,
        speed: serverSpeed(),          // скорость жизни × замедление в закрытой игре
        lifeSpeed: lifeSpeed(),        // по отдельности — на будущее
        offlineSpeed: offlineSpeed(),
        sleepStart: App.constants.SLEEP_START + (App.settings.sleepingHoursOffset || 0),
        sleepEnd: App.constants.SLEEP_END + (App.settings.sleepingHoursOffset || 0),
        plants: [], animals: [], rabbitHole: null, ageUpAt: null,
      };

      snap.plants = (App.plants || []).map(p => ({
        name: p.name, age: p.age,
        lastGrowthTime: p.lastGrowthTime, lastWatered: p.lastWatered,
        wateredDuration: p.wateredDuration, deathDuration: p.deathDuration, growthDelay: p.growthDelay,
        watered: p.isWatered,
      }));

      snap.animals = ((App.animals && App.animals.list) || []).map(a => ({
        name: a.name, happiness: a.stats && a.stats.current_happiness,
        lastStatsUpdate: a.lastStatsUpdate, buff: a.stats && a.stats.buff,
      }));

      const hole = App.pet.stats.current_rabbit_hole;
      if (hole && hole.name && hole.endTime) snap.rabbitHole = { name: hole.name, endTime: hole.endTime };

      if (App.settings.automaticAging) {
        const next = App.petDefinition.getNextAutomaticBirthdayDate();
        if (next) snap.ageUpAt = next.valueOf ? next.valueOf() : +next;
      }
      return snap;
    } catch (e) { return null; }
  }

  function collectNeeds() {
    if (!hasApp() || !App.pet || !App.pet.stats || !App.petDefinition) return [];
    const s = App.pet.stats;
    const name = App.petDefinition.name || 'Питомец';
    const found = {};
    const now = Date.now();

    // из нескольких источников одного события берём самое раннее время
    const mark = (key, at) => { if (found[key] == null || at < found[key]) found[key] = at; };

    collectWorldEvents(mark, now);

    if (s.is_dead) { mark('dead', now); return finish(found, name, now); }
    if (s.is_egg) { mark('egg', now); return finish(found, name, now); }

    /* Стадии в игре пронумерованы 0 / 0.5 / 1 / 2 / 3, а не подряд —
       раньше здесь взрослому доставался множитель подростка. */
    const stage = App.petDefinition.lifeStage;
    const stageMult = stage === 0 ? 1.65 : stage === 0.5 ? 1.46 : stage === 1 ? 1.3 : 1;

    const TICKS = 2;   // statsManager вызывается дважды в секунду — и в игре, и в офлайн-догоне

    /* Черты характера меняют расход — ровно как в Pet.statsManager. */
    const has = n => { try { return !!App.petDefinition.hasTrait(n); } catch (e) { return false; } };
    const r = {
      hunger:  s.hunger_depletion_rate      * TICKS * stageMult * (has('lightEater') ? 0.5 : 1)   * (has('voraciousHunger') ? 1.5 : 1),
      fun:     s.fun_depletion_rate         * TICKS * stageMult * (has('chill') ? 0.5 : 1)        * (has('playBurnout') ? 1.5 : 1),
      sleep:   s.sleep_depletion_rate       * TICKS * stageMult * (has('deepSleeper') ? 0.5 : 1)  * (has('restless') ? 1.5 : 1),
      bladder: s.bladder_depletion_rate     * TICKS * stageMult * (has('ironBladder') ? 0.5 : 1)  * (has('tinyTank') ? 1.5 : 1),
      clean:   s.cleanliness_depletion_rate * TICKS * stageMult * (has('selfCleaning') ? 0.5 : 1) * (has('dustMagnet') ? 1.5 : 1),
      health:  s.health_depletion_rate      * TICKS * stageMult * (has('germGuardian') ? 0.5 : 1),
    };

    // пороги берём те же, по которым сама игра понимает, что питомец чего-то хочет
    const grumpy = has('grumpy');   // ворчуну всего надо раньше остальных
    const T = {
      hunger: (s.hunger_min_desire != null ? s.hunger_min_desire : 40) * (grumpy ? 1.5 : 1),
      fun:    (s.fun_min_desire    != null ? s.fun_min_desire    : 35) * (grumpy ? 1.8 : 1),
      sleep:  (s.sleep_min_desire  != null ? s.sleep_min_desire  : 20) * (grumpy ? 2 : 1),
      toilet: (s.max_bladder || 100) / 4,
      clean:  25,
      sick:   (s.max_health || 100) * 0.25,
      danger: (s.max_health || 100) * 0.1,
    };

    let hunger = s.current_hunger, fun = s.current_fun, sleep = s.current_sleep,
        bladder = s.current_bladder, clean = s.current_cleanliness, health = s.current_health,
        poop = s.has_poop_out || 0;
    let sleeping = !!s.is_sleeping;
    const sleepMax = s.max_sleep || 100;
    const replenish = s.sleep_replenish_rate || 0.1;

    if (s.is_misbehaving) mark('misbehave', now);

    /* Прогноз обязан описывать тот порядок, по которому уведомления реально
       приходят, а он зависит от режима счёта:

       • «на сервере» (по умолчанию) — питомец живёт так, будто игра открыта:
         ночью сам не засыпает и сам не просыпается.
       • «в игре» — браузер досчитывает пропущенное офлайн-догоном, где ночью
         питомец укладывается сам и восстанавливает сон вдвое быстрее.

       В обоих случаях о том, что уже не так прямо сейчас, сообщаем сразу:
       время такого события — «сейчас», а не «никогда». */
    const srv = serverSim();

    const steps = Math.round(HORIZON_HOURS * 3600 / STEP_SEC);
    for (let i = 0; i <= steps; i++) {
      const at = now + i * STEP_SEC * 1000;
      const night = srv ? false : isSleepHourAt(new Date(at));
      const mult = serverSpeed();                // та же скорость, что у сервера
      const dt = STEP_SEC;

      /* Спящего питомца нельзя ни покормить, ни поиграть с ним — в режиме
         «в игре» пока он спит, молчим. Сервер же сообщает и про спящего:
         он о состоянии питомца, а не о том, что игрок может сделать сейчас. */
      if (srv || !sleeping) {
        if (hunger <= T.hunger) mark('hunger', at);
        if (fun <= T.fun) mark('fun', at);
        if (!night && sleep <= T.sleep) mark('sleep', at);
        if (bladder <= T.toilet) mark('toilet', at);
      }
      if (poop > 0) mark('poop', at);
      if (clean <= T.clean) mark('clean', at);
      if (health <= T.sick) mark('sick', at);
      // отсчёт до смерти в игре запускается, когда всё это разом на нуле
      if (health <= T.danger || (health <= 0 && clean <= 0 && fun <= 0 && hunger <= 0)) mark('danger', at);

      // шаг вперёд
      hunger = Math.max(0, hunger - r.hunger * mult * dt);
      fun    = Math.max(0, fun    - r.fun    * mult * dt);
      clean  = Math.max(0, clean  - r.clean  * mult * dt);

      if (sleeping) {
        sleep = Math.min(sleepMax, sleep + replenish * (night ? 2 : 1) * dt);
        // сам просыпается только в режиме «в игре»: сервер спящего не будит,
        // питомец проснётся, когда игрок откроет приложение
        if (!srv && sleep >= sleepMax && !night) sleeping = false;
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

      if (Object.keys(found).length >= 14) break;
    }

    return finish(found, name, now);
  }

  /* Никаких отсрочек и переносов: время события — это время события. */
  function finish(found, name, now) {
    return Object.keys(found).map(key => {
      const t = NEED_TEXT[key] || { title: '{name} зовёт', body: 'Кажется, ему что-то нужно' };
      return {
        key,
        at: Math.max(found[key], now),
        title: t.title.replace('{name}', name),
        body: t.body,
        short: t.short || t.body
      };
    }).sort((a, b) => (a.at - b.at) || (rank(a.key) - rank(b.key)));
  }

  /* ======================================================================
     Звук на айфоне при выключенном звонке

     Игра играет звуки через Web Audio. На iOS такой звук по умолчанию идёт
     в «фоновой» звуковой сессии, а её глушит переключатель на боку телефона.
     Обычные приложения ставят себе сессию «воспроизведение» — она беззвучный
     режим игнорирует. В Safari то же самое доступно двумя способами:

       • navigator.audioSession.type = 'playback' — официально, с iOS 16.4;
       • для версий постарше — трюк: если на странице играет обычный тег
         <audio>, WebKit переключает всю страницу в сессию воспроизведения.
         Поэтому крутим по кругу почти беззвучный файл.

     И то и другое разрешено запускать только по касанию экрана.
     ====================================================================== */
  const soundInSilent = () => get(LS.sound) !== '0';
  const SILENT_WAV = 'data:audio/wav;base64,UklGRqQ+AABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YYA+AACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA';
  let silentAudio = null, audioFixed = false;

  function fixIosAudio() {
    if (audioFixed) return;
    audioFixed = true;

    if (soundInSilent()) {
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {}
    }

    try {
      if (!soundInSilent()) throw 0;
      // трюк с беззвучной петлёй нужен только на iOS, остальным он ни к чему
      if (!isIOS()) throw 0;
      if (!silentAudio) {
        silentAudio = new Audio(SILENT_WAV);
        silentAudio.loop = true;
        silentAudio.volume = 0.02;
        silentAudio.setAttribute('playsinline', '');
        silentAudio.preload = 'auto';
      }
      const p = silentAudio.play();
      if (p && p.catch) p.catch(() => { audioFixed = false; });   // не вышло — попробуем на следующее касание
    } catch (e) { audioFixed = false; }

    // сам звук игры на iOS часто стартует «приостановленным»
    try {
      const ctx = hasApp() && App.audioChannel && App.audioChannel.audioContext;
      if (ctx && ctx.state === 'suspended') ctx.resume();
      const sctx = hasApp() && App.speechAudioChannel && App.speechAudioChannel.audioContext;
      if (sctx && sctx.state === 'suspended') sctx.resume();
    } catch (e) {}
  }

  /* если система вернула страницу из фона, сессию надо восстановить */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !soundInSilent()) return;
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {}
    if (silentAudio && silentAudio.paused) silentAudio.play().catch(() => {});
    try {
      const ctx = hasApp() && App.audioChannel && App.audioChannel.audioContext;
      if (ctx && ctx.state === 'suspended') ctx.resume();
    } catch (e) {}
  });

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
    fixIosAudio();
    schedulePush();
  }

  async function pushSave(force, allowDuringReset) {
    if ((resetting || get(LS.reset)) && !allowDuringReset) {
      return { ok: false, msg: 'Идёт сброс питомца' };
    }
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
          gen: genNum(),                         // «к какому поколению питомца это относится»
          last_time: Date.now(),
          device: deviceId(),
          tz: -new Date().getTimezoneOffset(),   // сдвиг от UTC в минутах — сервер молчит по ночам
          active: lastInteraction,
          seen: document.visibilityState === 'visible' ? Date.now() : 0,
          needs: collectNeeds(),
          mode: serverSim() ? 'server' : 'client',
          sim: simSnapshot(),
          pet_name: (App.petDefinition && App.petDefinition.name) || null
        })
      });
      if (res.status === 409 && res.data && res.data.conflict === 'reset') {
        /* Питомца сбросили на другом устройстве. Наше сохранение теперь от
           прежней жизни — отправлять его нельзя, надо стереть у себя тоже. */
        await adoptRemoteReset(res.data.gen);
        return { ok: false, msg: 'Питомца сбросили на другом устройстве' };
      }
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
    if (resetting) return;
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
    if (resetting || get(LS.reset)) return;
    if (!enabled() || applying || busy || !token()) return;
    if (!hasApp() || !App.loadingEnded) return;
    if (!fromUser) {
      if (Date.now() - lastInteraction < 30000) return;         // здесь прямо сейчас играют
      if (Date.now() - lastPullAt < PULL_THROTTLE) return;
    }
    try {
      const { data } = await api('/api/meta');
      // питомца начали заново на другом устройстве
      if (data && data.gen && genNum() && data.gen !== genNum()) {
        await adoptRemoteReset(data.gen);
        return;
      }
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
     Сброс питомца

     Раньше игра стирала питомца только у себя и тут же перезагружалась.
     Сервер об этом не знал и продолжал жить со старым питомцем: новому яйцу
     доставались его характеристики и какашки, уведомления шли по старому
     расписанию, а второе устройство при случае возвращало и всё сохранение
     целиком.

     Теперь сброс — это одно определённое действие в определённом порядке:
       1. сказать серверу «забудь» и дождаться ответа;
       2. сервер поднимает номер поколения — всё, что было отправлено до
          этого, он больше не примет (в том числе запрос, зависший в пути,
          и вкладка на другом устройстве, которая ещё не знает о сбросе);
       3. только потом стереть питомца в браузере;
       4. и только потом перезагрузиться.

     Пока дело не доведено до конца, метка в localStorage держит обмен
     закрытым: с сервера ничего не берём и ничего туда не шлём.
     ====================================================================== */
  let resetting = false;

  const genNum = () => Number(get(LS.gen)) || 0;
  const setGen = g => { if (g) set(LS.gen, String(g)); };

  /* Стереть питомца в браузере — ровно то же, что делает пункт меню. */
  async function wipeLocalPet(full) {
    try {
      if (full) localStorage.clear();
      else { localStorage.removeItem('pet'); localStorage.removeItem('last_time'); }
    } catch (e) {}
    try {
      if (!window.idbKeyval) return;
      if (full) await window.idbKeyval.clear();
      else await window.idbKeyval.delMany(['last_time', 'pet']);
    } catch (e) { console.warn('[sync] локально стереть не вышло:', e); }
  }

  async function serverResetRequest(full) {
    const t = token() || lastToken;
    if (!server() || !t) throw new Error('Сервер не задан');
    const r = await fetch(server() + '/api/reset', {
      method: 'POST',
      keepalive: true,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + t },
      body: JSON.stringify({ full: !!full })
    });
    if (!r.ok) throw new Error('Сервер ответил ' + r.status);
    const data = await r.json().catch(() => null);
    if (data && data.gen) setGen(data.gen);
    return data;
  }

  /* Пометить, что сброс начался, и сказать серверу — не дожидаясь ответа.
     Используется подстраховкой: страница в этот момент может уже уходить
     на перезагрузку, ждать нечего. */
  function markReset(full) {
    if (resetting) return;
    resetting = true;
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
    set(LS.reset, full ? 'full' : '1');
    drop(LS.hash);
    serverResetRequest(full).catch(() => {});
  }

  /* Подстраховка: если питомца сотрут не через наш пункт меню (другой кнопкой,
     чужим кодом, очисткой данных сайта), мы всё равно об этом узнаем. Метка
     останется, и следующий запуск доведёт сброс до сервера. Без этого сервер
     продолжил бы жить со старым питомцем и отдал бы его новому яйцу. */
  function hookReset() {
    const idb = window.idbKeyval;
    if (!idb || idb.__tamaSyncReset) return false;
    const wrap = (name, isReset, full) => {
      const orig = idb[name];
      if (typeof orig !== 'function') return;
      idb[name] = function () {
        try { if (isReset(arguments)) markReset(full); } catch (e) {}
        return orig.apply(this, arguments);
      };
    };
    wrap('delMany', a => Array.isArray(a[0]) && a[0].indexOf('pet') !== -1, false);
    wrap('del',     a => a[0] === 'pet', false);
    wrap('clear',   () => true, true);
    idb.__tamaSyncReset = true;
    return true;
  }

  /* Полный ход сброса. Вызывается из пункта меню. */
  async function doReset(full) {
    resetting = true;
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
    try { App.save = () => {}; } catch (e) {}     // игра больше ничего не пишет
    set(LS.reset, full ? 'full' : '1');
    drop(LS.hash);

    try { App.displayPopup('сбрасываю…', App.INF); } catch (e) {}

    /* Сначала сервер. Ждём ответа, но не вечно: без сети сброс всё равно
       состоится, а до сервера его доведёт следующий запуск игры. */
    let told = false;
    try {
      await Promise.race([
        serverResetRequest(full).then(() => { told = true; }),
        wait(5000)
      ]);
    } catch (e) { console.warn('[sync] сервер о сбросе не узнал:', e.message); }

    await wipeLocalPet(full);
    if (told && !full) drop(LS.reset);            // всё уже сделано как надо

    setTimeout(() => location.reload(), 500);
  }

  /* Если сброс не доехал до сервера (не было сети), доводим дело до конца
     при следующем запуске — и только потом разрешаем обмен. */
  async function finishPendingReset() {
    if (!get(LS.reset)) return false;
    try {
      await ensureAccount();
      const data = await api('/api/reset', { method: 'POST', body: JSON.stringify({ full: false }) });
      if (data && data.data && data.data.gen) setGen(data.data.gen);
      drop(LS.hash);
      await resubscribePush();      // после полного сброса токен новый — подписку надо перевесить
      let res = null;
      for (let i = 0; i < 5; i++) {
        res = await pushSave(true, true);         // на сервере теперь именно новый питомец
        if (res.ok) break;
        await wait(2000);
      }
      if (!res || !res.ok) throw new Error(res ? res.msg : 'не отправилось');
      drop(LS.reset);
      console.log('[sync] сброс питомца доведён до сервера');
    } catch (e) {
      console.warn('[sync] сброс до сервера пока не дошёл:', e.message);
    }
    return true;
  }

  /* Питомца сбросили на другом устройстве. Здесь у нас на руках сохранение
     от прежней жизни — его надо стереть, иначе оно вернётся на сервер. */
  async function adoptRemoteReset(newGen) {
    if (resetting) return;
    resetting = true;
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
    setGen(newGen);
    drop(LS.hash);
    try { App.save = () => {}; } catch (e) {}
    try { App.displayPopup('питомца начали заново', App.INF); } catch (e) {}
    console.log('[sync] питомца сбросили на другом устройстве — стираем и здесь');
    await wipeLocalPet(false);
    setTimeout(() => location.reload(), 500);
  }

  /* Перевешивает уже выданную браузером подписку на текущий токен. */
  async function resubscribePush() {
    try {
      if (!('Notification' in window) || Notification.permission !== 'granted') return;
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg && await reg.pushManager.getSubscription();
      if (!sub) return;
      const j = sub.toJSON();
      await api('/api/subscribe', {
        method: 'POST',
        body: JSON.stringify({ endpoint: j.endpoint, keys: j.keys, device: deviceId() })
      });
    } catch (e) {}
  }

  /* ======================================================================
     Запуск
     ====================================================================== */
  async function ensureAccount() {
    if (token()) return true;
    const { data } = await api('/api/register', { method: 'POST' });
    if (data && data.token) { set(LS.token, data.token); setGen(data.gen || 1); return true; }
    return false;
  }

  /* Дожидаемся, пока игра действительно загрузится. Раньше запуск был просто
     «через шесть секунд»: если страница грузилась дольше (а после сброса и
     перезагрузки так и бывает), первое сохранение молча не уходило, и на
     сервере какое-то время не было вообще ничего. */
  async function waitForGame(limitMs) {
    const until = Date.now() + (limitMs || 90000);
    while (Date.now() < until) {
      if (hasApp() && App.pet && App.loadingEnded) return true;
      await wait(400);
    }
    return hasApp() && !!App.pet && !!App.loadingEnded;
  }

  async function boot() {
    if (!enabled()) return;
    if (!(await waitForGame())) { console.warn('[sync] игра так и не загрузилась'); return; }
    /* Питомца только что сбросили: с сервера сейчас брать нечего и незачем —
       там либо уже пусто, либо ещё лежит старый, которого мы стёрли. */
    if (get(LS.reset)) {
      window.__tamaPendingCatchUp = 0;
      await finishPendingReset();
      return;
    }
    /* Сначала выясняем поколение: вдруг питомца начали заново на другом
       устройстве, пока это лежало выключенным. Тогда брать здесь нечего —
       наше сохранение от прежней жизни. */
    let meta = null;
    try {
      await ensureAccount();
      meta = (await api('/api/meta')).data;
      if (meta && meta.gen) {
        const mine = genNum();
        if (!mine) setGen(meta.gen);
        else if (meta.gen !== mine) { await adoptRemoteReset(meta.gen); return; }
      }
    } catch (e) {
      console.warn('[sync] недоступна:', e.message);
    }

    if (serverSim()) {
      try { await adoptServerState(); }
      catch (e) {
        // сервер не ответил — досчитываем сами, как в обычном режиме
        const pending = window.__tamaPendingCatchUp;
        if (pending && originalCatchUp) {
          console.warn('[sync] сервер не отдал состояние, считаем сами:', e.message);
          originalCatchUp.call(App.pet, pending);
          window.__tamaPendingCatchUp = 0;
        }
      }
    }
    try {
      const data = meta || (await api('/api/meta')).data;
      if (otherIsAhead(data)) {
        const res = await pullAndApply(false);
        if (res.ok) return;
      }
      /* Первое сохранение после запуска — важное: пока его нет, сервер не знает
         о питомце вообще. Поэтому не «попробовали и забыли», а до победы. */
      for (let i = 0; i < 5; i++) {
        const res = await pushSave(true);
        if (res.ok) break;
        await wait(2000);
      }
      /* Подписка на уведомления живёт в браузере, а сервер помнит её отдельно.
         Эти два списка умеют расходиться: сменился токен, чистили базу, сбой.
         Тогда в игре написано «уведомления включены», а слать их некому.
         Поэтому при каждом запуске молча подтверждаем подписку серверу. */
      await resubscribePush();
    } catch (e) {
      console.warn('[sync] недоступна:', e.message);
    }
  }

  /* ---------- когда отправлять и когда проверять ---------- */
  /* Ставим значение по умолчанию, если его ещё нет: оно должно попасть
     в сохранение, иначе на другом устройстве окажется другая скорость. */
  function ensureSpeedSetting() {
    if (!hasApp() || !App.settings) return;
    if (typeof App.settings.offlineSpeed !== 'number') App.settings.offlineSpeed = 1;
    /* Разовый переезд на новую настройку. Раньше замедлять жизнь можно было
       только через «закрыто», и кто хотел спокойной игры — крутил её. Теперь
       для этого есть «скорость жизни», а «закрыто» осталось дополнительным
       множителем: если оставить обе, они перемножатся и питомец почти замрёт.
       Поэтому в момент появления новой настройки возвращаем «закрыто» на
       100 % — ровно один раз, дальше человек волен ставить что хочет. */
    if (typeof App.settings.lifeSpeed !== 'number') {
      App.settings.lifeSpeed = LIFE_DEFAULT;
      if (App.settings.offlineSpeed < 1) App.settings.offlineSpeed = 1;
    }
    if (typeof App.settings.simOnServer !== 'boolean') App.settings.simOnServer = true;
  }

  /* В серверном режиме офлайн-догон в браузере отключается: состояние
     приходит с сервера. Если сервер недоступен — возвращаем всё как было,
     чтобы питомец не завис во времени. */
  let originalCatchUp = null;
  function hookOfflineCatchUp() {
    if (typeof Pet === 'undefined' || !Pet.prototype) return;
    if (Pet.prototype.simulateOfflineProgression.__tamaSync) return;
    originalCatchUp = Pet.prototype.simulateOfflineProgression;
    const patched = function (elapsed) {
      if (serverSim()) { window.__tamaPendingCatchUp = elapsed; return; }
      return originalCatchUp.apply(this, arguments);
    };
    patched.__tamaSync = true;
    Pet.prototype.simulateOfflineProgression = patched;
  }

  async function adoptServerState() {
    const { data } = await api('/api/state');
    if (!data || !data.has_state || !data.stats) throw new Error('сервер ещё не считал');
    const s = App.pet.stats;
    /* НАША ПРАВКА: одноразовые отметки «это уже случилось» с сервера не гасим.
       Сервер только досчитывает показатели, сам он такие отметки никогда не
       ставит. А приглашение в школу выдаётся при загрузке игры — то есть до
       того, как мы успеваем спросить сервер, и снимок у него ещё со старым
       false. Раньше он затирал только что поднятый флаг, при следующем пуске
       игра снова считала, что питомец в школу не звали, и письмо приходило
       каждый день заново. Гасим только в одну сторону: если локально уже
       true, а с сервера пришло false — оставляем true. */
    const ONE_SHOT = ['has_received_school_invite', 'is_revived_once', 'is_potty_trained'];
    Object.keys(data.stats).forEach(k => {
      if (ONE_SHOT.indexOf(k) !== -1 && s[k] && !data.stats[k]) return;
      s[k] = data.stats[k];
    });

    // огород и животные тоже приходят с сервера
    try {
      if (Array.isArray(data.plants) && App.plants) {
        data.plants.forEach((p, i) => {
          const local = App.plants[i];
          if (!local) return;
          local.age = p.age;
          local.lastGrowthTime = p.lastGrowthTime;
          local.isWatered = !!p.watered;
        });
      }
      if (Array.isArray(data.animals) && App.animals && App.animals.list) {
        data.animals.forEach((a, i) => {
          const local = App.animals.list[i];
          if (!local || !local.stats) return;
          local.stats.current_happiness = a.happiness;
          local.lastStatsUpdate = a.lastStatsUpdate;
        });
      }
    } catch (e) { console.warn('[sync] мир применить не вышло:', e); }

    await window.idbKeyval.set('last_time', data.at || Date.now());
    window.__tamaPendingCatchUp = 0;
    console.log('[sync] состояние взято с сервера');
    return true;
  }

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
    else {
      clearBadge();
      setTimeout(() => checkRemote(true), 800);
    }
  });

  /* Кружок на иконке приложения ставит служебный процесс, когда приходит
     напоминание. Открыли игру — снимаем. */
  function clearBadge() {
    try { if (navigator.clearAppBadge) navigator.clearAppBadge(); } catch (e) {}
  }
  clearBadge();
  window.addEventListener('pagehide', () => pushSave(true));
  window.addEventListener('online', () => { pushSave(false); checkRemote(true); });

  setInterval(() => { if (document.visibilityState === 'visible') checkRemote(); }, 25000);
  setInterval(() => pushSave(false), 60000);

  /* Подстраховку вешаем сразу, не дожидаясь запуска: меню могут открыть
     раньше, чем игра догрузится. */
  (function waitIdb(tries) {
    if (hookReset() || tries > 300) return;
    setTimeout(() => waitIdb(tries + 1), 50);
  })(0);

  setTimeout(async () => {
    await waitForGame();
    ensureSpeedSetting();
    hookSave();
    boot();
  }, 2000);

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

  const SERVER_VERSION = 12;     // такую версию воркера ждёт этот клиент

  function ago(ms) {
    if (!ms) return 'никогда';
    const m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return 'только что';
    if (m < 60) return m + ' мин назад';
    const h = m / 60;
    if (h < 24) return h.toFixed(1) + ' ч назад';
    return Math.round(h / 24) + ' дн назад';
  }
  function when(at) {
    const m = Math.round((at - Date.now()) / 60000);
    if (m <= 0) return 'уже пора';
    if (m < 60) return 'через ' + m + ' мин';
    if (m < 24 * 60) return 'через ' + (m / 60).toFixed(1) + ' ч';
    return new Date(at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  async function openDiagnostics() {
    const st0 = hasApp() && App.pet && App.pet.stats;
    if (!st0) return App.displayList([{ type: 'info', name: 'питомец ещё не загрузился' }]);

    let st = null, err = null;
    try { st = (await api('/api/status')).data; } catch (e) { err = e.message; }
    const notif = await notificationState();
    const needs = collectNeeds();

    const items = [];

    /* Сначала — то, ради чего сюда и заходят: работают ли уведомления. */
    if (err) {
      items.push({ type: 'info', icon: 'triangle-exclamation', name: 'сервер недоступен: ' + err });
    } else if (!st || !st.v || st.v < SERVER_VERSION) {
      items.push({
        type: 'info', icon: 'triangle-exclamation',
        name: '<b>На Cloudflare старая версия сервера.</b> Замени код воркера на свежий и нажми Deploy, иначе уведомления работать не будут.'
      });
    } else {
      const rows = [];
      /* Главное — сколько устройств реально подписано. Без подписки сервер
         физически ничего прислать не может, и это надо говорить прямо. */
      if (!st.subs) {
        rows.push('<b>уведомления никуда не приходят: подписки нет.</b> ' +
                  'Включи их в меню «синхронизация».');
      } else {
        rows.push('уведомления включены на устройствах: <b>' + st.subs + '</b>' +
                  (notif === 'включены' ? ' (это в их числе)' : ' (но не на этом)'));
      }
      if (st.last_error) rows.push('последняя загвоздка: <b>' + st.last_error + '</b>');
      rows.push(st.cron_at
        ? 'расписание: работало ' + ago(st.cron_at)
        : '<b>расписание ни разу не запускалось</b> — проверь Cron Trigger');
      rows.push('последнее <b>доставленное</b> уведомление: ' + ago(st.last_notify));
      rows.push('доставлено за сегодня: ' + (st.notify_today || 0));
      rows.push('счёт: <b>' + (st.mode === 'server' ? 'на сервере' : 'в игре') + '</b>');
      if (st.mode === 'server') rows.push('питомец досчитан: ' + ago(st.sim_at));
      items.push({ type: 'info', icon: 'server', name: rows.join('<br>') });
    }

    items.push({ type: 'separator' });
    /* Рядом с каждой строкой — то самое число, по которому принято решение.
       Так видно, что это не выдумка: сытость 39 при пороге 40 и есть «голоден». */
    const FACT = {
      hunger:  () => 'сытость ' + Math.round(st0.current_hunger) + ' из ' + (st0.hunger_min_desire ?? 40),
      fun:     () => 'настроение ' + Math.round(st0.current_fun) + ' из ' + (st0.fun_min_desire ?? 35),
      sleep:   () => 'бодрость ' + Math.round(st0.current_sleep) + ' из ' + (st0.sleep_min_desire ?? 20),
      toilet:  () => 'пузырь ' + Math.round(st0.current_bladder) + ' из ' + Math.round((st0.max_bladder || 100) / 4),
      clean:   () => 'чистота ' + Math.round(st0.current_cleanliness) + ' из 25',
      sick:    () => 'здоровье ' + Math.round(st0.current_health) + ' из ' + Math.round((st0.max_health || 100) * 0.25),
      danger:  () => 'здоровье ' + Math.round(st0.current_health) + ' из ' + Math.round((st0.max_health || 100) * 0.1),
      poop:    () => 'какашек ' + (st0.has_poop_out || 0),
    };
    items.push(needs.length
      ? {
          type: 'info', icon: 'bell',
          name: needs.map(n => {
            const fact = FACT[n.key] ? ' <small>(' + FACT[n.key]() + ')</small>' : '';
            return n.short + ' — ' + when(n.at) + fact;
          }).join('<br>')
        }
      : { type: 'info', icon: 'bell', name: 'сейчас питомцу ничего не нужно' });

    items.push({
      type: 'info',
      name: '<small>Пока игра открыта, напоминания не приходят — ты и так всё видишь. ' +
            'Они начнут приходить через пару минут после того, как закроешь приложение.</small>'
    });

    items.push({ type: 'separator' });
    const stats = STAT_NAMES.map(([cur, max, label]) => {
      const v = Math.round((st0[cur] / (st0[max] || 100)) * 100);
      return label + ': <b>' + v + '%</b>';
    });
    stats.push('спит: <b>' + (st0.is_sleeping ? 'да' : 'нет') + '</b>');
    if (st0.has_poop_out) stats.push('какашек: <b>' + st0.has_poop_out + '</b>');
    if (st0.is_misbehaving) stats.push('<b>балуется</b>');
    items.push({ type: 'info', name: stats.join('<br>') });

    return App.displayList(items);
  }

  async function openMenu() {
    let st = null, err = null;
    try {
      if (!token()) await ensureAccount();
      st = (await api('/api/status')).data;
    } catch (e) { err = e.message; }
    const notif = await notificationState();
    const online = !err;

    const outdated = !err && (!st || !st.v || st.v < SERVER_VERSION);

    let state;
    if (err) state = 'нет связи с сервером';
    else if (outdated) state = 'на Cloudflare старая версия сервера — уведомления не работают';
    else if (!enabled()) state = 'синхронизация приостановлена';
    else if (st && !st.subs) state = 'сервер на связи, но уведомления никуда не приходят — подписки нет';
    else state = 'сервер на связи' + (st && st.has_save ? ', сохранение есть' : ', сохранения ещё нет');

    const needs = collectNeeds();
    const soon = needs[0];
    /* Событие, которое уже наступило, — это «прямо сейчас», а не время на
       часах: показывать в такой строке текущее время бессмысленно. */
    const nextText = !soon
      ? 'пока ничего не нужно'
      : (soon.at - Date.now() <= 60000
          ? 'прямо сейчас — ' + soon.short
          : when(soon.at) + ' — ' + soon.short);

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
        name: 'питомцу нужно: ' + nextText
      },
      {
        icon: 'heart-pulse',
        name: 'что с питомцем',
        onclick: () => { openDiagnostics(); return true; }
      },
      /* Видно сразу, какая версия где стоит: без этого при странном поведении
         приходится гадать, обновились ли игра и Cloudflare. */
      {
        type: 'info',
        icon: 'circle-info',
        name: 'игра ' + (typeof VERSION !== 'undefined' ? VERSION : '?') +
              ' · сервер ' + (err ? 'нет связи' : (st && st.v) || '?') +
              ' · нужен ' + SERVER_VERSION +
              ' · поколение ' + (genNum() || '—')
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
        name: 'На айфоне уведомления работают только если игра добавлена на домашний экран: кнопка "Поделиться", затем "На экран Домой". Открывать игру потом нужно оттуда.'
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

  const DROP_FROM_SETTINGS = new RegExp([
    'save data is at risk', 'сохранение под угрозой',
    'manual save', 'ручное сохранение',
    'credits', 'send feedback', 'rate us', 'see changelog', 'discord'
  ].join('|'), 'i');

  /* ---------- пункт в настройках игры ---------- */
  function menuItem() {
    return {
      icon: 'cloud',
      name: 'синхронизация',
      onclick: () => { openMenu(); return true; }
    };
  }

  function soundItem() {
    return {
      icon: 'volume-high',
      name: 'звук в тишине: ' + (soundInSilent() ? 'да' : 'нет'),
      onclick: (btn) => {
        const now = !soundInSilent();
        set(LS.sound, now ? '1' : '0');
        if (now) { audioFixed = false; fixIosAudio(); }
        else {
          try { if (navigator.audioSession) navigator.audioSession.type = 'auto'; } catch (e) {}
          if (silentAudio) { try { silentAudio.pause(); } catch (e) {} }
        }
        btn.innerHTML = (App.getIcon ? App.getIcon('volume-high', true) : '') +
                        ' звук в тишине: ' + (now ? 'да' : 'нет');
        popup(now
          ? 'Звук будет слышен, даже если телефон в беззвучном режиме'
          : 'Звук снова подчиняется переключателю на боку телефона', 3500);
        return true;
      }
    };
  }

  const SPEEDS = [
    { v: 1,    label: '100%', note: 'Жизнь в закрытой игре идёт ровно так же, как в открытой' },
    { v: 0.5,  label: '50%',  note: 'В закрытой игре вдвое спокойнее' },
    { v: 0.25, label: '25%',  note: 'Как было в оригинале Tamaweb' },
    { v: 0.1,  label: '10%',  note: 'Питомец почти не меняется, пока игра закрыта' },
  ];

  const speedLabel = v => {
    const found = SPEEDS.find(s => s.v === v);
    return found ? found.label : Math.round(v * 100) + '%';
  };

  function speedItem() {
    return {
      icon: 'gauge-high',
      name: 'закрыто: ' + speedLabel(offlineSpeed()),
      onclick: (btn) => {
        /* Текущее значение читаем прямо сейчас, а не при отрисовке меню:
           иначе каждое нажатие переключало бы на одно и то же. */
        const idx = SPEEDS.findIndex(s => s.v === offlineSpeed());
        const next = SPEEDS[((idx < 0 ? 0 : idx) + 1) % SPEEDS.length];
        App.settings.offlineSpeed = next.v;
        App.save();
        pushSave(true);
        btn.innerHTML = (App.getIcon ? App.getIcon('gauge-high', true) : '') + ' закрыто: ' + speedLabel(next.v);
        popup(next.note, 4000);
        return true;
      }
    };
  }

  /* ------------------------------------------------------------------------ */
  /* Скорость жизни. Числа в подписях — не на глаз: это измеренное время, за
     которое взрослый питомец из сытого становится голодным. У малыша всё
     примерно вдвое быстрее.                                                   */
  /* ------------------------------------------------------------------------ */
  const LIVES = [
    { v: 0.3, label: '30%',  note: 'Спокойно: взрослый просит есть примерно раз в 2 часа, спать — раз в сутки' },
    { v: 0.2, label: '20%',  note: 'Очень спокойно: есть — раз в 3 часа. Можно спокойно уехать на день' },
    { v: 1,   label: '100%', note: 'Как в оригинале Tamaweb: голодный через 35 минут, скучно через 23. Это много' },
    { v: 0.5, label: '50%',  note: 'Активно: есть — примерно раз в час' },
  ];

  const lifeLabel = v => {
    const found = LIVES.find(s => s.v === v);
    return found ? found.label : Math.round(v * 100) + '%';
  };

  function lifeItem() {
    return {
      icon: 'heart-pulse',
      name: 'скорость жизни: ' + lifeLabel(lifeSpeed()),
      onclick: (btn) => {
        const idx = LIVES.findIndex(s => s.v === lifeSpeed());
        const next = LIVES[((idx < 0 ? 0 : idx) + 1) % LIVES.length];
        App.settings.lifeSpeed = next.v;
        App.save();
        pushSave(true);
        btn.innerHTML = (App.getIcon ? App.getIcon('heart-pulse', true) : '') +
                        ' скорость жизни: ' + lifeLabel(next.v);
        popup(next.note, 5000);
        return true;
      }
    };
  }

  function modeItem() {
    return {
      icon: 'calculator',
      name: 'счёт: ' + (serverSim() ? 'на сервере' : 'в игре'),
      onclick: (btn) => {
        const now = !serverSim();
        App.settings.simOnServer = now;
        App.save();
        pushSave(true);
        btn.innerHTML = (App.getIcon ? App.getIcon('calculator', true) : '') +
                        ' счёт: ' + (now ? 'на сервере' : 'в игре');
        popup(now
          ? 'Питомец теперь живёт на сервере круглосуточно. Уведомления приходят в момент события.'
          : 'Питомец снова живёт в браузере, а сервер только предсказывает события.', 5000);
        return true;
      }
    };
  }

  /* Пункты сброса делаем своими: важен порядок действий — сначала сервер,
     потом стирание, потом перезагрузка. В исходной игре порядок другой,
     и из-за этого старый питомец возвращался обратно. */
  const RESET_PET = /reset pet data|сбросить данные питомца/i;
  const RESET_ALL = /factory reset|сброс до заводских/i;

  function resetItem(orig, full) {
    return {
      ...orig,
      onclick: () => {
        App.displayConfirm(full
          ? 'Стереть вообще всё: питомца, достижения, вещи и настройки?'
          : 'Начать заново с новым яйцом? Питомец будет стёрт и здесь, и на сервере.', [
          {
            name: full ? 'да, стереть всё' : 'да, начать заново',
            onclick: () => { doReset(full); return false; }
          },
          { name: 'отмена', class: 'back-btn', onclick: () => {} }
        ]);
        return true;
      }
    };
  }

  function inject(items) {
    /* Защита от повторной вставки: если список уже разобран нами, второй раз
       не трогаем — иначе при лишнем перерисовывании пункты задваиваются. */
    if (items.some(it => typeof it.name === 'string' && it.name === 'синхронизация')) return items;

    const copy = items
      .filter(it => !(typeof it.name === 'string' && DROP_FROM_SETTINGS.test(it.name)))
      .map(it => {
        if (typeof it.name !== 'string') return it;
        if (RESET_PET.test(it.name)) return resetItem(it, false);
        if (RESET_ALL.test(it.name)) return resetItem(it, true);
        return it;
      });
    let at = copy.findIndex(it => typeof it.name === 'string' && /save management|управление сохранени/i.test(it.name));
    if (at === -1) at = copy.findIndex(it => typeof it.name === 'string' && /manual save|сохранить вручную/i.test(it.name));
    const mine = [menuItem(), soundItem(), lifeItem(), speedItem(), modeItem()];
    /* Пункты от других наших файлов (например фотокорпус) — через общий список,
       чтобы никто больше не перехватывал displayList и не спорил за него. */
    for (const make of (window.TamaExtraMenu || [])) {
      try { const it = make(); if (it) mine.push(it); } catch (e) { console.warn('[sync] пункт меню:', e); }
    }
    copy.splice(at === -1 ? 0 : at + 1, 0, ...mine);
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
    hookOfflineCatchUp();
    if (++tries > 120) clearInterval(hookTimer);
  }, 500);
  installMenuHook();
  hookOfflineCatchUp();

  /* ---------- на случай отладки из консоли ---------- */
  window.TamaSync = {
    setServer(url) { set(LS.server, String(url || '').replace(/\/+$/, '')); set(LS.on, '1'); },
    async link(code) {
      try {
        const { data } = await api('/api/link', { method: 'POST', body: JSON.stringify({ code: String(code || '').trim() }) });
        if (data && data.token) {
          set(LS.token, data.token); set(LS.on, '1'); set(LS.hash, '');
          setGen(data.gen || 1);
          return true;
        }
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
    adopt: adoptServerState,
    needs: collectNeeds,
    diag: openDiagnostics,
    why: liveBlocker,
    audio: () => ({ включено: soundInSilent(), применено: audioFixed,
                    трек: silentAudio ? (silentAudio.paused ? 'пауза' : 'играет') : 'не создан',
                    сессия: (navigator.audioSession && navigator.audioSession.type) || 'нет такого API' }),
    active: () => lastInteraction,
    off() { set(LS.on, '0'); },
    on() { set(LS.on, '1'); }
  };
})();
