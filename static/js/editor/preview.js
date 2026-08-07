/*
 * Safe, standalone preview panel for the project editor.
 *
 * Integration contract (kept intentionally independent of editor.js):
 *
 *   const preview = createPreviewPanel({
 *     container: previewSlot,
 *     getActiveDocument: () => ({
 *       path, content, context: { workspaceId, projectId }
 *     }),
 *     onStatus: ({ mode, state, message }) => {},
 *     onClose: () => {},
 *   });
 *   await preview.renderPreview();       // current Markdown or Typst document
 *   preview.openWebPreview('http://localhost:3000');
 *
 * `renderPreview(document)` also accepts top-level `workspaceId`/`projectId`.
 * Typst is intentionally gated on BOTH IDs and a safe project-relative `.typ`
 * path before it calls the project-bound preview service.  This module owns no
 * editor lifecycle; the editor integration decides when to mount, render, or
 * refresh it.
 */

const DEFAULT_TYPST_ENDPOINT = '/api/workspace/typst/preview';
const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

function createElement(tag, className = '', text = null) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== null && text !== undefined) element.textContent = String(text);
  return element;
}

function extension(path) {
  const name = String(path || '').split('/').pop() || '';
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

function safeRelativePath(path) {
  if (typeof path !== 'string' || !path.trim() || path.includes('\0')) return null;
  const value = path.trim().replace(/\\/g, '/');
  if (value.startsWith('/') || /^[a-zA-Z]:\//.test(value)) return null;
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return null;
  return value;
}

function normaliseDocument(value) {
  const source = value && typeof value === 'object' ? value : {};
  const context = source.context && typeof source.context === 'object' ? source.context : {};
  return {
    path: String(source.path || source.filePath || ''),
    content: typeof source.content === 'string' ? source.content : '',
    projectId: String(source.projectId || source.project_id || context.projectId || context.project_id || ''),
    workspaceId: String(source.workspaceId || source.workspace_id || context.workspaceId || context.workspace_id || ''),
  };
}

function isSafeLinkUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (raw.startsWith('#') || raw.startsWith('/')) return raw;
  try {
    const url = new URL(raw);
    if (!SAFE_LINK_PROTOCOLS.has(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch (_) {
    return null;
  }
}

/** Returns the supported preview kind for a project-relative file path. */
export function previewKindForPath(path) {
  const ext = extension(path);
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (ext === '.typ') return 'typst';
  return null;
}

/** Accept explicit HTTP(S) pages only; javascript:, data:, and file: are rejected. */
export function validateWebPreviewUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    if (url.hostname === '0.0.0.0') {
      url.hostname = '127.0.0.1';
    } else if (url.hostname === '[::]') {
      url.hostname = '[::1]';
    }
    return url.href;
  } catch (_) {
    return null;
  }
}

function appendInline(target, source) {
  const text = String(source || '');
  // The parser only creates DOM nodes and writes source text through
  // textContent. It never assigns Markdown-derived HTML to innerHTML.
  const tokens = /(`[^`]*`|\*\*[^*]+\*\*|\*[^*\n]+\*|\[[^\]]*\]\([^\s)]+\))/g;
  let cursor = 0;
  let match;
  while ((match = tokens.exec(text))) {
    if (match.index > cursor) target.append(document.createTextNode(text.slice(cursor, match.index)));
    const token = match[0];
    if (token.startsWith('`')) {
      target.append(createElement('code', 'editor-markdown-inline-code', token.slice(1, -1)));
    } else if (token.startsWith('**')) {
      const strong = createElement('strong');
      appendInline(strong, token.slice(2, -2));
      target.append(strong);
    } else if (token.startsWith('*')) {
      const emphasis = createElement('em');
      appendInline(emphasis, token.slice(1, -1));
      target.append(emphasis);
    } else {
      const close = token.indexOf('](');
      const label = token.slice(1, close);
      const href = isSafeLinkUrl(token.slice(close + 2, -1));
      if (!href) {
        target.append(document.createTextNode(label));
      } else {
        const link = createElement('a');
        link.href = href;
        link.rel = 'noopener noreferrer';
        if (!href.startsWith('#') && !href.startsWith('/')) link.target = '_blank';
        appendInline(link, label);
        target.append(link);
      }
    }
    cursor = match.index + token.length;
  }
  if (cursor < text.length) target.append(document.createTextNode(text.slice(cursor)));
}

function isTableDivider(line) {
  const cells = String(line || '').trim().replace(/^\||\|$/g, '').split('|');
  return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell.trim()));
}

function tableCells(line) {
  return String(line || '').trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
}

function appendTable(target, headerLine, bodyLines) {
  const table = createElement('table', 'editor-markdown-table');
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  tableCells(headerLine).forEach(value => {
    const cell = document.createElement('th');
    appendInline(cell, value);
    headRow.append(cell);
  });
  head.append(headRow);
  table.append(head);
  const body = document.createElement('tbody');
  bodyLines.forEach(line => {
    const row = document.createElement('tr');
    tableCells(line).forEach(value => {
      const cell = document.createElement('td');
      appendInline(cell, value);
      row.append(cell);
    });
    body.append(row);
  });
  table.append(body);
  target.append(table);
}

/** Render Markdown with DOM/text nodes only; raw HTML remains visible text. */
export function renderMarkdown(content, target) {
  if (!target) return;
  target.replaceChildren();
  const lines = String(content || '').replace(/\r\n?/g, '\n').split('\n');
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }

    const fence = line.match(/^\s*```([^\s`]*)\s*$/);
    if (fence) {
      const codeLines = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) codeLines.push(lines[index++]);
      if (index < lines.length) index += 1;
      const pre = createElement('pre', 'editor-markdown-code-block');
      const code = document.createElement('code');
      if (fence[1]) code.dataset.language = fence[1].replace(/[^a-z0-9_+-]/gi, '').slice(0, 32);
      code.textContent = codeLines.join('\n');
      pre.append(code);
      target.append(pre);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const element = document.createElement(`h${level}`);
      appendInline(element, heading[2]);
      target.append(element);
      index += 1;
      continue;
    }

    const setext = index + 1 < lines.length && lines[index + 1].match(/^\s*(=+|-+)\s*$/);
    if (setext && line.trim()) {
      const element = document.createElement(setext[1].startsWith('=') ? 'h1' : 'h2');
      appendInline(element, line.trim());
      target.append(element);
      index += 2;
      continue;
    }

    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      target.append(createElement('hr', 'editor-markdown-rule'));
      index += 1;
      continue;
    }

    if (index + 1 < lines.length && line.includes('|') && isTableDivider(lines[index + 1])) {
      const tableBody = [];
      index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) tableBody.push(lines[index++]);
      appendTable(target, line, tableBody);
      continue;
    }

    const list = line.match(/^\s*([-+*]|\d+\.)\s+(.+)$/);
    if (list) {
      const ordered = /\d+\./.test(list[1]);
      const element = document.createElement(ordered ? 'ol' : 'ul');
      while (index < lines.length) {
        const item = lines[index].match(/^\s*([-+*]|\d+\.)\s+(.+)$/);
        if (!item || /\d+\./.test(item[1]) !== ordered) break;
        const li = document.createElement('li');
        const task = item[2].match(/^\[([ xX])\]\s+(.+)$/);
        if (task) {
          li.className = 'editor-markdown-task';
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.disabled = true;
          checkbox.checked = task[1].toLowerCase() === 'x';
          checkbox.setAttribute('aria-label', checkbox.checked ? 'Completed task' : 'Incomplete task');
          li.append(checkbox);
          appendInline(li, task[2]);
        } else {
          appendInline(li, item[2]);
        }
        element.append(li);
        index += 1;
      }
      target.append(element);
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      const blockquote = document.createElement('blockquote');
      appendInline(blockquote, quote[1]);
      target.append(blockquote);
      index += 1;
      continue;
    }

    const paragraph = [];
    while (index < lines.length && lines[index].trim()) {
      if (paragraph.length && (/^\s*```/.test(lines[index]) || /^(#{1,6})\s+/.test(lines[index]) || /^\s*([-+*]|\d+\.)\s+/.test(lines[index]))) break;
      if (paragraph.length && index + 1 < lines.length && lines[index].includes('|') && isTableDivider(lines[index + 1])) break;
      paragraph.push(lines[index++]);
    }
    const element = document.createElement('p');
    paragraph.forEach((part, offset) => {
      if (offset) {
        const previous = paragraph[offset - 1];
        element.append(/ {2}$/.test(previous) || /\\$/.test(previous)
          ? document.createElement('br')
          : document.createTextNode(' '));
      }
      appendInline(element, part.replace(/(?: {2,}|\\)$/, ''));
    });
    target.append(element);
  }
}

function responseDetail(payload, fallback) {
  if (!payload) return fallback;
  if (typeof payload === 'string') return payload;
  if (typeof payload.detail === 'string') return payload.detail;
  if (typeof payload.message === 'string') return payload.message;
  return fallback;
}

/**
 * Create a detached preview element or mount it in `container`.
 * The returned object is the only integration surface; this module imports no
 * editor runtime and attaches no global editor listeners.
 */
export function createPreviewPanel({
  container = null,
  getActiveDocument = () => null,
  onClose = null,
  onStatus = null,
  onOpenExternal = null,
  typstEndpoint = DEFAULT_TYPST_ENDPOINT,
} = {}) {
  const root = createElement('section', 'editor-preview-panel');
  root.hidden = true;
  root.setAttribute('aria-label', 'Document preview');
  root.setAttribute('aria-live', 'polite');
  if (container?.append) container.append(root);

  const toolbar = createElement('div', 'editor-preview-toolbar');
  const label = createElement('span', 'editor-preview-title', 'Preview');
  const status = createElement('span', 'editor-preview-status', 'Idle');
  const urlInput = document.createElement('input');
  urlInput.className = 'editor-preview-url';
  urlInput.type = 'url';
  urlInput.placeholder = 'https://… or http://localhost:3000';
  urlInput.autocomplete = 'off';
  urlInput.spellcheck = false;
  urlInput.hidden = true;
  urlInput.setAttribute('aria-label', 'Web preview URL');
  const actions = createElement('div', 'editor-preview-actions');
  const reload = createElement('button', 'editor-preview-action', 'Reload');
  reload.type = 'button';
  const external = createElement('button', 'editor-preview-action', 'Open external');
  external.type = 'button';
  external.disabled = true;
  const ratioToggle = createElement('button', 'editor-preview-action', 'Scale: Full');
  ratioToggle.type = 'button';
  ratioToggle.hidden = true;
  const closeButton = createElement('button', 'editor-preview-action editor-preview-close', 'Close');
  closeButton.type = 'button';
  actions.append(reload, external, ratioToggle, closeButton);
  toolbar.append(label, status, urlInput, actions);
  const body = createElement('div', 'editor-preview-content');
  root.append(toolbar, body);

  let mode = null;
  let activeDocument = null;
  let activeUrl = null;
  let abortController = null;
  let renderEpoch = 0;
  let typstUrls = [];
  let closed = false;
  let is169 = false;
  let resizeObserver = null;

  function revokeTypstUrls() {
    typstUrls.forEach(url => { try { URL.revokeObjectURL(url); } catch (_) {} });
    typstUrls = [];
  }

  function emitStatus(state, message, extra = {}) {
    status.textContent = message;
    status.dataset.state = state;
    const detail = { mode, state, message, document: activeDocument, ...extra };
    try { onStatus?.(detail); } catch (_) {}
    root.dispatchEvent(new CustomEvent('aster:preview-status', { detail }));
  }

  function show(nextMode, title) {
    closed = false;
    mode = nextMode;
    root.hidden = false;
    label.textContent = title;
    urlInput.hidden = nextMode !== 'web';
    ratioToggle.hidden = nextMode !== 'web';
    external.disabled = nextMode !== 'web' || !activeUrl;
  }

  function clearBody() {
    body.style.removeProperty('display');
    body.style.removeProperty('flex-direction');
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    revokeTypstUrls();
    body.replaceChildren();
  }

  function showState(kind, title, message, diagnostics = []) {
    clearBody();
    const panel = createElement('div', `editor-preview-state editor-preview-${kind}`);
    panel.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    panel.append(createElement('strong', '', title), createElement('p', '', message));
    if (diagnostics.length) {
      const list = createElement('ul', 'editor-preview-diagnostics');
      diagnostics.slice(0, 25).forEach(diagnostic => {
        const item = createElement('li');
        const position = [diagnostic?.file, diagnostic?.line, diagnostic?.column].filter(value => value !== undefined && value !== null && value !== '').join(':');
        if (position) item.append(createElement('span', 'editor-preview-diagnostic-position', `${position} `));
        item.append(document.createTextNode(String(diagnostic?.message || diagnostic || 'Compiler error')));
        list.append(item);
      });
      panel.append(list);
    }
    body.append(panel);
  }

  function renderMarkdownPreview(documentValue) {
    activeDocument = normaliseDocument(documentValue);
    activeUrl = null;
    show('markdown', `Markdown · ${activeDocument.path || 'Untitled'}`);
    clearBody();
    const article = createElement('article', 'editor-markdown-preview');
    renderMarkdown(activeDocument.content, article);
    body.append(article);
    emitStatus('ready', 'Rendered safely from the active buffer');
    return { mode, state: 'ready' };
  }

  function appendTypstPages(payload) {
    const pageValues = Array.isArray(payload?.pages) ? payload.pages : (payload?.svg ? [payload.svg] : []);
    const pages = pageValues.map(page => typeof page === 'string' ? page : page?.svg).filter(value => typeof value === 'string' && value.trim());
    if (!pages.length) return false;
    const pagesWrap = createElement('div', 'editor-typst-pages');
    pages.forEach((page, index) => {
      const image = document.createElement('img');
      image.className = 'editor-typst-page';
      image.alt = `Typst page ${index + 1}`;
      image.draggable = false;
      // SVG is placed in an image Blob rather than injected inline. An SVG's
      // event handlers/scripts therefore cannot execute in the app document.
      const url = URL.createObjectURL(new Blob([page], { type: 'image/svg+xml' }));
      typstUrls.push(url);
      image.src = url;
      pagesWrap.append(image);
    });
    body.append(pagesWrap);
    return true;
  }

  async function renderTypstPreview(documentValue) {
    activeDocument = normaliseDocument(documentValue);
    activeUrl = null;
    show('typst', `Typst · ${activeDocument.path || 'Untitled'}`);
    const path = safeRelativePath(activeDocument.path);
    if (!path || extension(path) !== '.typ' || !activeDocument.workspaceId || !activeDocument.projectId) {
      showState('unavailable', 'Typst preview needs project context', 'Open a project-bound .typ file before compiling.');
      emitStatus('unavailable', 'Project context is required for Typst preview');
      return { mode, state: 'unavailable' };
    }

    abortController?.abort();
    abortController = new AbortController();
    const epoch = ++renderEpoch;
    showState('loading', 'Compiling Typst', 'The project-bound compiler is rendering the active buffer.');
    emitStatus('loading', 'Compiling Typst');
    try {
      const response = await fetch(typstEndpoint, {
        method: 'POST',
        credentials: 'same-origin',
        signal: abortController.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_id: activeDocument.workspaceId,
          project_id: activeDocument.projectId,
          path,
          content: activeDocument.content,
        }),
      });
      let payload = null;
      try { payload = await response.json(); } catch (_) {}
      if (epoch !== renderEpoch || closed) return { mode, state: 'superseded' };
      if (response.status === 503 || response.status === 404) {
        showState('unavailable', 'Typst preview unavailable', responseDetail(payload, 'The Typst compiler service is not available on this server.'));
        emitStatus('unavailable', 'Typst compiler service unavailable');
        return { mode, state: 'unavailable' };
      }
      if (!response.ok) {
        showState('error', 'Typst preview failed', responseDetail(payload, `Compiler request failed (${response.status}).`));
        emitStatus('error', 'Typst compiler request failed');
        return { mode, state: 'error' };
      }
      const diagnostics = Array.isArray(payload?.diagnostics) ? payload.diagnostics : [];
      if (!payload?.ok) {
        showState('error', 'Typst compile error', responseDetail(payload, 'The compiler did not return a rendered page.'), diagnostics);
        emitStatus('error', 'Typst compilation failed', { diagnostics });
        return { mode, state: 'error' };
      }
      clearBody();
      if (!appendTypstPages(payload)) {
        showState('error', 'Typst compile error', responseDetail(payload, 'The compiler did not return a rendered page.'), diagnostics);
        emitStatus('error', 'Typst compilation failed', { diagnostics });
        return { mode, state: 'error' };
      }
      emitStatus('ready', `Rendered ${typstUrls.length} Typst page${typstUrls.length === 1 ? '' : 's'}`, { diagnostics });
      return { mode, state: 'ready' };
    } catch (error) {
      if (error?.name === 'AbortError') return { mode, state: 'superseded' };
      if (epoch !== renderEpoch || closed) return { mode, state: 'superseded' };
      showState('unavailable', 'Typst preview unavailable', 'The compiler service could not be reached.');
      emitStatus('unavailable', 'Typst compiler service could not be reached', { error });
      return { mode, state: 'unavailable' };
    }
  }

  function updateFrameScale(container, scaler, frame) {
    if (!is169) {
      // Full mode: the page fills the whole preview area.
      frame.style.width = '100%';
      frame.style.height = '100%';
      frame.style.flex = '1 1 auto';
      frame.style.minHeight = '0';
      frame.style.removeProperty('transform');
      frame.style.removeProperty('transform-origin');

      scaler.style.width = '100%';
      scaler.style.height = '100%';
      scaler.style.flex = '1 1 auto';
      scaler.style.minHeight = '0';
      scaler.style.display = 'flex';
      scaler.style.flexDirection = 'column';
      scaler.style.removeProperty('transform');
      scaler.style.removeProperty('transform-origin');

      container.style.removeProperty('height');
      container.style.display = 'flex';
      container.style.flexDirection = 'column';
      container.style.flex = '1 1 auto';
      container.style.minHeight = '0';
      container.style.removeProperty('position');
      container.style.removeProperty('overflow');
      return;
    }
    // 16:9 mode — the ORIGINAL editor behaviour: a fixed 1280×720 page
    // viewport (desktop layout, media queries see 1280px) scaled down to the
    // container width. The iframe keeps its natural 1:1 layout inside a
    // transform-scaled wrapper so pointer hit-testing stays exact (a
    // transform directly on the iframe mis-maps clicks in some browsers).
    const containerWidth = container.clientWidth;
    const scale = containerWidth / 1280;
    const scaledHeight = Math.max(1, Math.round(720 * scale));

    frame.style.width = '1280px';
    frame.style.height = '720px';
    frame.style.flex = '0 0 auto';
    frame.style.minHeight = 'unset';
    frame.style.removeProperty('transform');
    frame.style.removeProperty('transform-origin');

    scaler.style.width = '1280px';
    scaler.style.height = '720px';
    scaler.style.flex = '0 0 auto';
    scaler.style.minHeight = 'unset';
    scaler.style.display = 'block';
    scaler.style.transform = `scale(${scale})`;
    scaler.style.transformOrigin = 'top left';

    container.style.height = `${scaledHeight}px`;
    container.style.display = 'block';
    container.style.position = 'relative';
    container.style.overflow = 'hidden';
    container.style.flex = '0 0 auto';
    container.style.minHeight = '0';
  }

  function renderWebFrame(url) {
    clearBody();
    body.style.display = 'flex';
    body.style.flexDirection = 'column';

    const container = document.createElement('div');
    container.className = 'editor-web-preview-container';

    const scaler = document.createElement('div');
    scaler.className = 'editor-web-preview-scaler';

    const frame = document.createElement('iframe');
    frame.className = 'editor-web-preview-frame';
    frame.title = `Web preview: ${url}`;
    frame.sandbox = 'allow-scripts allow-forms allow-same-origin allow-popups allow-modals';
    frame.referrerPolicy = 'no-referrer';
    frame.setAttribute('allow', '');
    frame.addEventListener('load', () => emitStatus('ready', 'Web preview loaded'));
    frame.addEventListener('error', () => {
      showState('error', 'Web preview failed', 'The page could not be loaded in the restricted preview frame.');
      emitStatus('error', 'Web preview failed to load');
    });
    frame.src = url;
    scaler.append(frame);
    container.append(scaler);
    body.append(container);

    if (resizeObserver) {
      resizeObserver.disconnect();
    }
    resizeObserver = new ResizeObserver(() => {
      updateFrameScale(container, scaler, frame);
    });
    resizeObserver.observe(container);
    updateFrameScale(container, scaler, frame);
  }

  function openWebPreview(value) {
    const url = validateWebPreviewUrl(value);
    activeDocument = null;
    activeUrl = url;
    show('web', 'Web preview');
    urlInput.value = String(value || '').trim();
    if (!url) {
      showState('error', 'Invalid preview URL', 'Use an explicit http:// or https:// URL, such as http://localhost:3000.');
      emitStatus('error', 'Web preview URL rejected');
      return { mode, state: 'error' };
    }
    urlInput.value = url;
    external.disabled = false;
    renderWebFrame(url);
    emitStatus('loading', 'Loading web preview');
    return { mode, state: 'loading', url };
  }

  async function render(documentValue = null) {
    const documentToRender = documentValue || getActiveDocument?.();
    const normalised = normaliseDocument(documentToRender);
    const kind = previewKindForPath(normalised.path);
    if (kind === 'markdown') return renderMarkdownPreview(normalised);
    if (kind === 'typst') return renderTypstPreview(normalised);
    activeDocument = normalised.path ? normalised : null;
    activeUrl = null;
    abortController?.abort();
    clearBody();
    root.hidden = true;
    mode = null;
    emitStatus('idle', 'No preview is available for this file');
    return { mode: null, state: 'idle' };
  }

  async function refresh() {
    if (mode === 'web') return activeUrl ? openWebPreview(activeUrl) : { mode, state: 'idle' };
    return render(activeDocument || getActiveDocument?.());
  }

  function close() {
    closed = true;
    abortController?.abort();
    renderEpoch += 1;
    clearBody();
    root.hidden = true;
    const detail = { mode, document: activeDocument, url: activeUrl };
    mode = null;
    activeUrl = null;
    try { onClose?.(detail); } catch (_) {}
    root.dispatchEvent(new CustomEvent('aster:preview-closed', { detail }));
  }

  function destroy() {
    close();
    root.remove();
  }

  reload.addEventListener('click', () => { void refresh(); });
  closeButton.addEventListener('click', close);
  ratioToggle.addEventListener('click', () => {
    is169 = !is169;
    ratioToggle.textContent = is169 ? 'Scale: 16:9' : 'Scale: Full';
    const container = body.querySelector('.editor-web-preview-container');
    const scaler = body.querySelector('.editor-web-preview-scaler');
    const frame = body.querySelector('.editor-web-preview-frame');
    if (container && scaler && frame) {
      updateFrameScale(container, scaler, frame);
    }
  });
  external.addEventListener('click', () => {
    if (!activeUrl) return;
    try {
      if (onOpenExternal) onOpenExternal(activeUrl);
      else window.open(activeUrl, '_blank', 'noopener,noreferrer');
    } catch (_) {}
  });
  urlInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      openWebPreview(urlInput.value);
    }
  });

  return {
    element: root,
    renderPreview: render,
    openWebPreview,
    refresh,
    close,
    destroy,
    get mode() { return mode; },
  };
}

/** Functional form for integrations that keep only the panel reference. */
export function renderPreview(panel, documentValue = null) {
  if (!panel || typeof panel.renderPreview !== 'function') {
    throw new TypeError('renderPreview requires a panel created by createPreviewPanel().');
  }
  return panel.renderPreview(documentValue);
}

export default { createPreviewPanel, renderPreview, renderMarkdown, previewKindForPath, validateWebPreviewUrl };
