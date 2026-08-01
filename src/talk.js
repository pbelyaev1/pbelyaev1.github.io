/* ============================================================================
   Разговор и память.

   Вот здесь модель наконец делает то, чего таблица не может. Реакцию на
   кормление можно написать руками — а вопрос, который питомец задаёт исходя
   из своей жизни, из твоего ответа неделю назад и из того, насколько он в
   этом возрасте вообще способен рассуждать, руками не пишется.

   ЖУРНАЛ. Всё, что с питомцем происходит, записывается строкой и уезжает на
   сервер. Записывает КЛИЕНТ из настоящего состояния — модель в журнал не
   пишет ничего, иначе он перестанет быть фактами и станет пересказом.
   Старое сжимается моделью в сводку, как человек помнит позавчерашний день
   одним предложением.

   РАЗГОВОР. Питомец говорит, ты отвечаешь выбором из вариантов, он отвечает
   на твой выбор. Клавиатуры нет и не будет — три кнопки, список, курсор.
   Всё это в игре уже написано: App.displayList рисует, App.handleShellButton
   водит по нему курсор. Мы не добавляем ни одного нового экрана.

   ПРАВИЛО НОМЕР ОДИН. Модель придумывает ТЕКСТ, движок решает ПОСЛЕДСТВИЯ.
   Вариант приезжает с пометкой намерения — тепло, быт, строго, любопытство, —
   и только по пометке игра меняет показатели. Незнакомая пометка не меняет
   ничего. Так модель не может решать игровые исходы, даже если захочет.
   ============================================================================ */
(function () {
  'use strict';

  const hasApp = () => typeof App !== 'undefined' && !!App;
  const sync   = () => (typeof TamaSync !== 'undefined' ? TamaSync : null);
  const ai     = () => (typeof TamaAI !== 'undefined' ? TamaAI : null);

  const LS_LOG  = 'tama_log_buf';     // что ещё не уехало на сервер
  const LS_LAST = 'tama_talk_last';   // когда последний раз разговаривали

  /* Разговор — событие, а не фон. Слишком часто, и он превращается в
     всплывающее окно, которое хочется закрыть не читая. */
  const ПАУЗА = 25 * 60 * 1000;
  /* Сколько журнала копим, прежде чем отправить. */
  const ПАЧКА = 6;

  const now = () => Date.now();
  const прочесть = (k, по) => { try { return JSON.parse(localStorage.getItem(k)) ?? по; } catch (e) { return по; } };
  const записать = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

  /* ====================================================================== */
  /* Журнал жизни                                                           */
  /* ====================================================================== */
  let буфер = прочесть(LS_LOG, []) || [];
  let отправляем = false;

  const времяСловами = () => {
    const h = new Date().getHours();
    if (h < 6) return 'ночью';
    if (h < 12) return 'утром';
    if (h < 17) return 'днём';
    if (h < 21) return 'вечером';
    return 'поздно вечером';
  };

  /* Строка журнала — факт, а не литература. «Утром меня покормили» пишем мы,
     а не модель: иначе через месяц питомец будет помнить то, чего не было. */
  function записьВЖурнал(текст) {
    if (!текст) return;
    буфер.push(времяСловами() + ' ' + текст);
    if (буфер.length > 200) буфер = буфер.slice(-200);   // сервер лежит — не растём вечно
    записать(LS_LOG, буфер);
    if (буфер.length >= ПАЧКА) отправитьЖурнал();
  }

  const ПО_ПОВОДУ = {
    'привет':     'хозяин заглянул ненадолго',
    'соскучился': 'хозяин долго не приходил, я успел соскучиться',
    'еда':        'меня покормили',
    'сыт':        'меня кормили, когда я уже наелся',
    'лекарство':  'мне дали лекарство',
    'игра':       'со мной играли',
    'чистота':    'меня помыли или убрали грязь',
    'похвала':    'меня похвалили',
    'ругань':     'меня отругали',
    'проснулся':  'я проснулся',
    'вернулся':   'я вернулся домой с занятия',
    'повзрослел': 'я повзрослел',
  };

  async function отправитьЖурнал(force) {
    if (отправляем || !буфер.length || !sync()) return false;
    if (!force && буфер.length < ПАЧКА) return false;
    отправляем = true;
    const ушло = буфер.slice();
    try {
      await sync().api('/api/memory', {
        method: 'POST',
        body: JSON.stringify({
          log: ушло,
          name: hasApp() && App.petDefinition ? App.petDefinition.name : null,
          bond: связь(),
          tz: -new Date().getTimezoneOffset(),
        }),
      });
      /* Убираем ровно то, что уехало: пока ходили на сервер, могло дописаться. */
      буфер = буфер.slice(ушло.length);
      записать(LS_LOG, буфер);
      return true;
    } catch (e) {
      return false;                    // полежит до следующего раза
    } finally {
      отправляем = false;
    }
  }

  /* Как у вас дела — считаем сами из поведения, не спрашиваем модель.
     Это факт про тебя, а не мнение о тебе. */
  function связь() {
    if (!hasApp() || !App.petDefinition) return null;
    const д = App.petDefinition.stats && App.petDefinition.stats.player_friendship;
    const части = [];
    if (typeof д === 'number') {
      части.push(д > 70 ? 'мы очень близки' : д > 40 ? 'мы неплохо ладим' : 'мы пока чужие');
    }
    const разговоров = прочесть('tama_talk_count', 0) || 0;
    if (разговоров > 0) части.push('мы разговаривали ' + (разговоров > 20 ? 'много раз' :
                                    разговоров > 5 ? 'уже не раз' : 'пару раз'));
    return части.length ? части.join(', ') : null;
  }

  /* ====================================================================== */
  /* Последствия выбора — их решает игра, а не модель                       */
  /* ====================================================================== */
  /* Специально без «правильного» варианта: это не тест на доброту, а три
     разных способа воспитывать. Тепло растит выразительность, строгость —
     логику, и они разводят питомца по разным веткам эволюции. */
  const ПОСЛЕДСТВИЯ = {
    'тепло': (d) => {
      d.increaseFriendship(4);
      d.stats.current_expression = (d.stats.current_expression || 0) + 1;
    },
    'быт': () => {
      const s = App.pet.stats;
      s.current_fun = Math.min(s.max_fun || 100, s.current_fun + 6);
    },
    'строго': (d) => {
      d.stats.current_discipline = Math.min(d.stats.max_discipline || 100,
                                            (d.stats.current_discipline || 0) + 3);
      d.stats.current_logic = (d.stats.current_logic || 0) + 1;
    },
    'любопытство': (d) => {
      d.stats.current_logic = (d.stats.current_logic || 0) + 1;
      d.increaseFriendship(2);
    },
  };

  function применить(намерение) {
    if (!намерение || !ПОСЛЕДСТВИЯ[намерение]) return null;   // незнакомое — ничего
    try {
      ПОСЛЕДСТВИЯ[намерение](App.petDefinition);
      return намерение;
    } catch (e) { return null; }
  }

  /* ====================================================================== */
  /* Сам разговор                                                           */
  /* ====================================================================== */
  let идёт = false;
  let ход = [];

  const занят = () => {
    if (!hasApp() || !App.pet || !App.petDefinition) return true;
    const s = App.pet.stats;
    if (s.is_egg || s.is_sleeping) return true;
    if (s.current_rabbit_hole && s.current_rabbit_hole.name) return true;
    if (App.pet.isDuringScriptedState && App.pet.isDuringScriptedState()) return true;
    /* Открыто какое-то меню — не лезем поверх него. Речевой пузырь не в счёт:
       он тоже «display», но это не меню, а слова питомца. */
    if (document.querySelector('.screen-wrapper .generic-list-container')) return true;
    return false;
  };

  const малыш = () => hasApp() && App.petDefinition && App.petDefinition.lifeStage === 0;

  async function спросить(повод) {
    const d = App.petDefinition, s = App.pet.stats;
    const { data } = await sync().api('/api/talk', {
      method: 'POST',
      body: JSON.stringify({
        name: d.name, stage: d.lifeStage,
        traits: (d.traits || []).map(t => {
          try {
            const def = App.definitions && App.definitions.traits && App.definitions.traits[t];
            return (def && (def.displayName || def.name)) || t;
          } catch (e) { return t; }
        }),
        stats: {
          hunger: Math.round(s.current_hunger), fun: Math.round(s.current_fun),
          sleep: Math.round(s.current_sleep), clean: Math.round(s.current_cleanliness),
          health: Math.round(s.current_health), poop: s.has_poop_out || 0,
        },
        timeOfDay: времяСловами(),
        'повод': повод ? (ПО_ПОВОДУ[повод] || повод) : null,
        turns: ход.slice(-6),
        tz: -new Date().getTimezoneOffset(),
      }),
    });
    return data;
  }

  /* Пузыри в игре не заменяют друг друга, а накапливаются: App.pet.say просто
     рисует ещё один. Для разговора это плохо — «…» повисло бы поверх реплики.
     Поэтому свой пузырь мы держим за руку и закрываем сами. */
  let мойПузырь = null;
  function молвить(текст, мс) {
    убратьПузырь();
    try {
      мойПузырь = App.displayMessageBubble(текст, App.petDefinition.getFullCSprite());
      const мой = мойПузырь;
      setTimeout(() => { if (мойПузырь === мой) убратьПузырь(); }, мс || 30000);
    } catch (e) { мойПузырь = null; }
  }
  function убратьПузырь() {
    if (!мойПузырь) return;
    try { мойПузырь.close(); } catch (e) {}
    мойПузырь = null;
  }

  /* Один обмен: показать реплику и варианты, дождаться выбора. */
  function показать(talk) {
    /* «…» было нужно, пока ждали сервер. Дождались — убираем, иначе оно
       висит поверх вариантов ответа. */
    убратьПузырь();
    return new Promise((resolve) => {
      let закрыт = false;
      const кончить = (v) => {
        if (закрыт) return;
        закрыт = true;
        clearInterval(сторож);
        resolve(v || null);
      };

      /* Реплику питомца кладём первой строкой списка, а не в пузырь: пузырь
         рисуется поверх и накрывает собой первый же вариант ответа. Читается
         это как переписка, и на экране в 192 точки так честнее. */
      const items = [
        { type: 'text', solid: true, name: talk.реплика },
        ...talk.варианты.map((v) => ({
          name: v.текст,
          /* Кнопка режет длинное на пятнадцатом знаке. Варианты у нас короче,
             но пусть будет запас — обрезанный на полуслове ответ выглядит
             поломкой. */
          ellipsisLength: 22,
          onclick: (btn, list) => {
            try { list.close(); } catch (e) {}
            кончить(v);
            return true;
          },
        })),
      ];

      /* Уйти можно всегда: разговор не должен запирать игрока. Кнопка «назад»
         у списка своя, её рисует сама игра. */
      const list = App.displayList(items, () => кончить(null));

      /* А если список убрали не кнопкой — закрыли всё разом, начался сон,
         игрок ушёл в другое меню, — разговор всё равно обязан кончиться.
         Обещание, которое никогда не исполнится, подвешивает всё за собой. */
      const сторож = setInterval(() => {
        if (!list || !list.isConnected) кончить(null);
      }, 500);

    });
  }

  async function начать(повод) {
    if (идёт || занят() || малыш() || !sync()) return false;
    if (ai() && !ai().isOn()) return false;

    идёт = true;
    ход = [];
    let обменов = 0;
    let вышло = false;

    try {

      const пределы = { 0.5: 2, 1: 3, 2: 4, 3: 3 };
      const предел = пределы[App.petDefinition.lifeStage] || 3;

      while (обменов < предел) {
        /* Пока сервер думает, питомец не должен выглядеть зависшим. */
        молвить('…', 15000);
        const d = await спросить(обменов === 0 ? повод : null);
        const talk = d && d.talk;
        if (!talk) {
          /* Не собралось. Молча выходим: питомец просто ничего не сказал.
             Извиняться перед игроком за чужой сервер — не наше дело. */
          break;
        }
        вышло = true;
        const выбор = await показать(talk);
        ход.push({ pet: talk.реплика, user: выбор ? выбор.текст : null });
        if (!выбор) break;                       // отошёл

        const сделали = применить(выбор.намерение);
        обменов++;

        записьВЖурнал('я сказал «' + talk.реплика + '», а хозяин ответил «' + выбор.текст + '»');
        if (сделали) {
          /* Показатели уже изменены движком — сохраняем, чтобы не потерять. */
          try { App.save(); } catch (e) {}
        }
      }
    } catch (e) {
      /* сеть отвалилась посреди разговора — тоже молча */
    } finally {
      убратьПузырь();
      идёт = false;
      if (вышло) {
        записать(LS_LAST, now());
        записать('tama_talk_count', (прочесть('tama_talk_count', 0) || 0) + 1);
        /* Разговор утомляет — как и всё остальное в этой игре. */
        try {
          const s = App.pet.stats;
          s.current_sleep = Math.max(0, s.current_sleep - (12 + Math.floor(Math.random() * 8)));
          App.save();
        } catch (e) {}
        отправитьЖурнал(true);
      }
    }
    return вышло;
  }

  /* ====================================================================== */
  /* Когда разговор случается сам                                           */
  /* ====================================================================== */
  /* Не из пункта меню: пункт меню — это переход в режим чата, и он всё
     портит. Разговор рождается из того, что только что произошло. */
  const ПОВОДЫ_К_РАЗГОВОРУ = ['соскучился', 'вернулся', 'проснулся', 'повзрослел', 'ругань', 'еда'];

  function событие(повод) {
    записьВЖурнал(ПО_ПОВОДУ[повод] || повод);
    if (!ПОВОДЫ_К_РАЗГОВОРУ.includes(повод)) return;
    if (now() - (прочесть(LS_LAST, 0) || 0) < ПАУЗА) return;
    /* Не сразу: дать питомцу договорить свою реакцию на событие. */
    setTimeout(() => { if (!занят()) начать(повод); }, 6000);
  }

  /* ====================================================================== */
  /* Подключение                                                            */
  /* ====================================================================== */
  window.TamaAIEvents = window.TamaAIEvents || [];
  window.TamaAIEvents.push(событие);

  window.TamaExtraMenu = window.TamaExtraMenu || [];
  window.TamaExtraMenu.push(() => ({
    icon: 'comments',
    name: 'поговорить',
    onclick: (btn, list) => {
      try { list.close(); } catch (e) {}
      if (малыш()) {
        App.displayPopup('Он ещё не умеет говорить. Подрастёт — научится.', 4000);
        return true;
      }
      setTimeout(() => начать(null), 400);
      return true;
    },
  }));

  /* Журнал догоняем при уходе из игры и время от времени. */
  document.addEventListener('visibilitychange', () => { if (document.hidden) отправитьЖурнал(true); });
  window.addEventListener('pagehide', () => отправитьЖурнал(true));
  setInterval(() => отправитьЖурнал(false), 3 * 60 * 1000);

  window.TamaTalk = {
    start: начать,
    log: записьВЖурнал,
    flush: () => отправитьЖурнал(true),
    buffer: () => буфер.slice(),
    busy: () => идёт,
    turns: () => ход.slice(),
    apply: применить,
    bond: связь,
    event: событие,
    /* для проверок */
    _clearPause: () => записать(LS_LAST, 0),
  };
})();
