/* ============================================================================
   Слой русификации для Tamaweb.
   Ничего в исходном коде игры не меняет — просто переводит текст в DOM,
   когда он там появляется. Поэтому обновление оригинальной игры
   не ломает перевод: достаточно заново положить рядом эти два файла.

   Словарь: resources/data/ru.js  (глобальная переменная RU_DICT)

   Как дособрать словарь:
     1. играй как обычно;
     2. в консоли браузера набери  I18N.missing()   — покажет всё,
        что встретилось на экране, но перевода не нашло;
     3. набери  I18N.download()   — скачает файл missing.json,
        его можно отдать на перевод и дописать в ru.js.
   ============================================================================ */
(function () {
  'use strict';

  const DICT = (typeof RU_DICT !== 'undefined') ? RU_DICT : {};
  const missing = new Map();

  /* ---- нормализация: приводим строку к ключу словаря ---- */
  function norm(s) {
    return s.replace(/\s+/g, ' ').trim();
  }
  // «Level 12» -> «Level {n}», чтобы одна запись покрывала все числа
  function numKey(s) {
    return s.replace(/\d+/g, '{n}');
  }

  const lower = {};
  for (const k in DICT) lower[k.toLowerCase()] = DICT[k];

  /* ---- шаблоны с подстановками ----
     Ключ "{*} съел {*}" ловит любую фразу, куда игра подставила имя или предмет.
     Захваченные куски переносятся в перевод в том же порядке.            */
  const RX_ESC = /[.*+?^${}()|[\]\\]/g;
  const patterns = [];
  for (const k in DICT) {
    if (k.indexOf('{*}') === -1) continue;
    const rx = new RegExp('^' + k.split('{*}').map(s => s.replace(RX_ESC, '\\$&')).join('([\\s\\S]*?)') + '$');
    patterns.push({ rx, out: DICT[k], len: k.length });
  }
  patterns.sort((a, b) => b.len - a.len);   // сначала самые конкретные

  function matchPattern(s) {
    for (let i = 0; i < patterns.length; i++) {
      const m = s.match(patterns[i].rx);
      if (!m) continue;
      let n = 1;
      const res = patterns[i].out.replace(/\{\*\}/g, () => {
        const piece = m[n++] ?? '';
        // то, что игра подставила внутрь фразы, тоже может требовать перевода
        const t = piece && piece.trim();
        if (t) {
          const dur = duration(t);
          if (dur != null) return piece.replace(t, dur);
          const hit = DICT[t] != null ? DICT[t] : lower[t.toLowerCase()];
          if (hit != null) return piece.replace(t, hit);
        }
        return piece;
      });
      if (res !== s) return res;
    }
    return null;
  }

  /* Игра сама режет длинные подписи и дописывает многоточие: "gameplay settin\u2026".
     Точного совпадения у обрубка быть не может, поэтому ищем ключ,
     который начинается так же. Берём самый короткий подходящий —
     он почти всегда и есть исходная подпись.                              */
  const keysLower = Object.keys(DICT).map(k => [k.toLowerCase(), k]).sort();
  const prefixCache = new Map();
  function prefixMatch(base) {
    const b = base.toLowerCase();
    if (b.length < 4) return null;
    if (prefixCache.has(b)) return prefixCache.get(b);
    // Кандидатов может быть несколько ("underworld tickets" и "Underworld Entrance").
    // Сначала предпочитаем совпадение по регистру первой буквы — подписи меню
    // пишутся так же, как в исходнике. При равенстве берём более короткий ключ.
    const upper = /^[A-Z]/.test(base);
    let best = null, bestScore = -Infinity;
    for (let i = 0; i < keysLower.length; i++) {
      const kl = keysLower[i][0];
      if (kl.length <= b.length || kl.indexOf(b) !== 0) continue;
      const orig = keysLower[i][1];
      const score = (/^[A-Z]/.test(orig) === upper ? 1000 : 0) - kl.length;
      if (score > bestScore) { bestScore = score; best = keysLower[i]; }
    }
    const res = best ? DICT[best[1]] : null;
    prefixCache.set(b, res);
    return res;
  }

  function lookupCore(s) {
    if (DICT[s] != null) return DICT[s];
    const l = s.toLowerCase();
    if (lower[l] != null) return lower[l];
    const nk = numKey(s);
    if (nk !== s) {
      const hit = DICT[nk] != null ? DICT[nk] : lower[nk.toLowerCase()];
      if (hit != null) {
        const nums = s.match(/\d+/g) || [];
        let i = 0;
        return hit.replace(/\{n\}/g, () => nums[i++] ?? '');
      }
    }
    return matchPattern(s);
  }

  /* ---------- время: правильные окончания ----------
     Игра собирает такие подписи руками: `${n} minute${n !== 1 ? 's' : ''}`.
     Словарём это не покрыть — по-русски у числительных три формы. */
  const UNITS = {
    second: ['секунда', 'секунды', 'секунд'],
    minute: ['минута', 'минуты', 'минут'],
    hour:   ['час', 'часа', 'часов'],
    day:    ['день', 'дня', 'дней'],
    week:   ['неделя', 'недели', 'недель'],
    month:  ['месяц', 'месяца', 'месяцев'],
    year:   ['год', 'года', 'лет'],
  };
  function plural(n, forms) {
    const ones = n % 10, tens = n % 100;
    if (ones === 1 && tens !== 11) return forms[0];
    if (ones >= 2 && ones <= 4 && (tens < 12 || tens > 14)) return forms[1];
    return forms[2];
  }
  function duration(s) {
    let m = s.match(/^(\d+)\s+(second|minute|hour|day|week|month|year)s?$/i);
    if (m) return m[1] + ' ' + plural(+m[1], UNITS[m[2].toLowerCase()]);
    m = s.match(/^(\d+)\s+hours?\s+and\s+(\d+)\s+minutes?$/i);
    if (m) return m[1] + ' ' + plural(+m[1], UNITS.hour) + ' и ' + m[2] + ' ' + plural(+m[2], UNITS.minute);
    return null;
  }

  function lookup(raw, collect) {
    const s = norm(raw);
    if (!s || s.length > 400) return null;
    if (!/[A-Za-z]/.test(s)) return null;          // уже русский / только цифры

    const dur = duration(s);
    if (dur != null) return dur;

    const direct = lookupCore(s);
    if (direct != null) return direct;

    // подписи предметов приходят с количеством: "rattle (x1)", "milk (x\u221E)"
    const qty = s.match(/^(.*\S)\s*(\((?:x|\u00D7)\s*[\d\u221E]+\))$/i);
    if (qty) {
      const hit = lookupCore(qty[1]);
      if (hit != null) return hit + ' ' + qty[2];
    }

    // подписи настроек приходят с двоеточием: "auto aging:"
    const colon = s.match(/^(.*\S)\s*:$/);
    if (colon) {
      const hit = lookupCore(colon[1]);
      if (hit != null) return hit + ':';
    }

    // снимаем номер в начале ("#12 ") и многоточие в конце — они мешают поиску
    let head = '', body = s;
    const num = body.match(/^(#\s*\d+[.)]?\s+)(.+)$/);
    if (num) { head = num[1]; body = num[2]; }
    let cut = false;
    const ell = body.match(/^(.*?)\s*(?:\u2026|\.\.\.)$/);
    if (ell) { body = ell[1].trim(); cut = true; }

    if (head || cut) {
      const hit = lookupCore(body);
      if (hit != null) return head + hit;      // перевод целый — многоточие ни к чему
      // обрубок слова: ищем ключ по началу и подставляем подпись целиком
      if (cut) {
        const p = prefixMatch(body);
        if (p != null) return head + p;
      }
    }

    // не нашли — копим для дословаря
    if (collect !== false && /[a-z]{2}/.test(s)) missing.set(s, (missing.get(s) || 0) + 1);
    return null;
  }

  /* ---- целые предложения, разорванные тегами ----
     Игра пишет «Your browser may <b>delete</b> it unexpectedly.» — браузер видит
     три отдельных куска текста, и по отдельности они не переводятся.
     Здесь мы берём элемент целиком, сверяем его текст со словарём и,
     если нашли, заменяем содержимое переводом. Жирность внутри теряется,
     но фраза становится связной.                                          */
  const INLINE_OK = new Set(['B','I','U','EM','STRONG','BR','SPAN','SMALL','FONT','LABEL','P','SUP','SUB']);
  function isSimpleBlock(el) {
    if (el.__i18nBlock) return false;
    if (el.querySelector('button,input,canvas,img,svg,select,textarea,a,video')) return false;
    const kids = el.querySelectorAll('*');
    if (!kids.length) return false;                 // без тегов внутри — обычный текстовый узел
    for (const d of kids) if (!INLINE_OK.has(d.tagName)) return false;
    return true;
  }
  function translateBlock(el) {
    if (!isSimpleBlock(el)) return false;
    const txt = norm(el.textContent || '');
    if (!txt || txt.length > 320) return false;
    if (!/[A-Za-z]{3}/.test(txt)) return false;
    const hit = lookup(txt, false);
    if (hit == null) return false;
    el.textContent = hit;
    el.__i18nBlock = true;
    return true;
  }

  /* ---- перевод одного текстового узла ---- */
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE']);

  function translateTextNode(node) {
    const p = node.parentNode;
    if (!p || SKIP_TAGS.has(p.nodeName)) return;
    if (p.closest && p.closest('[data-no-i18n]')) return;
    const raw = node.textContent;
    if (!raw || !raw.trim()) return;
    const hit = lookup(raw);
    if (hit == null) return;
    // сохраняем отступы вокруг текста, иначе слова слипаются
    const pre = raw.match(/^\s*/)[0], post = raw.match(/\s*$/)[0];
    if (node.__i18nSrc === raw) return;             // уже переводили этот же текст
    node.textContent = pre + hit + post;
    node.__i18nSrc = node.textContent;
  }

  const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
  function translateAttrs(el) {
    if (!el.getAttribute) return;
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (!v) continue;
      const hit = lookup(v);
      if (hit != null && hit !== v) el.setAttribute(a, hit);
    }
    // значение кнопок input[type=button|submit]
    if (el.tagName === 'INPUT' && /button|submit/i.test(el.type || '')) {
      const hit = lookup(el.value || '');
      if (hit != null) el.value = hit;
    }
  }

  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) return translateTextNode(root);
    if (root.nodeType !== 1) return;
    if (SKIP_TAGS.has(root.nodeName)) return;
    translateAttrs(root);

    // сначала целые предложения — иначе куски переведутся по отдельности
    // и склеить их обратно будет уже нечем
    translateBlock(root);
    if (root.querySelectorAll) {
      const blocks = root.querySelectorAll('*');
      for (let i = 0; i < blocks.length; i++) translateBlock(blocks[i]);
    }

    const it = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const list = [];
    let n;
    while ((n = it.nextNode())) list.push(n);
    list.forEach(translateTextNode);
    if (root.querySelectorAll) root.querySelectorAll('[placeholder],[title],[alt],input').forEach(translateAttrs);
  }

  /* ---- следим за DOM: игра постоянно перерисовывает экран ---- */
  let scheduled = false;
  const pending = new Set();
  function flush() {
    scheduled = false;
    const nodes = [...pending];
    pending.clear();
    nodes.forEach(walk);
  }
  function schedule(node) {
    pending.add(node);
    if (!scheduled) { scheduled = true; requestAnimationFrame(flush); }
  }

  const observer = new MutationObserver(muts => {
    for (const m of muts) {
      if (m.type === 'characterData') schedule(m.target);
      else m.addedNodes.forEach(schedule);
    }
  });

  function start() {
    walk(document.body);
    observer.observe(document.body, {
      childList: true, subtree: true, characterData: true
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
  // игра догружается асинхронно — пройдёмся ещё раз позже
  setTimeout(() => walk(document.body), 2500);
  setTimeout(() => walk(document.body), 8000);

  /* ---- инструменты для дописывания словаря ---- */
  window.I18N = {
    dict: DICT,
    retranslate: () => walk(document.body),
    missing() {
      const arr = [...missing.entries()].sort((a, b) => b[1] - a[1]);
      console.table(arr.map(([en, n]) => ({ en, встречалось: n })));
      return arr.map(([en]) => en);
    },
    download() {
      const arr = [...missing.keys()].sort();
      const blob = new Blob([JSON.stringify(arr, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'missing.json';
      a.click();
      console.log('Строк без перевода:', arr.length);
    },
    off() { observer.disconnect(); location.reload(); }
  };
})();

/* ============================================================================
   Имена для новых питомцев — на японский манер, русскими буквами.

   В оригинальных тамагочи имя складывается из японской основы и окончания
   -tchi / -chi / -chu / -ko: Mametchi, Kuchipatchi, Mimitchi, Makiko.
   Здесь то же самое, только кириллицей: Маметчи, Кучипатчи, Мимитчи, Макико.

   Функция getRandomName объявлена в Utils.js как обычная функция, то есть
   живёт в window — её можно подменить. Ждём, пока Utils.js загрузится,
   иначе он перезапишет нашу подмену своей.
   ============================================================================ */
(function () {
  'use strict';

  /* Основы намеренно не заканчиваются на «чи», «ти», «чу» и «ко»,
     чтобы с окончанием не выходило заикание вроде «Кококо». */
  const STEMS = [
    'Ака','Аки','Ама','Ари','Аса','Аюми','Бента','Вата','Гин','Гозару',
    'Дайфу','Дзуки','Дора','Ёши','Ика','Ина','Иро','Кабу','Каге','Кайто',
    'Каме','Кана','Кику','Кина','Кира','Кицу','Кома','Кону','Кото','Кума',
    'Кури','Куро','Кучипа','Маки','Маме','Мари','Маро','Мару','Меме','Мидо',
    'Мике','Мими','Мири','Мозу','Момидзи','Момо','Мори','Муги','Мура','Нами',
    'Нана','Нару','Нацу','Ниси','Нобу','Нори','Нэри','Ня','Оки','Онига',
    'Оядзи','Пуку','Пури','Рики','Рина','Рири','Руми','Рэй','Сакура','Сато',
    'Сиро','Соба','Сузу','Суми','Сэн','Така','Таки','Тама','Танпо','Тара',
    'Тоби','Тора','Тофу','Тэн','Уме','Уса','Фува','Фуку','Фуми','Хана',
    'Хару','Химе','Хина','Хиро','Хоси','Цуки','Чаме','Чиби','Шима','Юки',
    'Юме','Юри','Яки','Ями','Ясу','Ямато','Кинта','Дайза','Нэги','Аоба'
  ];
  const SUFFIXES = ['чи', 'чу', 'тчи', 'ко'];

  function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function ruRandomName(seed, noSuffix) {
    // seed используется игрой, чтобы имя друга всегда получалось одним и тем же
    if (seed) {
      try {
        pRandom.save();
        pRandom.seed = seed;
        const n = pRandomFromArray(STEMS);
        const s = pRandomFromArray(SUFFIXES);
        pRandom.load();
        return n + s;
      } catch (e) { /* дальше обычным способом */ }
    }
    return pick(STEMS) + (noSuffix ? '' : pick(SUFFIXES));
  }
  ruRandomName.__ru = true;

  let tries = 0;
  const timer = setInterval(() => {
    if (typeof window.getRandomName === 'function' && !window.getRandomName.__ru) {
      window.getRandomName = ruRandomName;
    }
    if (++tries > 600) clearInterval(timer);   // ~30 секунд
  }, 50);
})();

/* ============================================================================
   Относительное время по-русски.

   moment.js в игре подключён без локалей, поэтому fromNow() и humanize()
   говорили «in 3 hours», «2 days ago», «a month». Числовые формы словарь ещё
   как-то ловил, а одиночные («an hour», «a day») — нет. Описываем локаль
   прямо здесь: правила множественного числа в русском такие, что без функции
   не обойтись — 1 час, 2 часа, 5 часов.
   ============================================================================ */
(function () {
  'use strict';

  function forms(word, num) {
    const f = word.split('_');
    if (num % 10 === 1 && num % 100 !== 11) return f[0];
    if (num % 10 >= 2 && num % 10 <= 4 && (num % 100 < 10 || num % 100 >= 20)) return f[1];
    return f[2];
  }

  /* withoutSuffix — это форма «сколько прошло» («2 минуты»), без него нужен
     винительный падеж для «через минуту» и «минуту назад». */
  function withPlural(number, withoutSuffix, key) {
    const map = {
      ss: withoutSuffix ? 'секунда_секунды_секунд' : 'секунду_секунды_секунд',
      mm: withoutSuffix ? 'минута_минуты_минут' : 'минуту_минуты_минут',
      hh: 'час_часа_часов',
      dd: 'день_дня_дней',
      MM: 'месяц_месяца_месяцев',
      yy: 'год_года_лет',
    };
    if (key === 'm') return withoutSuffix ? 'минута' : 'минуту';
    return number + ' ' + forms(map[key], +number);
  }

  function apply() {
    if (typeof moment === 'undefined' || !moment.defineLocale) return false;
    if (moment.locale() === 'ru-tama') return true;
    try {
      moment.defineLocale('ru-tama', {
        months: 'января_февраля_марта_апреля_мая_июня_июля_августа_сентября_октября_ноября_декабря'.split('_'),
        monthsShort: 'янв_фев_мар_апр_мая_июн_июл_авг_сен_окт_ноя_дек'.split('_'),
        weekdays: 'воскресенье_понедельник_вторник_среда_четверг_пятница_суббота'.split('_'),
        weekdaysShort: 'вс_пн_вт_ср_чт_пт_сб'.split('_'),
        weekdaysMin: 'вс_пн_вт_ср_чт_пт_сб'.split('_'),
        longDateFormat: {
          LT: 'H:mm', LTS: 'H:mm:ss', L: 'DD.MM.YYYY', LL: 'D MMMM YYYY г.',
          LLL: 'D MMMM YYYY г., H:mm', LLLL: 'dddd, D MMMM YYYY г., H:mm',
        },
        calendar: {
          sameDay: '[Сегодня в] LT', nextDay: '[Завтра в] LT', lastDay: '[Вчера в] LT',
          nextWeek: 'dddd [в] LT', lastWeek: '[в прошлый] dddd [в] LT', sameElse: 'L',
        },
        relativeTime: {
          future: 'через %s', past: '%s назад',
          s: 'несколько секунд', ss: withPlural,
          m: withPlural, mm: withPlural,
          h: 'час', hh: withPlural,
          d: 'день', dd: withPlural,
          M: 'месяц', MM: withPlural,
          y: 'год', yy: withPlural,
        },
        week: { dow: 1, doy: 4 },
      });
      moment.locale('ru-tama');
      return true;
    } catch (e) { return false; }
  }

  if (!apply()) {
    let tries = 0;
    const timer = setInterval(() => {
      if (apply() || ++tries > 600) clearInterval(timer);
    }, 50);
  }
})();

/* ============================================================================
   Болтовня питомца — по-русски.

   Оригинал складывает фразу из трёх английских слов и вставляет её в пузырь
   уже собранной, поэтому словарь тут бессилен: сочетаний десятки тысяч.
   Подменяем сам генератор, как раньше подменили getRandomName.

   Чтобы получалось грамотно, а не «Кот хотеть печенье»:
     • подлежащее берём только в третьем лице единственного числа —
       тогда любой глагол из списка с ним согласуется;
     • дополнения храним парой «именительный / винительный», иначе
       «хочет звезда» вместо «хочет звезду»;
     • вопросы разделены на два вида — те, после которых нужен именительный
       падеж, и те, после которых винительный.
   ============================================================================ */
(function () {
  'use strict';

  const SUBJ = [
    'Кот','Собака','Птица','Мышь','Рыбка','Заяц','Лиса','Медведь','Корова','Свинья',
    'Ящерица','Черепаха','Монстр','Призрак','Пришелец','Робот','Волшебник','Герой','Злодей','Фея',
    'Дракон','Зомби','Друг','Незнакомец','Помощник','Малыш','Учитель','Тень','Свет','Сон',
    'Магия','Звезда','Эхо','Голос','Время','Идея','Кто-то','Ветер','Луна','Облако',
  ];

  const VERB = [
    'любит','хочет','видит','открывает','чувствует','ест','прячет','слышит','находит','трогает',
    'несёт','роняет','даёт','берёт','закрывает','пробует','делает','строит','ломает','чинит',
    'ищет','помнит','забывает','рисует','читает','считает','моет','украшает','обнимает','щекочет',
    'пугает','ждёт','зовёт','тянет','толкает','бросает','ловит','греет','нюхает','грызёт',
    'играет в','думает про','смотрит на','мечтает про','спрашивает про',
  ];

  /* [именительный, винительный] */
  const OBJ = [
    ['игрушка','игрушку'],['игра','игру'],['головоломка','головоломку'],['кубик','кубик'],['наклейка','наклейку'],
    ['мяч','мяч'],['карточка','карточку'],['печенье','печенье'],['конфета','конфету'],['фрукт','фрукт'],
    ['торт','торт'],['сок','сок'],['молоко','молоко'],['суп','суп'],['хлеб','хлеб'],
    ['мороженое','мороженое'],['песня','песню'],['барабан','барабан'],['шум','шум'],['мелодия','мелодию'],
    ['шляпа','шляпу'],['книга','книгу'],['ручка','ручку'],['коробка','коробку'],['карта','карту'],
    ['монета','монету'],['стул','стул'],['одеяло','одеяло'],['подушка','подушку'],['кровать','кровать'],
    ['окно','окно'],['зеркало','зеркало'],['ключ','ключ'],['дверь','дверь'],['сумка','сумку'],
    ['лампа','лампу'],['верёвка','верёвку'],['кольцо','кольцо'],['экран','экран'],['кнопка','кнопку'],
    ['облако','облако'],['дождь','дождь'],['снег','снег'],['солнце','солнце'],['луна','луну'],
    ['дерево','дерево'],['цветок','цветок'],['листок','листок'],['камень','камень'],['песок','песок'],
    ['огонь','огонь'],['вода','воду'],['ветер','ветер'],['туман','туман'],['замок','замок'],
    ['башня','башню'],['мост','мост'],['тропинка','тропинку'],['комната','комнату'],['дом','дом'],
    ['школа','школу'],['лес','лес'],['пещера','пещеру'],['остров','остров'],['планета','планету'],
    ['цвет','цвет'],['узор','узор'],['число','число'],['буква','букву'],['слово','слово'],
    ['история','историю'],['шутка','шутку'],['правда','правду'],['тайна','тайну'],['сюрприз','сюрприз'],
    ['желание','желание'],['темнота','темноту'],['сон','сон'],['идея','идею'],['магия','магию'],
    ['звезда','звезду'],['искра','искру'],['пламя','пламя'],['тень','тень'],['портал','портал'],
    ['меч','меч'],['щит','щит'],['стрела','стрелу'],['шлем','шлем'],['корона','корону'],
    ['плащ','плащ'],['посох','посох'],['палочка','палочку'],['картина','картину'],['статуя','статую'],
    ['записка','записку'],['сообщение','сообщение'],['сигнал','сигнал'],['флаг','флаг'],['знак','знак'],
  ];

  const Q_ACC = [
    'Можно мне','Ты видишь','Хочешь','Дашь мне','Можно потрогать','Ты слышишь',
    'Давай найдём','Ты любишь','Покажешь мне','Можно взять','Давай попробуем','Ты помнишь',
    'Спрячем','Поищем','А ты видел','Можно посмотреть на',
  ];
  const Q_NOM = [
    'Где','Что такое','Это','А это','Куда пропала','Интересно, где',
  ];

  const pick = a => a[Math.floor(Math.random() * a.length)];

  function ruSentence(isQuestion = Math.random() > 0.5) {
    if (isQuestion) {
      /* «Куда пропала» согласуется только с женским родом — для остальных
         вопросов род не важен, поэтому такой вариант просто пропускаем. */
      const start = pick(Q_NOM.concat(Q_ACC));
      const o = pick(OBJ);
      if (Q_ACC.indexOf(start) !== -1) return start + ' ' + o[1] + '?';
      if (start === 'Куда пропала' && !/[аяь]$/.test(o[0])) return 'Где ' + o[0] + '?';
      return start + ' ' + o[0] + '?';
    }
    return pick(SUBJ) + ' ' + pick(VERB) + ' ' + pick(OBJ)[1];
  }
  /* Utils.js объявляет свой генератор через const, в window он не попадает и
     подменить его снаружи нельзя. Поэтому там стоит наша вставка, которая
     спрашивает вот эту функцию. */
  window.ruRandomSentence = ruSentence;
})();
