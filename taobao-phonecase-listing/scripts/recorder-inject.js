(function () {
  if (window.__codexRec && window.__codexRec.version) return;

  var QUEUE = [];
  var MAX_QUEUE = 5000;

  function push(ev) {
    ev.t = Date.now();
    QUEUE.push(ev);
    if (QUEUE.length > MAX_QUEUE) QUEUE.splice(0, QUEUE.length - MAX_QUEUE);
  }

  function clean(text, limit) {
    return String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, limit || 80);
  }

  function stableClasses(el) {
    var raw = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
    return raw
      .filter(function (c) {
        if (c.length > 30) return false;
        if (/^[a-z]*[0-9a-f]{6,}$/i.test(c)) return false;
        if (/^\d/.test(c)) return false;
        if (/^(active|hover|focus|selected|is-|js-)/i.test(c) && c.length > 24) return false;
        return true;
      })
      .slice(0, 4);
  }

  function cssPath(el) {
    var parts = [];
    var node = el;
    var depth = 0;
    while (node && node.nodeType === 1 && depth < 8) {
      var tag = node.tagName.toLowerCase();
      var id = node.getAttribute('id');
      if (id && /^[A-Za-z][\w\-]*$/.test(id)) {
        parts.unshift('#' + id);
        break;
      }
      var part = tag;
      var cls = stableClasses(node);
      if (cls.length) part += '.' + cls.join('.');
      var parent = node.parentElement;
      if (parent) {
        var same = [];
        for (var i = 0; i < parent.children.length; i++) {
          if (parent.children[i].tagName === node.tagName) same.push(parent.children[i]);
        }
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = node.parentElement;
      depth++;
    }
    return parts.join(' > ');
  }

  function xPath(el) {
    var parts = [];
    var node = el;
    var depth = 0;
    while (node && node.nodeType === 1 && depth < 12) {
      var idx = 1;
      var sib = node.previousElementSibling;
      while (sib) {
        if (sib.tagName === node.tagName) idx++;
        sib = sib.previousElementSibling;
      }
      parts.unshift(node.tagName.toLowerCase() + '[' + idx + ']');
      node = node.parentElement;
      depth++;
    }
    return '/html/' + parts.join('/');
  }

  function describe(el) {
    if (!el || el.nodeType !== 1) return null;
    var attrs = {};
    var list = el.attributes || [];
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (a.name === 'class' || a.name === 'style') continue;
      if (a.name.length > 40) continue;
      var v = String(a.value);
      if (v.length > 200) v = v.slice(0, 200);
      attrs[a.name] = v;
    }
    var rect = null;
    try {
      var r = el.getBoundingClientRect();
      rect = [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
    } catch (e) {}

    var out = {
      tag: el.tagName.toLowerCase(),
      id: el.getAttribute('id') || null,
      classes: stableClasses(el),
      attrs: attrs,
      text: clean(el.innerText || el.textContent, 80),
      role: el.getAttribute('role') || null,
      ariaLabel: el.getAttribute('aria-label') || null,
      name: el.getAttribute('name') || null,
      type: el.getAttribute('type') || null,
      placeholder: el.getAttribute('placeholder') || null,
      href: el.tagName === 'A' ? el.getAttribute('href') : null,
      css: cssPath(el),
      xpath: xPath(el),
      rect: rect
    };
    if (el.scrollWidth && el.clientWidth) {
      out.overflow = el.scrollWidth > el.clientWidth + 4;
    }
    return out;
  }

  function readValue(el) {
    try {
      if (el.tagName === 'SELECT') {
        return {
          kind: 'select',
          value: el.value,
          optionText: el.options && el.selectedIndex >= 0 ? el.options[el.selectedIndex].text : null
        };
      }
      if (el.isContentEditable) {
        return { kind: 'contenteditable', value: clean(el.innerText, 300) };
      }
      var type = (el.getAttribute('type') || '').toLowerCase();
      if (type === 'password') return { kind: 'password', value: '***' };
      if (type === 'checkbox' || type === 'radio') {
        return { kind: type, value: String(el.checked), checked: !!el.checked };
      }
      return { kind: 'text', value: String(el.value == null ? '' : el.value).slice(0, 500) };
    } catch (e) {
      return { kind: 'unknown', value: null };
    }
  }

  function targetOf(ev) {
    var t = ev.target;
    if (t && t.nodeType === 3) t = t.parentElement;
    return t;
  }

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    return !!el.isContentEditable;
  }

  document.addEventListener(
    'click',
    function (ev) {
      var el = targetOf(ev);
      if (!el) return;
      var closest = null;
      try {
        closest = el.closest('a,button,[role="button"],[role="tab"],[role="option"],li,label,span,div,i,img');
      } catch (e) {}
      push({
        kind: 'click',
        button: ev.button,
        target: describe(el),
        closestActionable: closest && closest !== el ? describe(closest) : null
      });
    },
    true
  );

  document.addEventListener(
    'dblclick',
    function (ev) {
      var el = targetOf(ev);
      push({ kind: 'dblclick', target: describe(el) });
    },
    true
  );

  document.addEventListener(
    'contextmenu',
    function (ev) {
      push({ kind: 'contextmenu', target: describe(targetOf(ev)) });
    },
    true
  );

  var lastValue = new WeakMap();

  function onValueEvent(ev, kind) {
    var el = targetOf(ev);
    if (!isEditable(el)) return;
    var info = readValue(el);
    if (kind === 'input' && info.kind === 'text' && lastValue.get(el) === info.value) return;
    lastValue.set(el, info.value);
    push({
      kind: kind,
      valueKind: info.kind,
      value: info.value,
      optionText: info.optionText || null,
      checked: info.checked,
      target: describe(el)
    });
  }

  document.addEventListener('input', function (ev) { onValueEvent(ev, 'input'); }, true);
  document.addEventListener('change', function (ev) { onValueEvent(ev, 'change'); }, true);

  document.addEventListener(
    'paste',
    function (ev) {
      var el = targetOf(ev);
      var text = '';
      try {
        text = (ev.clipboardData || window.clipboardData).getData('text') || '';
      } catch (e) {}
      push({
        kind: 'paste',
        pastedText: String(text).slice(0, 500),
        target: describe(el)
      });
    },
    true
  );

  document.addEventListener(
    'keydown',
    function (ev) {
      var keys = ['Enter', 'Escape', 'Tab', 'Delete', 'Backspace', 'ArrowDown', 'ArrowUp'];
      var mod = ev.ctrlKey || ev.metaKey || ev.altKey;
      if (keys.indexOf(ev.key) === -1 && !(mod && ev.key.length === 1)) return;
      push({
        kind: 'key',
        key: ev.key,
        ctrl: ev.ctrlKey,
        meta: ev.metaKey,
        alt: ev.altKey,
        shift: ev.shiftKey,
        target: describe(targetOf(ev))
      });
    },
    true
  );

  document.addEventListener(
    'focusin',
    function (ev) {
      var el = targetOf(ev);
      if (!isEditable(el)) return;
      push({ kind: 'focus', target: describe(el) });
    },
    true
  );

  window.__codexRec = {
    version: 1,
    queue: QUEUE,
    drain: function () {
      return QUEUE.splice(0, QUEUE.length);
    },
    info: function () {
      return { url: location.href, title: document.title };
    }
  };
})();
