// AsterCaeser webview bridge.
// Include this script in a local app displayed by the editor's Web view:
// <script src="http://localhost:7860/static/js/editor/webview-bridge.js"></script>
//
// It exposes only the rendered, visible page text to a trusted local
// AsterCaeser parent. It does not expose cookies, storage, source code, or
// arbitrary DOM nodes.
(function () {
  'use strict';

  window.__ASTERCAESER_WEBVIEW_BRIDGE__ = true;

  const REQUEST = 'astercaeser-webview-snapshot-request';
  const RESPONSE = 'astercaeser-webview-snapshot';
  const SELECT_REQUEST = 'astercaeser-webview-select-element';
  const SELECTED = 'astercaeser-webview-element-selected';
  const MAX_TEXT = 40_000;
  const MAX_ELEMENTS = 300;

  function isTrustedParent(origin) {
    try {
      const url = new URL(origin);
      return url.protocol === 'http:' && (
        url.hostname === 'localhost'
        || url.hostname === '127.0.0.1'
        || url.hostname === '[::1]'
      );
    } catch (_) {
      return false;
    }
  }

  function elementSelector(element) {
    const parts = [];
    let current = element;
    while (current && current.nodeType === 1 && current !== document.body && parts.length < 6) {
      let part = current.tagName.toLowerCase();
      if (current.id) part += `#${CSS.escape(current.id)}`;
      else if (current.classList.length) part += [...current.classList].slice(0, 3).map(name => `.${CSS.escape(name)}`).join('');
      parts.unshift(part);
      current = current.parentElement;
    }
    return parts.join(' > ');
  }

  function describeElement(element, includeMarkup = false) {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const type = String(element.getAttribute('type') || '').toLowerCase();
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return null;
    if (!rect.width || !rect.height || type === 'password' || element.disabled) return null;
    const item = {
      tag: element.tagName.toLowerCase(),
      id: element.id || '',
      className: typeof element.className === 'string' ? element.className.slice(0, 500) : '',
      selector: elementSelector(element),
      role: element.getAttribute('role') || '',
      label: element.getAttribute('aria-label') || element.getAttribute('title') || '',
      testId: element.getAttribute('data-od-id') || '',
      text: String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500),
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      styles: {
        color: style.color,
        backgroundColor: style.backgroundColor,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        display: style.display,
      },
    };
    if (element.matches('input,select,textarea')) {
      item.type = type || element.tagName.toLowerCase();
      item.name = element.getAttribute('name') || '';
      if (type !== 'password') item.value = String(element.value || '').slice(0, 300);
    }
    if (element.matches('a') && element.href) item.href = element.href;
    if (includeMarkup) item.outerHTML = element.outerHTML.slice(0, 2_000);
    return item;
  }

  function snapshot() {
    const text = String(document.body?.innerText || '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    const elements = [];
    const selector = 'h1,h2,h3,h4,h5,h6,button,a,input,select,textarea,table,thead,tbody,tr,th,td,[role],[data-od-id]';
    document.querySelectorAll(selector).forEach((element) => {
      if (elements.length >= MAX_ELEMENTS) return;
      const item = describeElement(element);
      if (item) elements.push(item);
    });
    return {
      type: RESPONSE,
      url: window.location.href,
      title: document.title || '',
      text: text.slice(0, MAX_TEXT),
      truncated: text.length > MAX_TEXT,
      elements,
      at: Date.now(),
    };
  }

  let selecting = false;
  let parentOrigin = '';
  let hovered = null;
  let previousOutline = '';
  const selectable = '*';

  function selectionCandidate(target) {
    if (!target || target === document.documentElement || target === document.body) return null;
    return target.closest('button,a,input,select,textarea,[role],[data-od-id],article,section,main,nav,aside,header,footer,div,li,td,th') || target;
  }

  function stopSelection() {
    selecting = false;
    if (hovered) hovered.style.outline = previousOutline;
    hovered = null;
    document.body.style.cursor = '';
  }

  window.addEventListener('mousemove', function (event) {
    if (!selecting) return;
    const target = selectionCandidate(event.target);
    if (target === hovered) return;
    if (hovered) hovered.style.outline = previousOutline;
    hovered = target && describeElement(target) ? target : null;
    if (hovered) {
      previousOutline = hovered.style.outline;
      hovered.style.outline = '2px solid #58a6ff';
    }
  }, true);

  window.addEventListener('click', function (event) {
    if (!selecting) return;
    const target = selectionCandidate(event.target);
    const element = target ? describeElement(target, true) : null;
    if (!element || !isTrustedParent(parentOrigin)) return;
    event.preventDefault();
    event.stopPropagation();
    try { window.parent.postMessage({ type: SELECTED, element }, parentOrigin); } catch (_) {}
    stopSelection();
  }, true);

  window.addEventListener('message', function (event) {
    if (event.source !== window.parent || !event.data) return;
    if (!isTrustedParent(event.origin)) return;
    if (event.data.type === SELECT_REQUEST) {
      parentOrigin = event.origin;
      selecting = true;
      document.body.style.cursor = 'crosshair';
      return;
    }
    if (event.data.type !== REQUEST) return;
    try { window.parent.postMessage(snapshot(), event.origin); } catch (_) {}
  });
}());
