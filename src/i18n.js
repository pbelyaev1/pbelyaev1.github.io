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

  function lookup(raw, collect) {
    const s = norm(raw);
    if (!s || s.length > 400) return null;
    if (!/[A-Za-z]/.test(s)) return null;          // уже русский / только цифры

    const direct = lookupCore(s);
    if (direct != null) return direct;

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
