/* ============================================================================
   Сервер для Тамагочи — Cloudflare Worker + база D1.

   Делает три вещи:
     1. Хранит полное сохранение, чтобы играть с любого устройства.
     2. Присылает уведомление, когда питомцу что-то нужно — без повторов.
     3. Посредничает к языковой модели: ключ живёт здесь, а не в браузере.

   Разворачивается через сайт Cloudflare, без терминала. Инструкция — в
   файле СЕРВЕР-КАК-ЗАПУСТИТЬ.md
   ============================================================================ */

/* Версию отдаём клиенту: если на Cloudflare остался старый код, игра об этом
   скажет прямо в меню, а не будет молча сидеть без уведомлений. */
const VERSION = 17;


const enc = new TextEncoder();

/* ============================================================================
   ГОЛОС ПИТОМЦА — реплики от языковой модели.

   ПРАВИЛО НОМЕР ОДИН: движок — истина, модель — голос.
   Сюда приходит готовое состояние из симулятора. Модель ничего не решает и
   ничего не выдумывает про мир — она только произносит то, что уже правда.
   Всё, что она вернула, проходит проверку кодом, а не доверием к промпту.

   Экономия. Питомец болтает раз в 1–5 минут, вызов на каждую реплику не
   потянуть: на бесплатных моделях OpenRouter 50 запросов в сутки. Поэтому
   один вызов отдаёт сразу пачку реплик, а игра проигрывает их следующие
   полчаса. Пачка пересобирается, когда состояние заметно поменялось.

   Три уровня. Не ответила выбранная модель — пробуем следующую из списка.
   Не ответил никто — возвращаем пусто, и игра говорит своим генератором.
   Молча: разговор не должен ломаться из-за чужого сервера.

   Живёт в этом же файле нарочно: воркер разворачивается вставкой одного
   файла в редактор Cloudflare, второй файл туда просто негде положить.
   Лишние export'ы Cloudflare не мешают — их читают только тесты.
   ============================================================================ */

/* Списки бесплатных моделей меняются каждый месяц — это список с перебором,
   а не одна модель. Порядок: сначала те, что умеют структурированный вывод.
   Проверять актуальность: https://openrouter.ai/models?max_price=0          */
export const MODELS = [
  'poolside/laguna-xs-2.1:free',      // самая мелкая, значит самая быстрая
  'tencent/hy3:free',
  'cohere/north-mini-code:free',      // не рассуждает вовсе, хорошо держит JSON
  'nvidia/nemotron-3-ultra-550b-a55b:free',   // умная, но медленная — в конец
];

/* Сколько ждём модель, прежде чем перейти к следующей. Разговор, в котором
   ждёшь минуту перед каждой репликой, — не разговор. Лучше быстрая и глупее,
   чем умная и через две минуты. */
export const TIMEOUT_MS = 22000;

/* Сколько слов разрешено на реплику. Малыша здесь нет намеренно: он ещё не
   говорит, ему модель не нужна вообще. */
export const LIMITS = {
  child:  { words: 5,  chars: 40 },
  teen:   { words: 9,  chars: 70 },
  adult:  { words: 14, chars: 100 },
  elder:  { words: 14, chars: 100 },
};

export const STAGE_NAMES = { 0: 'baby', 0.5: 'child', 1: 'teen', 2: 'adult', 3: 'elder' };

/* Заготовки для малыша: он не разговаривает, и это не ограничение, а правда. */
export const BABY_SOUNDS = [
  'ня', 'пи', 'мя', 'ай', 'ух', 'ням', 'бу', 'ой', 'э-э', 'ва',
  'пи-пи', 'ня-ня', 'ам', 'уу', 'ко', 'ба', 'мм', 'иии',
];

/* ---------------------------------------------------------------------- */
/* Проверка ответа. Всё, что не прошло, выбрасывается молча.               */
/* ---------------------------------------------------------------------- */
export function cleanLine(raw, limit) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();

  // разметка, кавычки, списки, эмодзи-мусор по краям
  s = s.replace(/^[-*•—\d.)\s]+/, '').replace(/[*_`#>]/g, '').trim();
  s = s.replace(/^["«'']+|["»'']+$/g, '').trim();
  if (!s) return null;

  // латиница и ссылки: модель сбилась на другой язык
  if (/[a-zA-Z]/.test(s)) return null;
  if (/https?:|www\./i.test(s)) return null;

  /* Цифры запрещены. Модель не знает настоящих чисел игры, а выдуманное
     «я не ел 5 часов» — это ровно то враньё, от которого мы ушли. */
  if (/\d/.test(s)) return null;

  // должно быть по-русски
  if (!/[а-яё]/i.test(s)) return null;

  // одна фраза, без диалогов и переносов
  s = s.split('\n')[0].trim();
  if (/[:]\s*$/.test(s)) return null;

  const words = s.split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  if (words.length > limit.words) return null;
  if (s.length > limit.chars) return null;

  return s;
}

export function cleanBatch(list, stage) {
  const limit = LIMITS[stage] || LIMITS.adult;
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const s = cleanLine(raw, limit);
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

/* ---------------------------------------------------------------------- */
/* Промпт. Всё фактическое приходит сюда готовым.                          */
/* ---------------------------------------------------------------------- */
const MOOD = (s) => {
  const bad = [];
  if (s.hunger != null && s.hunger < 40) bad.push('голоден');
  if (s.fun != null && s.fun < 35) bad.push('скучно');
  if (s.sleep != null && s.sleep < 20) bad.push('хочет спать');
  if (s.clean != null && s.clean < 25) bad.push('грязно вокруг');
  if (s.health != null && s.health < 25) bad.push('нездоровится');
  if (s.poop) bad.push('рядом лежит какашка');
  return bad;
};

const STAGE_VOICE = {
  child: 'Ты маленький ребёнок. Говори простыми словами, не больше пяти слов во фразе. Можешь ошибаться в словах.',
  teen:  'Ты подросток. Целые короткие фразы, у тебя есть своё мнение, иногда ворчишь.',
  adult: 'Ты взрослый. Говоришь спокойно и по-своему, короткими фразами.',
  elder: 'Ты старый и мудрый. Говоришь неспешно, часто вспоминаешь прошлое.',
};

/* ------------------------------------------------------------------------ */
/* Поводы заговорить.

   Пузырь по таймеру — плохой канал: чтобы услышать питомца, надо сидеть и
   смотреть на пустой экран. Поэтому реплики просим сразу пачками по поводам,
   а игра достаёт нужную пачку в момент события — мгновенно, без запроса.

   Ключ — то, что игра умеет распознать по изменению состояния. Описание —
   то, что уходит в промпт. Порядок важен: он же порядок в промпте.          */
export const GROUPS = [
  ['просто',     'просто так, сам с собой, ничего особенного не произошло'],
  ['привет',     'хозяин только что вернулся, его не было недолго'],
  ['соскучился', 'хозяин вернулся после долгого отсутствия, ты успел соскучиться'],
  ['еда',        'тебя только что покормили, было вкусно'],
  ['сыт',        'тебя покормили, но ты уже наелся и больше не лезет'],
  ['лекарство',  'тебе дали лекарство и стало легче'],
  ['игра',       'с тобой только что поиграли, было весело'],
  ['чистота',    'тебя помыли или убрали грязь вокруг, стало чисто'],
  ['похвала',    'тебя только что похвалили'],
  ['ругань',     'тебя только что отругали, ты виноват'],
  ['проснулся',  'ты только что проснулся'],
  ['вернулся',   'ты вернулся домой с занятия'],
  ['повзрослел', 'ты только что повзрослел и стал другим'],
];

/* Сколько реплик просим на повод и сколько считаем достаточным. Меньше двух
   в группе — повод просто молчит: одна и та же фраза каждый раз хуже тишины. */
const PER_GROUP = 3;
const MIN_GROUP = 2;
const AMBIENT   = 8;

export function buildPrompt(ctx) {
  const stage = ctx.stage || 'adult';
  const limit = LIMITS[stage] || LIMITS.adult;
  const плохо = MOOD(ctx.stats || {});
  const черты = (ctx.traits || []).slice(0, 4);

  const строки = [
    `Тебя зовут ${ctx.name || 'Питомец'}. Ты — виртуальный питомец, живое существо в маленькой игре.`,
    STAGE_VOICE[stage] || STAGE_VOICE.adult,
  ];
  if (черты.length) строки.push(`Твой характер: ${черты.join(', ')}.`);
  строки.push(плохо.length
    ? `Сейчас с тобой вот что: ${плохо.join(', ')}.`
    : 'Сейчас тебе хорошо: сыт, отдохнул, вокруг чисто.');
  if (ctx.recent && ctx.recent.length) строки.push(`Недавно с тобой было: ${ctx.recent.join('; ')}.`);
  if (ctx.timeOfDay) строки.push(`Сейчас ${ctx.timeOfDay}.`);

  строки.push(
    '',
    'Придумай реплики, которые ты говоришь вслух в разных случаях.',
    `Для случая "просто" придумай ${ctx.ambient || AMBIENT} реплик, для каждого остального — ${PER_GROUP}.`,
    '',
    'Случаи:'
  );
  for (const [ключ, описание] of GROUPS) {
    строки.push(`— "${ключ}": ${описание};`);
  }

  строки.push(
    '',
    'Правила:',
    `— каждая реплика не длиннее ${limit.words} слов;`,
    '— только по-русски, без латиницы;',
    '— НИКАКИХ цифр и чисел;',
    '— не обращайся к хозяину по имени, ты его не знаешь;',
    '— не выдумывай событий, которых нет в описании случая;',
    '— без кавычек, без списков, без разметки;',
    '— реплики разные по настроению, не повторяйся;',
    '— реплика должна подходить своему случаю и никакому другому.',
    '',
    'Ответь строго объектом JSON, где ключ — название случая, а значение —',
    'массив строк. Например: {"просто": ["...", "..."], "еда": ["...", "..."]}.',
    'Никакого текста кроме этого объекта.'
  );
  return строки.join('\n');
}

/* Разбор ответа по группам. Группа, из которой почти ничего не выжило, просто
   исчезает — и тогда игра на этот повод молчит. Молчание честнее, чем реплика
   не про то. */
export function cleanGroups(obj, stage) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  const занято = new Set();
  for (const [ключ] of GROUPS) {
    const списком = cleanBatch(obj[ключ], stage);
    /* Одну и ту же фразу в двух группах держать незачем: модель любит
       повторять «ура» и «спасибо» везде, а игрок это замечает сразу. */
    const свои = списком.filter(s => !занято.has(s.toLowerCase()));
    const хватит = ключ === 'просто' ? 4 : MIN_GROUP;
    if (свои.length >= хватит) {
      out[ключ] = свои;
      for (const s of свои) занято.add(s.toLowerCase());
    }
  }
  return out;
}

/* ---------------------------------------------------------------------- */
/* Вызов модели                                                            */
/* ---------------------------------------------------------------------- */
function extractJson(text) {
  if (!text) return null;
  // модели-рассуждатели любят обрамлять ответ; вырезаем первый объект
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (e) { return null; }
}

/* Один вызов модели с перебором списка. Возвращает разобранный JSON или
   причину, по которой не вышло. Всё, что выше по стеку, только решает, что с
   этим JSON делать. */
export async function callModel(env, prompt, deps = {}) {
  const doFetch = deps.fetch || fetch;
  const models = deps.models || MODELS;
  const key = env.OPENROUTER_KEY;
  if (!key) return { obj: null, model: null, source: 'нет ключа', left: null };

  let lastError = null;
  let left = null;
  const ждать = deps.timeout || TIMEOUT_MS;
  /* Общий срок на весь перебор. Без него четыре задумчивые модели подряд
     держат игрока минуты — а он в это время смотрит на пузырь и решает,
     что игра сломалась. */
  const срок = Date.now() + (deps.deadline || ждать * 2);

  for (const model of models) {
    if (Date.now() > срок) {
      lastError = lastError || 'никто не успел ответить вовремя';
      break;
    }
    /* Обрываем сами: без этого одна задумчивая модель держит игрока в
       ожидании столько, сколько ей вздумается. */
    const стоп = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const будильник = стоп ? setTimeout(() => стоп.abort(), ждать) : null;
    const начали = Date.now();
    try {
      const r = await doFetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        signal: стоп ? стоп.signal : undefined,
        headers: {
          'authorization': 'Bearer ' + key,
          'content-type': 'application/json',
          'x-title': 'Tamaweb pet',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: deps.maxTokens || 2000,
          temperature: deps.temperature == null ? 0.85 : deps.temperature,
          response_format: { type: 'json_object' },
          /* Рассуждать вслух модели тут незачем: это стоит десятков секунд
             ожидания на ровном месте. Модели без рассуждений поле игнорируют. */
          reasoning: { effort: 'none' },
        }),
      });

      /* Сколько бесплатных запросов осталось — знает только OpenRouter, и
         только он говорит правду: лимит зависит от того, пополнял ли ты
         когда-нибудь счёт. Если заголовка нет, врать не будем. */
      const остаток = Number(r.headers && r.headers.get &&
                             r.headers.get('x-ratelimit-remaining'));
      if (Number.isFinite(остаток)) left = остаток;

      if (!r.ok) {
        lastError = 'модель ' + model.split('/').pop() + ' ответила ' + r.status;
        continue;
      }
      const data = await r.json();
      const text = data && data.choices && data.choices[0] &&
                   data.choices[0].message && data.choices[0].message.content;
      const obj = extractJson(typeof text === 'string' ? text : '');
      if (obj) return { obj, model, source: 'модель', left, ms: Date.now() - начали };
      lastError = 'модель ' + model.split('/').pop() + ': ответ не разобрался';
    } catch (e) {
      const имя = model.split('/').pop();
      lastError = (e && (e.name === 'AbortError' || /abort/i.test(String(e.message))))
        ? 'модель ' + имя + ' думала дольше ' + Math.round(ждать / 1000) + ' секунд'
        : 'модель ' + имя + ': ' + (e && e.message ? e.message : 'сбой');
    } finally {
      if (будильник) clearTimeout(будильник);
    }
  }
  return { obj: null, model: null, source: 'не ответила', error: lastError, left };
}

export async function askModel(env, ctx, deps = {}) {
  const key = env.OPENROUTER_KEY;
  if (!key) return { lines: [], groups: {}, source: 'нет ключа', model: null };

  const models = deps.models || MODELS;
  const prompt = buildPrompt(ctx);
  let lastError = null;
  let left = null;

  /* Перебор здесь свой, а не в callModel: годность ответа решается по составу
     поводов, и модель, вернувшая разобравшийся, но пустой JSON, нам не подошла. */
  for (const model of models) {
    const r = await callModel(env, prompt, { ...deps, models: [model] });
    if (r.left != null) left = r.left;
    if (!r.obj) { lastError = r.error || lastError; continue; }

    const groups = cleanGroups(r.obj, ctx.stage);
    /* Годным считаем ответ, где есть фоновая болтовня и хотя бы половина
       поводов. Часть поводов может не приехать — это не беда, они молчат. */
    const поводов = Object.keys(groups).length;
    if (groups['просто'] && поводов >= Math.ceil(GROUPS.length / 2)) {
      return { lines: groups['просто'], groups, source: 'модель', model, left, ms: r.ms };
    }
    lastError = 'модель ' + model.split('/').pop() + ': годных поводов ' + поводов +
                ' из ' + GROUPS.length;
  }
  return { lines: [], groups: {}, source: 'не ответила', model: null, error: lastError, left };
}

/* ========================================================================
   РАЗГОВОР

   Здесь начинается то, ради чего вообще нужна модель. Реакцию на кормление
   можно написать руками — а вот вопрос, который питомец задаёт исходя из
   своей жизни, твоего ответа неделю назад и того, насколько он в этом
   возрасте вообще способен рассуждать, руками не пишется.

   ПРАВИЛО НОМЕР ОДИН остаётся: модель придумывает ТЕКСТ, движок решает
   ПОСЛЕДСТВИЯ. Вариант ответа приезжает с пометкой намерения — тепло, быт,
   строго, — и только по пометке игра меняет показатели. Незнакомая пометка
   не меняет ничего.
   ======================================================================== */

/* Сколько вариантов ответа даём на каждой стадии. Малыш не разговаривает
   вовсе: он не понимает, и предлагать ему сложное было бы враньём. */
export const TALK_CHOICES = { baby: 0, child: 2, teen: 3, adult: 4, elder: 4 };

/* Сколько обменов держится разговор. Дальше питомец отвлекается — так же,
   как отвлекается ребёнок. */
export const TALK_TURNS = { child: 2, teen: 3, adult: 4, elder: 3 };

/* Во втором обмене вариантов всегда два. Дерево четыре-на-четыре модель пишет
   вдвое дольше, а на экране разницы никакой: всё равно выбираешь один. */
export const NEXT_CHOICES = 2;

/* Намерения, которые движок понимает. Всё остальное игнорируется. */
export const INTENTS = ['тепло', 'быт', 'строго', 'любопытство'];

/* Как питомец соображает в этом возрасте. Это не про длину фразы — про то,
   что он способен связать с чем. */
const MIND = {
  child: [
    'Ты рассуждаешь как маленький ребёнок: путаешь причину и следствие,',
    'делаешь неверные, но связные выводы и держишься за них.',
    'Ты можешь неправильно запомнить то, что тебе сказали.',
    'Ты спрашиваешь про простое и близкое: еда, игра, кто где был.',
  ].join(' '),
  teen: [
    'Ты рассуждаешь как подросток: выводы делаешь верные, но резкие.',
    'У тебя есть своё мнение, ты можешь не согласиться и поспорить.',
    'Ты спрашиваешь про то, что тебя задевает, и обижаешься, если отмахнуться.',
  ].join(' '),
  adult: [
    'Ты рассуждаешь как взрослый: связываешь события между собой,',
    'помнишь точно и замечаешь, если одно противоречит другому.',
    'Ты спрашиваешь по делу и можешь предложить помощь.',
  ].join(' '),
  elder: [
    'Ты рассуждаешь как старик: спокойно, неторопливо, часто через прошлое.',
    'Ты замечаешь то, что повторяется из раза в раз, и говоришь об этом.',
  ].join(' '),
};

/* Что показываем модели из памяти. Журнал режем: старое уже сжато в сводку. */
const LOG_SHOWN = 14;

function памятьВПромпт(mem) {
  const строки = [];
  if (mem && mem.story) строки.push('Что было раньше в твоей жизни: ' + mem.story);
  const журнал = Array.isArray(mem && mem.log) ? mem.log.slice(-LOG_SHOWN) : [];
  if (журнал.length) {
    строки.push('Что было недавно, от старого к свежему:');
    for (const e of журнал) строки.push('— ' + e);
  }
  const факты = Array.isArray(mem && mem.facts) ? mem.facts.slice(-20) : [];
  if (факты.length) {
    строки.push('Что ты знаешь про хозяина:');
    for (const f of факты) строки.push('— ' + f);
  }
  if (mem && mem.bond) строки.push('Как у вас дела: ' + mem.bond);
  return строки;
}

export function buildTalkPrompt(ctx) {
  const stage = ctx.stage || 'adult';
  const limit = LIMITS[stage] || LIMITS.adult;
  const сколько = TALK_CHOICES[stage] || 3;
  const плохо = MOOD(ctx.stats || {});
  const черты = (ctx.traits || []).slice(0, 4);

  const строки = [
    `Тебя зовут ${ctx.name || 'Питомец'}. Ты — виртуальный питомец, живое существо в маленькой игре.`,
    'Ты разговариваешь со своим хозяином — человеком, который за тобой ухаживает.',
    MIND[stage] || MIND.adult,
  ];
  if (черты.length) строки.push(`Твой характер: ${черты.join(', ')}.`);
  строки.push(плохо.length
    ? `Сейчас с тобой вот что: ${плохо.join(', ')}.`
    : 'Сейчас тебе хорошо: сыт, отдохнул, вокруг чисто.');
  if (ctx.timeOfDay) строки.push(`Сейчас ${ctx.timeOfDay}.`);
  if (ctx['повод']) строки.push(`Только что произошло вот что: ${ctx['повод']}.`);

  const память = памятьВПромпт(ctx.memory);
  if (память.length) {
    строки.push(...память);
  } else {
    /* Пустая память — самая частая причина бессвязицы: модели не за что
       зацепиться, и она выдумывает. Скажем ей прямо, что говорить не о чем. */
    строки.push(
      'Ты пока ничего не помните друг о друге: вы только знакомитесь.',
      'Поэтому спроси что-нибудь простое и понятное про самого хозяина или про себя.'
    );
  }

  строки.push(
    '',
    'Придумай короткий разговор на два обмена.',
    '',
    'Как он устроен:',
    '1. Ты говоришь одну фразу. Это либо вопрос хозяину, либо рассказ о себе.',
    `2. Хозяин выбирает один из ${сколько} ответов, которые ты тоже придумываешь.`,
    '3. Ты отвечаешь на каждый из этих ответов — по-своему на каждый.',
    `4. Хозяин снова выбирает, теперь из ${NEXT_CHOICES} ответов.`,
    '',
    'Последняя твоя фраза — не пустое поддакивание. Скажи, что ты из этого',
    'понял, что почувствовал или что решил. Разговор должен чем-то кончаться.',
    '',
    'Главное правило: варианты должны быть ответами ИМЕННО на твою фразу.',
    'Прочитай свою фразу и проверь: подходит ли каждый вариант как ответ на неё?',
    'Если спрашиваешь «где ты был» — варианты про то, где он был, а не про еду.',
    'Если рассказываешь о себе — варианты про то, что хозяин на это скажет.',
    'Пусть по варианту сразу понятно, отвечает хозяин про себя или про тебя.',
    '',
    'Правила:',
    `— твоя фраза не длиннее ${limit.words} слов и понятна сама по себе;`,
    `— вариантов ровно ${сколько};`,
    '— вариант ответа очень короткий: не больше четырёх слов и двадцати знаков;',
    '— варианты разные по духу, и среди них нет очевидно правильного;',
    `— у каждого варианта есть намерение — одно из: ${INTENTS.join(', ')};`,
    '— только по-русски, без латиницы;',
    '— НИКАКИХ цифр и чисел;',
    '— не выдумывай событий, которых нет выше;',
    '— не называй хозяина по имени, ты его не знаешь;',
    '— без кавычек, без разметки.',
    '',
    'Если из ответа хозяина ты узнаёшь про него что-то стоящее, добавь этому',
    'варианту поле "запомнить" — одна короткая фраза от твоего лица. Нечего',
    'запоминать — поля не добавляй.',
    '',
    'Ответь строго объектом JSON вот такого вида и ничем больше:',
    '{',
    '  "реплика": "твоя первая фраза",',
    '  "варианты": [',
    '    {',
    '      "текст": "ответ хозяина",',
    '      "намерение": "тепло",',
    '      "запомнить": "что ты из этого понял про хозяина",',
    '      "ответ": "что ты говоришь в ответ именно на это",',
    '      "дальше": [',
    '        { "текст": "ответ хозяина", "намерение": "быт" }',
    '      ]',
    '    }',
    '  ]',
    '}'
  );
  return строки.join('\n');
}

/* Вариант ответа хозяина — это кнопка на экране в 192 точки. Всё, что длиннее,
   она обрежет на полуслове, и это выглядит как поломка игры. */
const ВАРИАНТ = { words: 4, chars: 22 };

function чиститьВарианты(сырые, нужно, глубже) {
  if (!Array.isArray(сырые)) return [];
  const out = [];
  const занято = new Set();
  for (const v of сырые) {
    if (!v || typeof v !== 'object') continue;
    const текст = cleanLine(v['текст'] || v.text, ВАРИАНТ);
    if (!текст) continue;
    const k = текст.toLowerCase();
    if (занято.has(k)) continue;
    занято.add(k);

    const намерение = String(v['намерение'] || v.intent || '').trim().toLowerCase();
    /* Незнакомое намерение не отбрасывает вариант — просто он ничего не
       меняет в показателях. Молчаливое «ничего» честнее выдуманного «тепло». */
    const item = { текст, намерение: INTENTS.includes(намерение) ? намерение : null };

    const запомнить = v['запомнить'] || v.remember;
    if (запомнить) {
      const f = cleanLine(запомнить, { words: 12, chars: 90 });
      if (f) item['запомнить'] = f;
    }

    if (глубже) {
      /* Ответ питомца на этот выбор и следующие варианты — они уже приехали,
         поэтому второй обмен пойдёт мгновенно, без похода на сервер. */
      const ответ = cleanLine(v['ответ'] || v.reply, глубже.limit);
      if (ответ) {
        item['ответ'] = ответ;
        const дальше = чиститьВарианты(v['дальше'] || v.next, глубже.нужно, null);
        if (дальше.length >= 2) item['дальше'] = дальше.slice(0, глубже.нужно);
      }
    }
    out.push(item);
  }
  return out.slice(0, нужно);
}

/* Приёмка ответа. Всё, что не прошло, — не разговор. Здесь нельзя быть
   мягким: кривой вариант на экране выглядит как поломка игры. */
export function cleanTalk(obj, stage) {
  const limit = LIMITS[stage] || LIMITS.adult;
  const нужно = TALK_CHOICES[stage] || 3;
  if (!obj || typeof obj !== 'object') return null;

  const реплика = cleanLine(obj['реплика'] || obj.line, limit);
  if (!реплика) return null;

  const варианты = чиститьВарианты(obj['варианты'] || obj.options, нужно,
                                   { limit, 'нужно': NEXT_CHOICES });
  if (варианты.length < Math.min(2, нужно)) return null;

  return { реплика, варианты };
}

export async function askTalk(env, ctx, deps = {}) {
  const stage = ctx.stage || 'adult';
  if (stage === 'baby') return { talk: null, source: 'малыш', model: null };
  if (!env.OPENROUTER_KEY) return { talk: null, source: 'нет ключа', model: null };

  const models = deps.models || MODELS;
  const prompt = buildTalkPrompt(ctx);
  let lastError = null, left = null;
  const срок = Date.now() + 40000;

  for (const model of models) {
    if (Date.now() > срок) { lastError = lastError || 'никто не успел ответить вовремя'; break; }
    /* Разговор ждут глядя в экран, поэтому срок жёстче, чем для реплик. */
    const r = await callModel(env, prompt, { ...deps, models: [model],
                                             maxTokens: 1400, timeout: 18000 });
    if (r.left != null) left = r.left;
    if (!r.obj) { lastError = r.error || lastError; continue; }
    const talk = cleanTalk(r.obj, stage);
    if (talk) return { talk, source: 'модель', model, left, ms: r.ms };
    lastError = 'модель ' + model.split('/').pop() + ': разговор не собрался';
  }
  return { talk: null, source: 'не ответила', model: null, error: lastError, left };
}

/* ------------------------------------------------------------------------ */
/* Память                                                                    */
/* ------------------------------------------------------------------------ */
/* Журнал растёт, а в промпт всё не влезет и влезать не должно. Поэтому:
   свежее держим как есть, старое отдаём модели и просим сжать в несколько
   строк — так же, как человек помнит позавчерашний день одним предложением. */
export const LOG_KEEP = 40;      // сколько событий держим сырыми
export const LOG_SQUEEZE = 60;   // с какого размера начинаем сжимать
export const FACTS_KEEP = 40;

export function cleanFacts(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const s = cleanLine(raw, { words: 12, chars: 90 });
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out.slice(-FACTS_KEEP);
}

/* Событие журнала — строка, которую собрал КЛИЕНТ из настоящего состояния.
   Модель сюда ничего не пишет: это факты, а не пересказ. */
export function cleanLog(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    if (typeof raw !== 'string') continue;
    const s = raw.trim().slice(0, 120);
    if (!s) continue;
    if (/[a-zA-Z]/.test(s) && !/[а-яё]/i.test(s)) continue;
    out.push(s);
  }
  return out;
}

export async function squeezeLog(env, mem, ctx, deps = {}) {
  const журнал = Array.isArray(mem.log) ? mem.log : [];
  if (журнал.length < LOG_SQUEEZE) return mem;

  const старое = журнал.slice(0, журнал.length - LOG_KEEP);
  const свежее = журнал.slice(журнал.length - LOG_KEEP);

  const prompt = [
    `Ты — виртуальный питомец по имени ${ctx.name || 'Питомец'}. Ты вспоминаешь свою жизнь.`,
    mem.story ? 'Раньше ты помнил вот что: ' + mem.story : '',
    '',
    'А вот что было потом, по порядку:',
    ...старое.map(e => '— ' + e),
    '',
    'Перескажи всё это одним куском в три-четыре предложения, от своего лица,',
    'как ты сам это помнишь. Оставь то, что повторялось и что было важным,',
    'мелочи выбрось. Только по-русски, без цифр, без списков.',
    '',
    'Ответь строго объектом JSON вида {"память": "..."} и ничем больше.',
  ].filter(Boolean).join('\n');

  const r = await callModel(env, prompt, { ...deps, maxTokens: 500, temperature: 0.6 });
  const сжато = r.obj && typeof r.obj['память'] === 'string' ? r.obj['память'].trim() : null;

  /* Не сжалось — журнал всё равно подрезаем, иначе он будет расти вечно.
     Лучше забыть, чем возить с собой мегабайт. */
  return {
    ...mem,
    story: (сжато && !/[a-zA-Z]{3}/.test(сжато)) ? сжато.slice(0, 900) : (mem.story || null),
    log: свежее,
  };
}

/* ---------------------------------------------------------------------- */
/* Учёт расхода. Врать про потраченные вызовы нельзя — их видно в игре.     */
/* ---------------------------------------------------------------------- */
/* Загвоздку держим здесь же, а не в pets.last_error: там живут беды доставки
   уведомлений, и смешивать их с бедами модели — значит врать в диагностике. */
export async function bumpUsage(env, day, ok, error, left, ms, model) {
  try {
    const row = await env.DB.prepare('SELECT v FROM kv WHERE k = ?').bind('ai_usage').first();
    let u = { day: '', calls: 0, fails: 0, err: null, err_at: null, ms: null, model: null };
    if (row && row.v) { try { u = JSON.parse(row.v); } catch (e) {} }
    if (u.day !== day) u = { day, calls: 0, fails: 0, err: u.err || null, err_at: u.err_at || null };
    u.calls += 1;
    if (!ok) u.fails += 1;
    if (error) { u.err = String(error); u.err_at = Date.now(); }
    else if (ok) { u.err = null; u.err_at = null; }
    if (Number.isFinite(left)) u.left = left;
    if (Number.isFinite(ms)) { u.ms = ms; u.model = model || u.model || null; }
    await env.DB.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .bind('ai_usage', JSON.stringify(u)).run();
    return u;
  } catch (e) { return null; }
}

export async function readUsage(env) {
  try {
    const row = await env.DB.prepare('SELECT v FROM kv WHERE k = ?').bind('ai_usage').first();
    if (row && row.v) return JSON.parse(row.v);
  } catch (e) {}
  return { day: '', calls: 0, fails: 0, err: null, err_at: null };
}

/* ---------- мелкие утилиты ---------- */
const b64u = {
  dec(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
           return Uint8Array.from(atob(s), c => c.charCodeAt(0)); },
  enc(b) { let s = ''; for (const x of new Uint8Array(b)) s += String.fromCharCode(x);
           return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
};
const cat = (...a) => { const n = a.reduce((s, x) => s + x.length, 0), o = new Uint8Array(n);
                        let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type,authorization',
  'access-control-allow-methods': 'GET,PUT,POST,OPTIONS'
};
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json', ...cors }
});
const rnd = (n) => b64u.enc(crypto.getRandomValues(new Uint8Array(n)));
const parse = (s, fallback) => { try { return JSON.parse(s); } catch (e) { return fallback; } };

/* ---------- самообновление базы ----------
   Новые колонки добавляются на лету, чтобы не лазить в консоль D1 руками.
   Если колонка уже есть — SQLite ругается, и это нормально.              */
let migrated = false;
async function migrate(env) {
  if (migrated) return;
  const columns = [
    'ALTER TABLE pets ADD COLUMN needs TEXT',
    'ALTER TABLE pets ADD COLUMN notified TEXT',
    'ALTER TABLE pets ADD COLUMN last_seen INTEGER',
    'ALTER TABLE pets ADD COLUMN last_writer TEXT',
    'ALTER TABLE pets ADD COLUMN hash TEXT',
    'ALTER TABLE pets ADD COLUMN last_active INTEGER',
    'ALTER TABLE pets ADD COLUMN last_notify INTEGER',
    'ALTER TABLE pets ADD COLUMN tz INTEGER',
    'ALTER TABLE pets ADD COLUMN notify_day TEXT',
    'ALTER TABLE pets ADD COLUMN notify_count INTEGER',
    'ALTER TABLE pets ADD COLUMN mode TEXT',
    'ALTER TABLE pets ADD COLUMN sim TEXT',
    'ALTER TABLE pets ADD COLUMN gen INTEGER',
    'ALTER TABLE pets ADD COLUMN last_error TEXT',
    /* Память питомца. Журнал — свежие события как есть; сводка — сжатое
       прошлое; факты — что он знает про хозяина; связь — как у вас дела. */
    'ALTER TABLE pets ADD COLUMN log TEXT',
    'ALTER TABLE pets ADD COLUMN story TEXT',
    'ALTER TABLE pets ADD COLUMN facts TEXT',
    'ALTER TABLE pets ADD COLUMN bond TEXT'
  ];
  for (const sql of columns) {
    try { await env.DB.prepare(sql).run(); } catch (e) { /* уже есть */ }
  }
  try { await env.DB.prepare('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)').run(); } catch (e) {}
  migrated = true;
}

/* ---------- шифрование веб-push (RFC 8291) ----------
   Проверено на официальном тест-векторе RFC — байт в байт.            */
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}
async function hkdf(salt, ikm, info, len) {
  const prk = await hmac(salt, ikm);
  return (await hmac(prk, cat(info, Uint8Array.of(1)))).slice(0, len);
}
async function encryptPush(payload, uaPublic, authSecret) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, pair.privateKey, 256));

  const ikm = await hkdf(authSecret, shared, cat(enc.encode('WebPush: info\0'), uaPublic, asPub), 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey,
                            cat(enc.encode(payload), Uint8Array.of(2))));
  const rs = new Uint8Array(4); new DataView(rs.buffer).setUint32(0, 4096);
  return cat(salt, rs, Uint8Array.of(asPub.length), asPub, ct);
}

/* ---------- подпись VAPID (RFC 8292) ----------
   Доказывает службе доставки, что уведомление отправили действительно мы. */
async function vapidHeader(endpoint, env) {
  const aud = new URL(endpoint).origin;
  const head = b64u.enc(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u.enc(enc.encode(JSON.stringify({
    aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT || 'mailto:me@example.com'
  })));
  const pub = b64u.dec(env.VAPID_PUBLIC);
  const jwk = { kty: 'EC', crv: 'P-256', d: env.VAPID_PRIVATE,
                x: b64u.enc(pub.slice(1, 33)), y: b64u.enc(pub.slice(33, 65)), ext: true };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(head + '.' + body));
  return `vapid t=${head}.${body}.${b64u.enc(sig)}, k=${env.VAPID_PUBLIC}`;
}

async function sendPush(sub, payload, env) {
  const body = await encryptPush(payload, b64u.dec(sub.p256dh), b64u.dec(sub.auth));
  return fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'authorization': await vapidHeader(sub.endpoint, env),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      'ttl': '86400', 'urgency': 'normal'
    },
    body
  });
}


/* ============================================================================
   Симулятор жизни питомца — точный перенос Pet.statsManager из игры.
   Сверен с настоящей игрой на промежутках от часа до трёх суток: все
   показатели, счётчик смерти, оценка ухода и количество какашек совпадают.
   ============================================================================ */
const LIFE = { baby: 0, child: 0.5, teen: 1, adult: 2, elder: 3 };

/* Черты характера меняют скорость расхода. В оригинальном Tamaweb эта часть
   молча не работала: в Pet.statsManager функция hasTrait отрывалась от своего
   объекта и всегда возвращала пустоту. В нашей сборке игра починена, поэтому
   и сервер черты применяет — иначе питомец шёл бы с разной скоростью в
   открытом и закрытом приложении. */
const TRAITS_AFFECT_RATES = true;

function stageMult(stage) {
  if (stage === LIFE.baby) return 1.65;
  if (stage === LIFE.child) return 1.46;
  if (stage === LIFE.teen) return 1.3;
  return 1;
}
function maxDeathTick(s, stage) {
  if (stage === LIFE.baby) return s.baby_max_death_tick ?? 44;
  if (stage === LIFE.child) return s.child_max_death_tick ?? 60;
  if (stage === LIFE.teen) return s.teen_max_death_tick ?? 74;
  return s.max_death_tick ?? 100;
}
const simClamp = (v, a, b) => Math.min(Math.max(v, a), b);
const simRnd = (min, max) => Math.floor(Math.random() * (Math.floor(max) - Math.ceil(min) + 1)) + Math.ceil(min);

function within24(h) { h = h % 24; return h < 0 ? h + 24 : h; }
function isWithinHour(cur, start, end) {
  start = within24(start); end = within24(end); cur = within24(cur);
  return start <= end ? (cur >= start && cur < end) : (cur >= start || cur < end);
}

/* Один тик — половина секунды игрового времени.
   ctx: { hour, offline, speed, live, careCooldown } */
function tick(pet, ctx) {
  const s = pet.stats;
  if (s.is_dead) return;

  const has = t => Array.isArray(pet.traits) && pet.traits.indexOf(t) !== -1;
  const stage = pet.stage ?? LIFE.adult;
  const prev = { current_health: s.current_health, current_fun: s.current_fun,
                 current_hunger: s.current_hunger, current_cleanliness: s.current_cleanliness };

  /* Настройка «закрыто: 100/50/25/10 %» — это скорость жизни, пока человек не
     в игре. Считает ли в этот момент сервер или потом досчитывает браузер,
     значения не имеет: множитель применяется в обоих случаях, иначе выбранная
     скорость молча не работала бы в серверном режиме, а игра показывала бы
     время следующего напоминания не по тем числам, по которым оно приходит. */
  let mult = typeof ctx.speed === 'number' ? ctx.speed : 1, offlineAndIsNight = false;
  if (ctx.offline) {
    if (isWithinHour(ctx.hour, ctx.sleepStart, ctx.sleepEnd)) offlineAndIsNight = true;
  } else if (ctx.live) {
    attemptMisbehave(pet, ctx);
  }

  mult *= stageMult(stage);

  if (s.is_at_parents) {
    if (ctx.hour < (ctx.daycareStart ?? 3) || ctx.hour >= (ctx.daycareEnd ?? 18)) s.is_at_parents = false;
  }
  if (!offlineAndIsNight && s.is_at_parents) mult = -0.1;
  if (s.is_at_vacation) mult = -0.1;

  const T = TRAITS_AFFECT_RATES ? has : () => false;

  let hungerRate = s.hunger_depletion_rate * mult;
  if (T('lightEater')) hungerRate *= 0.5;
  if (T('voraciousHunger')) hungerRate *= 1.5;

  let sleepRate = s.sleep_depletion_rate * mult;
  if (T('deepSleeper')) sleepRate *= 0.5;
  if (T('restless')) sleepRate *= 1.5;

  let funRate = s.fun_depletion_rate * mult;
  if (T('chill')) funRate *= 0.5;
  if (T('playBurnout')) funRate *= 1.5;

  let bladderRate = s.bladder_depletion_rate * mult;
  if (T('ironBladder')) bladderRate *= 0.5;
  if (T('tinyTank')) bladderRate *= 1.5;

  let healthRate = s.health_depletion_rate * mult;
  if (T('germGuardian')) healthRate *= 0.5;

  let cleanRate = s.cleanliness_depletion_rate * mult;
  if (T('selfCleaning')) cleanRate *= 0.5;
  if (T('dustMagnet')) cleanRate *= 1.5;

  const disciplineRate = s.is_at_vacation ? 0 : s.discipline_depletion_rate;
  const maxDeath = maxDeathTick(s, stage);

  if (ctx.offline) sleepRate /= 2;
  if (s.is_sleeping || offlineAndIsNight) {
    sleepRate = -s.sleep_replenish_rate * (offlineAndIsNight ? 2 : 1);
  }

  s.current_hunger      = simClamp(s.current_hunger, 0, s.max_hunger);
  s.current_sleep       = simClamp(s.current_sleep, 0, s.max_sleep);
  s.current_fun         = simClamp(s.current_fun, 0, s.max_fun);
  s.current_bladder     = simClamp(s.current_bladder, 0, s.max_bladder);
  s.current_health      = simClamp(s.current_health, 0, s.max_health);
  s.current_cleanliness = simClamp(s.current_cleanliness, 0, s.max_cleanliness);
  s.current_discipline  = simClamp(s.current_discipline, 0, s.max_discipline);

  s.current_hunger -= hungerRate;
  if (s.current_hunger <= 0) s.current_hunger = 0;

  s.current_sleep -= sleepRate;
  if (s.current_sleep <= 0) { s.current_sleep = 0; s.is_sleeping = true; }

  s.current_fun -= funRate;
  if (s.current_fun <= 0) s.current_fun = 0;

  s.current_bladder -= bladderRate;
  if (s.current_bladder <= 0) {
    s.current_bladder = s.max_bladder;
    if (!s.is_potty_trained) s.has_poop_out = (s.has_poop_out || 0) + 1;
  }

  s.current_cleanliness -= cleanRate;
  if (s.current_cleanliness <= 0) s.current_cleanliness = 0;

  const isDirty = s.current_cleanliness <= 25;
  if (s.has_poop_out || isDirty) {
    s.current_health -= healthRate * s.health_depletion_mult;
    s.current_cleanliness -= cleanRate * s.cleanliness_depletion_mult;
  }
  if (s.current_health <= 0) s.current_health = 0;

  s.current_discipline -= disciplineRate;
  if (s.current_discipline <= 0) {
    s.current_discipline = 0;
    if (!has('proper')) s.is_misbehaving = true;
  }

  if (s.current_health <= 0 && s.current_cleanliness <= 0 &&
      s.current_fun <= 0 && s.current_hunger <= 0 && !s.is_ghost) {
    s.current_death_tick -= s.death_tick_rate;
  } else {
    s.current_death_tick = maxDeath;
  }
  if (s.current_death_tick <= 0) s.is_dead = true;

  /* оценка ухода */
  const careStats = ['current_health', 'current_fun', 'current_hunger', 'current_cleanliness'];
  if (!ctx.offline) {
    for (const k of careStats) {
      if (prev[k] !== 0 && s[k] === 0) {
        ctx.careCooldown--;
        if (ctx.careCooldown <= 0) {
          ctx.careCooldown = 2;
          adjustCare(s, false);
          s.current_discipline -= simRnd(2, 5);
        }
      }
    }
  }
  if (careStats.every(k => s[k] <= 0)) {
    s.current_care = 1;
    adjustCare(s, false);
  }
  const careThreshold = s.hunger_satisfaction || 85;
  if (careStats.every(k => s[k] > careThreshold)) {
    if (s.should_care_increase) { s.should_care_increase = false; adjustCare(s, true); }
  } else if (careStats.some(k => s[k] < 65)) {
    s.should_care_increase = true;
  }
}

function adjustCare(s, add) {
  s.current_care = simClamp((s.current_care || 1) + (add ? 1 : -1), 1, s.max_care || 3);
}

function attemptMisbehave(pet, ctx) {
  const s = pet.stats;
  if (Array.isArray(pet.traits) && pet.traits.indexOf('proper') !== -1) return;
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  if ((ctx.nowMs - (s.last_time_misbehave_attempted || 0)) <= SIX_HOURS) return;
  s.last_time_misbehave_attempted = ctx.nowMs;

  let startingChance = 1;
  const stage = pet.stage ?? LIFE.adult;
  if (stage === LIFE.teen) startingChance = 18;
  else if (stage === LIFE.child) startingChance = 9;
  else if (stage === LIFE.baby) startingChance = 5;

  const helper = (100 - s.current_discipline) / 2.8;
  if (simRnd(startingChance, s.max_discipline) > (s.current_discipline + helper)) {
    s.is_misbehaving = true;
  }
}

/* Прокрутить состояние с fromMs до toMs.
   opts: { speed, live, tzMin, sleepStart, sleepEnd, maxMs, careCooldown }

   careCooldown обязательно передавать между вызовами. В игре этот счётчик
   («сколько обнулившихся показателей пропустить перед снижением оценки ухода»)
   живёт весь сеанс в App.temp. Сервер же зовёт advance раз в минуту, и если
   счётчик каждый раз начинать заново, запущенный питомец теряет оценку ухода
   и дисциплину вдвое быстрее, чем в самой игре. Поэтому он хранится в sim
   и возвращается наружу вместе с результатом. */
function advance(pet, fromMs, toMs, opts = {}) {
  const speed = typeof opts.speed === 'number' ? opts.speed : 1;
  const tz = opts.tzMin || 0;
  const sleepStart = opts.sleepStart ?? 21;
  const sleepEnd = opts.sleepEnd ?? 8;
  const maxMs = opts.maxMs ?? 12 * 60 * 60 * 1000;

  let span = toMs - fromMs;
  if (span <= 0) return { until: fromMs, ticks: 0 };
  if (span > maxMs) span = maxMs;

  const iterations = Math.floor(span / 1000 * 2);
  const ctx = { offline: !opts.live, live: !!opts.live, speed, sleepStart, sleepEnd,
                careCooldown: Number(opts.careCooldown) || 0, hour: 0, nowMs: fromMs,
                daycareStart: opts.daycareStart ?? 3, daycareEnd: opts.daycareEnd ?? 18 };

  for (let i = 0; i < iterations; i++) {
    // игра отсчитывает от (now - elapsed) и первый шаг делает уже сдвинутым на 500 мс
    const at = fromMs + (i + 1) * 500;
    ctx.nowMs = at;
    ctx.hour = new Date(at + tz * 60000).getUTCHours();
    if (pet.stats.is_egg || pet.stats.is_dead) break;
    tick(pet, ctx);
  }
  return { until: fromMs + iterations * 500, ticks: iterations, careCooldown: ctx.careCooldown };
}


/* ============================================================================
   Остальная жизнь: огород, животные, возвращение с занятий, взросление.
   Здесь нет посекундных тиков — всё считается по времени напрямую, ровно
   по тем же формулам, что в Plant.js и Animal.js.
   ============================================================================ */
const HOUR_MS = 60 * 60 * 1000;
const PLANT_AGE = { seedling: 0, tiny: 1, grown: 2, dead: 3 };

function plantDurations(plant, traits, animals) {
  const isBotanist = Array.isArray(traits) && traits.indexOf('botanist') !== -1;
  const buffs = new Set((animals || []).map(a => a && a.buff).filter(Boolean));

  let watered = typeof plant.wateredDuration === 'number' ? plant.wateredDuration : 2 * HOUR_MS;
  let death   = typeof plant.deathDuration === 'number' ? plant.deathDuration : 20 * HOUR_MS;
  let growth  = typeof plant.growthDelay === 'number' ? plant.growthDelay : 9 * HOUR_MS;

  if (buffs.has('increasedWateredDuration')) watered += 3 * HOUR_MS;
  if (isBotanist) watered += 3 * HOUR_MS;
  if (buffs.has('longerDeathDuration')) death += 8 * HOUR_MS;
  if (isBotanist) death += 5 * HOUR_MS;
  if (buffs.has('shorterGrowthDelay')) growth -= 4 * HOUR_MS;
  if (isBotanist) growth -= 3 * HOUR_MS;

  return { watered, death, growth };
}

/* Одно растение на момент now — повторяет Plant.checkForProgress */
function advancePlant(plant, traits, animals, now) {
  const d = plantDurations(plant, traits, animals);
  const out = { age: plant.age, lastGrowthTime: plant.lastGrowthTime, watered: false };

  out.watered = (now - plant.lastWatered) < d.watered;
  if (now > plant.lastWatered + d.death + d.watered) { out.age = PLANT_AGE.dead; return out; }
  if (out.age === PLANT_AGE.grown || out.age === PLANT_AGE.dead) return out;

  while (out.lastGrowthTime + d.growth < now && out.age !== PLANT_AGE.grown) {
    out.lastGrowthTime += d.growth;
    out.age = simClamp(out.age + 1, PLANT_AGE.seedling, PLANT_AGE.grown);
  }
  return out;
}

/* Счастье животного падает со 100 до нуля за 48 часов — как в Animal.js */
function advanceAnimal(animal, now) {
  const perSec = 100 / (48 * 3600);
  const delta = Math.max(0, now - (animal.lastStatsUpdate || now));
  const happiness = simClamp((animal.happiness ?? 100) - perSec * (delta / 1000), 0, 100);
  return { happiness, lastStatsUpdate: now };
}

/* Всё, что произошло в мире вокруг питомца. Состояние меняем только там,
   где это чистые числа; всё, что игра показывает окнами и за что даёт
   награды (возвращение с занятия, уход животных), оставляем ей. */
function advanceWorld(sim, now) {
  const events = [];
  const seen = sim.seen || (sim.seen = {});
  const once = (key, ev) => { if (!seen[key]) { seen[key] = now; events.push(ev); } };

  /* огород */
  const plants = sim.plants || [];
  for (let i = 0; i < plants.length; i++) {
    const p = plants[i];
    const before = { age: p.age, watered: p.watered !== false };
    const after = advancePlant(p, sim.traits, sim.animals, now);
    p.age = after.age; p.lastGrowthTime = after.lastGrowthTime; p.watered = after.watered;

    if (before.age !== PLANT_AGE.grown && after.age === PLANT_AGE.grown)
      once('plant_ready_' + i + '_' + after.age,
           { key: 'plant_ready', title: 'Урожай готов', body: 'Пора собирать', short: 'урожай готов' });
    if (before.watered && !after.watered && after.age !== PLANT_AGE.dead)
      once('plant_water_' + i + '_' + p.lastWatered,
           { key: 'plant_water', title: 'Растения хотят пить', body: 'Пора полить', short: 'полить растения' });
    if (before.age !== PLANT_AGE.dead && after.age === PLANT_AGE.dead)
      once('plant_dead_' + i + '_' + p.lastWatered,
           { key: 'plant_dead', title: 'Растение погибло', body: 'Его больше не спасти', short: 'растение погибло' });
  }

  /* животные */
  const animals = sim.animals || [];
  for (let i = 0; i < animals.length; i++) {
    const a = animals[i];
    const before = a.happiness ?? 100;
    const after = advanceAnimal(a, now);
    a.happiness = after.happiness; a.lastStatsUpdate = after.lastStatsUpdate;

    if (before > 20 && after.happiness <= 20 && after.happiness > 0)
      once('animal_sad_' + i, { key: 'animal', title: 'Животное заскучало',
            body: (a.name || 'Зверёк') + ' скучает', short: 'животное скучает' });
    if (before > 0 && after.happiness <= 0)
      once('animal_left_' + i, { key: 'animal_left', title: 'Животное уходит',
            body: (a.name || 'Зверёк') + ' устал ждать', short: 'животное уходит' });
  }

  /* вернулся с занятия */
  const hole = sim.rabbitHole;
  if (hole && hole.name && hole.endTime && now >= hole.endTime)
    once('home_' + hole.endTime, { key: 'home', title: (sim.name || 'Питомец') + ' вернулся домой',
          body: 'Занятие «' + hole.name + '» закончилось', short: 'вернулся домой' });

  /* пора взрослеть */
  if (sim.ageUpAt && now >= sim.ageUpAt)
    once('ageup_' + sim.ageUpAt, { key: 'ageup', title: (sim.name || 'Питомец') + ' готов повзрослеть',
          body: 'Загляни — он изменится', short: 'готов повзрослеть' });

  return events;
}

/* Что с питомцем не так ПРЯМО СЕЙЧАС.

   Именно текущее состояние, а не «что изменилось за последнюю минуту». Если
   игру закрыли с уже голодным питомцем, о голоде всё равно надо сказать:
   человек мог зайти в приложение и не заметить. Чтобы одно и то же не
   повторялось бесконечно, каждая отметка ставится один раз и снимается сама,
   когда потребность закрыта (см. sim.notified в расписании).             */
function currentNeeds(s, pet, traits) {
  const name = pet.pet_name || 'Питомец';
  const out = [];
  const add = (key, on, title, body, short) => { if (on) out.push({ key, title, body, short }); };

  if (s.is_egg) return [];      // яйцу ничего не нужно, оно просто лежит
  if (s.is_dead) return [{ key: 'dead', title: name + ' умер', body: 'Можно воскресить', short: 'умер' }];

  /* «Ворчуну» всего хочется раньше — те же множители, что в moodlets игры */
  const grumpy = TRAITS_AFFECT_RATES && Array.isArray(traits) && traits.indexOf('grumpy') !== -1;
  const hungerT = (s.hunger_min_desire ?? 40) * (grumpy ? 1.5 : 1);
  const sleepT  = (s.sleep_min_desire ?? 20) * (grumpy ? 2 : 1);
  const funT    = (s.fun_min_desire ?? 35) * (grumpy ? 1.8 : 1);

  add('danger', s.current_health <= (s.max_health || 100) * 0.1,
      name + ' совсем плохо!', 'Срочно зайди в игру', 'совсем плохо');
  add('sick', s.current_health <= (s.max_health || 100) * 0.25,
      name + ' заболел', 'Нужно лекарство', 'заболел');
  add('hunger', s.current_hunger <= hungerT, name + ' проголодался', 'Пора покормить', 'голоден');
  add('toilet', s.current_bladder <= (s.max_bladder || 100) / 4,
      name + ' просится в туалет', 'Отведи его', 'просится в туалет');
  add('poop', (s.has_poop_out || 0) > 0, 'У ' + name + ' грязно', 'Надо убрать', 'надо убрать');
  add('fun', s.current_fun <= funT, name + ' скучает', 'Хочет поиграть', 'скучает');
  add('sleep', s.current_sleep <= sleepT, name + ' хочет спать', 'Пора выключить свет', 'хочет спать');
  add('clean', s.current_cleanliness <= 25, name + ' испачкался', 'Пора помыть', 'надо помыть');
  add('misbehave', !!s.is_misbehaving, name + ' балуется', 'Стоит поругать', 'балуется');
  add('sleeping', !!s.is_sleeping, name + ' уснул', 'Спокойной ночи', 'уснул');
  return out;
}

/* Отбирает из текущих потребностей те, о которых ещё не говорили, и снимает
   отметки с закрытых. Меняет sim.notified на месте. */
function pendingEvents(sim, pet, now) {
  const notified = sim.notified || (sim.notified = {});
  const needs = currentNeeds(sim.stats, pet, sim.traits);
  const active = new Set(needs.map(n => n.key));

  for (const key of Object.keys(notified)) {
    if (!active.has(key)) delete notified[key];        // потребность закрыли — можно объявлять снова
  }

  return needs.filter(n => {
    if (n.key === 'poop') {
      /* про какашки говорим о каждой новой, а не только о первой */
      const count = sim.stats.has_poop_out || 0;
      if (notified.poop != null && count <= notified.poop) return false;
      notified.poop = count;
      return true;
    }
    if (notified[n.key] != null) return false;
    notified[n.key] = now;
    return true;
  });
}

/* ---------- проверка доступа ---------- */
async function auth(req, env) {
  const t = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!t) return null;
  return env.DB.prepare('SELECT * FROM pets WHERE token = ?').bind(t).first();
}

/* ---------- правила напоминаний ----------
   Правило одно: событие произошло — уведомление ушло. Ни ночной тишины,
   ни отсрочек, ни дневных лимитов. О каждом событии сообщаем один раз;
   когда игрок его закрыл, клиент присылает новое время, отметка снимается,
   и следующее такое же событие снова будет объявлено.                    */
const PRIORITY = ['dead', 'danger', 'sick', 'hunger', 'toilet', 'poop', 'fun', 'sleep',
                  'clean', 'misbehave', 'home', 'ageup', 'egg',
                  'plant_ready', 'plant_water', 'plant_dying', 'animal'];
const ACTIVE_WINDOW = 2 * 60 * 1000;    // человек прямо сейчас в игре и всё видит сам

/* Только для счётчика «сколько уведомлений сегодня» — он ничего не ограничивает,
   просто показывается в игре. Клиент присылает свой сдвиг от UTC в минутах. */
function localParts(now, tzMin) {
  const d = new Date(now + (tzMin || 0) * 60000);
  return { hour: d.getUTCHours(), day: d.toISOString().slice(0, 10) };
}

/* ============================ маршруты ============================ */
export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, '');

    try {
      /* Какая версия здесь на самом деле лежит — можно посмотреть прямо в
         браузере, без токена. Нужно, чтобы не гадать, обновлён ли Cloudflare. */
      if (p === '/api/version') return json({ v: VERSION });

      await migrate(env);

      /* Первый запуск: устройство заводит себе аккаунт.
         Отдаём токен (хранится в браузере) и код для привязки второго устройства. */
      if (p === '/api/register' && req.method === 'POST') {
        const token = rnd(24), link = rnd(4).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
        await env.DB.prepare(
          'INSERT INTO pets (token, link_code, created_at, updated_at, gen) VALUES (?,?,?,?,1)'
        ).bind(token, link, Date.now(), Date.now()).run();
        return json({ token, link_code: link, gen: 1 });
      }

      /* Привязка второго устройства по коду — отдаёт тот же токен. */
      if (p === '/api/link' && req.method === 'POST') {
        const { code } = await req.json();
        const row = await env.DB.prepare('SELECT token, gen FROM pets WHERE link_code = ?')
                      .bind(String(code || '').toUpperCase()).first();
        if (!row) return json({ error: 'код не найден' }, 404);
        return json({ token: row.token, gen: row.gen || 1 });
      }

      const pet = await auth(req, env);
      if (!pet) return json({ error: 'нужен токен' }, 401);
      const gen = pet.gen || 1;

      /* Лёгкая проверка «а не появилось ли там свежее» — без тела сохранения. */
      if (p === '/api/meta') {
        return json({
          v: VERSION,
          gen,
          has_save: !!pet.save,
          last_time: pet.last_time,
          hash: pet.hash,
          active: pet.last_active,
          writer: pet.last_writer,
          updated_at: pet.updated_at
        });
      }

      /* Сохранение: заливаем и забираем. */
      if (p === '/api/save' && req.method === 'PUT') {
        const body = await req.json();
        const { save, last_time, device, seen, pet_name, tz } = body;

        /* Номер поколения. Сброс питомца увеличивает его на единицу, и всё,
           что было отправлено до сброса, сюда уже не попадёт: ни запрос,
           зависший в пути на том же телефоне, ни вкладка на другом устройстве,
           которая ещё не знает, что питомца начали заново. Раньше именно
           так старый питомец и возвращался обратно вместе со своими какашками.
           Сравниваем номерами, а не временем: часы на устройствах врут. */
        if (body.gen != null && Number(body.gen) !== gen) {
          return json({ conflict: 'reset', gen }, 409);
        }
        /* Пока игра открыта, главный — браузер. Каждое сохранение сбрасывает
           состояние симулятора: сервер продолжит именно с него.

           Отметки «об этом уже говорили» сбрасываются, только если человек
           действительно смотрел на игру (seen). Тогда после закрытия ему
           заново расскажут обо всём, что осталось неисправленным, — он ведь
           мог зайти и не заметить. А вот вкладка, забытая открытой в фоне,
           шлёт сохранения сама по себе, и обнулять отметки по ним нельзя:
           иначе одно и то же уведомление приходило бы каждые пару минут. */
        const prevSim = parse(pet.sim, null);
        const fresh = !!seen;

        /* Даже у фонового сохранения снимаем отметки с того, что игрок уже
           закрыл. Иначе так: покормил — сытость подскочила, но расписание
           просыпается раз в минуту и этой секунды просто не застало; отметка
           «о голоде говорили» осталась бы висеть, и о следующем голоде уже
           никто бы не сказал. */
        const carried = (!fresh && prevSim && prevSim.notified) ? { ...prevSim.notified } : {};
        if (!fresh && body.sim && body.sim.stats) {
          const still = new Set(
            currentNeeds(body.sim.stats, { pet_name }, body.sim.traits).map(n => n.key));
          for (const key of Object.keys(carried)) if (!still.has(key)) delete carried[key];
          // какашек могло стать меньше — считаем заново от того, что есть сейчас
          if (carried.poop != null) carried.poop = body.sim.stats.has_poop_out || 0;
        }

        const simState = body.sim && body.sim.stats
          ? JSON.stringify({
              stats: body.sim.stats, traits: body.sim.traits || [],
              stage: body.sim.stage, speed: body.sim.speed,
              sleepStart: body.sim.sleepStart, sleepEnd: body.sim.sleepEnd,
              name: body.pet_name || null,
              plants: body.sim.plants || [], animals: body.sim.animals || [],
              rabbitHole: body.sim.rabbitHole || null, ageUpAt: body.sim.ageUpAt || null,
              seen: fresh ? {} : ((prevSim && prevSim.seen) || {}),
              notified: carried,
              care: 0,          // игра тоже начинает счётчик оценки ухода заново при запуске
              at: last_time || Date.now()
            })
          : null;
        if (typeof save !== 'string') return json({ error: 'нет данных' }, 400);
        if (save.length > 4_000_000) return json({ error: 'слишком большое сохранение' }, 413);
        /* Главным считается то устройство, которым человек пользовался позже.
           Если пишет «отставшее» — не принимаем: пусть сначала заберёт свежее.
           Иначе фоновое автосохранение простаивающего устройства затирало бы
           игру, которая идёт прямо сейчас на другом. */
        const active = Number(body.active) || 0;
        const known = Number(pet.last_active) || 0;
        if (active + 5000 < known) {
          return json({ conflict: 'stale_device', active: known }, 409);
        }
        if (pet.last_time && last_time && last_time < pet.last_time && device !== pet.last_writer) {
          return json({ conflict: 'stale_save', active: known, server_last_time: pet.last_time }, 409);
        }

        const needs = Array.isArray(body.needs) ? body.needs.slice(0, 16) : [];
        const now = Date.now();

        /* Снимаем отметку «уже напомнили» с тех потребностей, которые игрок
           закрыл: их время уехало в будущее либо они вовсе исчезли из списка. */
        const notified = parse(pet.notified, {}) || {};
        const future = new Set(needs.filter(n => n && n.at > now + 60_000).map(n => n.key));
        const present = new Set(needs.map(n => n && n.key));
        for (const key of Object.keys(notified)) {
          if (future.has(key) || !present.has(key)) delete notified[key];
        }

        const earliest = needs.slice().sort((a, b) => a.at - b.at)[0] || null;

        await env.DB.prepare(
          `UPDATE pets SET save=?, hash=?, last_time=?, needs=?, notified=?, next_call_at=?, call_reason=?,
                           pet_name=?, tz=?, last_seen=?, last_active=?, last_writer=?, updated_at=?,
                           mode=?, sim=COALESCE(?, sim) WHERE token=?`
        ).bind(save, body.hash || null, last_time || now, JSON.stringify(needs), JSON.stringify(notified),
               earliest ? earliest.at : null, earliest ? earliest.title : null,
               pet_name || null, tz != null ? tz : pet.tz, seen || pet.last_seen || 0,
               Math.max(Number(body.active) || 0, Number(pet.last_active) || 0),
               device || null, now,
               body.mode === 'server' ? 'server' : 'client', simState, pet.token).run();
        return json({ ok: true });
      }
      if (p === '/api/save' && req.method === 'GET') {
        return json({ save: pet.save || null, hash: pet.hash, active: pet.last_active,
                      last_time: pet.last_time, pet_name: pet.pet_name });
      }

      /* Состояние, которое насчитал сервер. Игра забирает его при открытии
         вместо того, чтобы догонять офлайн у себя. */
      if (p === '/api/state') {
        const sim = parse(pet.sim, null);
        if (!sim || !sim.stats) return json({ has_state: false });
        return json({ has_state: true, at: sim.at, stats: sim.stats, mode: pet.mode || 'client',
                      plants: sim.plants || [], animals: sim.animals || [] });
      }

      /* Сброс питомца. Игра стирает питомца у себя и говорит об этом сюда,
         иначе сервер продолжит считать старого и подсунет его новому яйцу
         (старые какашки, старые характеристики, а то и целиком старый файл).
         Токен и код привязки остаются: аккаунт тот же, устройства связаны. */
      if (p === '/api/reset' && req.method === 'POST') {
        let full = false;
        try { full = !!(await req.json()).full; } catch (e) {}
        if (full) {
          /* «Полный сброс» из меню: аккаунт брошен целиком. Подписки тоже
             убираем, иначе на телефон продолжат ходить напоминания от
             питомца, которого уже нет. */
          await env.DB.prepare('DELETE FROM subs WHERE token=?').bind(pet.token).run();
          await env.DB.prepare('DELETE FROM pets WHERE token=?').bind(pet.token).run();
          return json({ ok: true, full: true });
        }
        const next = gen + 1;               // новое поколение: всё прежнее недействительно
        await env.DB.prepare(
          `UPDATE pets SET save=NULL, hash=NULL, sim=NULL, needs=NULL, notified=NULL,
                           next_call_at=NULL, call_reason=NULL, notified_for=NULL,
                           last_time=NULL, pet_name=NULL, last_active=0, last_writer=NULL,
                           last_seen=0, gen=?, updated_at=? WHERE token=?`
        ).bind(next, Date.now(), pet.token).run();
        return json({ ok: true, gen: next });
      }

      /* Подписка на уведомления. */
      if (p === '/api/subscribe' && req.method === 'POST') {
        const { endpoint, keys } = await req.json();
        if (!endpoint || !keys?.p256dh || !keys?.auth) return json({ error: 'плохая подписка' }, 400);
        await env.DB.prepare(
          'INSERT OR REPLACE INTO subs (endpoint, token, p256dh, auth, created_at) VALUES (?,?,?,?,?)'
        ).bind(endpoint, pet.token, keys.p256dh, keys.auth, Date.now()).run();
        return json({ ok: true });
      }
      if (p === '/api/unsubscribe' && req.method === 'POST') {
        const { endpoint } = await req.json();
        if (endpoint) await env.DB.prepare('DELETE FROM subs WHERE endpoint=? AND token=?')
                                  .bind(endpoint, pet.token).run();
        return json({ ok: true });
      }

      /* Проверка «а дойдёт ли вообще» — присылает уведомление прямо сейчас. */
      if (p === '/api/test-push' && req.method === 'POST') {
        const subs = await env.DB.prepare('SELECT * FROM subs WHERE token=?').bind(pet.token).all();
        const detail = [];
        let sent = 0;
        for (const s of subs.results || []) {
          try {
            const r = await sendPush(s, JSON.stringify({
              title: 'Проверка связи', body: 'Уведомления работают 🥚', tag: 'test'
            }), env);
            detail.push({ ok: r.ok, status: r.status });
            if (r.ok) sent++;
          } catch (e) {
            detail.push({ ok: false, status: String(e && e.message || e) });
          }
        }
        return json({ sent, total: (subs.results || []).length, detail });
      }

      /* Публичный ключ для подписки на уведомления. */
      if (p === '/api/vapid') return json({ key: env.VAPID_PUBLIC || null });

      /* ---------- голос питомца ----------
         Отдаёт пачку реплик под текущее состояние. Всё фактическое приходит
         от клиента из симулятора; модель только произносит. Не получилось —
         возвращаем пусто, и игра говорит своим генератором. */
      if (p === '/api/lines' && req.method === 'POST') {
        const body = await req.json().catch(() => ({}));
        const stage = STAGE_NAMES[body.stage] || 'adult';

        /* Малыш не разговаривает. Модель для него не нужна вообще —
           это не экономия, это правда: он ещё не умеет. */
        if (stage === 'baby') {
          /* На каждый повод у него один и тот же ответ — звук. Это правда,
             а не заглушка: он ещё не различает поводов. */
          const groups = {};
          for (const [ключ] of GROUPS) groups[ключ] = BABY_SOUNDS.slice();
          return json({ lines: BABY_SOUNDS.slice(), groups, source: 'малыш', model: null,
                        stage, usage: await readUsage(env) });
        }

        const day = localParts(Date.now(), body.tz).day;
        const res = await askModel(env, {
          name: body.name, stage, traits: body.traits, stats: body.stats,
          recent: body.recent, timeOfDay: body.timeOfDay, count: 16,
        });
        const usage = await bumpUsage(env, day, res.lines.length > 0, res.error, res.left, res.ms, res.model);
        return json({ lines: res.lines, groups: res.groups || {}, source: res.source,
                      model: res.model, error: res.error || null, stage, usage });
      }

      /* ---------- память ----------
         Журнал пишет клиент из настоящего состояния — модель сюда не пишет
         ничего. Сжатие старого в сводку запускается само, когда журнал
         перерос порог. */
      if (p === '/api/memory' && req.method === 'POST') {
        const body = await req.json().catch(() => ({}));
        let mem = {
          log:   parse(pet.log, []) || [],
          story: pet.story || null,
          facts: parse(pet.facts, []) || [],
          bond:  pet.bond || null,
        };

        const новые = cleanLog(body.log);
        if (новые.length) mem.log = mem.log.concat(новые);
        if (typeof body.bond === 'string') mem.bond = body.bond.slice(0, 200);

        let сжали = false;
        if (mem.log.length >= LOG_SQUEEZE) {
          const было = mem.log.length;
          mem = await squeezeLog(env, mem, { name: body.name });
          сжали = mem.log.length < было;
          if (сжали) {
            const day = localParts(Date.now(), body.tz).day;
            await bumpUsage(env, day, true);
          }
        }

        await env.DB.prepare('UPDATE pets SET log=?, story=?, facts=?, bond=? WHERE token=?')
          .bind(JSON.stringify(mem.log), mem.story, JSON.stringify(mem.facts), mem.bond, pet.token)
          .run();

        return json({ ok: true, log: mem.log.length, story: !!mem.story,
                      facts: mem.facts.length, squeezed: сжали });
      }

      /* Что питомец помнит — можно посмотреть глазами, а не верить на слово. */
      if (p === '/api/memory' && req.method === 'GET') {
        return json({
          log:   parse(pet.log, []) || [],
          story: pet.story || null,
          facts: parse(pet.facts, []) || [],
          bond:  pet.bond || null,
        });
      }

      /* ---------- разговор ----------
         Клиент присылает состояние, повод и то, что уже сказано в этом
         разговоре. Сервер отдаёт реплику питомца и варианты ответа с
         пометками намерения. Показатели меняет игра, и только по пометке. */
      if (p === '/api/talk' && req.method === 'POST') {
        const body = await req.json().catch(() => ({}));
        const stage = STAGE_NAMES[body.stage] || 'adult';
        if (stage === 'baby') {
          return json({ talk: null, source: 'малыш', stage,
                        why: 'малыш ещё не разговаривает' });
        }

        const mem = {
          log:   parse(pet.log, []) || [],
          story: pet.story || null,
          facts: parse(pet.facts, []) || [],
          bond:  pet.bond || null,
        };

        const day = localParts(Date.now(), body.tz).day;
        const res = await askTalk(env, {
          name: body.name, stage, traits: body.traits, stats: body.stats,
          timeOfDay: body.timeOfDay, memory: mem,
          'повод': body['повод'] || body.reason || null,
        });
        const usage = await bumpUsage(env, day, !!res.talk, res.error, res.left, res.ms, res.model);

        /* Факт про хозяина теперь висит на конкретном варианте ответа:
           запоминать его надо не сейчас, а когда игрок этот вариант выберет.
           Кладёт его игра отдельным запросом — см. /api/remember. */

        return json({ talk: res.talk, source: res.source, model: res.model,
                      error: res.error || null, stage, usage,
                      knows: mem.facts.length, remembers: mem.log.length });
      }

      /* Игрок выбрал вариант, к которому был привязан факт про него.
         Кладём факт только теперь: до выбора он был лишь предположением. */
      if (p === '/api/remember' && req.method === 'POST') {
        const body = await req.json().catch(() => ({}));
        const было = parse(pet.facts, []) || [];
        const facts = cleanFacts(было.concat([body.fact]));
        await env.DB.prepare('UPDATE pets SET facts=? WHERE token=?')
          .bind(JSON.stringify(facts), pet.token).run();
        return json({ ok: facts.length > было.length, facts: facts.length });
      }

      if (p === '/api/status') {
        const cron = await env.DB.prepare('SELECT v FROM kv WHERE k=?').bind('last_cron').first();
        const subs = await env.DB.prepare('SELECT COUNT(*) AS n FROM subs WHERE token=?')
                       .bind(pet.token).first();
        return json({ v: VERSION, gen,
                      subs: (subs && subs.n) || 0,       // на скольких устройствах включены уведомления
                      last_error: pet.last_error || null,
                      has_save: !!pet.save, last_time: pet.last_time,
                      next_call_at: pet.next_call_at, call_reason: pet.call_reason,
                      link_code: pet.link_code, needs: parse(pet.needs, []),
                      last_notify: pet.last_notify, last_seen: pet.last_seen,
                      mode: pet.mode || 'client',
                      sim_at: (parse(pet.sim, null) || {}).at || null,
                      notified: parse(pet.notified, {}) || {},
                      notify_today: pet.notify_count || 0,
                      ai: { key: !!env.OPENROUTER_KEY, models: MODELS,
                            usage: await readUsage(env),
                            mem: { log: (parse(pet.log, []) || []).length,
                                   facts: (parse(pet.facts, []) || []).length,
                                   story: !!pet.story } },
                      cron_at: cron ? Number(cron.v) : null });
      }

      return json({ error: 'нет такого адреса' }, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },

  /* Раз в минуту: кому пора напомнить о питомце. */
  async scheduled(event, env, ctx) {
    await migrate(env);
    const now = Date.now();
    // отметка «расписание живо» — по ней игра показывает, работает ли оно вообще
    try {
      await env.DB.prepare('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)')
        .bind('last_cron', String(now)).run();
    } catch (e) {}
    /* ---- питомцы, которые живут на сервере ---- */
    const living = await env.DB.prepare(
      `SELECT * FROM pets WHERE mode='server' AND sim IS NOT NULL LIMIT 100`
    ).bind().all();

    for (const pet of living.results || []) {
      const sim = parse(pet.sim, null);
      if (!sim || !sim.stats) continue;
      // пока игра открыта, считает браузер — сервер только ждёт
      if (pet.last_seen && now - pet.last_seen < ACTIVE_WINDOW) continue;
      if (!(sim.at < now - 1000)) continue;

      const petState = { stats: sim.stats, traits: sim.traits || [], stage: sim.stage };
      const res = advance(petState, sim.at, now, {
        speed: typeof sim.speed === 'number' ? sim.speed : 1,
        live: true,                       // сервер живёт по-настоящему, со случайностями
        tzMin: pet.tz || 0,
        sleepStart: sim.sleepStart ?? 21,
        sleepEnd: sim.sleepEnd ?? 8,
        careCooldown: sim.care ?? 0,      // счётчик оценки ухода живёт между вызовами
      });
      sim.stats = petState.stats;
      sim.at = res.until;
      sim.care = res.careCooldown;

      /* Запоминаем отметки ДО того, как их проставят: если уведомление никуда
         не доедет, отметки надо вернуть на место, иначе о событии не скажут
         уже никогда. Раньше сервер записывал «уведомил», даже когда подписки
         не было вовсе — отсюда «последнее уведомление 11 минут назад» на
         телефоне, которому ничего не приходило. */
      const notifiedBefore = JSON.stringify(sim.notified || {});
      const worldSeenBefore = JSON.stringify(sim.seen || {});

      const events = pendingEvents(sim, pet, now).concat(advanceWorld(sim, sim.at));

      if (!events.length) {
        await env.DB.prepare('UPDATE pets SET sim=? WHERE token=?')
          .bind(JSON.stringify(sim), pet.token).run();
        continue;
      }

      const payload = JSON.stringify(
        events.length > 1
          ? { title: (pet.pet_name || 'Питомец') + ' зовёт тебя',
              body: events.map(e => e.short).join(', '), tag: 'pet', count: events.length }
          : { title: events[0].title, body: events[0].body, tag: 'pet', count: 1 }
      );

      const subs = await env.DB.prepare('SELECT * FROM subs WHERE token=?').bind(pet.token).all();
      const list = subs.results || [];
      let delivered = 0, lastError = null;

      for (const sub of list) {
        let r = null;
        try { r = await sendPush(sub, payload, env); }
        catch (e) { lastError = 'сбой отправки: ' + String((e && e.message) || e).slice(0, 80); }
        if (r && r.ok) { delivered++; continue; }
        if (r) {
          lastError = 'служба доставки ответила ' + r.status;
          if (r.status === 404 || r.status === 410) {
            lastError = 'подписка на этом устройстве больше не действует — включи уведомления заново';
            await env.DB.prepare('DELETE FROM subs WHERE endpoint=?').bind(sub.endpoint).run();
          }
        }
      }
      if (!list.length) lastError = 'уведомления не включены ни на одном устройстве';

      /* Ничего не доставлено — значит и объявленным событие считать нельзя.
         Возвращаем отметки: на следующей минуте попробуем ещё раз. */
      if (!delivered) {
        sim.notified = parse(notifiedBefore, {});
        sim.seen = parse(worldSeenBefore, {});
      }
      await env.DB.prepare('UPDATE pets SET sim=?, last_error=? WHERE token=?')
        .bind(JSON.stringify(sim), lastError, pet.token).run();

      if (!delivered) continue;

      const today = localParts(now, pet.tz).day;
      const used = pet.notify_day === today ? (pet.notify_count || 0) : 0;
      await env.DB.prepare('UPDATE pets SET last_notify=?, notify_day=?, notify_count=? WHERE token=?')
        .bind(now, today, used + events.length, pet.token).run();
    }

    /* ---- питомцы, которые считаются в браузере (прогноз) ---- */
    const due = await env.DB.prepare(
      `SELECT * FROM pets WHERE (mode IS NULL OR mode <> 'server')
        AND needs IS NOT NULL AND next_call_at IS NOT NULL AND next_call_at <= ? LIMIT 100`
    ).bind(now).all();

    for (const pet of due.results || []) {
      const needs = parse(pet.needs, []) || [];
      const notified = parse(pet.notified, {}) || {};

      // всё, что уже наступило и о чём ещё не сообщали
      const ready = needs.filter(n => n && n.at <= now && !notified[n.key]);
      if (!ready.length) continue;

      // человек прямо сейчас в игре — он и так всё видит
      if (pet.last_seen && now - pet.last_seen < ACTIVE_WINDOW) continue;

      ready.sort((a, b) => {
        const pa = PRIORITY.indexOf(a.key), pb = PRIORITY.indexOf(b.key);
        return (pa < 0 ? 99 : pa) - (pb < 0 ? 99 : pb);
      });

      /* Всё, что случилось к этой минуте, уходит одним уведомлением —
         это не задержка, а просто способ не прислать четыре подряд. */
      const chosen = ready;
      const need = chosen[0];
      const payload = JSON.stringify(
        chosen.length > 1
          ? {
              title: (pet.pet_name || 'Питомец') + ' зовёт тебя',
              body: chosen.map(n => n.short || n.body).join(', '),
              tag: 'pet', count: chosen.length
            }
          : {
              title: need.title || ((pet.pet_name || 'Питомец') + ' зовёт тебя'),
              body: need.body || 'Кажется, ему что-то нужно',
              tag: 'pet', count: 1
            }
      );

      const subs = await env.DB.prepare('SELECT * FROM subs WHERE token=?').bind(pet.token).all();
      for (const sub of subs.results || []) {
        const r = await sendPush(sub, payload, env).catch(() => null);
        // подписка протухла — убираем, иначе будем долбиться в неё вечно
        if (r && (r.status === 404 || r.status === 410)) {
          await env.DB.prepare('DELETE FROM subs WHERE endpoint=?').bind(sub.endpoint).run();
        }
      }

      chosen.forEach(n => { notified[n.key] = now; });

      // следующая проверка — время ближайшего события, о котором ещё не сообщали
      const rest = needs.filter(n => !notified[n.key]).sort((a, b) => a.at - b.at)[0];
      const today = localParts(now, pet.tz).day;
      const usedToday = pet.notify_day === today ? (pet.notify_count || 0) : 0;

      await env.DB.prepare(
        `UPDATE pets SET notified=?, next_call_at=?, call_reason=?, last_notify=?,
                         notify_day=?, notify_count=? WHERE token=?`
      ).bind(JSON.stringify(notified), rest ? rest.at : null,
             rest ? rest.title : null, now,
             today, usedToday + chosen.length, pet.token).run();
    }
  }
};
