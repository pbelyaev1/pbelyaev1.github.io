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
  let batch = { lines: [], at: 0, key: '', source: 'нет', model: null, error: null, stage: null };
  let asking = false;
  let lastAsk = 0;

  try {
    const saved = JSON.parse(localStorage.getItem(LS_BATCH) || 'null');
    if (saved && Array.isArray(saved.lines)) batch = saved;
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
        batch = { lines: d.lines.slice(), at: now, key,
                  source: d.source || 'модель', model: d.model || null,
                  error: d.error || null, stage: d.stage || null };
        save();
        return true;
      }
      /* Пусто — запоминаем причину для диагностики и живём на своём генераторе */
      batch = { lines: [], at: now, key, source: (d && d.source) || 'нет связи',
                model: null, error: (d && d.error) || null, stage: (d && d.stage) || null };
      save();
    } catch (e) {
      batch = { lines: [], at: now, key, source: 'нет связи', model: null,
                error: String(e && e.message || e), stage: null };
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
     фраза выглядит поломкой, даже если пачка большая. */
  let порядок = [], указатель = 0, порядокДля = '';

  function next() {
    if (!batch.lines.length) return null;
    const метка = batch.at + ':' + batch.lines.length;
    if (порядокДля !== метка) {
      порядок = batch.lines.map((_, i) => i);
      for (let i = порядок.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [порядок[i], порядок[j]] = [порядок[j], порядок[i]];
      }
      указатель = 0;
      порядокДля = метка;
    }
    const s = batch.lines[порядок[указатель % порядок.length]];
    указатель++;
    return s || null;
  }

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
    key: stateKey,
    payload: () => (started() ? payload() : null),
    /* для тестов: подсунуть пачку, не ходя на сервер */
    _set: (lines, source) => {
      batch = { lines: lines.slice(), at: Date.now(), key: stateKey(),
                source: source || 'подстановка', model: null, error: null, stage: null };
      порядокДля = '';
      save();
    },
  };
})();
