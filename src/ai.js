/* ============================================================================
   Голос питомца.

   Первый этап плана из ИИ-ПЛАН.md: питомец перестаёт бормотать случайный набор
   слов и начинает говорить осмысленно — про то, что с ним сейчас происходит,
   с учётом характера и возраста.

   ПРАВИЛО НОМЕР ОДИН: движок — истина, модель — голос. Отсюда наверх уезжает
   готовое состояние из симулятора, модель его только произносит. Ничего
   выдуманного про мир она сказать не может: и промпт это запрещает, и ответ
   проверяется кодом.

   ЭКОНОМИЯ. Питомец говорит раз в 1–5 минут. Вызов на каждую реплику съел бы
   дневной лимит за час, поэтому один запрос отдаёт пачку из полутора десятков
   реплик, а игра проигрывает их дальше сама. Пачка пересобирается, только
   когда состояние заметно поменялось: поел, проснулся, повзрослел, вернулся.

   ТИХИЙ ОТКАТ. Нет ключа, нет сети, модель промолчала, ответ не прошёл
   проверку — питомец говорит нашим русским генератором из i18n.js, как и
   раньше. Игрок ничего не замечает.

   Нового интерфейса здесь нет: речевой пузырь у игры уже свой.
   ============================================================================ */
(function () {
  'use strict';

  const hasApp = () => typeof App !== 'undefined' && !!App;
  const sync = () => (typeof TamaSync !== 'undefined' ? TamaSync : null);

  const LS_ON    = 'tama_ai_on';
  const LS_BATCH = 'tama_ai_batch';

  /* Пачку просим не чаще, чем раз в столько. Защита от того, что состояние
     дёргается туда-сюда на границе порога. */
  const MIN_GAP_MS = 4 * 60 * 1000;
  /* Пачка живёт не дольше этого, даже если ничего не менялось. */
  const MAX_AGE_MS = 45 * 60 * 1000;

  const isOn = () => {
    try { return localStorage.getItem(LS_ON) !== '0'; } catch (e) { return true; }
  };
  const setOn = (v) => { try { localStorage.setItem(LS_ON, v ? '1' : '0'); } catch (e) {} };

  /* ---------------------------------------------------------------------- */
  /* Состояние пачки                                                         */
  /* ---------------------------------------------------------------------- */
  let batch = { lines: [], groups: {}, at: 0, key: '', source: 'нет', model: null, error: null, stage: null };
  let asking = false;
  let lastAsk = 0;

  try {
    const saved = JSON.parse(localStorage.getItem(LS_BATCH) || 'null');
    if (saved && Array.isArray(saved.lines)) {
      batch = saved;
      if (!batch.groups || typeof batch.groups !== 'object') batch.groups = {};
    }
  } catch (e) {}

  const save = () => {
    try { localStorage.setItem(LS_BATCH, JSON.stringify(batch)); } catch (e) {}
  };

  /* ---------------------------------------------------------------------- */
  /* Что именно считается «состояние заметно поменялось»                     */
  /* ---------------------------------------------------------------------- */
  /* Ключ огрублён нарочно: пока питомец просто медленно голодает, ключ не
     меняется и лишних запросов нет. Он меняется на переходах через пороги —
     то есть тогда, когда питомцу и правда есть что сказать нового. */
  function stateKey() {
    if (!hasApp() || !App.pet || !App.petDefinition) return '';
    const s = App.pet.stats;
    const п = (v, порог) => (v == null ? '?' : v < порог ? '1' : '0');
    return [
      App.petDefinition.lifeStage,
      п(s.current_hunger, 40),
      п(s.current_fun, 35),
      п(s.current_sleep, 20),
      п(s.current_cleanliness, 25),
      п(s.current_health, 25),
      s.has_poop_out ? 'к' : '-',
      s.is_sleeping ? 'сон' : '-',
      (App.petDefinition.traits || []).join('.'),
      Math.floor(new Date().getHours() / 6),         // утро/день/вечер/ночь
    ].join('|');
  }

  const времяСуток = () => {
    const h = new Date().getHours();
    if (h < 6) return 'глубокая ночь';
    if (h < 12) return 'утро';
    if (h < 17) return 'день';
    if (h < 21) return 'вечер';
    return 'ночь';
  };

  /* Что с питомцем было недавно — берём у игры, не выдумываем. */
  function recent() {
    const out = [];
    try {
      const s = App.pet.stats;
      if (s.is_sleeping) out.push('ты спишь');
      if (s.current_rabbit_hole && s.current_rabbit_hole.name) {
        out.push('ты на занятии: ' + s.current_rabbit_hole.name);
      }
      if (s.is_at_parents) out.push('ты у родителей');
      if (s.is_at_vacation) out.push('ты в отпуске');
      if (s.is_misbehaving) out.push('ты балуешься');
      const d = App.petDefinition;
      if (d && d.lifeStage === 0.5) out.push('ты недавно вылупился');
    } catch (e) {}
    return out;
  }

  /* ---------------------------------------------------------------------- */
  /* Запрос пачки                                                            */
  /* ---------------------------------------------------------------------- */
  function payload() {
    const s = App.pet.stats;
    const d = App.petDefinition;
    return {
      name: d.name || 'Питомец',
      stage: d.lifeStage,
      traits: (d.traits || []).map(t => {
        /* Отправляем человеческие названия черт, а не внутренние ключи —
           модель должна понимать, о чём речь. */
        try {
          const def = App.definitions && App.definitions.traits && App.definitions.traits[t];
          return (def && (def.displayName || def.name)) || t;
        } catch (e) { return t; }
      }),
      stats: {
        hunger: Math.round(s.current_hunger),
        fun: Math.round(s.current_fun),
        sleep: Math.round(s.current_sleep),
        clean: Math.round(s.current_cleanliness),
        health: Math.round(s.current_health),
        poop: s.has_poop_out || 0,
      },
      recent: recent(),
      timeOfDay: времяСуток(),
      tz: -new Date().getTimezoneOffset(),
    };
  }

  async function ask(force) {
    if (asking || !isOn() || !hasApp() || !App.pet || !sync()) return false;
    const now = Date.now();
    if (!force && now - lastAsk < MIN_GAP_MS) return false;

    asking = true;
    lastAsk = now;
    const key = stateKey();
    try {
      const r = await sync().api('/api/lines', {
        method: 'POST', body: JSON.stringify(payload()),
      });
      const d = r && r.data;
      if (d && Array.isArray(d.lines) && d.lines.length) {
        batch = { lines: d.lines.slice(), groups: (d.groups && typeof d.groups === 'object') ? d.groups : {},
                  at: now, key,
                  source: d.source || 'модель', model: d.model || null,
                  error: d.error || null, stage: d.stage || null };
        порядки = {};
        save();
        return true;
      }
      /* Пусто — запоминаем причину для диагностики и живём на своём генераторе */
      batch = { lines: [], groups: {}, at: now, key, source: (d && d.source) || 'нет связи',
                model: null, error: (d && d.error) || null, stage: (d && d.stage) || null };
      порядки = {};
      save();
    } catch (e) {
      batch = { lines: [], groups: {}, at: now, key, source: 'нет связи', model: null,
                error: String(e && e.message || e), stage: null };
      порядки = {};
      save();
    } finally {
      asking = false;
    }
    return false;
  }

  /* Нужна ли новая пачка прямо сейчас. */
  function needsRefresh() {
    if (!isOn()) return false;
    const now = Date.now();
    if (!batch.lines.length) return now - lastAsk > MIN_GAP_MS;
    if (now - batch.at > MAX_AGE_MS) return true;
    if (batch.key !== stateKey()) return true;
    return false;
  }

  /* ---------------------------------------------------------------------- */
  /* Выдача реплики                                                          */
  /* ---------------------------------------------------------------------- */
  /* Реплики раздаём по кругу в перемешанном порядке: подряд одна и та же
     фраза выглядит поломкой, даже если пачка большая. Порядок свой у каждого
     повода — иначе редкий повод всегда выдавал бы одну и ту же реплику. */
  let порядки = {};

  function изГруппы(имя) {
    const список = имя === 'просто'
      ? (batch.lines || [])
      : ((batch.groups && batch.groups[имя]) || []);
    if (!список.length) return null;

    const метка = batch.at + ':' + список.length;
    let п = порядки[имя];
    if (!п || п.метка !== метка) {
      const idx = список.map((_, i) => i);
      for (let i = idx.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [idx[i], idx[j]] = [idx[j], idx[i]];
      }
      п = порядки[имя] = { метка, idx, при: 0 };
    }
    const s = список[п.idx[п.при % п.idx.length]];
    п.при++;
    return s || null;
  }

  const next = (имя) => изГруппы(имя || 'просто');

  /* ---------------------------------------------------------------------- */
  /* Подмена источника реплик                                                */
  /* ---------------------------------------------------------------------- */
  /* Utils.js спрашивает window.ruRandomSentence — туда i18n.js уже положил
     русский генератор. Оборачиваем его: сначала пробуем реплику от модели,
     если её нет — отдаём прежнюю выдумку. Игра ничего об этом не знает. */
  function hook() {
    if (window.ruRandomSentence && window.ruRandomSentence.__ai) return;
    const прежний = window.ruRandomSentence;
    const наш = function (isQuestion) {
      /* Выключили — значит выключили: старую пачку доигрывать нечестно. */
      if (!isOn()) return typeof прежний === 'function' ? прежний(isQuestion) : '…';
      /* Просим следующую пачку заранее, не дожидаясь, пока кончится текущая */
      if (needsRefresh()) ask(false);
      const s = next();
      if (s) return s;
      return typeof прежний === 'function' ? прежний(isQuestion) : '…';
    };
    наш.__ai = true;
    наш.__prev = прежний;
    window.ruRandomSentence = наш;
  }

  /* ---------------------------------------------------------------------- */
  /* Поводы заговорить                                                       */
  /* ---------------------------------------------------------------------- */
  /* Пузырь по таймеру — слабый канал: чтобы услышать питомца, надо сидеть и
     смотреть на пустой экран. Поэтому он отвечает на то, что ты с ним сделал.

     Смотрим за состоянием, а не перехватываем методы игры. Так реакция
     сработает независимо от того, каким путём еда попала в питомца — из
     холодильника, из подарка, из мини-игры, — и ни один наш патч не может
     сломать чужой код, которого он не трогает. */

  const ТИК = 700;                      // как часто сверяем состояние
  const ПАУЗА_ОБЩАЯ  = 8 * 1000;        // не тараторить: одна реакция за раз
  const ПАУЗА_ПОВОДА = 60 * 1000;       // один и тот же повод — не чаще
  const ЗАДЕРЖКА = 700;                 // дать анимации начаться

  let прошлое = null;
  let последняяРеакция = 0;
  const когдаПовод = {};

  /* Сколько ждать реплики после закрытия игры, чтобы считать это возвращением */
  const ДОЛГО = 3 * 60 * 60 * 1000;

  function сказать(повод, задержка) {
    if (!isOn() || !hasApp() || !App.pet) return false;
    const now = Date.now();
    if (now - последняяРеакция < ПАУЗА_ОБЩАЯ) return false;
    if (now - (когдаПовод[повод] || 0) < ПАУЗА_ПОВОДА) return false;

    const s = изГруппы(повод);
    /* Реплик на этот повод не приехало — молчим. Случайная фраза не про то
       хуже тишины: она сразу выдаёт, что за питомцем никого нет. */
    if (!s) return false;

    последняяРеакция = now;
    когдаПовод[повод] = now;
    setTimeout(() => {
      try {
        if (App.pet && !App.pet.stats.is_sleeping) App.pet.say(s, 5000);
      } catch (e) {}
    }, задержка == null ? ЗАДЕРЖКА : задержка);
    return true;
  }

  /* Снимок того, за чем следим. */
  function снимок() {
    if (!hasApp() || !App.pet || !App.petDefinition) return null;
    const s = App.pet.stats;
    return {
      hunger: s.current_hunger,
      fun:    s.current_fun,
      clean:  s.current_cleanliness,
      health: s.current_health,
      poop:   s.has_poop_out || 0,
      sleep:  !!s.is_sleeping,
      hole:   !!(s.current_rabbit_hole && s.current_rabbit_hole.name),
      stage:  App.petDefinition.lifeStage,
      praise: s.last_time_praise_given || 0,
      discip: s.current_discipline,
      misbeh: !!s.is_misbehaving,
      max:    s.max_hunger || 100,
    };
  }

  /* Что именно изменилось. Порядок проверок = приоритет: если за один тик
     случилось два события, говорим про более значимое. */
  /* Сколько показателей дёрнулось за один тик. Синхронизация с сервером и
     догон офлайн-прогресса меняют всё сразу — это не событие, это переезд,
     и радоваться «еде» тут было бы враньём. */
  function сколькоПрыгнуло(a, b) {
    let n = 0;
    for (const k of ['hunger', 'fun', 'clean', 'health']) {
      if (Math.abs((b[k] || 0) - (a[k] || 0)) > 3) n++;
    }
    return n;
  }

  function поводИзменения(a, b) {
    if (b.stage !== a.stage) return 'повзрослел';
    if (a.hole && !b.hole) return 'вернулся';
    if (a.sleep && !b.sleep) return 'проснулся';

    /* Похвала и ругань: у игры для них есть свои отметки времени и счётчик
       послушания, лезть в её методы не нужно. */
    if (b.praise > a.praise) return 'похвала';
    if (a.misbeh && !b.misbeh && b.discip > a.discip) return 'ругань';

    if (сколькоПрыгнуло(a, b) > 1) return null;

    if (b.health > a.health + 3) return 'лекарство';
    if (b.hunger > a.hunger + 3) {
      /* Уже был почти сыт, а его всё кормят — это другой разговор. */
      return a.hunger > b.max * 0.85 ? 'сыт' : 'еда';
    }
    if (b.fun > a.fun + 3) return 'игра';
    if (b.clean > a.clean + 3 || (a.poop > 0 && b.poop < a.poop)) return 'чистота';
    return null;
  }

  function следить() {
    const сейчас = снимок();
    if (!сейчас) return;
    if (!прошлое) { прошлое = сейчас; return; }

    /* Во время сценки (ест, моется, играет) состояние уже изменилось, но
       говорить рано — реплика перебьёт саму сценку. Ждём следующего тика. */
    const повод = поводИзменения(прошлое, сейчас);
    прошлое = сейчас;
    if (!повод) return;
    if (needsRefresh()) ask(false);
    сказать(повод);
  }

  /* Приветствие при запуске. «Давно» считаем по последней отметке игры о том,
     когда её видели, — её же ведёт синхронизация. */
  function поздороваться() {
    let ушёл = 0;
    try {
      const t = Number(localStorage.getItem('tama_ai_seen') || 0);
      if (t) ушёл = Date.now() - t;
    } catch (e) {}
    try { localStorage.setItem('tama_ai_seen', String(Date.now())); } catch (e) {}
    /* Первый запуск вообще — здороваться не с чем. */
    if (!ушёл) return;
    const повод = ушёл > ДОЛГО ? 'соскучился' : 'привет';
    /* Пачка могла ещё не приехать — тогда пробуем ещё раз, когда приедет.
       Здороваться через минуту после запуска глупо, поэтому попыток две. */
    if (!сказать(повод, 1500)) setTimeout(() => сказать(повод, 0), 9000);
  }

  function отмечатьУход() {
    const пометка = () => {
      try { localStorage.setItem('tama_ai_seen', String(Date.now())); } catch (e) {}
    };
    document.addEventListener('visibilitychange', () => { if (document.hidden) пометка(); });
    window.addEventListener('pagehide', пометка);
    setInterval(пометка, 60 * 1000);
  }

  /* ---------------------------------------------------------------------- */
  /* Пункт в настройках                                                      */
  /* ---------------------------------------------------------------------- */
  /* Через общий список sync.js, чтобы никто не перехватывал displayList
     во второй раз. Подробности — в «что с питомцем». */
  window.TamaExtraMenu = window.TamaExtraMenu || [];
  window.TamaExtraMenu.push(() => ({
    icon: 'comment',
    name: 'живая речь: ' + (isOn() ? 'да' : 'нет'),
    onclick: (btn) => {
      const now = !isOn();
      setOn(now);
      if (now) ask(true);
      btn.innerHTML = (hasApp() && App.getIcon ? App.getIcon('comment', true) : '') +
                      ' живая речь: ' + (now ? 'да' : 'нет');
      try {
        App.displayPopup(now
          ? 'Питомец будет говорить о том, что с ним сейчас происходит'
          : 'Питомец снова бормочет случайные фразы, как в оригинале', 4000);
      } catch (e) {}
      return true;
    }
  }));

  /* ---------------------------------------------------------------------- */
  const started = () => hasApp() && App.loadingEnded && App.pet && App.petDefinition;

  (function wait(tries) {
    if (started() && typeof window.ruRandomSentence === 'function') {
      hook();
      прошлое = снимок();
      отмечатьУход();
      setInterval(следить, ТИК);
      /* Здороваемся после того, как игра дорисовала первый кадр и закрыла
         свои стартовые окна, иначе пузырь появится под ними. */
      setTimeout(поздороваться, 3500);
      /* первую пачку просим не сразу: пусть игра догрузится и синхронизируется */
      setTimeout(() => { if (needsRefresh()) ask(true); }, 8000);
      setInterval(() => { if (needsRefresh()) ask(false); }, 60 * 1000);
      return;
    }
    if (tries > 600) return;
    setTimeout(() => wait(tries + 1), 250);
  })(0);

  window.TamaAI = {
    on:   () => { setOn(true); ask(true); },
    off:  () => { setOn(false); },
    isOn,
    ask,                                    // принудительно обновить пачку
    batch: () => JSON.parse(JSON.stringify(batch)),
    next,                                   // следующая реплика, как её увидит игра
    say: сказать,                           // сказать по поводу (для проверки)
    watch: следить,                         // один шаг наблюдателя
    snap: снимок,
    reason: поводИзменения,                 // какой повод дало изменение
    /* для тестов: снять паузы между репликами */
    _reset: () => { последняяРеакция = 0; for (const k in когдаПовод) delete когдаПовод[k]; },
    key: stateKey,
    payload: () => (started() ? payload() : null),
    /* для тестов: подсунуть пачку, не ходя на сервер */
    _set: (lines, source, groups) => {
      batch = { lines: lines.slice(), groups: groups || {}, at: Date.now(), key: stateKey(),
                source: source || 'подстановка', model: null, error: null, stage: null };
      порядки = {};
      save();
    },
  };
})();
