/**
 * Project code editor entry point.
 *
 * Public API for editor extensions:
 *   initCodeEditor()                    bind the `open-editor` event once
 *   openEditor(project | id, path?)     open an editor overlay
 *   openAt(path, { line, column })      load/focus a project-relative file
 *   saveActiveFile(), closeEditor()     lifecycle actions
 *   getCurrentContext(), getActiveDocument()
 *   requestPanel('search')
 *
 * Events use an `aster:editor-*` namespace. The detail always includes the
 * immutable `{ workspaceId, projectId, path }` context where it is relevant:
 * `opened`, `closed`, `active-document`, `document-changed`, `saved`, and
 * `panel-request`. The search panel is project-scoped.
 *
 * AI chat lives in the main window: select code and use "Ask agent" to hand
 * the selection off to the main chat (the editor closes to reveal it).
 */
import { mountFileTree } from '../fileTree.js';
import uiModule from '../ui.js';
import { askAgentAboutSelection, requestInlineCompletion } from './ai.js';
import { ProjectSearchPanel } from './search.js';
import { makeWindowDraggable } from '../windowDrag.js';
import * as Modals from '../modalManager.js';
import { applyEdgeDock, clearRightDock } from '../modalSnap.js';
import {
  basicSetup,
  Compartment,
  css,
  EditorSelection,
  EditorState,
  EditorView,
  html,
  javascript,
  json,
  keymap,
  markdown,
  python,
  scss,
  shell,
  StreamLanguage,
  syntaxHighlighting,
  defaultHighlightStyle,
  tsx,
  typescript,
  vim,
  Vim,
} from '../vendor/aster-editor-vendor.js';

// Configure custom Vim mappings (Double space / Leader space to search files)
if (Vim) {
  try {
    Vim.defineEx('filesearch', 'fs', () => {
      showPanel('search');
    });
    Vim.map('<Space><Space>', ':filesearch<CR>', 'normal');
    Vim.map('<Space>f', ':filesearch<CR>', 'normal');
    Vim.map('<Space>p', ':filesearch<CR>', 'normal');
  } catch (e) {
    console.warn('Vim custom mappings setup error:', e);
  }
}
// Override defaultHighlightStyle colors by matching original color values.
// This mutates the singleton so basicSetup picks up the new colors.
const _hlOverrides = {
  '#708': '#cc78dd',  // keyword → Pink/Purple (#cc78dd)
  '#940': '#5c6370',  // comment → Muted Olive (#5c6370)
  '#a11': '#d19a66',  // string → Amber Orange (#d19a66)
  '#219': '#56b6c2',  // atom/bool/url/label → Cyan (#56b6c2)
  '#164': '#56b6c2',  // literal/inserted → Cyan (#56b6c2)
  '#e40': '#d19a66',  // regexp/escape/special(string) → Amber (#d19a66)
  '#00f': '#61afef',  // definition(variableName) → Light Blue (#61afef)
  '#30a': '#61afef',  // local(variableName) → Light Blue (#61afef)
  '#085': '#36c692',  // typeName/namespace → Mint Green (#36c692)
  '#167': '#36c692',  // className → Mint Green (#36c692)
  '#256': '#e5c07b',  // special(variableName)/macroName/function → Gold (#e5c07b)
  '#00c': '#61afef',  // definition(propertyName) → Light Blue (#61afef)
  '#f00': '#e06c75',  // invalid → Coral Red (#e06c75)
};
for (const spec of defaultHighlightStyle.specs) {
  if (spec.color && _hlOverrides[spec.color]) {
    spec.color = _hlOverrides[spec.color];
  }
  if (spec.color === '#e40' || spec.color === '#a11' || spec.color === '#d14' || spec.color === '#aa1111') {
    spec.color = '#d19a66';
  }
  // Add italic to comments
  if (spec.color === '#5c6370' || spec.color === '#6a9955') spec.fontStyle = 'italic';
}

// Fallback StreamLanguage parser for Typst (used when CDN is unavailable)
const _typstFallback = StreamLanguage.define({
  name: 'typst',
  startState: () => ({ inBlockComment: 0 }),
  token: (stream, state) => {
    if (stream.match('//')) { stream.skipToEnd(); return 'comment'; }
    if (stream.match('/*')) { state.inBlockComment++; return 'comment'; }
    if (state.inBlockComment) {
      if (stream.match('*/')) state.inBlockComment--;
      else stream.next();
      return 'comment';
    }
    if (stream.match(/#(let|set|show|import|include|if|else|for|while|return)\b/)) return 'keyword';
    if (stream.match(/"([^"\\]|\\.)*"/)) return 'string';
    if (stream.match(/\b\d+(\.\d+)?(pt|mm|cm|in|em|%)?\b/)) return 'number';
    if (stream.match(/=+/)) return 'heading';
    if (stream.match(/[-+*]/)) return 'list';
    stream.next();
    return null;
  },
});
// Dynamic import of @codemirror/lang-typst (tree-sitter based Typst grammar)
let _typstLang = null;
async function loadTypstLang() {
  if (!_typstLang) {
    try {
      const mod = await import('https://esm.sh/@codemirror/lang-typst@0.1.1');
      _typstLang = mod.typst();
    } catch (e) {
      console.warn('Failed to load Typst language from CDN, using fallback', e);
      _typstLang = _typstFallback;
    }
  }
  return _typstLang;
}

const API_ROOT = '/api/workspace';
const PERSISTENCE_PREFIX = 'astercaeser-code-editor:';
const PANEL_NAMES = new Set(['search']);
const TAB_SIZES = new Set([2, 4, 8]);
const MAX_LIVE_EDITOR_CHARS = 500_000;

const state = {
  context: null,
  root: null,
  tree: null,
  view: null,
  documents: new Map(),
  activePath: null,
  vimEnabled: true,
  tabSize: 2,
  treeVisible: true,
  toolsVisible: true,
  activePanel: 'search',
  panels: null,
  symbolRequestId: 0,
  completionRequestId: 0,
  initialized: false,
  noticeTimer: null,
  externalPollTimer: null,
  toolsPosition: 'bottom',
  draggedPanelName: null,
};

const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    color: '#abb2bf',
    backgroundColor: 'var(--bg)',
  },
  // Linkarzu Dark Eldritch / Neovim Theme Palette (from Screenshot)
  '.cm-content .ͼb, .cm-content .ͼa': { color: '#cc78dd' },                                   // Keywords (import, from, def, return, with, as, if, for) -> Pink/Purple (#cc78dd)
  '.cm-content .ͼc': { color: '#5c6370', fontStyle: 'italic' },                               // Comments -> Muted Olive (#5c6370)
  '.cm-content .ͼd, .cm-content .ͼe, .cm-content span[class*="ͼe"]': { color: '#d19a66' },    // Strings & Docstrings -> Amber Orange (#d19a66)
  '.cm-content .ͼf': { color: '#56b6c2' },                                                   // Numbers, Booleans & Constants -> Cyan (#56b6c2)
  '.cm-content .ͼg': { color: '#e5c07b' },                                                   // Defined Functions -> Gold (#e5c07b)
  '.cm-content .ͼh': { color: '#61afef' },                                                   // Variables & Parameters -> Light Blue (#61afef)
  '.cm-content .ͼi, .cm-content .ͼj': { color: '#36c692' },                                   // Modules, Packages & Class Names -> Vibrant Mint Green (#36c692)
  '.cm-content .ͼk, .cm-content .ͼl, .cm-content .ͼm': { color: '#e5c07b' },                  // Functions, Methods & Properties -> Gold (#e5c07b), Methods & Properties -> VS Code Yellow
  '.cm-scroller': {
    fontFamily: "'Fira Code', 'Cascadia Code', 'JetBrains Mono', monospace",
    fontSize: '13px',
    lineHeight: '1.5',
  },
  '.cm-content': { caretColor: 'var(--accent, var(--red))' },
  '.cm-gutters': {
    color: 'color-mix(in srgb, var(--fg) 42%, transparent)',
    backgroundColor: 'var(--panel)',
    borderRight: '1px solid var(--border)',
  },
  '.cm-activeLine, .cm-activeLineGutter': {
    backgroundColor: 'color-mix(in srgb, var(--fg) 5%, transparent)',
  },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--accent, var(--red)) 30%, transparent)',
  },
  '&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket': {
    backgroundColor: 'color-mix(in srgb, var(--accent, #e0e0e0) 25%, transparent)',
    outline: 'none',
  },
});

function contextSnapshot() {
  return state.context ? { ...state.context } : null;
}

function documentSnapshot(document) {
  if (!document) return null;
  return {
    path: document.path,
    name: document.path.split('/').pop(),
    language: document.languageName,
    content: document.content,
    dirty: document.dirty,
    loaded: document.loaded,
  };
}

function emit(name, detail = {}) {
  document.dispatchEvent(new CustomEvent(`aster:editor-${name}`, {
    detail: { context: contextSnapshot(), ...detail },
  }));
}

function persistenceKey(context = state.context) {
  return context ? `${PERSISTENCE_PREFIX}${context.workspaceId}:${context.projectId}` : null;
}

function isSafeRelativePath(path) {
  const value = String(path || '').replaceAll('\\', '/').replace(/^\.\//, '');
  if (!value || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..')) return null;
  return value;
}

function extensionFor(path) {
  const name = path.split('/').pop().toLowerCase();
  const ext = name.includes('.') ? name.split('.').pop() : '';
  switch (ext) {
    case 'js': case 'mjs': case 'cjs': return ['JavaScript', javascript()];
    case 'jsx': return ['JSX', javascript({ jsx: true })];
    case 'ts': return ['TypeScript', typescript()];
    case 'tsx': return ['TSX', tsx()];
    case 'py': return ['Python', python()];
    case 'json': case 'jsonc': return ['JSON', json()];
    case 'html': case 'htm': case 'svg': return ['HTML', html()];
    case 'css': return ['CSS', css()];
    case 'scss': return ['SCSS', scss()];
    case 'sass': return ['Sass', scss({ indented: true })];
    case 'md': case 'markdown': case 'mdx': return ['Markdown', markdown()];
    case 'sh': case 'bash': case 'zsh': case 'fish': return ['Shell', shell()];
    case 'typ': return ['Typst', []];  // loaded async below
    default: return ['Plain text', []];
  }
}

async function fileApi(suffix, body) {
  if (!state.context) throw new Error('Open a project before accessing files.');
  const { workspaceId, projectId } = state.context;
  const response = await fetch(
    `${API_ROOT}/${encodeURIComponent(workspaceId)}/project/${encodeURIComponent(projectId)}/files/${suffix}`,
    {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    let detail = `Request failed (${response.status})`;
    try {
      const payload = await response.json();
      detail = payload.detail || payload.message || detail;
    } catch (_) { /* Status remains useful when an error is not JSON. */ }
    const error = new Error(typeof detail === 'string' ? detail : detail?.message || `Request failed (${response.status})`);
    error.status = response.status;
    error.payload = detail;
    throw error;
  }
  return response.json();
}

function normaliseProject(detail, path) {
  const project = detail?.project || detail || {};
  const projectId = String(project.id || project.projectId || project.project_id || detail?.projectId || '');
  const workspaceId = String(
    project.workspaceId || project.workspace_id || detail?.workspaceId || detail?.workspace_id || '',
  );
  if (!projectId) throw new Error('The editor needs a project id.');
  return {
    projectId,
    workspaceId,
    path: String(project.path || detail?.path || path || ''),
  };
}

async function findWorkspaceFor(projectId) {
  const workspacesResponse = await fetch(API_ROOT, { credentials: 'same-origin' });
  if (!workspacesResponse.ok) throw new Error('Could not resolve the project workspace.');
  const workspaces = (await workspacesResponse.json()).workspaces || [];
  for (const workspace of workspaces) {
    const workspaceId = String(workspace.id || '');
    if (!workspaceId) continue;
    const projectsResponse = await fetch(
      `${API_ROOT}/${encodeURIComponent(workspaceId)}/project`,
      { credentials: 'same-origin' },
    );
    if (!projectsResponse.ok) continue;
    const project = ((await projectsResponse.json()).projects || []).find(item => String(item.id) === projectId);
    if (project) return { workspaceId: String(project.workspace_id || workspaceId), path: String(project.path || '') };
  }
  throw new Error('The selected project is no longer available.');
}

function createDocument(path) {
  const document = {
    path,
    content: '',
    savedContent: '',
    dirty: false,
    loaded: false,
    loading: false,
    error: null,
    saving: null,
    diskVersion: '',
    externalVersion: '',
    // Once a previously-open file is removed or renamed, stop the background
    // watcher from requesting it every two seconds. The tab remains available
    // with its last loaded content so the user can copy/recover it.
    externalMissing: false,
    state: null,
    languageCompartment: new Compartment(),
    vimCompartment: new Compartment(),
    tabSizeCompartment: new Compartment(),
    languageName: extensionFor(path)[0],
  };
  document.state = createEditorState(document);
  return document;
}

function createEditorState(document) {
  const [, language] = document.content.length > MAX_LIVE_EDITOR_CHARS
    ? ['Plain text', []]
    : extensionFor(document.path);
  return EditorState.create({
    doc: document.content,
    extensions: [
      document.vimCompartment.of(state.vimEnabled ? vim() : []),
      basicSetup,
      EditorView.darkTheme.of(true),
      editorTheme,
      document.languageCompartment.of(language),
      document.tabSizeCompartment.of(EditorState.tabSize.of(state.tabSize)),
      keymap.of([
        { key: 'Tab', run: indentWithConfiguredTab, preventDefault: true },
        { key: 'Mod-s', run: () => { void saveActiveFile(); return true; } },
        { key: 'Mod-\\', run: () => { toggleFileTree(); return true; } },
        { key: 'Mod-Shift-j', run: () => { toggleToolsPanel(); return true; } },
        { key: 'Mod-j', run: () => { showPanel('search'); return true; } },
        { key: 'Mod-Alt-a', run: () => { askAgentForSelection(); return true; } },
        { key: 'Mod-k', run: () => { showCommandPalette(); return true; } },
        { key: 'Ctrl-Space', run: () => { void checkInlineCompletion(); return true; } },
        { key: 'Alt-/', run: () => { void checkInlineCompletion(); return true; } },
        { key: 'F11', run: () => { void toggleFullscreen(); return true; } },
        { key: 'Mod-Alt-ArrowLeft', run: () => { toggleDock('left'); return true; } },
        { key: 'Mod-Alt-ArrowRight', run: () => { toggleDock('right'); return true; } },
        { key: 'Mod-Alt-m', run: () => { Modals.minimize('code-editor-root'); return true; } },
        { key: 'Mod-Shift-/', run: () => { showKeyboardHelp(); return true; } },
      ]),
      EditorView.updateListener.of(update => handleViewUpdate(document, update)),
    ],
  });
}

/**
 * Keep Tab inside the editor. CodeMirror's default indentation can be driven
 * by a language's preferred indent width, which is not necessarily the value
 * selected in the editor toolbar. This handler always uses that selected
 * width, while still advancing to the next tab stop for a cursor mid-line.
 */
function indentWithConfiguredTab(view) {
  const tabSize = state.tabSize;
  const document = view.state.doc;
  const changes = new Map();

  for (const range of view.state.selection.ranges) {
    if (range.empty) {
      const line = document.lineAt(range.head);
      const column = range.head - line.from;
      const spaces = tabSize - (column % tabSize);
      changes.set(range.head, ' '.repeat(spaces));
      continue;
    }

    const firstLine = document.lineAt(range.from).number;
    const endLine = document.lineAt(range.to).number;
    const lastLine = range.to > range.from && range.to === document.line(endLine).from
      ? endLine - 1
      : endLine;
    for (let number = firstLine; number <= lastLine; number += 1) {
      changes.set(document.line(number).from, ' '.repeat(tabSize));
    }
  }

  if (!changes.size) return false;
  const edits = [...changes]
    .sort(([fromA], [fromB]) => fromA - fromB)
    .map(([from, insert]) => ({ from, insert }));
  // A selection is associated with the left side of an inserted change by
  // default. Explicitly map it to the right side so the caret lands after the
  // spaces just inserted, exactly as it does in a normal code editor.
  const movePastIndent = position => position + edits.reduce(
    (offset, edit) => offset + (edit.from <= position ? edit.insert.length : 0),
    0,
  );
  view.dispatch({
    changes: edits,
    selection: EditorSelection.create(
      view.state.selection.ranges.map(range => EditorSelection.range(
        movePastIndent(range.anchor),
        movePastIndent(range.head),
      )),
      view.state.selection.mainIndex,
    ),
    userEvent: 'input.indent',
  });
  return true;
}

function handleViewUpdate(document, update) {
  document.state = update.state;
  if (update.docChanged) {
    document.content = update.state.doc.toString();
    document.dirty = document.content !== document.savedContent;
    if (document.path === state.activePath) {
      renderTabs();
      updateStatus();
    }
    persist();
    emit('document-changed', { document: documentSnapshot(document) });
  } else if (update.selectionSet && document.path === state.activePath) {
    updateStatus();
  }
  if (document.path === state.activePath && (update.docChanged || update.selectionSet)) {
    updateAskAgentAction();
  }
}

function getRootPart(selector) {
  return state.root?.querySelector(selector) || null;
}

// ── Floating-window mode ────────────────────────────────────────────────────
// The editor used to be a fullscreen-only overlay. It is now also a
// draggable/resizable/dockable window: drag the windowbar, resize any edge,
// dock left/right beside the chat, minimize to the dock chip, or maximize
// (F11 / ⛶). Mode + position persist across opens; size persists via the
// shared windowResize storage key.

const WINDOW_MODE_KEY = 'astercaeser-editor-window';

function loadWindowPrefs() {
  try { return JSON.parse(localStorage.getItem(WINDOW_MODE_KEY) || 'null') || {}; } catch (_) { return {}; }
}
function saveWindowPrefs(prefs) {
  try { localStorage.setItem(WINDOW_MODE_KEY, JSON.stringify(prefs)); } catch (_) {}
}
function storedWinSize() {
  try {
    const s = JSON.parse(localStorage.getItem('winsize-code-editor-root') || 'null');
    if (s && Number.isFinite(s.w) && Number.isFinite(s.h)) return { w: s.w, h: s.h };
  } catch (_) {}
  return null;
}

function defaultWindowRect() {
  const vw = window.innerWidth, vh = window.innerHeight;
  const w = Math.min(980, Math.max(440, Math.round(vw * 0.72)));
  const h = Math.min(760, Math.max(340, Math.round(vh * 0.78)));
  return {
    left: Math.max(8, Math.round((vw - w) / 2)),
    top: Math.max(8, Math.round((vh - h) / 3)),
    width: w,
    height: h,
  };
}

function enterWindowed() {
  const root = state.root;
  if (!root) return;
  const prefs = loadWindowPrefs();
  const stored = storedWinSize();
  const def = defaultWindowRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  const w = Math.min(vw - 16, Math.max(440, (stored && stored.w) || (prefs.mode === 'windowed' && prefs.width) || def.width));
  const h = Math.min(vh - 16, Math.max(320, (stored && stored.h) || (prefs.mode === 'windowed' && prefs.height) || def.height));
  let left = (prefs.mode === 'windowed' && Number.isFinite(prefs.left)) ? prefs.left : def.left;
  let top = (prefs.mode === 'windowed' && Number.isFinite(prefs.top)) ? prefs.top : def.top;
  left = Math.max(8, Math.min(vw - w - 8, left));
  top = Math.max(8, Math.min(vh - h - 8, top));
  root.classList.remove('code-editor-fullscreen');
  root.style.position = 'fixed';
  root.style.left = left + 'px';
  root.style.top = top + 'px';
  root.style.width = w + 'px';
  root.style.height = h + 'px';
  root.style.maxWidth = 'none';
  root.style.maxHeight = 'none';
  root.style.right = 'auto';
  root.style.bottom = 'auto';
  root.style.margin = '0';
  root.style.transform = 'none';
  root.style.borderRadius = '';
  root.style.zIndex = '300';
  saveWindowPrefs({ ...prefs, mode: 'windowed', left, top, width: w, height: h });
  updateWindowBar();
}

function enterFullscreen() {
  const root = state.root;
  if (!root) return;
  root.classList.add('code-editor-fullscreen');
  ['left', 'top', 'right', 'bottom', 'width', 'maxWidth', 'height', 'maxHeight', 'borderRadius', 'transform', 'margin', 'zIndex'].forEach(p => root.style.removeProperty(p));
  saveWindowPrefs({ ...loadWindowPrefs(), mode: 'fullscreen' });
  updateWindowBar();
}

function toggleDock(side) {
  const root = state.root;
  if (!root) return;
  const docked = root.classList.contains('modal-left-docked') ? 'left'
    : root.classList.contains('modal-right-docked') ? 'right' : null;
  if (docked) {
    if (docked === side) {
      clearRightDock(root);
    } else {
      clearRightDock(root);
      requestAnimationFrame(() => applyEdgeDock(root, side));
    }
    return;
  }
  if (root.classList.contains('code-editor-fullscreen')) enterWindowed();
  applyEdgeDock(root, side);
}

function updateWindowBar() {
  const root = state.root;
  if (!root) return;
  const nameEl = root.querySelector('.ce-window-name');
  const pathEl = root.querySelector('.ce-window-path');
  if (!nameEl && !pathEl) return;
  const ctx = state.context || {};
  const path = ctx.path || '';
  const name = path ? (path.split('/').filter(Boolean).pop() || path) : (ctx.projectId || 'Code editor');
  if (nameEl) nameEl.textContent = name;
  if (pathEl) pathEl.textContent = path;
}

function wireWindow(root) {
  if (root._ceWindowWired) return;
  root._ceWindowWired = true;
  const bar = root.querySelector('.code-editor-windowbar');
  if (!bar) return;
  makeWindowDraggable(root, {
    content: root,
    header: bar,
    fsClass: 'code-editor-fullscreen',
    mobileSkip: 768,
    minWidth: 440,
    minHeight: 320,
    resizeStorageKey: 'winsize-code-editor-root',
    enableFullscreen: true,
    onEnterFullscreen: enterFullscreen,
    onExitFullscreen: (cx, cy) => { enterWindowed(); },
    onDragEnd: ({ rect }) => {
      if (root.classList.contains('code-editor-fullscreen')) return;
      saveWindowPrefs({
        ...loadWindowPrefs(),
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
    },
  });
  // When another tool window surfaces while the editor floats, it should come
  // above the editor; grabbing the editor raises it again (see mountRoot's
  // mousedown handler). The listener is global and registered once in
  // initCodeEditor via root._ceLowerEditor so it can't leak across re-opens.
  root._ceLowerEditor = () => {
    if (!root.classList.contains('code-editor-fullscreen')
        && !root.classList.contains('modal-right-docked')
        && !root.classList.contains('modal-left-docked')) {
      root.style.zIndex = '250';
    }
  };
}

function mountRoot() {
  if (state.root) return state.root;
  const root = document.createElement('section');
  root.id = 'code-editor-root';
  root.className = 'code-editor-root code-editor-fullscreen';
  root.setAttribute('aria-label', 'Project code editor');
  root.innerHTML = `
    <div class="code-editor-windowbar" id="ce-windowbar" title="Drag to move the editor window">
      <div class="code-editor-window-title">
        <span class="ce-window-dot" aria-hidden="true"></span>
        <span class="ce-window-name" id="ce-window-name">Code editor</span>
        <span class="ce-window-path" id="ce-window-path"></span>
      </div>
      <div class="code-editor-window-controls">
        <button class="code-editor-action-btn" type="button" data-editor-action="dock-left" title="Dock left — editor beside chat (Cmd/Ctrl+Alt+←)" aria-label="Dock left">◧</button>
        <button class="code-editor-action-btn" type="button" data-editor-action="dock-right" title="Dock right — editor beside chat (Cmd/Ctrl+Alt+→)" aria-label="Dock right">◨</button>
        <button class="code-editor-action-btn" type="button" data-editor-action="minimize" title="Minimize to the dock (Cmd/Ctrl+Alt+M)" aria-label="Minimize"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="5" y1="18" x2="19" y2="18"/></svg></button>
        <button class="code-editor-action-btn" type="button" data-editor-action="fullscreen" title="Toggle fullscreen (F11)" aria-label="Toggle fullscreen">⛶</button>
        <button class="code-editor-action-btn" type="button" data-editor-action="close" title="Close editor" aria-label="Close editor">✕</button>
      </div>
    </div>
    <div class="code-editor-toolbar">
      <div class="code-editor-tabs" id="code-editor-tabs" role="tablist" aria-label="Open files"></div>
      <div class="code-editor-breadcrumb" id="ce-breadcrumb" aria-label="File path"></div>
      <div class="code-editor-actions">
        <button class="code-editor-action-btn" type="button" data-editor-action="tree" aria-pressed="true" title="Hide files (Cmd/Ctrl+\\ or Cmd/Ctrl+Alt+F)">Files</button>
        <button class="code-editor-action-btn" type="button" data-editor-action="tools" aria-pressed="true" title="Show/hide the search panel (Cmd/Ctrl+Shift+J or Cmd/Ctrl+Alt+T)">Panels</button>
        <button class="code-editor-action-btn" type="button" data-editor-action="ask-agent" disabled title="Select code to ask the agent about it">Ask agent</button>
        <button class="code-editor-action-btn" type="button" data-editor-action="definition" title="Go to definition (F12)">Definition</button>
        <button class="code-editor-action-btn" type="button" data-editor-action="references" title="Find references (Alt+F12)">References</button>
        <button class="code-editor-action-btn" type="button" data-editor-action="completion" title="Check inline completion availability">Complete</button>
        <button class="code-editor-action-btn" type="button" data-editor-action="vim" aria-pressed="true" title="Toggle Vim mode (Cmd/Ctrl+Alt+V)">Vim</button>
        <button class="code-editor-action-btn" type="button" data-editor-action="layout" aria-expanded="false" title="Editor layout and tab size (Cmd/Ctrl+Alt+L)">Layout</button>
        <button class="code-editor-action-btn" type="button" data-editor-action="commands" title="Command palette (Cmd/Ctrl+K)">Command</button>
        <button class="code-editor-action-btn" type="button" data-editor-action="help" title="Keyboard shortcuts">?</button>
      </div>
    </div>
    <div class="code-editor-body">
      <aside class="code-editor-sidebar" aria-label="Project files">
        <div class="code-editor-sidebar-header"><span>Files</span><button id="ce-file-tree-expand" type="button" title="Expand every project folder">Expand all</button></div>
        <div class="code-editor-file-tree" id="code-editor-file-tree"></div>
      </aside>
      <main class="code-editor-main">
        <div class="code-editor-textarea-wrap" id="code-editor-view" aria-label="Code editor"></div>
        <div class="code-editor-statusbar" aria-live="polite">
          <span id="ce-status-file">No file open</span>
          <span id="ce-status-language">Plain text</span>
          <span id="ce-status-tab">Tabs: 2</span>
          <span id="ce-status-save"></span>
          <span id="ce-status-position">Ln 1, Col 1</span>
        </div>
      </main>
    </div>
    <section class="code-editor-panels" aria-label="Project tools">
      <div class="code-editor-panel-tabs" role="tablist" aria-label="Project tools">
        <button id="ce-panel-tab-search" class="ce-panel-tab" type="button" role="tab" aria-controls="ce-panel-search" data-editor-panel="search">Search</button>
      </div>
      <div id="ce-panel-search" class="code-editor-panel-content" data-editor-panel-slot="search" role="tabpanel" aria-labelledby="ce-panel-tab-search" hidden></div>
    </section>
    <div id="code-editor-panel-slots" hidden aria-label="Editor extension slots"></div>
    <div class="code-editor-layout-menu" id="ce-layout-menu" role="menu" hidden aria-label="Editor layout">
      <label class="ce-layout-tab-size" for="ce-tab-size"><span>Tab size</span>
        <select id="ce-tab-size" aria-label="Tab size">
          <option value="2">2 spaces</option>
          <option value="4">4 spaces</option>
          <option value="8">8 spaces</option>
        </select>
      </label>
      <button type="button" role="menuitem" data-editor-layout="tree">Hide files <kbd>⌘\</kbd></button>
      <button type="button" role="menuitem" data-editor-layout="tools">Hide panels <kbd>⌘⇧J</kbd></button>
      <button type="button" role="menuitem" data-editor-layout="dock-left">Dock left <kbd>⌘⌥←</kbd></button>
      <button type="button" role="menuitem" data-editor-layout="dock-right">Dock right <kbd>⌘⌥→</kbd></button>
      <button type="button" role="menuitem" data-editor-layout="minimize">Minimize <kbd>⌘⌥M</kbd></button>
      <button type="button" role="menuitem" data-editor-layout="fullscreen">Toggle fullscreen <kbd>F11</kbd></button>
    </div>`;
  document.body.appendChild(root);
  state.root = root;
  root.style.display = 'flex';
  root.querySelector('[data-editor-action="vim"]')?.addEventListener('click', toggleVim);
  root.querySelector('[data-editor-action="tree"]')?.addEventListener('click', toggleFileTree);
  root.querySelector('[data-editor-action="tools"]')?.addEventListener('click', toggleToolsPanel);
  root.querySelector('[data-editor-action="ask-agent"]')?.addEventListener('click', askAgentForSelection);
  root.querySelector('[data-editor-action="definition"]')?.addEventListener('click', () => { void findSymbol('definition'); });
  root.querySelector('[data-editor-action="references"]')?.addEventListener('click', () => { void findSymbol('reference'); });
  root.querySelector('[data-editor-action="completion"]')?.addEventListener('click', () => { void checkInlineCompletion(); });
  root.querySelector('[data-editor-action="layout"]')?.addEventListener('click', toggleLayoutMenu);
  root.querySelector('[data-editor-action="commands"]')?.addEventListener('click', showCommandPalette);
  root.querySelector('[data-editor-action="help"]')?.addEventListener('click', showKeyboardHelp);
  root.querySelector('[data-editor-action="fullscreen"]')?.addEventListener('click', () => { void toggleFullscreen(); });
  root.querySelector('[data-editor-action="close"]')?.addEventListener('click', () => { void closeEditor(); });
  root.querySelector('[data-editor-action="minimize"]')?.addEventListener('click', () => { Modals.minimize('code-editor-root'); });
  root.querySelector('[data-editor-action="dock-left"]')?.addEventListener('click', () => toggleDock('left'));
  root.querySelector('[data-editor-action="dock-right"]')?.addEventListener('click', () => toggleDock('right'));
  root.addEventListener('mousedown', () => {
    if (!root.classList.contains('code-editor-fullscreen')
        && !root.classList.contains('modal-right-docked')
        && !root.classList.contains('modal-left-docked')) {
      root.style.zIndex = '300';
    }
  }, true);
  root.querySelector('#ce-file-tree-expand')?.addEventListener('click', async () => {
    const button = root.querySelector('#ce-file-tree-expand');
    if (!state.tree || button?.disabled) return;
    button.disabled = true;
    try {
      if (button.dataset.expanded === 'true') {
        state.tree.collapseAll();
        button.dataset.expanded = 'false';
      } else {
        button.textContent = 'Loading…';
        await state.tree.expandAll();
        button.dataset.expanded = 'true';
      }
    } catch (error) {
      uiModule.showError?.(`Could not expand project files: ${error.message}`);
    } finally {
      button.disabled = false;
      button.textContent = button.dataset.expanded === 'true' ? 'Collapse all' : 'Expand all';
    }
  });
  let dragOverlay = root.querySelector('#ce-drag-overlay');
  if (!dragOverlay) {
    dragOverlay = window.document.createElement('div');
    dragOverlay.id = 'ce-drag-overlay';
    dragOverlay.style.cssText = 'position:absolute;inset:0;z-index:99999;display:none;pointer-events:auto;box-sizing:border-box;transition:background 120ms ease, border 120ms ease;';
    root.appendChild(dragOverlay);
  }

  root.querySelectorAll('[data-editor-panel]').forEach(button => {
    button.addEventListener('click', () => showPanel(button.dataset.editorPanel));
    button.setAttribute('draggable', 'true');
    button.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', 'editor-panel-tab');
      e.dataTransfer.effectAllowed = 'move';
      state.draggedPanelName = button.dataset.editorPanel;
      setTimeout(() => {
        if (dragOverlay) {
          dragOverlay.style.display = 'block';
          dragOverlay.style.border = '2px dashed rgba(236, 106, 92, 0.4)';
          dragOverlay.style.background = 'rgba(236, 106, 92, 0.02)';
        }
      }, 0);
    });
    button.addEventListener('dragend', () => {
      state.draggedPanelName = null;
      if (dragOverlay) {
        dragOverlay.style.display = 'none';
        dragOverlay.style.border = 'none';
        dragOverlay.style.background = 'transparent';
      }
    });
  });

  dragOverlay.addEventListener('dragover', (e) => {
    e.preventDefault();
    const isTop = e.clientY < 52;
    const isBottom = e.clientY > window.innerHeight - 200;
    if (isTop) {
      dragOverlay.style.border = 'none';
      dragOverlay.style.borderTop = '8px dashed var(--accent, #ec6a5c)';
      dragOverlay.style.background = 'linear-gradient(to bottom, rgba(236, 106, 92, 0.12) 0%, transparent 100%)';
    } else if (isBottom) {
      dragOverlay.style.border = 'none';
      dragOverlay.style.borderBottom = '8px dashed var(--accent, #ec6a5c)';
      dragOverlay.style.background = 'linear-gradient(to top, rgba(236, 106, 92, 0.12) 0%, transparent 100%)';
    } else {
      dragOverlay.style.border = 'none';
      dragOverlay.style.borderRight = '8px dashed var(--accent, #ec6a5c)';
      dragOverlay.style.background = 'linear-gradient(to left, rgba(236, 106, 92, 0.12) 0%, transparent 100%)';
    }
  });

  dragOverlay.addEventListener('dragleave', () => {
    if (dragOverlay) {
      dragOverlay.style.border = '2px dashed rgba(236, 106, 92, 0.4)';
      dragOverlay.style.background = 'rgba(236, 106, 92, 0.02)';
    }
  });

  dragOverlay.addEventListener('drop', (e) => {
    e.preventDefault();
    if (dragOverlay) {
      dragOverlay.style.display = 'none';
    }
    const data = e.dataTransfer.getData('text/plain');
    if (data === 'editor-panel-tab') {
      const isTop = e.clientY < 52;
      const isBottom = e.clientY > window.innerHeight - 200;
      if (isTop && state.draggedPanelName) {
        const name = state.draggedPanelName;
        const path = `virtual://${name}`;
        if (!state.documents.has(path)) {
          state.documents.set(path, {
            path: path,
            content: '',
            savedContent: '',
            loaded: true,
            loading: false,
            dirty: false,
            state: EditorState.create({ extensions: [] }),
            languageName: name.toUpperCase()
          });
        }
        void openAt(path);
      } else {
        state.toolsPosition = isBottom ? 'bottom' : 'side';
        applyToolsPosition();
        applyActiveView();
        persist();
      }
    }
  });

  root.querySelector('#ce-tab-size')?.addEventListener('change', event => {
    setTabSize(Number(event.currentTarget.value));
  });
  root.querySelectorAll('[data-editor-layout]').forEach(button => {
    button.addEventListener('click', () => {
      const action = button.dataset.editorLayout;
      if (action === 'tree') toggleFileTree();
      else if (action === 'tools') toggleToolsPanel();
      else if (action === 'dock-left') toggleDock('left');
      else if (action === 'dock-right') toggleDock('right');
      else if (action === 'minimize') Modals.minimize('code-editor-root');
      else if (action === 'fullscreen') void toggleFullscreen();
      closeLayoutMenu();
    });
  });
  root.addEventListener('click', event => {
    const menu = getRootPart('#ce-layout-menu');
    const toggle = getRootPart('[data-editor-action="layout"]');
    if (menu && !menu.hidden && !menu.contains(event.target) && !toggle?.contains(event.target)) closeLayoutMenu();
  });
  root.addEventListener('keydown', event => {
    if (event.defaultPrevented) return;
    // Browser-safe toolbar chords: the extra Alt/Option modifier keeps these
    // away from common browser bindings such as Cmd/Ctrl+F, W, L, and T.
    if ((event.metaKey || event.ctrlKey) && event.altKey && !event.shiftKey) {
      const shortcutActions = {
        KeyF: 'tree',
        KeyT: 'tools',
        KeyV: 'vim',
        KeyL: 'layout',
        KeyM: 'minimize',
        ArrowLeft: 'dock-left',
        ArrowRight: 'dock-right',
      };
      const action = shortcutActions[event.code];
      const button = action ? getRootPart(`[data-editor-action="${action}"]`) : null;
      if (button && !button.disabled) {
        event.preventDefault();
        button.click();
        return;
      }
    }
    if (event.key === 'F12' && event.altKey && !event.shiftKey) {
      event.preventDefault();
      void findSymbol('reference');
    } else if (event.key === 'F12' && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      void findSymbol('definition');
    } else if (!(event.metaKey || event.ctrlKey)) {
      return;
    } else if (event.shiftKey && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      showPanel('search');
    } else if (!event.shiftKey && event.key === '\\') {
      event.preventDefault();
      toggleFileTree();
    } else if (event.shiftKey && event.key.toLowerCase() === 'j') {
      event.preventDefault();
      toggleToolsPanel();
    } else if (!event.shiftKey && event.key.toLowerCase() === 'j') {
      event.preventDefault();
      showPanel('search');
    } else if (event.altKey && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      askAgentForSelection();
    }
  });
  return root;
}

function closeLayoutMenu() {
  const menu = getRootPart('#ce-layout-menu');
  const button = getRootPart('[data-editor-action="layout"]');
  if (menu) menu.hidden = true;
  button?.setAttribute('aria-expanded', 'false');
}

function toggleLayoutMenu() {
  const menu = getRootPart('#ce-layout-menu');
  const button = getRootPart('[data-editor-action="layout"]');
  if (!menu) return;
  menu.hidden = !menu.hidden;
  button?.setAttribute('aria-expanded', String(!menu.hidden));
  if (!menu.hidden) getRootPart('#ce-tab-size')?.focus();
}

function applyActiveView() {
  const root = state.root;
  if (!root) return;

  const viewHost = getRootPart('#code-editor-view');
  const main = getRootPart('.code-editor-main');
  const panels = getRootPart('.code-editor-panels');
  
  if (!viewHost || !main || !panels) return;

  const activePath = state.activePath || '';
  const isVirtual = activePath.startsWith('virtual://');

  if (isVirtual) {
    panels.style.setProperty('display', 'none', 'important');
    viewHost.style.setProperty('display', 'none', 'important');
  } else {
    panels.style.removeProperty('display');
    viewHost.style.removeProperty('display');
    root.classList.toggle('code-editor-tools-hidden', !state.toolsVisible);
  }

  for (const name of ['search']) {
    const panel = getRootPart(`#ce-panel-${name}`);
    if (!panel) continue;
    
    if (panel.parentNode === main) {
      panels.appendChild(panel);
    }
    
    const isThisVirtualActive = activePath === `virtual://${name}`;
    if (isThisVirtualActive) {
      main.appendChild(panel);
      panel.hidden = false;
      panel.style.removeProperty('display');
      panel.style.setProperty('flex', '1', 'important');
      panel.style.setProperty('height', '100%', 'important');
    } else {
      const isActiveInBottom = state.activePanel === name && !isVirtual;
      panel.hidden = !isActiveInBottom;
      if (isActiveInBottom) {
        panel.style.removeProperty('display');
      } else {
        panel.style.setProperty('display', 'none', 'important');
      }
    }
  }
}

let popupDragInitialized = false;

function applyToolsPosition() {
  const panels = getRootPart('.code-editor-panels');
  const root = getRootPart('#code-editor-root');
  if (!panels || !root) return;

  if (panels.parentNode !== root) {
    root.appendChild(panels);
  }
  
  if (!popupDragInitialized) {
    const header = getRootPart('.code-editor-panel-tabs');
    if (header) {
      popupDragInitialized = true;
      let isDragging = false;
      let startX = 0, startY = 0;
      let initialX = 0, initialY = 0;

      header.addEventListener('mousedown', (e) => {
        if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        
        const rect = panels.getBoundingClientRect();
        const rootRect = root.getBoundingClientRect();
        
        initialX = rect.left - rootRect.left;
        initialY = rect.top - rootRect.top;
        
        panels.style.width = rect.width + 'px';
        panels.style.height = rect.height + 'px';
        
        e.preventDefault();
      });

      window.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        
        panels.style.left = (initialX + dx) + 'px';
        panels.style.top = (initialY + dy) + 'px';
        panels.style.bottom = 'auto';
        panels.style.right = 'auto';
      });

      window.addEventListener('mouseup', () => {
        isDragging = false;
      });
    }
  }
}

function syncLayoutPreferences() {
  const root = state.root;
  if (!root) return;
  root.classList.toggle('code-editor-tree-hidden', !state.treeVisible);
  root.classList.toggle('code-editor-tools-hidden', !state.toolsVisible);
  const treeButton = getRootPart('[data-editor-action="tree"]');
  const toolsButton = getRootPart('[data-editor-action="tools"]');
  const treeMenu = getRootPart('[data-editor-layout="tree"]');
  const toolsMenu = getRootPart('[data-editor-layout="tools"]');
  const tabSize = getRootPart('#ce-tab-size');
  const tabStatus = getRootPart('#ce-status-tab');
  if (treeButton) {
    treeButton.textContent = state.treeVisible ? 'Files' : 'Files off';
    treeButton.title = `${state.treeVisible ? 'Hide' : 'Show'} files (Cmd/Ctrl+\\)`;
    treeButton.setAttribute('aria-pressed', String(state.treeVisible));
  }
  if (toolsButton) {
    toolsButton.textContent = state.toolsVisible ? 'Panels' : 'Panels off';
    toolsButton.title = `${state.toolsVisible ? 'Hide' : 'Show'} the search panel (Cmd/Ctrl+Shift+J)`;
    toolsButton.setAttribute('aria-pressed', String(state.toolsVisible));
  }
  if (treeMenu) treeMenu.innerHTML = `${state.treeVisible ? 'Hide' : 'Show'} files <kbd>⌘\\</kbd>`;
  if (toolsMenu) toolsMenu.innerHTML = `${state.toolsVisible ? 'Hide' : 'Show'} panels <kbd>⌘⇧J</kbd>`;
  if (tabSize) tabSize.value = String(state.tabSize);
  if (tabStatus) tabStatus.textContent = `Tabs: ${state.tabSize}`;
  applyToolsPosition();
}

function setTabSize(value) {
  const tabSize = TAB_SIZES.has(value) ? value : 2;
  if (tabSize === state.tabSize) {
    syncLayoutPreferences();
    return;
  }
  state.tabSize = tabSize;
  for (const document of state.documents.values()) {
    const effect = document.tabSizeCompartment.reconfigure(EditorState.tabSize.of(tabSize));
    if (document.path === state.activePath && state.view) state.view.dispatch({ effects: effect });
    else document.state = document.state.update({ effects: effect }).state;
  }
  syncLayoutPreferences();
  persist();
  notice(`Tab size set to ${tabSize} spaces`);
}

function toggleFileTree() {
  state.treeVisible = !state.treeVisible;
  syncLayoutPreferences();
  persist();
  notice(state.treeVisible ? 'Files shown' : 'Files hidden');
}

function toggleToolsPanel() {
  state.toolsVisible = !state.toolsVisible;
  syncLayoutPreferences();
  if (state.toolsVisible) showPanel(state.activePanel, { focus: false });
  persist();
  notice(state.toolsVisible ? 'Search panel shown' : 'Search panel hidden');
}

function selectedCodeContext() {
  const active = state.documents.get(state.activePath);
  const view = state.view;
  if (!active || !view || !state.context) return null;
  const selection = view.state.selection.main;
  if (selection.empty) return null;
  const text = view.state.sliceDoc(selection.from, selection.to);
  if (!text) return null;
  return {
    text,
    path: active.path,
    startLine: view.state.doc.lineAt(selection.from).number,
    endLine: view.state.doc.lineAt(selection.to).number,
    projectId: state.context.projectId,
  };
}

function symbolAtCursorOrSelection() {
  const view = state.view;
  if (!view) return null;
  const selection = view.state.selection.main;
  const raw = selection.empty
    ? view.state.wordAt(selection.head)?.text
    : view.state.sliceDoc(selection.from, selection.to);
  const symbol = String(raw || '').trim();
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(symbol) ? symbol : null;
}

function updateAskAgentAction() {
  const button = getRootPart('[data-editor-action="ask-agent"]');
  if (!button) return;
  const selection = selectedCodeContext();
  button.disabled = !selection;
  button.title = selection
    ? `Ask the agent about ${selection.path}, ${selection.startLine === selection.endLine ? `line ${selection.startLine}` : `lines ${selection.startLine}-${selection.endLine}`}`
    : 'Select code to ask the agent about it';
}

function askAgentForSelection() {
  const selection = selectedCodeContext();
  if (!selection) {
    updateAskAgentAction();
    notice('Select code before asking the agent.');
    return false;
  }
  const accepted = () => {
    // A full-screen editor otherwise obscures the newly opened chat, which
    // made a successful Ask Agent action look like a no-op.  Respect unsaved
    // changes through the normal close flow before revealing the chat.
    void closeEditor().then(closed => {
      if (!closed) notice('The selected code was sent. Close the editor to view the chat.');
    });
  };
  const rejected = error => {
    notice(`Could not start the project chat: ${error?.message || 'Unknown error'}`, 4200);
  };
  if (!askAgentAboutSelection(selection, { onAccepted: accepted, onError: rejected })) {
    notice('Could not prepare the selected code for chat.');
    return false;
  }
  notice('Sending selected code to a project chat…');
  return true;
}

async function projectApi(suffix, body, context = state.context) {
  if (!context?.workspaceId || !context?.projectId) throw new Error('Open a project first.');
  const response = await fetch(
    `${API_ROOT}/${encodeURIComponent(context.workspaceId)}/project/${encodeURIComponent(context.projectId)}/${suffix}`,
    {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  let payload = null;
  try { payload = await response.json(); } catch (_) { /* Preserve the HTTP status below. */ }
  if (!response.ok) throw new Error(payload?.detail || payload?.message || `Request failed (${response.status})`);
  return payload || {};
}

function closeSymbolResults() {
  state.root?.querySelector('.code-editor-symbol-dialog')?.remove();
}

function showSymbolResults(symbol, mode, response) {
  closeSymbolResults();
  if (!state.root) return;
  const results = Array.isArray(response.results) ? response.results : [];
  const dialog = document.createElement('div');
  dialog.className = 'code-editor-symbol-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', `${mode === 'definition' ? 'Definitions' : 'References'} for ${symbol}`);
  dialog.style.cssText = 'position:absolute;inset:0;z-index:3;display:grid;place-items:center;background:rgb(0 0 0 / 55%);';
  const card = document.createElement('section');
  card.style.cssText = 'width:min(680px,calc(100% - 32px));max-height:min(520px,calc(100% - 32px));display:flex;flex-direction:column;gap:8px;padding:16px;border:1px solid var(--border);border-radius:8px;background:var(--panel);box-shadow:0 12px 32px rgb(0 0 0 / 35%);font-size:12px;';
  const header = document.createElement('div');
  const count = Number.isFinite(response.total) ? response.total : results.length;
  header.textContent = results.length === 0
    ? `No ${mode === 'definition' ? 'definition' : 'references'} found for ${symbol}.`
    : `${count} ${mode === 'definition' ? 'definition' : 'reference'} result${count === 1 ? '' : 's'} for ${symbol}${response.truncated ? ' (truncated)' : ''}. ${results.length > 1 ? 'Choose a result.' : ''}`;
  card.appendChild(header);
  const list = document.createElement('div');
  list.style.cssText = 'display:grid;gap:4px;overflow:auto;';
  for (const result of results) {
    const path = isSafeRelativePath(result.path);
    const line = Number(result.line_number || result.line || 1);
    if (!path || !Number.isInteger(line) || line < 1) continue;
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'ce-search-hit';
    item.style.textAlign = 'left';
    const location = document.createElement('strong');
    location.textContent = `${result.kind || mode} · ${path}:${line}`;
    const snippet = document.createElement('span');
    snippet.style.cssText = 'display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.72;';
    snippet.textContent = String(result.content || '');
    item.append(location, snippet);
    item.addEventListener('click', () => {
      closeSymbolResults();
      void openAt(path, { line });
    });
    list.appendChild(item);
  }
  card.appendChild(list);
  const close = document.createElement('button');
  close.type = 'button'; close.className = 'code-editor-action-btn'; close.textContent = 'Close';
  close.addEventListener('click', closeSymbolResults);
  card.appendChild(close); dialog.appendChild(card);
  dialog.addEventListener('click', event => { if (event.target === dialog) closeSymbolResults(); });
  dialog.addEventListener('keydown', event => { if (event.key === 'Escape') closeSymbolResults(); });
  state.root.appendChild(dialog);
  close.focus();
}

async function findSymbol(mode) {
  const symbol = symbolAtCursorOrSelection();
  if (!symbol) {
    notice('Place the cursor in an identifier or select one first.');
    return false;
  }
  const context = contextSnapshot();
  const active = state.documents.get(state.activePath);
  const requestId = ++state.symbolRequestId;
  notice(`Finding ${mode === 'definition' ? 'definition' : 'references'} for ${symbol}…`);
  try {
    const response = await projectApi('symbols/search', {
      query: symbol,
      mode,
      path: active?.path || null,
      max_results: 50,
    }, context);
    if (requestId !== state.symbolRequestId || context?.workspaceId !== state.context?.workspaceId || context?.projectId !== state.context?.projectId) return false;
    showSymbolResults(symbol, mode, response);
    return true;
  } catch (error) {
    if (requestId === state.symbolRequestId) notice(`Symbol lookup failed: ${error.message}`, 3200);
    return false;
  }
}

async function checkInlineCompletion() {
  const active = state.documents.get(state.activePath);
  const view = state.view;
  const context = contextSnapshot();
  if (!active || !view || !context) return false;
  const requestId = ++state.completionRequestId;
  const button = getRootPart('[data-editor-action="completion"]');
  if (button) button.disabled = true;
  const cursor = view.state.selection.main.head;
  const content = view.state.doc.toString();
  const selection = view.state.selection.main;
  const body = {
    prefix: content.slice(Math.max(0, cursor - 4000), cursor),
    suffix: content.slice(cursor, cursor + 4000),
    selected_text: selection.empty ? '' : content.slice(selection.from, Math.min(selection.to, selection.from + 4000)),
    current_file_context: content.slice(Math.max(0, cursor - 6000), Math.min(content.length, cursor + 6000)),
    language: active.languageName,
  };
  notice('Copilot checking completion…');
  const result = await requestInlineCompletion(context, body);
  if (button) button.disabled = false;
  if (requestId !== state.completionRequestId || context.workspaceId !== state.context?.workspaceId || context.projectId !== state.context?.projectId) return false;
  if (!result.available) {
    if (!result.aborted) notice(`Copilot unavailable: ${result.reason}`, 4200);
    return false;
  }
  if (result.completion) {
    const lineStart = content.lastIndexOf('\n', cursor - 1) + 1;
    view.dispatch({
      changes: { from: lineStart, to: cursor, insert: result.completion },
      selection: { anchor: lineStart + result.completion.length },
    });
    notice('AI Copilot code inserted!', 2500);
    return true;
  }
  notice('Copilot returned no suggestion for this line.', 2500);
  return false;
}

function showPanel(name, { focus = true } = {}) {
  if (name !== 'search' || !state.panels) return null;

  const isVirtualActive = state.activePath?.startsWith('virtual://');
  if (isVirtualActive) {
    void openAt('virtual://search');
    return getRootPart('[data-editor-panel-slot="search"]');
  }

  if (!state.toolsVisible) {
    state.toolsVisible = true;
    syncLayoutPreferences();
  }
  state.activePanel = name;
  const panel = getRootPart('#ce-panel-search');
  const tab = getRootPart('#ce-panel-tab-search');
  const active = true;
  if (panel) {
    panel.hidden = !active;
    if (active) panel.style.removeProperty('display');
    else panel.style.setProperty('display', 'none', 'important');
  }
  if (tab) {
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  }
  if (focus) requestAnimationFrame(() => state.panels?.search?.focus());
  applyActiveView();
  persist();
  emit('panel-request', { panel: name, slot: getRootPart('[data-editor-panel-slot="search"]') });
  return getRootPart('[data-editor-panel-slot="search"]');
}

async function saveAllOpenDocuments() {
  for (const document of state.documents.values()) {
    if (!await saveDocument(document)) return false;
  }
  return true;
}

async function refreshFilesAfterReplace(paths) {
  const changed = new Set(paths.map(isSafeRelativePath).filter(Boolean));
  for (const document of state.documents.values()) {
    if (!changed.has(document.path)) continue;
    document.loaded = false;
    document.loading = false;
    document.error = null;
    await readDocument(document);
  }
  await state.tree?.refresh?.();
  renderTabs();
  updateStatus();
}

function mountPanels() {
  if (!state.root || state.panels) return;
  const searchHost = getRootPart('#ce-panel-search');
  const search = searchHost && state.context
    ? new ProjectSearchPanel(searchHost, state.context, {
      onOpenAt: openAt,
      onBeforeReplace: saveAllOpenDocuments,
      onFilesChanged: refreshFilesAfterReplace,
    }).mount()
    : null;
  state.panels = { search };
  if (state.toolsVisible) showPanel(state.activePanel, { focus: false });
}

function ensureView() {
  const host = getRootPart('#code-editor-view');
  if (!host) return null;
  const active = state.documents.get(state.activePath);
  if (!state.view) {
    state.view = new EditorView({
      state: active?.state || EditorState.create({ extensions: [basicSetup, editorTheme] }),
      parent: host,
    });
  }
  return state.view;
}

function renderTabs() {
  const tabs = getRootPart('#code-editor-tabs');
  if (!tabs) return;
  tabs.replaceChildren();
  for (const document of state.documents.values()) {
    const tab = window.document.createElement('button');
    tab.type = 'button';
    tab.className = `code-editor-tab${document.path === state.activePath ? ' active' : ''}${document.dirty ? ' dirty' : ''}`;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(document.path === state.activePath));
    tab.title = document.path;
    const name = window.document.createElement('span');
    name.className = 'ce-tab-name';
    name.textContent = document.path.split('/').pop();
    const close = window.document.createElement('span');
    close.className = 'ce-tab-close';
    close.textContent = '✕';
    close.setAttribute('aria-label', `Close ${document.path}`);
    close.addEventListener('click', event => { event.stopPropagation(); void closeFile(document.path); });
    tab.append(name, close);
    tab.addEventListener('click', () => { void openAt(document.path); });
    tabs.appendChild(tab);
  }
}

function updateStatus(message = '') {
  const active = state.documents.get(state.activePath);
  const file = getRootPart('#ce-status-file');
  const language = getRootPart('#ce-status-language');
  const save = getRootPart('#ce-status-save');
  const position = getRootPart('#ce-status-position');
  const breadcrumb = getRootPart('#ce-breadcrumb');
  if (!active) {
    if (file) file.textContent = 'No file open';
    if (language) language.textContent = 'Plain text';
    if (position) position.textContent = 'Ln 1, Col 1';
  } else {
    if (file) file.textContent = active.path;
    if (language) language.textContent = active.languageName;
    if (breadcrumb) breadcrumb.textContent = active.path;
    if (position && state.view) {
      const cursor = state.view.state.selection.main.head;
      const line = state.view.state.doc.lineAt(cursor);
      position.textContent = `Ln ${line.number}, Col ${cursor - line.from + 1}`;
    }
  }
  if (!active && breadcrumb) breadcrumb.textContent = '';
  if (save) save.textContent = message;
}

function notice(message, duration = 1600) {
  updateStatus(message);
  clearTimeout(state.noticeTimer);
  state.noticeTimer = setTimeout(() => updateStatus(), duration);
}

function persist() {
  const key = persistenceKey();
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify({
      openPaths: [...state.documents.keys()],
      activePath: state.activePath,
      vimEnabled: state.vimEnabled,
      tabSize: state.tabSize,
      treeVisible: state.treeVisible,
      toolsVisible: state.toolsVisible,
      activePanel: state.activePanel,
      toolsPosition: state.toolsPosition,
    }));
  } catch (_) { /* Persistence is optional (private browsing may reject it). */ }
}

function restore() {
  const key = persistenceKey();
  if (!key) return [];
  try {
    const saved = JSON.parse(localStorage.getItem(key) || '{}');
    if (typeof saved.vimEnabled === 'boolean') state.vimEnabled = saved.vimEnabled;
    if (TAB_SIZES.has(saved.tabSize)) state.tabSize = saved.tabSize;
    if (typeof saved.treeVisible === 'boolean') state.treeVisible = saved.treeVisible;
    if (typeof saved.toolsVisible === 'boolean') state.toolsVisible = saved.toolsVisible;
    if (saved.activePanel === 'search') state.activePanel = saved.activePanel;
    if (saved.toolsPosition === 'bottom' || saved.toolsPosition === 'side') state.toolsPosition = saved.toolsPosition;
    return Array.isArray(saved.openPaths)
      ? saved.openPaths.map(p => p.startsWith('virtual://')
          ? (p === 'virtual://ai' || p === 'virtual://terminal' ? null : p)
          : isSafeRelativePath(p)).filter(Boolean).slice(0, 24)
      : [];
  } catch (_) {
    return [];
  }
}

async function setActive(path, { line, column } = {}) {
  const active = state.documents.get(path);
  if (!active) return false;
  state.activePath = path;

  if (path.startsWith('virtual://')) {
    applyActiveView();
  } else {
    const view = ensureView();
    if (view && view.state !== active.state) view.setState(active.state);
    applyActiveView();
  }

  renderTabs();
  updateStatus(active.loading ? 'Loading…' : active.error ? 'Load failed' : '');
  updateAskAgentAction();
  persist();
  emit('active-document', { document: documentSnapshot(active) });
  if (Number.isInteger(line) && line > 0) {
    requestAnimationFrame(() => goToPosition(line, column));
  }
  if (!path.startsWith('virtual://')) {
    requestAnimationFrame(() => state.view?.focus());
  }
  return true;
}

async function readDocument(document) {
  if (document.loaded || document.loading) return;
  document.loading = true;
  document.error = null;
  if (document.path === state.activePath) updateStatus('Loading…');
  try {
    const response = await fileApi('read', { path: document.path });
    document.content = String(response.content || '');
    document.savedContent = document.content;
    document.diskVersion = String(response.version || '');
    document.externalVersion = '';
    document.externalMissing = false;
    document.dirty = false;
    document.loaded = true;
    document.languageName = document.content.length > MAX_LIVE_EDITOR_CHARS
      ? 'Plain text (large file)'
      : extensionFor(document.path)[0];
    document.state = createEditorState(document);
    if (document.path === state.activePath) emit('active-document', { document: documentSnapshot(document) });
  } catch (error) {
    document.error = error.message;
    uiModule.showError?.(`Could not open ${document.path}: ${error.message}`);
  } finally {
    document.loading = false;
    if (document.path === state.activePath) {
      const view = ensureView();
      if (view && view.state !== document.state) view.setState(document.state);
      renderTabs();
      updateStatus(document.error ? 'Load failed' : '');
      updateAskAgentAction();
    }
  }
}

async function refreshExternallyChangedFile(path, projectId) {
  const safePath = isSafeRelativePath(path);
  if (!safePath || !state.context || (projectId && String(projectId) !== String(state.context.projectId))) return false;
  const document = state.documents.get(safePath);
  // Never discard local typing. The user can save or reopen deliberately if
  // they want the on-disk version instead.
  if (document?.dirty) {
    notice(`${safePath} changed on disk; keeping your unsaved editor changes.`, 4200);
    return false;
  }
  try {
    const response = await fileApi('read', { path: safePath });
    const content = String(response.content || '');
    if (document) {
      document.content = content;
      document.savedContent = content;
      document.diskVersion = String(response.version || '');
      document.externalVersion = '';
      document.dirty = false;
      document.loaded = true;
      document.state = createEditorState(document);
      if (document.path === state.activePath) {
        const view = ensureView();
        if (view && view.state !== document.state) view.setState(document.state);
        updateStatus('Updated from project');
        updateAskAgentAction();
      }
      renderTabs();
      emit('external-file-refresh', { document: documentSnapshot(document) });
    }
    await state.tree?.refresh();
    return true;
  } catch (error) {
    notice(`Could not refresh ${safePath}: ${error.message}`, 4200);
    return false;
  }
}

async function pollExternalProjectChanges() {
  if (state.externalPollInFlight || window.document.hidden || !state.context) return;
  const context = contextSnapshot();
  const documents = [...state.documents.values()].filter(
    item => item.loaded && !item.loading && !item.externalMissing,
  );
  if (!documents.length) return;
  state.externalPollInFlight = true;
  try {
    for (const editorDocument of documents) {
      if (!state.context || context.workspaceId !== state.context.workspaceId || context.projectId !== state.context.projectId) return;
      try {
        const response = await fileApi('stat', { path: editorDocument.path });
        const version = String(response.version || '');
        if (!version || !editorDocument.diskVersion || version === editorDocument.diskVersion) continue;
        if (editorDocument.dirty) {
          if (editorDocument.externalVersion !== version) {
            editorDocument.externalVersion = version;
            notice(`${editorDocument.path} changed outside the editor; keeping your unsaved edits.`, 4200);
          }
          continue;
        }
        await refreshExternallyChangedFile(editorDocument.path, context.projectId);
      } catch (error) {
        // A renamed/deleted tab would otherwise generate a pair of 404s on
        // every watcher tick forever. Preserve its already-loaded content, but
        // retire it from background polling until the user opens it again.
        if (error?.status === 404) {
          editorDocument.externalMissing = true;
          if (editorDocument.path === state.activePath) {
            updateStatus('File was removed or renamed on disk');
          }
          notice(`${editorDocument.path} was removed or renamed on disk; keeping the open tab.`, 4200);
        }
        // Other transient errors are intentionally retried by the watcher.
      }
    }
  } finally {
    state.externalPollInFlight = false;
  }
}

function startExternalFileWatcher() {
  if (state.externalPollTimer) return;
  state.externalPollTimer = window.setInterval(() => { void pollExternalProjectChanges(); }, 2000);
}

/** Open a project-relative file and optionally reveal a line/column. */
export async function openAt(path, options = {}) {
  const isVirtual = path.startsWith('virtual://');
  const safePath = isVirtual ? path : isSafeRelativePath(path);
  if (!safePath || !state.context) return false;
  let document = state.documents.get(safePath);
  if (!document) {
    if (isVirtual) {
      const name = safePath.replace('virtual://', '');
      document = {
        path: safePath,
        content: '',
        savedContent: '',
        loaded: true,
        loading: false,
        dirty: false,
        state: EditorState.create({ extensions: [] }),
        languageName: name.toUpperCase()
      };
    } else {
      document = createDocument(safePath);
    }
    state.documents.set(safePath, document);
  }
  // Load real Typst grammar from CDN (tree-sitter based), fallback to StreamLanguage
  if (!isVirtual && safePath.endsWith('.typ') && state.view) {
    loadTypstLang().then(lang => {
      if (lang && state.view && document.path === state.activePath) {
        state.view.dispatch({ effects: document.languageCompartment.reconfigure(lang) });
      }
    });
  }
  await setActive(safePath, options);
  if (!isVirtual) {
    await readDocument(document);
    if (!document.error && Number.isInteger(options.line) && options.line > 0) goToPosition(options.line, options.column);
  }
  return !document.error;
}

export const openFile = openAt;

function goToPosition(lineNumber, column = 1) {
  if (!state.view) return;
  const line = state.view.state.doc.line(Math.max(1, Math.min(lineNumber, state.view.state.doc.lines)));
  const position = Math.min(line.to, line.from + Math.max(0, (column || 1) - 1));
  state.view.dispatch({ selection: { anchor: position }, scrollIntoView: true });
  state.view.focus();
}

export function goToLine(line) {
  goToPosition(line, 1);
}

async function saveDocument(document, { force = false } = {}) {
  if (!document || !document.loaded || !document.dirty) return true;
  if (document.saving) return document.saving;
  const contentToSave = document.content;
  document.saving = (async () => {
    try {
      const response = await fileApi('write', {
        path: document.path,
        content: contentToSave,
        expected_version: document.diskVersion || undefined,
        force,
      });
      document.savedContent = contentToSave;
      document.diskVersion = String(response.version || '');
      document.externalVersion = '';
      document.dirty = document.content !== document.savedContent;
      renderTabs();
      if (document.path === state.activePath) {
        notice(document.dirty ? 'Saved; newer edits remain' : 'Saved');
      }
      persist();
      emit('saved', { document: documentSnapshot(document) });
      return !document.dirty;
    } catch (error) {
      if (error.status === 409 && document.path === state.activePath) {
        document.externalVersion = String(error.payload?.current_version || 'changed');
        const choice = await externalConflictChoice(document);
        if (choice === 'reload') {
          await refreshExternallyChangedFile(document.path, state.context?.projectId);
          return false;
        }
        if (choice === 'overwrite') {
          document.saving = null;
          return saveDocument(document, { force: true });
        }
        notice('Save cancelled; your edits are still in the editor.', 4200);
        return false;
      }
      uiModule.showError?.(`Could not save ${document.path}: ${error.message}`);
      if (document.path === state.activePath) updateStatus('Save failed');
      return false;
    } finally {
      document.saving = null;
    }
  })();
  return document.saving;
}

export async function saveActiveFile() {
  return saveDocument(state.documents.get(state.activePath));
}

function unsavedChoice(document, reason) {
  return new Promise(resolve => {
    const dialog = window.document.createElement('div');
    dialog.className = 'code-editor-unsaved-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', 'Unsaved changes');
    dialog.style.cssText = 'position:absolute;inset:0;z-index:3;display:grid;place-items:center;background:rgb(0 0 0 / 55%);';
    const card = window.document.createElement('div');
    card.style.cssText = 'max-width:360px;padding:16px;border:1px solid var(--border);border-radius:8px;background:var(--panel);box-shadow:0 12px 32px rgb(0 0 0 / 35%);font-size:12px;';
    const text = window.document.createElement('p');
    text.style.marginTop = '0';
    text.textContent = `${document.path} has unsaved changes. ${reason}`;
    const actions = window.document.createElement('div');
    actions.style.cssText = 'display:flex;justify-content:flex-end;gap:6px;';
    const finish = choice => { dialog.remove(); resolve(choice); };
    for (const [label, choice] of [['Cancel', 'cancel'], ['Don’t Save', 'discard'], ['Save', 'save']]) {
      const button = window.document.createElement('button');
      button.type = 'button';
      button.className = 'code-editor-action-btn';
      button.textContent = label;
      button.addEventListener('click', () => finish(choice));
      actions.appendChild(button);
      if (choice === 'cancel') requestAnimationFrame(() => button.focus());
    }
    dialog.addEventListener('keydown', event => { if (event.key === 'Escape') finish('cancel'); });
    card.append(text, actions);
    dialog.appendChild(card);
    state.root?.appendChild(dialog);
  });
}

function externalConflictChoice(document) {
  return new Promise(resolve => {
    const dialog = window.document.createElement('div');
    dialog.className = 'code-editor-unsaved-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', 'File changed on disk');
    dialog.style.cssText = 'position:absolute;inset:0;z-index:3;display:grid;place-items:center;background:rgb(0 0 0 / 55%);';
    const card = window.document.createElement('div');
    card.style.cssText = 'max-width:390px;padding:16px;border:1px solid var(--border);border-radius:8px;background:var(--panel);box-shadow:0 12px 32px rgb(0 0 0 / 35%);font-size:12px;';
    const heading = window.document.createElement('strong');
    heading.textContent = 'File changed on disk';
    const text = window.document.createElement('p');
    text.textContent = `${document.path} was changed outside this editor. Choose whether to keep your edits or reload the newer file.`;
    text.style.margin = '10px 0 14px';
    const actions = window.document.createElement('div');
    actions.style.cssText = 'display:flex;justify-content:flex-end;gap:6px;flex-wrap:wrap;';
    const finish = choice => { dialog.remove(); resolve(choice); };
    for (const [label, choice] of [['Cancel', 'cancel'], ['Reload disk', 'reload'], ['Keep mine', 'overwrite']]) {
      const button = window.document.createElement('button');
      button.type = 'button';
      button.className = 'code-editor-action-btn';
      button.textContent = label;
      button.addEventListener('click', () => finish(choice));
      actions.appendChild(button);
    }
    card.append(heading, text, actions);
    dialog.appendChild(card);
    dialog.addEventListener('click', event => { if (event.target === dialog) finish('cancel'); });
    dialog.addEventListener('keydown', event => { if (event.key === 'Escape') finish('cancel'); });
    state.root?.appendChild(dialog);
    requestAnimationFrame(() => actions.querySelector('button')?.focus());
  });
}

async function allowDiscard(document, reason) {
  if (!document?.dirty) return true;
  const choice = await unsavedChoice(document, reason);
  if (choice === 'cancel') return false;
  if (choice === 'save') return saveDocument(document);
  return true;
}

export async function closeFile(path) {
  const document = state.documents.get(path);
  if (!document || !await allowDiscard(document, 'Close this tab?')) return false;
  const wasActive = state.activePath === path;
  state.documents.delete(path);
  if (wasActive) {
    const next = [...state.documents.keys()].at(-1) || null;
    state.activePath = next;
    if (next) await setActive(next);
    else {
      if (state.view) state.view.setState(EditorState.create({ extensions: [basicSetup, editorTheme] }));
      applyActiveView();
    }
  } else {
    applyActiveView();
  }
  renderTabs();
  updateStatus();
  persist();
  return true;
}

export async function toggleVim() {
  state.vimEnabled = !state.vimEnabled;
  for (const document of state.documents.values()) {
    const effect = document.vimCompartment.reconfigure(state.vimEnabled ? vim() : []);
    if (document.path === state.activePath && state.view) state.view.dispatch({ effects: effect });
    else document.state = document.state.update({ effects: effect }).state;
  }
  getRootPart('[data-editor-action="vim"]')?.setAttribute('aria-pressed', String(state.vimEnabled));
  const vimButton = getRootPart('[data-editor-action="vim"]');
  if (vimButton) vimButton.textContent = state.vimEnabled ? 'Vim' : 'Vim off';
  persist();
  notice(state.vimEnabled ? 'Vim mode on' : 'Vim mode off');
}

export async function toggleFullscreen() {
  const root = state.root;
  if (!root) return false;
  if (root.classList.contains('code-editor-fullscreen')) enterWindowed();
  else enterFullscreen();
  try {
    if (!document.fullscreenElement && root.requestFullscreen) await root.requestFullscreen();
    else if (document.fullscreenElement && document.exitFullscreen) await document.exitFullscreen();
  } catch (_) {
    // The overlay already fills the viewport; browser fullscreen is optional.
  }
  return true;
}

function showCommandPalette() {
  if (!state.root || state.root.querySelector('.code-editor-command-dialog')) return;
  const dialog = window.document.createElement('div');
  dialog.className = 'code-editor-command-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', 'Command palette');
  dialog.style.cssText = 'position:absolute;inset:0;z-index:6;display:grid;place-items:start center;padding-top:11vh;background:rgb(0 0 0 / 45%);';
  const card = window.document.createElement('div');
  card.style.cssText = 'width:min(520px,calc(100% - 28px));border:1px solid var(--border);border-radius:9px;background:var(--panel);box-shadow:0 16px 44px rgb(0 0 0 / 40%);overflow:hidden;';
  const input = window.document.createElement('input');
  input.type = 'search';
  input.placeholder = 'Type a command…';
  input.setAttribute('aria-label', 'Filter commands');
  input.style.cssText = 'width:100%;padding:12px 14px;border:0;border-bottom:1px solid var(--border);background:var(--bg);color:var(--fg);font:13px inherit;outline:none;box-sizing:border-box;';
  const list = window.document.createElement('div');
  list.style.cssText = 'max-height:360px;overflow:auto;padding:6px;';
  const commands = [
    ['Save active file', () => saveActiveFile()],
    ['Open project search', () => showPanel('search')],
    ['Toggle files sidebar', () => toggleFileTree()],
    ['Toggle Vim mode', () => toggleVim()],
    ['Toggle fullscreen', () => toggleFullscreen()],
    ['Dock left beside chat', () => toggleDock('left')],
    ['Dock right beside chat', () => toggleDock('right')],
    ['Minimize to dock', () => { Modals.minimize('code-editor-root'); }],
    ['Show keyboard shortcuts', () => showKeyboardHelp()],
  ];
  const render = () => {
    const query = input.value.trim().toLowerCase();
    list.replaceChildren();
    commands.filter(([label]) => label.toLowerCase().includes(query)).forEach(([label, action]) => {
      const button = window.document.createElement('button');
      button.type = 'button';
      button.className = 'code-editor-action-btn';
      button.style.cssText = 'display:block;width:100%;padding:9px 10px;text-align:left;border:0;border-radius:5px;';
      button.textContent = label;
      button.addEventListener('click', () => { dialog.remove(); void action(); });
      list.append(button);
    });
  };
  input.addEventListener('input', render);
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.remove(); });
  dialog.addEventListener('keydown', event => { if (event.key === 'Escape') dialog.remove(); });
  card.append(input, list);
  dialog.appendChild(card);
  state.root.appendChild(dialog);
  render();
  input.focus();
}

function showKeyboardHelp() {
  if (!state.root || state.root.querySelector('.code-editor-help-dialog')) return;
  const dialog = window.document.createElement('div');
  dialog.className = 'code-editor-help-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', 'Editor keyboard shortcuts');
  dialog.style.cssText = 'position:absolute;inset:0;z-index:3;display:grid;place-items:center;background:rgb(0 0 0 / 55%);';
  const card = window.document.createElement('div');
  card.style.cssText = 'max-width:420px;padding:16px;border:1px solid var(--border);border-radius:8px;background:var(--panel);font-size:12px;';
  card.innerHTML = '<strong>Editor shortcuts</strong><ul><li>Cmd/Ctrl+S — save</li><li>Cmd/Ctrl+Shift+F / Cmd/Ctrl+J — project search</li><li>Cmd/Ctrl+Alt+F — files</li><li>Cmd/Ctrl+Alt+V/L — Vim / layout</li><li>Ctrl+Space / Alt+/ — AI Copilot completion</li><li>Cmd/Ctrl+Alt+A — ask agent about selected code</li><li>F12 / Alt+F12 — definition / references</li><li>F11 — fullscreen</li><li>Cmd/Ctrl+Shift+/ — this help</li><li>Vim on: i, Esc, h/j/k/l, dd, yy, p, u, /</li></ul>';
  const close = window.document.createElement('button');
  close.type = 'button'; close.className = 'code-editor-action-btn'; close.textContent = 'Close';
  close.addEventListener('click', () => dialog.remove());
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.remove(); });
  dialog.addEventListener('keydown', event => { if (event.key === 'Escape') dialog.remove(); });
  card.appendChild(close); dialog.appendChild(card); state.root.appendChild(dialog); close.focus();
}

/** Return the current project identity for later editor modules. */
export function getCurrentContext() {
  return contextSnapshot();
}

/** Return a serializable view of the active CodeMirror document. */
export function getActiveDocument() {
  return documentSnapshot(state.documents.get(state.activePath));
}

/** Request a project panel or return the reserved slot for a future extension. */
export function requestPanel(name) {
  if (name === 'search') return showPanel(name);
  const slot = getRootPart(`[data-editor-panel-slot="${name}"]`);
  emit('panel-request', { panel: name, slot });
  return slot;
}

function teardownRoot() {
  if (state.externalPollTimer) clearInterval(state.externalPollTimer);
  state.externalPollTimer = null;
  state.externalPollInFlight = false;
  state.panels = null;
  state.tree?.destroy();
  state.tree = null;
  state.view?.destroy();
  state.view = null;
  state.root?.remove();
  state.root = null;
}

/** Close the overlay after resolving each unsaved document. */
export async function closeEditor() {
  for (const document of state.documents.values()) {
    if (!await allowDiscard(document, 'Close the editor?')) return false;
  }
  if (document.fullscreenElement && document.exitFullscreen) {
    try { await document.exitFullscreen(); } catch (_) { /* Non-fatal. */ }
  }
  teardownRoot();
  emit('closed');
  try { localStorage.removeItem('astercaeser-editor-open'); } catch (_) {}
  return true;
}

/** Open a project. Accepts the new project object or the legacy id/path pair. */
export async function openEditor(projectOrId, legacyPath) {
  let next = normaliseProject(typeof projectOrId === 'string' ? { id: projectOrId, path: legacyPath } : projectOrId, legacyPath);
  if (!next.workspaceId) {
    const resolved = await findWorkspaceFor(next.projectId);
    next = { ...next, ...resolved };
  }
  const changingProject = state.context && (
    state.context.workspaceId !== next.workspaceId || state.context.projectId !== next.projectId
  );
  if (changingProject) {
    for (const document of state.documents.values()) {
      if (!await allowDiscard(document, 'Switch projects?')) return false;
    }
    teardownRoot();
    state.documents.clear();
    state.activePath = null;
  }
  state.context = next;
  startExternalFileWatcher();
  // These values are project-specific. Start from sensible defaults before
  // restoring this project's local preference record.
  if (state.documents.size === 0) {
    state.vimEnabled = true;
    state.tabSize = 2;
    state.treeVisible = true;
    state.toolsVisible = true;
    state.activePanel = 'search';
  }
  const root = mountRoot();
  root.style.display = 'flex';
  wireWindow(root);
  updateWindowBar();
  if (window.innerWidth <= 768 || loadWindowPrefs().mode === 'fullscreen') enterFullscreen();
  else enterWindowed();
  const restoredPaths = state.documents.size ? [] : restore();
  syncLayoutPreferences();
  mountPanels();
  for (const path of restoredPaths) {
    if (path.startsWith('virtual://')) {
      const name = path.replace('virtual://', '');
      state.documents.set(path, {
        path: path,
        content: '',
        savedContent: '',
        loaded: true,
        loading: false,
        dirty: false,
        state: EditorState.create({ extensions: [] }),
        languageName: name.toUpperCase()
      });
    } else {
      state.documents.set(path, createDocument(path));
    }
  }
  renderTabs();
  const treeHost = getRootPart('#code-editor-file-tree');
  state.tree?.destroy();
  state.tree = await mountFileTree(treeHost, next, { onFileOpen: path => { void openAt(path); } });
  const restoredActive = (() => {
    try { return JSON.parse(localStorage.getItem(persistenceKey()) || '{}').activePath; } catch (_) { return null; }
  })();
  const initialPath = (restoredActive && (restoredActive.startsWith('virtual://') || isSafeRelativePath(restoredActive))) || restoredPaths[0];
  if (initialPath) await openAt(initialPath);
  const vimButton = getRootPart('[data-editor-action="vim"]');
  if (vimButton) {
    vimButton.textContent = state.vimEnabled ? 'Vim' : 'Vim off';
    vimButton.setAttribute('aria-pressed', String(state.vimEnabled));
  }
  try { localStorage.setItem('astercaeser-editor-open', 'true'); } catch (_) {}
  emit('opened', { project: { ...next } });
  return true;
}

/** Bind application events. Safe to call repeatedly. */
export function initCodeEditor() {
  if (state.initialized) return;
  state.initialized = true;
  Modals.register('code-editor-root', {
    label: 'Code',
    icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m8 6-6 6 6 6"/><path d="m16 6 6 6-6 6"/></svg>',
    restoreFn: () => {
      const root = document.getElementById('code-editor-root');
      if (!root) return;
      root.style.display = 'flex';
      try { state.view?.focus(); } catch (_) {}
      emit('opened', { project: state.context ? { ...state.context } : {} });
    },
    closeFn: () => { void closeEditor(); },
  });
  document.addEventListener('open-editor', event => {
    const detail = event.detail || {};
    const filePath = isSafeRelativePath(detail.filePath);
    void openEditor(detail)
      .then(opened => opened && filePath ? openAt(filePath) : false)
      .catch(error => uiModule.showError?.(`Could not open editor: ${error.message}`));
  });
  document.addEventListener('aster:project-file-changed', event => {
    const detail = event.detail || {};
    void refreshExternallyChangedFile(detail.path, detail.projectId);
  });
  window.addEventListener('astercaeser:modal-opened', () => {
    if (state.root && state.root._ceLowerEditor) state.root._ceLowerEditor();
  });
}

export default {
  closeEditor,
  closeFile,
  getActiveDocument,
  getCurrentContext,
  initCodeEditor,
  openAt,
  openEditor,
  openFile,
  requestPanel,
  saveActiveFile,
  toggleFullscreen,
  toggleVim,
};
