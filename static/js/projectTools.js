/**
 * Project tool windows — Terminal, Preview, and Web view.
 *
 * These used to live inside the code editor's bottom panels and toolbar.
 * They are now standalone windows launched from the main sidebar / icon
 * rail, sharing the code editor's window chrome (windowbar: drag, dock
 * left/right, minimize to the dock chip, fullscreen, close).
 *
 * All three are project-scoped: they need the active project context
 * (workspaceId + projectId). The context comes from the code editor when it
 * is open, falling back to the project manager's active project. Without a
 * project they show an empty state with a shortcut to the workspace manager.
 */

import { ProjectTerminal } from './editor/terminal.js';
import { createPreviewPanel } from './editor/preview.js';
import { getCurrentContext, getActiveDocument } from './editor/editor.js';
import { openCodeEditor, getActiveProjectId, getActiveWorkspaceId } from './projectManager.js';
import * as Modals from './modalManager.js';
import { makeWindowDraggable } from './windowDrag.js';
import { applyEdgeDock, clearRightDock } from './modalSnap.js';
import { snapModalToZone } from './tileManager.js';

const API_ROOT = '/api/workspace';
const WEBVIEW_LAST_URL_KEY = 'astercaeser-pt-webview-last-url';

// Latest project chosen in the app-wide project manager (from the
// `project-changed` event). The code editor keeps its OWN context that only
// updates when the editor opens a project — the project-tool windows must
// follow the project manager, not the editor.
let _activeProject = null; // { workspaceId, projectId, path }

// Explicit "attach to chat" context set from the web view window (picked
// element + page text). Injected into the NEXT chat message, then cleared.
let _pendingChatAttachment = '';

const ICONS = {
  terminal: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
  preview: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
  webview: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
};

const _windows = new Map(); // id -> { modal, content, bar, body, nameEl, pathEl, def }

let _initialized = false;

function projectContext() {
  // App-wide source of truth: the project manager's active project. The
  // editor's context is only a fallback — it goes stale when the user
  // switches projects without reopening the editor.
  try {
    const workspaceId = getActiveWorkspaceId?.();
    const projectId = getActiveProjectId?.();
    if (workspaceId && projectId) {
      let path = (_activeProject && _activeProject.projectId === projectId) ? _activeProject.path : '';
      if (!path) {
        try {
          const ctx = getCurrentContext();
          if (ctx && String(ctx.projectId) === String(projectId) && ctx.path) path = ctx.path;
        } catch (_) {}
      }
      return { workspaceId, projectId, path };
    }
  } catch (_) {}
  try {
    const ctx = getCurrentContext();
    if (ctx && ctx.projectId && ctx.workspaceId) return ctx;
  } catch (_) {}
  return null;
}

function defaultLocalUrl(port = 5020) {
  return `${window.location.protocol}//${window.location.hostname}:${port}/`;
}

// ── Shared window chrome ────────────────────────────────────────────────────

function buildWindowbar() {
  const bar = document.createElement('div');
  bar.className = 'code-editor-windowbar pt-windowbar modal-header';
  bar.innerHTML = `
    <div class="code-editor-window-title">
      <span class="ce-window-dot" aria-hidden="true"></span>
      <span class="ce-window-name"></span>
      <span class="ce-window-path"></span>
    </div>
    <div class="code-editor-window-controls">
      <button class="code-editor-action-btn" type="button" data-pt-action="dock-left" title="Dock left — beside the chat (Cmd/Ctrl+Alt+←)" aria-label="Dock left">◧</button>
      <button class="code-editor-action-btn" type="button" data-pt-action="dock-right" title="Dock right — beside the chat (Cmd/Ctrl+Alt+→)" aria-label="Dock right">◨</button>
      <button class="code-editor-action-btn" type="button" data-pt-action="minimize" title="Minimize to the dock" aria-label="Minimize"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="5" y1="18" x2="19" y2="18"/></svg></button>
      <button class="code-editor-action-btn" type="button" data-pt-action="fullscreen" title="Toggle fullscreen" aria-label="Toggle fullscreen">⛶</button>
      <button class="code-editor-action-btn" type="button" data-pt-action="close" title="Close" aria-label="Close">✕</button>
    </div>`;
  return bar;
}

function buildEmptyState(api, message) {
  const empty = document.createElement('div');
  empty.className = 'pt-empty';
  const hint = document.createElement('p');
  hint.textContent = message;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'pt-empty-btn';
  button.textContent = 'Open project manager';
  button.addEventListener('click', () => {
    try { void openCodeEditor(); } catch (_) {}
  });
  empty.append(hint, button);
  api.body.appendChild(empty);
  return empty;
}

function showEmpty(api, empty, on = true) {
  if (!empty) return;
  empty.hidden = !on;
  api.body.classList.toggle('pt-has-empty', on);
}

function defaultSize(id) {
  const sizes = {
    'pt-terminal-window': [760, 480],
    'pt-preview-window': [860, 600],
    'pt-webview-window': [940, 640],
  };
  return sizes[id] || [800, 560];
}

function togglePtFullscreen(api) {
  const { modal, content } = api;
  if (content.dataset._tileZone) {
    let pre = null;
    try { pre = JSON.parse(content.dataset._tilePreSnap || 'null'); } catch (_) {}
    ['position', 'left', 'top', 'right', 'bottom', 'width', 'maxWidth', 'height', 'maxHeight', 'margin', 'transform'].forEach(p => content.style.removeProperty(p));
    delete content.dataset._tileZone;
    delete content.dataset._tilePreSnap;
    if (pre) {
      Object.assign(content.style, pre);
    }
    if (!content.style.position) content.style.position = 'fixed';
    if (!content.style.width) {
      const [w, h] = defaultSize(modal.id);
      content.style.width = `${w}px`;
      content.style.height = `${h}px`;
      content.style.left = `${Math.max(8, Math.round((window.innerWidth - w) / 2))}px`;
      content.style.top = `${Math.max(8, Math.round((window.innerHeight - h) / 3))}px`;
    }
  } else {
    snapModalToZone(modal, {
      name: 'fullscreen',
      rect: { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight },
    });
  }
}

function togglePtDock(api, side) {
  const { modal } = api;
  const docked = modal.classList.contains('modal-left-docked') ? 'left'
    : modal.classList.contains('modal-right-docked') ? 'right' : null;
  if (docked) {
    if (docked === side) clearRightDock(modal);
    else { clearRightDock(modal); requestAnimationFrame(() => applyEdgeDock(modal, side)); }
    return;
  }
  applyEdgeDock(modal, side);
}

// Give keyboard focus back to the chat composer after a tool window closes,
// so the user can keep typing without clicking the input first.
function refocusComposer() {
  const input = document.getElementById('message');
  if (input && !input.disabled && !input.matches(':focus')) {
    try { input.focus(); } catch (_) {}
  }
}

// ── Terminal window ─────────────────────────────────────────────────────────

function buildTerminalWindow(api) {
  const terminalState = { sessions: [], activeId: null, context: null };
  api.body.innerHTML = `
    <div class="pt-terminal-layout">
      <div class="pt-terminal-host" id="pt-terminal-host"></div>
      <aside class="pt-terminal-sidebar">
        <div class="pt-terminal-sidebar-header"><span>Sessions</span><button id="pt-terminal-add" type="button" title="New terminal session" aria-label="New terminal session">+</button></div>
        <div class="pt-terminal-list" id="pt-terminal-list"></div>
      </aside>
    </div>`;
  const empty = buildEmptyState(api, 'Open a project first — the terminal runs in the project folder.');
  const host = api.body.querySelector('.pt-terminal-host');
  const list = api.body.querySelector('#pt-terminal-list');
  const addBtn = api.body.querySelector('#pt-terminal-add');

  const renderList = () => {
    list.replaceChildren();
    terminalState.sessions.forEach(session => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `pt-terminal-session${session.id === terminalState.activeId ? ' active' : ''}`;
      item.textContent = session.name;
      const close = document.createElement('span');
      close.className = 'pt-terminal-session-close';
      close.textContent = '✕';
      close.title = 'Close session';
      close.addEventListener('click', event => {
        event.stopPropagation();
        killSession(session.id);
      });
      item.append(close);
      item.addEventListener('click', () => selectSession(session.id));
      list.appendChild(item);
    });
  };

  // Terminal sessions live on the server keyed by session_id and survive a
  // page refresh (the shell keeps running; reconnecting replays the output
  // history). Persist the ids per project so the window can restore them.
  const storageKey = () => terminalState.context
    ? `astercaeser-pt-terminal-${terminalState.context.projectId}`
    : null;
  const saveSessions = () => {
    const key = storageKey();
    if (!key) return;
    try {
      localStorage.setItem(key, JSON.stringify(
        terminalState.sessions.map(s => ({ id: s.id, name: s.name })),
      ));
    } catch (_) {}
  };
  const loadSessions = () => {
    const key = storageKey();
    if (!key) return [];
    try {
      const raw = JSON.parse(localStorage.getItem(key) || '[]');
      return Array.isArray(raw)
        ? raw.filter(s => s && typeof s.id === 'string' && s.id.length < 200).slice(0, 12)
        : [];
    } catch (_) {
      return [];
    }
  };

  const createSession = (id = null, name = null) => {
    if (!terminalState.context) return;
    const sessionId = id || `${terminalState.context.projectId}-terminal-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const index = terminalState.sessions.length + 1;
    const container = document.createElement('div');
    container.className = 'pt-terminal-session-container';
    container.style.display = 'none';
    host.appendChild(container);
    const session = { id: sessionId, name: name || `Terminal ${index}`, terminal: null, container };
    terminalState.sessions.push(session);
    const terminal = new ProjectTerminal(container, { ...terminalState.context, terminalSessionId: sessionId }, {
      onState: tsState => {
        if (tsState.kind === 'init' && tsState.shell) {
          session.name = tsState.shell;
          saveSessions();
          renderList();
        }
      },
    });
    session.terminal = terminal;
    try {
      terminal.open();
    } catch (error) {
      session.terminal = null;
      container.textContent = `Could not start terminal: ${error.message}`;
    }
    selectSession(sessionId);
    renderList();
    saveSessions();
  };

  const selectSession = id => {
    terminalState.activeId = id;
    terminalState.sessions.forEach(session => {
      if (!session.container) return;
      session.container.style.display = session.id === id ? 'block' : 'none';
    });
    const active = terminalState.sessions.find(s => s.id === id);
    if (active && active.terminal) {
      try { active.terminal.refresh(); active.terminal.focus(); } catch (_) {}
    }
    renderList();
  };

  const killSession = id => {
    const session = terminalState.sessions.find(s => s.id === id);
    if (!session) return;
    if (session.terminal) {
      try { session.terminal._send({ type: 'kill' }); } catch (_) {}
      try { session.terminal.dispose(); } catch (_) {}
    }
    session.container?.remove();
    terminalState.sessions = terminalState.sessions.filter(s => s.id !== id);
    if (terminalState.activeId === id) {
      const next = terminalState.sessions.at(-1) || null;
      if (next) selectSession(next.id);
      else terminalState.activeId = null;
    }
    renderList();
    saveSessions();
  };

  const disposeAll = () => {
    [...terminalState.sessions].forEach(session => killSession(session.id));
  };

  addBtn.addEventListener('click', () => createSession());

  const restoreForContext = ctx => {
    if (terminalState.sessions.length > 0) return;
    const saved = loadSessions();
    if (saved.length) saved.forEach(s => createSession(s.id, s.name));
    else createSession();
  };

  api.onOpen = () => {
    const ctx = projectContext();
    if (!ctx) {
      showEmpty(api, empty, true);
      return;
    }
    showEmpty(api, empty, false);
    if (!terminalState.context || terminalState.context.projectId !== ctx.projectId) {
      disposeAll();
      terminalState.context = ctx;
    }
    if (terminalState.sessions.length === 0) restoreForContext();
    api.pathEl.textContent = terminalState.context.path || '';
    api.nameEl.textContent = 'Terminal';
  };

  api.onClose = () => { /* Sessions keep running while the window is hidden. */ };
  api.onProjectChanged = () => {
    if (api.modal.classList.contains('hidden')) return;
    const ctx = projectContext();
    if (ctx && terminalState.context && ctx.projectId !== terminalState.context.projectId) {
      disposeAll();
      terminalState.context = ctx;
      restoreForContext();
      api.pathEl.textContent = ctx.path || '';
      api.nameEl.textContent = 'Terminal';
    }
  };

  api.getTerminalContext = () => {
    const active = terminalState.sessions.find(s => s.id === terminalState.activeId);
    const term = active?.terminal?.terminal;
    if (!term || !term.buffer) return '';
    try {
      const buffer = term.buffer.active;
      const start = Math.max(0, buffer.length - 40);
      const lines = [];
      for (let i = start; i < buffer.length; i += 1) {
        const line = buffer.getLine(i);
        if (line) lines.push(line.translateToString(true));
      }
      const text = lines.join('\n').replace(/\s+$/, '');
      if (!text.trim()) return '';
      return `[Project terminal — last ${lines.length} lines of output]\n${text.slice(0, 6000)}`;
    } catch (_) {
      return '';
    }
  };
}

// ── Preview window ──────────────────────────────────────────────────────────

function buildPreviewWindow(api) {
  let panel = null;
  let lastPreviewed = null;
  const empty = buildEmptyState(api, 'Open the code editor with a Markdown or Typst file to preview it here.');

  const activeDocumentValue = () => {
    const ctx = projectContext();
    const doc = getActiveDocument();
    if (!doc) return ctx ? { path: '', content: '', context: ctx } : null;
    return { ...doc, context: ctx };
  };

  const renderActive = () => {
    if (api.modal.classList.contains('hidden')) return;
    if (!panel) return;
    const value = activeDocumentValue();
    if (!value) {
      showEmpty(api, empty, true);
      return;
    }
    showEmpty(api, empty, false);
    void panel.renderPreview(value);
    lastPreviewed = value;
    api.pathEl.textContent = value.path || '';
  };

  api.onOpen = () => {
    if (!panel) {
      panel = createPreviewPanel({
        container: api.body,
        getActiveDocument: () => activeDocumentValue() || {},
        onStatus: () => {},
        onClose: () => { api.modal.classList.add('hidden'); },
      });
    }
    renderActive();
  };

  let renderTimer = null;
  const scheduleRender = () => {
    if (api.modal.classList.contains('hidden')) return;
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = setTimeout(renderActive, 250);
  };
  document.addEventListener('aster:editor-active-document', scheduleRender);
  document.addEventListener('aster:editor-document-changed', scheduleRender);
  document.addEventListener('aster:editor-saved', scheduleRender);

  api.onClose = () => {};
  api.onProjectChanged = renderActive;
  api.getPreviewContext = () => {
    if (!lastPreviewed || !lastPreviewed.path || !lastPreviewed.content) return '';
    return `[Project preview: ${lastPreviewed.path}]\n${String(lastPreviewed.content).slice(0, 8000)}`;
  };
}

// ── Web view window ─────────────────────────────────────────────────────────

function buildWebviewWindow(api) {
  let panel = null;
  let lastUrl = '';
  let webviewSnapshot = null;
  let selectedElement = null;
  let snapshotPoll = null;
  const empty = buildEmptyState(api, 'Open a project first — the web view previews the project web app.');

  // Toolbar: element picking + copy + attach-to-chat, driven by the
  // postMessage bridge (static/js/editor/webview-bridge.js) provisioned into
  // the previewed app.
  api.body.insertAdjacentHTML('afterbegin', `
    <div class="pt-webview-toolbar">
      <button type="button" class="code-editor-action-btn" data-wv="pick" title="Click an element inside the web view to capture it">Pick element</button>
      <button type="button" class="code-editor-action-btn" data-wv="copy-page" title="Copy the page text to the clipboard">Copy page text</button>
      <button type="button" class="code-editor-action-btn" data-wv="copy-element" disabled title="Copy the picked element details">Copy element</button>
      <button type="button" class="code-editor-action-btn" data-wv="attach" title="Attach the web view context to your next chat message">Attach to chat</button>
      <span class="pt-webview-status" data-wv="status"></span>
      <span class="pt-webview-attached" data-wv="attached" hidden>✓ Context attached · goes with your next message <button type="button" data-wv="clear" title="Clear attached context">✕</button></span>
    </div>`);
  const toolbar = api.body.querySelector('.pt-webview-toolbar');
  const statusEl = toolbar.querySelector('[data-wv="status"]');
  const attachedEl = toolbar.querySelector('[data-wv="attached"]');
  const pickBtn = toolbar.querySelector('[data-wv="pick"]');
  const copyPageBtn = toolbar.querySelector('[data-wv="copy-page"]');
  const copyElementBtn = toolbar.querySelector('[data-wv="copy-element"]');

  const setStatus = (text, temporary = false) => {
    statusEl.textContent = text || '';
    if (temporary && text) {
      setTimeout(() => { if (statusEl.textContent === text) statusEl.textContent = ''; }, 4000);
    }
  };

  const refreshSelectionUi = () => {
    copyElementBtn.disabled = !selectedElement;
    const el = selectedElement;
    if (!el) {
      pickBtn.textContent = 'Pick element';
      pickBtn.classList.remove('is-picking');
      return;
    }
    const tag = el.tag || 'element';
    const identity = el.id
      ? `#${el.id}`
      : (el.className ? `.${String(el.className).trim().split(/\s+/)[0]}` : (el.label || el.text || ''));
    const rect = el.rect || {};
    const dimensions = rect.width && rect.height ? ` · ${rect.width}×${rect.height}` : '';
    setStatus(`Selected: ${tag}${identity ? identity : ''}${dimensions}`);
  };

  const provisionBridge = async ctx => {
    if (!ctx?.workspaceId || !ctx?.projectId) return;
    try {
      await fetch(
        `${API_ROOT}/${encodeURIComponent(ctx.workspaceId)}/project/${encodeURIComponent(ctx.projectId)}/webview-bridge/provision`,
        { method: 'POST', credentials: 'same-origin' },
      );
    } catch (_) { /* A bridge failure must not prevent the web view from opening. */ }
  };

  api.onOpen = async () => {
    const ctx = projectContext();
    if (!ctx) {
      showEmpty(api, empty, true);
      return;
    }
    showEmpty(api, empty, false);
    if (!panel) {
      panel = createPreviewPanel({
        container: api.body,
        getActiveDocument: () => ({}),
        onStatus: () => {},
        onClose: () => { api.modal.classList.add('hidden'); },
      });
    }
    api.nameEl.textContent = 'Web view';
    api.pathEl.textContent = ctx.path || '';
    await provisionBridge(ctx);
    const url = lastUrl || (() => { try { return localStorage.getItem(WEBVIEW_LAST_URL_KEY) || ''; } catch (_) { return ''; } })();
    const target = url || defaultLocalUrl(5020);
    panel.openWebPreview(target);
    try { localStorage.setItem(WEBVIEW_LAST_URL_KEY, target); } catch (_) {}
    // Keep the snapshot cache warm: ask the embedded app for its page text
    // on open and periodically while the window is visible.
    requestSnapshot();
    if (!snapshotPoll) {
      snapshotPoll = setInterval(() => {
        if (api.modal.classList.contains('hidden')) return;
        requestSnapshot();
      }, 10000);
    }
  };

  const requestSnapshot = () => {
    const frame = api.body.querySelector('.editor-web-preview-frame');
    if (!frame || !frame.isConnected || !frame.src) return;
    try { frame.contentWindow.postMessage({ type: 'astercaeser-webview-snapshot-request' }, '*'); } catch (_) {}
  };

  // Request a snapshot and wait briefly for the embedded app to answer.
  const fetchFreshSnapshot = (timeout = 1200) => new Promise(resolve => {
    const frame = api.body.querySelector('.editor-web-preview-frame');
    if (!frame || !frame.isConnected || !frame.src) { resolve(webviewSnapshot); return; }
    const before = webviewSnapshot;
    requestSnapshot();
    setTimeout(() => resolve(webviewSnapshot && webviewSnapshot !== before ? webviewSnapshot : webviewSnapshot), timeout);
  });

  const copyText = async text => {
    if (!text) return false;
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch (_2) {
        return false;
      }
    }
  };

  const buildContextText = async () => {
    const parts = [];
    if (selectedElement) {
      const element = selectedElement;
      const compact = {
        tag: String(element.tag || '').slice(0, 80),
        id: String(element.id || '').slice(0, 160),
        className: String(element.className || '').slice(0, 240),
        selector: String(element.selector || '').slice(0, 500),
        role: String(element.role || '').slice(0, 120),
        label: String(element.label || '').slice(0, 240),
        text: String(element.text || '').slice(0, 500),
        rect: element.rect || null,
        outerHTML: String(element.outerHTML || '').slice(0, 1000),
      };
      parts.push(`[Selected web element — use this as context; do not repeat the JSON in your reply:]\n${JSON.stringify(compact)}\n[/Selected web element]`);
    }
    const snap = await fetchFreshSnapshot();
    if (snap && snap.text) {
      const title = snap.title ? `${snap.title} — ` : '';
      parts.push(`[ASTERCAESER_WEBVIEW_CONTEXT]\n[Web view context — the live web app is loaded at ${snap.url}]\n${title}${snap.text.slice(0, 15000)}\n[/ASTERCAESER_WEBVIEW_CONTEXT]`);
    }
    return parts.join('\n\n');
  };

  toolbar.addEventListener('click', async event => {
    const button = event.target.closest('[data-wv]');
    if (!button) return;
    const action = button.dataset.wv;
    const frame = api.body.querySelector('.editor-web-preview-frame');

    if (action === 'pick') {
      if (!frame || !frame.isConnected) { setStatus('Open a page in the web view first.', true); return; }
      pickBtn.classList.add('is-picking');
      pickBtn.textContent = 'Click an element…';
      setStatus('Selection mode on — click an element inside the web view.', true);
      try { frame.contentWindow.postMessage({ type: 'astercaeser-webview-select-element' }, '*'); } catch (_) {}
      return;
    }
    if (action === 'copy-page') {
      setStatus('Copying page text…', true);
      const snap = await fetchFreshSnapshot();
      const text = snap && snap.text ? `${snap.url}\n${snap.text}` : '';
      if (!text) { setStatus('No page text available to copy.', true); return; }
      const ok = await copyText(text);
      setStatus(ok ? 'Page text copied.' : 'Could not copy — clipboard blocked.', true);
      return;
    }
    if (action === 'copy-element') {
      if (!selectedElement) return;
      const ok = await copyText(JSON.stringify(selectedElement, null, 2));
      setStatus(ok ? 'Element copied.' : 'Could not copy — clipboard blocked.', true);
      return;
    }
    if (action === 'attach') {
      setStatus('Capturing web view context…', true);
      const context = await buildContextText();
      if (!context) { setStatus('Nothing to attach — open a page in the web view first.', true); return; }
      _pendingChatAttachment = context;
      attachedEl.hidden = false;
      setStatus('Context attached — it will go with your next chat message.');
      return;
    }
    if (action === 'clear') {
      _pendingChatAttachment = '';
      attachedEl.hidden = true;
      setStatus('');
    }
  });

  api.onClose = () => {
    if (snapshotPoll) { clearInterval(snapshotPoll); snapshotPoll = null; }
  };
  api.onProjectChanged = () => { void api.onOpen(); };

  // Re-consume the postMessage bridge (static/js/editor/webview-bridge.js,
  // provisioned into the previewed app) so the AI chat can read the page
  // text without touching the cross-origin frame's DOM. The frame is
  // cross-origin, so the embedded page sends its visible text up.
  window.addEventListener('message', event => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    const frame = api.body.querySelector('.editor-web-preview-frame');
    if (!frame || event.source !== frame.contentWindow) return;
    if (data.type === 'astercaeser-webview-snapshot') {
      if (typeof data.text !== 'string' || !data.text.trim()) return;
      webviewSnapshot = {
        url: typeof data.url === 'string' ? data.url : frame.src,
        title: typeof data.title === 'string' ? data.title : '',
        text: data.text.slice(0, 40000),
        elements: Array.isArray(data.elements) ? data.elements.slice(0, 300) : [],
        at: Date.now(),
      };
      return;
    }
    if (data.type === 'astercaeser-webview-element-selected') {
      if (!data.element || typeof data.element !== 'object') return;
      selectedElement = data.element;
      pickBtn.classList.remove('is-picking');
      pickBtn.textContent = 'Pick element';
      refreshSelectionUi();
    }
  });

  api.getWebviewContext = () => {
    const frame = api.body.querySelector('.editor-web-preview-frame');
    const snap = webviewSnapshot;
    if (!snap || !frame || !frame.isConnected) return '';
    if (Date.now() - snap.at > 30000) return '';
    const samePage = snap.url === frame.src
      || snap.url.startsWith(frame.src)
      || (snap.url.endsWith('/') && frame.src.startsWith(snap.url));
    if (!samePage) return '';
    const title = snap.title ? `${snap.title} — ` : '';
    // Wrapped in the ASTERCAESER_WEBVIEW_CONTEXT markers so the server's
    // existing bounding logic truncates it and keeps only the latest turn.
    return `[ASTERCAESER_WEBVIEW_CONTEXT]\n[Web view context — the live web app is loaded at ${frame.src}]\n${title}${snap.text.slice(0, 15000)}\n[/ASTERCAESER_WEBVIEW_CONTEXT]`;
  };
}

// ── Window factory ──────────────────────────────────────────────────────────

function buildWindow({ id, label, icon, railId, sidebarId, minWidth = 420, minHeight = 300, builder }) {
  const modal = document.createElement('div');
  modal.id = id;
  modal.className = 'modal pt-window';
  modal.hidden = true;
  // The app's `.modal` CSS sets display:flex, which overrides the HTML
  // `hidden` attribute — the `.hidden` class is what actually hides tool
  // windows (see .modal.hidden in style.css). Without it the three project
  // tool windows render visible at boot and cover the whole app.
  modal.classList.add('hidden');
  const content = document.createElement('div');
  content.className = 'modal-content pt-window-content';
  const bar = buildWindowbar();
  const body = document.createElement('div');
  body.className = 'pt-window-body';
  content.append(bar, body);
  modal.appendChild(content);
  document.body.appendChild(modal);

  const [w, h] = defaultSize(id);
  content.style.width = `${w}px`;
  content.style.height = `${h}px`;

  const api = {
    modal, content, bar, body,
    nameEl: bar.querySelector('.ce-window-name'),
    pathEl: bar.querySelector('.ce-window-path'),
    onOpen: null,
    onClose: null,
    onProjectChanged: null,
  };
  api.nameEl.textContent = label;

  bar.querySelector('[data-pt-action="dock-left"]')?.addEventListener('click', () => togglePtDock(api, 'left'));
  bar.querySelector('[data-pt-action="dock-right"]')?.addEventListener('click', () => togglePtDock(api, 'right'));
  bar.querySelector('[data-pt-action="minimize"]')?.addEventListener('click', () => Modals.minimize(id));
  bar.querySelector('[data-pt-action="fullscreen"]')?.addEventListener('click', () => togglePtFullscreen(api));
  bar.querySelector('[data-pt-action="close"]')?.addEventListener('click', () => {
    api.modal.classList.add('hidden');
    api.modal.hidden = true;
    refocusComposer();
  });

  makeWindowDraggable(modal, {
    content,
    header: bar,
    minWidth,
    minHeight,
    resizeStorageKey: `winsize-${id}`,
  });

  builder(api);

  const registerOpts = {
    label,
    icon,
    railBtnId: railId,
    sidebarBtnId: sidebarId,
    restoreFn: () => {
      api.modal.hidden = false;
      api.modal.classList.remove('hidden');
      try { api.onOpen?.(); } catch (error) { console.warn(`pt-window ${id} restore:`, error); }
    },
    closeFn: () => {
      api.modal.classList.add('hidden');
      api.modal.hidden = true;
      refocusComposer();
    },
  };
  api.registerOpts = registerOpts;
  Modals.register(id, registerOpts);

  _windows.set(id, api);
  return api;
}

function openWindow(id) {
  const api = _windows.get(id);
  if (!api) return;
  if (!Modals.isRegistered(id)) Modals.register(id, api.registerOpts);
  api.modal.hidden = false;
  try { Modals.restore(id); } catch (error) { console.warn(`pt-window ${id} open:`, error); }
}

// ── Entry point ─────────────────────────────────────────────────────────────

// ── AI context from the project tools ───────────────────────────────────────
// The main chat knows nothing about the web view / terminal / preview. When
// the user sends a message, attach whatever the open tool windows can tell
// us (web page text via the bridge, terminal output, previewed document) so
// the model can answer about them. The context is hidden from the visible
// bubble via the same astercaeserDisplayMessage mechanism the editor chat
// used before it was extracted.

function buildToolContext() {
  const parts = [];
  const seen = new Set();
  // Explicit user attachment (web view → "Attach to chat") goes first and is
  // consumed by the next message.
  if (_pendingChatAttachment) {
    parts.push(_pendingChatAttachment);
    _pendingChatAttachment = '';
  }
  for (const api of _windows.values()) {
    const getters = [api.getWebviewContext, api.getTerminalContext, api.getPreviewContext];
    for (const getter of getters) {
      if (typeof getter !== 'function') continue;
      try {
        const text = getter();
        if (text && !seen.has(text.slice(0, 40))) {
          seen.add(text.slice(0, 40));
          parts.push(text);
        }
      } catch (_) {}
    }
  }
  return parts.length ? `\n\n${parts.join('\n\n')}` : '';
}

function attachToolContextToChatSend() {
  const attach = () => {
    const input = document.getElementById('message');
    if (!input) return;
    if (input.dataset.astercaeserDisplayMessage) return; // already attached for this send
    const visible = String(input.value || '').trim();
    if (!visible) return;
    const context = buildToolContext();
    if (!context) return;
    // Keep the composer and the user bubble clean: stash the context in a
    // hidden dataset that chat.js merges into the server payload only.
    input.dataset.astercaeserToolContext = context;
    input.dataset.astercaeserDisplayMessage = visible;
    input.dataset.astercaeserEditorChat = 'true';
  };
  // chat.js reads #message from its own button-click / Enter handlers, so the
  // context must be attached before those run — capture phase on click, on
  // Enter in the composer, and on the form submit.
  document.addEventListener('click', event => {
    if (event.target.closest && event.target.closest('.send-btn, #submit, [data-action="send"]')) attach();
  }, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && event.target && event.target.id === 'message') attach();
  }, true);
  document.addEventListener('submit', event => {
    if (event.target && event.target.id === 'chat-form') attach();
  }, true);
}

function initProjectTools() {
  if (_initialized) return;
  _initialized = true;

  buildWindow({ id: 'pt-terminal-window', label: 'Terminal', railId: 'rail-terminal', sidebarId: 'tool-terminal-btn', icon: ICONS.terminal, minWidth: 420, minHeight: 160, builder: buildTerminalWindow });
  buildWindow({ id: 'pt-preview-window', label: 'Preview', railId: 'rail-preview', sidebarId: 'tool-preview-btn', icon: ICONS.preview, minWidth: 420, minHeight: 300, builder: buildPreviewWindow });
  buildWindow({ id: 'pt-webview-window', label: 'Web view', railId: 'rail-webview', sidebarId: 'tool-webview-btn', icon: ICONS.webview, minWidth: 480, minHeight: 320, builder: buildWebviewWindow });

  for (const api of _windows.values()) {
    document.getElementById(api.registerOpts.sidebarBtnId)?.addEventListener('click', () => {
      if (!Modals.toggle(api.modal.id)) openWindow(api.modal.id);
    });
  }

  document.addEventListener('project-changed', event => {
    const detail = event.detail || {};
    if (detail.projectId && detail.workspaceId) {
      _activeProject = {
        workspaceId: detail.workspaceId,
        projectId: detail.projectId,
        path: detail.project?.path || '',
      };
    }
    for (const api of _windows.values()) {
      try { api.onProjectChanged?.(); } catch (_) {}
    }
  });

  attachToolContextToChatSend();
}

export { initProjectTools };
export default { initProjectTools };
