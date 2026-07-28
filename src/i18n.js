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
      const res = patterns[i].out.replace(/\{\*\}/g, () => m[n++] ?? '');
      if (res !== s) return res;
    }
    return null;
  }

  function lookup(raw) {
    const s = norm(raw);
    if (!s || s.length > 400) return null;
    if (!/[A-Za-z]/.test(s)) return null;          // уже русский / только цифры

    if (DICT[s] != null) return DICT[s];
    const l = s.toLowerCase();
    if (lower[l] != null) return lower[l];

    // игра обрезает длинные пункты многоточием: "past generation…"
    const m = s.match(/^(.*?)(\s*(?:\u2026|\.\.\.))$/);
    if (m) {
      const base = m[1].trim();
      const hit = DICT[base] != null ? DICT[base] : lower[base.toLowerCase()];
      if (hit != null) return hit + m[2];
    }

    // с числами
    const nk = numKey(s);
    if (nk !== s) {
      const hit = DICT[nk] != null ? DICT[nk] : lower[nk.toLowerCase()];
      if (hit != null) {
        const nums = s.match(/\d+/g) || [];
        let i = 0;
        return hit.replace(/\{n\}/g, () => nums[i++] ?? '');
      }
    }

    // фразы с подставленными именами и числами
    const byPattern = matchPattern(s);
    if (byPattern != null) return byPattern;

    // не нашли — копим для дословаря
    if (/[a-z]{2}/.test(s)) missing.set(s, (missing.get(s) || 0) + 1);
    return null;
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
