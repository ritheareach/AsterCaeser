/**
 * Project code editor entry point.
 *
 * Public API for editor extensions:
 *   initCodeEditor()                    bind the `open-editor` event once
 *   openEditor(project | id, path?)     open an editor overlay
 *   openAt(path, { line, column })      load/focus a project-relative file
 *   saveActiveFile(), closeEditor()     lifecycle actions
 *   getCurrentContext(), getActiveDocument()
 *   requestPanel('terminal'|'search'|'preview'|'ai')
 *
 * Events use an `aster:editor-*` namespace. The detail always includes the
 * immutable `{ workspaceId, projectId, path }` context where it is relevant:
 * `opened`, `closed`, `active-document`, `document-changed`, `saved`, and
 * `panel-request`. Terminal and search are project-scoped panels; preview and
 * AI retain extension slots without creating a second editor implementation.
 */
import { mountFileTree } from '../fileTree.js';
import uiModule from '../ui.js';
import { askAgentAboutSelection, requestInlineCompletion } from './ai.js';
import { createPreviewPanel } from './preview.js';
import { previewKindFor } from '../aster/editor/preview.js';
import { ProjectSearchPanel } from './search.js';
import { ProjectTerminal } from './terminal.js';
import {
  basicSetup,
  Compartment,
  css,
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
const PANEL_NAMES = new Set(['terminal', 'search', 'preview', 'ai']);
const TAB_SIZES = new Set([2, 4, 8]);

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
  previewWidth: null,
  activePanel: 'terminal',
  panels: null,
  preview: null,
  symbolRequestId: 0,
  completionRequestId: 0,
  initialized: false,
  noticeTimer: null,
  previewTimer: null,
  externalPollTimer: null,
  externalPollInFlight: false,
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
    throw new Error(detail);
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
  const [, language] = extensionFor(document.path);
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
        { key: 'Mod-s', run: () => { void saveActiveFile(); return true; } },
        { key: 'Mod-\\', run: () => { toggleFileTree(); return true; } },
        { key: 'Mod-Shift-j', run: () => { toggleToolsPanel(); return true; } },
        { key: 'Mod-j', run: () => { showPanel('terminal'); return true; } },
        { key: 'Mod-Alt-a', run: () => { askAgentForSelection(); return true; } },
        { key: 'F11', run: () => { void toggleFullscreen(); return true; } },
        { key: 'Mod-Shift-/', run: () => { showKeyboardHelp(); return true; } },
      ]),
      EditorView.updateListener.of(update => handleViewUpdate(document, update)),
    ],
  });
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
    queueMarkdownPreview(document);
  } else if (update.selectionSet && document.path === state.activePath) {
    updateStatus();
  }
  if (document.path === state.activePath && (update.docChanged || update.selectionSet)) {
    updateAskAgentAction();
    updatePreviewAction();
  }
}

function getRootPart(selector) {
  return state.root?.querySelector(selector) || null;
}

function mountRoot() {
  if (state.root) return state.root;
  const root = document.createElement('section');
  root.id = 'code-editor-root';
  root.className = 'code-editor-root code-editor-fullscreen';
  root.setAttribute('aria-label', 'Project code editor');
  root.innerHTML = `
    <div class="code-editor-toolbar">
      <div class="code-editor-tabs" id="code-editor-tabs" role="tablist" aria-label="Open files"></div>
      <div class="code-editor-actions">
        <button class="code-editor-action-btn" type="button" data-editor-action="tree" aria-pressed="true" title="Hide files (Cmd/Ctrl+\\)">Files</button>
        <button class="code-editor-action-btn" type="button" data-editor-action="tools" aria-pressed="true" title="Hide terminal and search (Cmd/Ctrl+Shift+J)">Terminal</button>
        <button class="code-editor-action-btn" type="button" data-editor-action="ask-agent" disabled title="Select code to ask the agent about it">Ask agent</button>
        <button class="code-editor-action-btn" type="button" data-editor-action="definition" title="Go to definition (F12)">Definition</button>
        <button class="code-editor-action-btn" type="button" data-editor-action="references" title="Find references (Alt+F12)">References</button>
        <button class="code-editor-action-btn" type="button" data-editor-action="completion" title="Check inline completion availability">Complete</button>
        <button class="code-editor-action-btn" type="button" data-editor-action="preview" aria-pressed="false" disabled title="Preview the active Markdown or Typst file">Preview</button>
        <button class="code-editor-action-btn" type="button" data-editor-action="web-preview" title="Open a validated HTTP(S) web preview">Web view</button>
        <button class="code-editor-action-btn" type="button" data-editor-action="vim" aria-pressed="true" title="Toggle Vim mode">Vim</button>
        <button class="code-editor-action-btn" type="button" data-editor-action="layout" aria-expanded="false" title="Editor layout and tab size">Layout</button>
        <button class="code-editor-action-btn" type="button" data-editor-action="help" title="Keyboard shortcuts">?</button>
        <button class="code-editor-action-btn" type="button" data-editor-action="fullscreen" title="Toggle fullscreen (F11)">⛶</button>
        <button class="code-editor-action-btn" type="button" data-editor-action="close" title="Close editor">✕</button>
      </div>
    </div>
    <div class="code-editor-body">
      <aside class="code-editor-sidebar" aria-label="Project files">
        <div class="code-editor-sidebar-header"><span>Files</span></div>
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
      <div id="code-editor-preview-slot" data-editor-panel-slot="preview" style="display:contents"></div>
    </div>
    <section class="code-editor-panels" aria-label="Project tools">
      <div class="code-editor-panel-tabs" role="tablist" aria-label="Project tools">
        <button id="ce-panel-tab-terminal" class="ce-panel-tab" type="button" role="tab" aria-controls="ce-panel-terminal" data-editor-panel="terminal">Terminal</button>
        <button id="ce-panel-tab-search" class="ce-panel-tab" type="button" role="tab" aria-controls="ce-panel-search" data-editor-panel="search">Search</button>
        <button class="ce-panel-tab" type="button" data-editor-panel-action="close-terminal" title="Close terminal session" aria-label="Close terminal session" style="margin-left:auto">Close terminal</button>
      </div>
      <div id="ce-panel-terminal" class="code-editor-panel-content" data-editor-panel-slot="terminal" role="tabpanel" aria-labelledby="ce-panel-tab-terminal" style="padding:0;overflow:hidden;position:relative">
        <div id="ce-terminal-host" style="height:100%;min-height:0"></div>
        <div id="ce-terminal-status" role="status" aria-live="polite" style="position:absolute;right:8px;top:5px;font-size:10px;opacity:.65;pointer-events:none"></div>
      </div>
      <div id="ce-panel-search" class="code-editor-panel-content" data-editor-panel-slot="search" role="tabpanel" aria-labelledby="ce-panel-tab-search" hidden></div>
    </section>
    <div id="code-editor-panel-slots" hidden aria-label="Editor extension slots">
      <div data-editor-panel-slot="ai"></div>
    </div>
    <div class="code-editor-layout-menu" id="ce-layout-menu" role="menu" hidden aria-label="Editor layout">
      <label class="ce-layout-tab-size" for="ce-tab-size"><span>Tab size</span>
        <select id="ce-tab-size" aria-label="Tab size">
          <option value="2">2 spaces</option>
          <option value="4">4 spaces</option>
          <option value="8">8 spaces</option>
        </select>
      </label>
      <button type="button" role="menuitem" data-editor-layout="tree">Hide files <kbd>⌘\</kbd></button>
      <button type="button" role="menuitem" data-editor-layout="tools">Hide terminal <kbd>⌘⇧J</kbd></button>
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
  root.querySelector('[data-editor-action="preview"]')?.addEventListener('click', () => { void previewActiveDocument(); });
  root.querySelector('[data-editor-action="web-preview"]')?.addEventListener('click', openWebPreview);
  root.querySelector('[data-editor-action="layout"]')?.addEventListener('click', toggleLayoutMenu);
  root.querySelector('[data-editor-action="help"]')?.addEventListener('click', showKeyboardHelp);
  root.querySelector('[data-editor-action="fullscreen"]')?.addEventListener('click', () => { void toggleFullscreen(); });
  root.querySelector('[data-editor-action="close"]')?.addEventListener('click', () => { void closeEditor(); });
  root.querySelectorAll('[data-editor-panel]').forEach(button => {
    button.addEventListener('click', () => showPanel(button.dataset.editorPanel));
  });
  root.querySelector('[data-editor-panel-action="close-terminal"]')?.addEventListener('click', closeTerminalPanel);
  root.querySelector('#ce-tab-size')?.addEventListener('change', event => {
    setTabSize(Number(event.currentTarget.value));
  });
  root.querySelectorAll('[data-editor-layout]').forEach(button => {
    button.addEventListener('click', () => {
      if (button.dataset.editorLayout === 'tree') toggleFileTree();
      if (button.dataset.editorLayout === 'tools') toggleToolsPanel();
    });
  });
  root.addEventListener('click', event => {
    const menu = getRootPart('#ce-layout-menu');
    const toggle = getRootPart('[data-editor-action="layout"]');
    if (menu && !menu.hidden && !menu.contains(event.target) && !toggle?.contains(event.target)) closeLayoutMenu();
  });
  root.addEventListener('keydown', event => {
    if (event.defaultPrevented) return;
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
      showPanel('terminal');
    } else if (event.altKey && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      askAgentForSelection();
    }
  });
  return root;
}

function setTerminalStatus({ kind, message }) {
  const status = getRootPart('#ce-terminal-status');
  if (!status) return;
  status.dataset.state = kind;
  status.textContent = message;
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
    toolsButton.textContent = state.toolsVisible ? 'Terminal' : 'Terminal off';
    toolsButton.title = `${state.toolsVisible ? 'Hide' : 'Show'} terminal and search (Cmd/Ctrl+Shift+J)`;
    toolsButton.setAttribute('aria-pressed', String(state.toolsVisible));
  }
  if (treeMenu) treeMenu.innerHTML = `${state.treeVisible ? 'Hide' : 'Show'} files <kbd>⌘\\</kbd>`;
  if (toolsMenu) toolsMenu.innerHTML = `${state.toolsVisible ? 'Hide' : 'Show'} terminal <kbd>⌘⇧J</kbd>`;
  if (tabSize) tabSize.value = String(state.tabSize);
  if (tabStatus) tabStatus.textContent = `Tabs: ${state.tabSize}`;
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
  if (!state.toolsVisible) closeTerminalPanel();
  syncLayoutPreferences();
  if (state.toolsVisible) showPanel(state.activePanel, { focus: false });
  persist();
  notice(state.toolsVisible ? 'Terminal and search shown' : 'Terminal and search hidden');
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

function previewKindForActiveDocument(document = state.documents.get(state.activePath)) {
  const path = document?.path?.toLowerCase() || '';
  if (path.endsWith('.md') || path.endsWith('.markdown')) return 'markdown';
  if (path.endsWith('.typ')) return 'typst';
  return null;
}

function previewDocument() {
  const active = state.documents.get(state.activePath);
  if (!active?.loaded || !state.context) return null;
  return {
    path: active.path,
    content: active.content,
    context: {
      workspaceId: state.context.workspaceId,
      projectId: state.context.projectId,
    },
  };
}

function updatePreviewAction() {
  const button = getRootPart('[data-editor-action="preview"]');
  if (!button) return;
  const kind = previewKindForActiveDocument();
  button.disabled = !kind;
  button.title = kind
    ? `Preview the active ${kind === 'typst' ? 'Typst' : 'Markdown'} file`
    : 'Preview is available for Markdown and Typst files';
  button.setAttribute('aria-pressed', String(!!state.preview?.panel && !state.preview.panel.element.hidden && state.preview.panel.mode !== 'web'));
}

function applyPreviewWidth(panel, width = state.previewWidth) {
  if (!panel?.element) return;
  if (!Number.isFinite(width)) {
    panel.element.style.removeProperty('flex');
    panel.element.style.removeProperty('width');
    return;
  }
  panel.element.style.flex = `0 0 ${Math.round(width)}px`;
  panel.element.style.width = `${Math.round(width)}px`;
}

function syncPreviewResizeHandle() {
  const preview = state.preview;
  if (!preview) return;
  const panel = preview.panel;
  if (!panel) { preview.resizeHandle.hidden = true; return; }
  preview.resizeHandle.hidden = panel.element.hidden;
}

function wirePreviewResize(resizeHandle, panel) {
  if (!resizeHandle || !panel) return;
  resizeHandle.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || panel.element.hidden || window.matchMedia('(max-width: 768px)').matches) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = panel.element.getBoundingClientRect().width;
    const maxWidth = Math.max(
      minimumWidth,
      body.clientWidth - (sidebar?.getBoundingClientRect().width || 0) - 320,
    );
    handle.classList.add('dragging');
    handle.setPointerCapture?.(event.pointerId);
    const move = moveEvent => {
      const nextWidth = Math.min(maxWidth, Math.max(minimumWidth, startWidth + startX - moveEvent.clientX));
      state.previewWidth = nextWidth;
      applyPreviewWidth(panel, nextWidth);
    };
    const finish = () => {
      handle.classList.remove('dragging');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', finish);
      persist();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  });
  handle.addEventListener('dblclick', () => {
    state.previewWidth = null;
    applyPreviewWidth(panel, null);
    persist();
  });
}

function ensurePreviewPanel() {
  if (state.preview?.panel) return state.preview.panel;
  const slot = getRootPart('#code-editor-preview-slot');
  if (!slot) return null;
  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'editor-preview-resize-handle';
  resizeHandle.hidden = true;
  resizeHandle.setAttribute('role', 'separator');
  resizeHandle.setAttribute('aria-label', 'Resize preview');
  resizeHandle.setAttribute('aria-orientation', 'vertical');
  slot.append(resizeHandle);
  const panel = createPreviewPanel({
    container: slot,
    getActiveDocument: previewDocument,
    onStatus: ({ state: previewState, message }) => {
      syncPreviewResizeHandle();
      if (previewState === 'error' || previewState === 'unavailable') notice(`Preview: ${message}`, 3200);
    },
    onClose: () => {
      syncPreviewResizeHandle();
      updatePreviewAction();
    },
  });
  state.preview = { panel, resizeHandle };
  applyPreviewWidth(panel);
  wirePreviewResize(resizeHandle, panel);
  return panel;
}

async function previewActiveDocument() {
  const active = state.documents.get(state.activePath);
  const kind = previewKindForActiveDocument(active);
  if (!kind) {
    updatePreviewAction();
    notice('Preview is available for Markdown and Typst files.');
    return false;
  }
  const documentValue = previewDocument();
  if (!documentValue) {
    notice('Open a saved, project-bound file before previewing it.');
    return false;
  }
  const panel = ensurePreviewPanel();
  if (!panel) return false;
  await panel.renderPreview(documentValue);
  syncPreviewResizeHandle();
  updatePreviewAction();
  return true;
}

function openWebPreview() {
  const value = window.prompt('Web preview URL (http:// or https://)', 'http://localhost:3000');
  if (value === null) return false;
  const panel = ensurePreviewPanel();
  if (!panel) return false;
  panel.openWebPreview(value);
  syncPreviewResizeHandle();
  updatePreviewAction();
  return true;
}

async function refreshPreviewForActiveDocument() {
  const panel = state.preview?.panel;
  if (!panel || panel.element.hidden || panel.mode === 'web') return;
  const active = state.documents.get(state.activePath);
  const kind = previewKindForActiveDocument(active);
  if (!kind) {
    await panel.renderPreview(null);
    updatePreviewAction();
    return;
  }
  const documentValue = previewDocument();
  if (documentValue) await panel.renderPreview(documentValue);
  updatePreviewAction();
}

function queueMarkdownPreview(document) {
  if (document.path !== state.activePath || previewKindForActiveDocument(document) !== 'markdown') return;
  const panel = state.preview?.panel;
  if (!panel || panel.element.hidden || panel.mode !== 'markdown') return;
  clearTimeout(state.previewTimer);
  state.previewTimer = setTimeout(() => {
    state.previewTimer = null;
    const current = state.documents.get(state.activePath);
    if (current?.path === document.path && panel.mode === 'markdown' && !panel.element.hidden) {
      void panel.renderPreview(previewDocument());
    }
  }, 180);
}

function ensureTerminal() {
  if (!state.panels || state.panels.terminal) return state.panels?.terminal || null;
  const host = getRootPart('#ce-terminal-host');
  if (!host || !state.context) return null;
  const terminal = new ProjectTerminal(host, state.context, { onState: setTerminalStatus });
  state.panels.terminal = terminal;
  try {
    terminal.open();
  } catch (error) {
    state.panels.terminal = null;
    setTerminalStatus({ kind: 'error', message: `Could not start terminal: ${error.message}` });
  }
  return state.panels.terminal;
}

function closeTerminalPanel() {
  const terminal = state.panels?.terminal;
  if (!terminal) {
    setTerminalStatus({ kind: 'closed', message: 'Terminal is already closed' });
    return;
  }
  terminal.dispose();
  state.panels.terminal = null;
}

function showPanel(name, { focus = true } = {}) {
  if (!['terminal', 'search'].includes(name) || !state.panels) return null;
  if (!state.toolsVisible) {
    state.toolsVisible = true;
    syncLayoutPreferences();
  }
  state.activePanel = name;
  for (const panelName of ['terminal', 'search']) {
    const panel = getRootPart(`#ce-panel-${panelName}`);
    const tab = getRootPart(`#ce-panel-tab-${panelName}`);
    const active = panelName === name;
    if (panel) panel.hidden = !active;
    if (tab) {
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    }
  }
  if (name === 'terminal') {
    const terminal = ensureTerminal();
    requestAnimationFrame(() => {
      terminal?.refresh();
      if (focus) terminal?.focus();
    });
  } else if (focus) {
    requestAnimationFrame(() => state.panels?.search?.focus());
  }
  persist();
  emit('panel-request', { panel: name, slot: getRootPart(`[data-editor-panel-slot="${name}"]`) });
  return getRootPart(`[data-editor-panel-slot="${name}"]`);
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
  state.panels = { terminal: null, search };
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
  if (!active) {
    if (file) file.textContent = 'No file open';
    if (language) language.textContent = 'Plain text';
    if (position) position.textContent = 'Ln 1, Col 1';
  } else {
    if (file) file.textContent = active.path;
    if (language) language.textContent = active.languageName;
    if (position && state.view) {
      const cursor = state.view.state.selection.main.head;
      const line = state.view.state.doc.lineAt(cursor);
      position.textContent = `Ln ${line.number}, Col ${cursor - line.from + 1}`;
    }
  }
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
      previewWidth: state.previewWidth,
      activePanel: state.activePanel,
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
    if (Number.isFinite(saved.previewWidth) && saved.previewWidth >= 300) state.previewWidth = saved.previewWidth;
    if (saved.activePanel === 'terminal' || saved.activePanel === 'search') state.activePanel = saved.activePanel;
    return Array.isArray(saved.openPaths)
      ? saved.openPaths.map(isSafeRelativePath).filter(Boolean).slice(0, 24)
      : [];
  } catch (_) {
    return [];
  }
}

async function setActive(path, { line, column } = {}) {
  const active = state.documents.get(path);
  if (!active) return false;
  state.activePath = path;
  const view = ensureView();
  if (view && view.state !== active.state) view.setState(active.state);
  renderTabs();
  updateStatus(active.loading ? 'Loading…' : active.error ? 'Load failed' : '');
  updateAskAgentAction();
  updatePreviewAction();
  persist();
  emit('active-document', { document: documentSnapshot(active) });
  if (Number.isInteger(line) && line > 0) {
    requestAnimationFrame(() => goToPosition(line, column));
  }
  requestAnimationFrame(() => state.view?.focus());
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
    document.dirty = false;
    document.loaded = true;
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
      updatePreviewAction();
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
        void refreshPreviewForActiveDocument();
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
  const documents = [...state.documents.values()].filter(item => item.loaded && !item.loading);
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
      } catch (_) {
        // A deleted or renamed file is handled when the user selects it again;
        // background polling should never turn that into a noisy error loop.
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
  const safePath = isSafeRelativePath(path);
  if (!safePath || !state.context) return false;
  let document = state.documents.get(safePath);
  if (!document) {
    document = createDocument(safePath);
    state.documents.set(safePath, document);
  }
  // Load real Typst grammar from CDN (tree-sitter based), fallback to StreamLanguage
  if (safePath.endsWith('.typ') && state.view) {
    loadTypstLang().then(lang => {
      if (lang && state.view && document.path === state.activePath) {
        state.view.dispatch({ effects: document.languageCompartment.reconfigure(lang) });
      }
    });
  }
  await setActive(safePath, options);
  await readDocument(document);
  void refreshPreviewForActiveDocument();
  if (!document.error && Number.isInteger(options.line) && options.line > 0) goToPosition(options.line, options.column);
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

async function saveDocument(document) {
  if (!document || !document.loaded || !document.dirty) return true;
  if (document.saving) return document.saving;
  const contentToSave = document.content;
  document.saving = (async () => {
    try {
      const response = await fileApi('write', { path: document.path, content: contentToSave });
      document.savedContent = contentToSave;
      document.diskVersion = String(response.version || '');
      document.externalVersion = '';
      document.dirty = document.content !== document.savedContent;
      renderTabs();
      if (document.path === state.activePath) {
        notice(document.dirty ? 'Saved; newer edits remain' : 'Saved');
        if (!document.dirty) void refreshPreviewForActiveDocument();
      }
      persist();
      emit('saved', { document: documentSnapshot(document) });
      return !document.dirty;
    } catch (error) {
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
    else if (state.view) state.view.setState(EditorState.create({ extensions: [basicSetup, editorTheme] }));
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
  root.classList.toggle('code-editor-fullscreen');
  try {
    if (!document.fullscreenElement && root.requestFullscreen) await root.requestFullscreen();
    else if (document.fullscreenElement && document.exitFullscreen) await document.exitFullscreen();
  } catch (_) {
    // The overlay already fills the viewport; browser fullscreen is optional.
  }
  return true;
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
  card.innerHTML = '<strong>Editor shortcuts</strong><ul><li>Cmd/Ctrl+S — save</li><li>Cmd/Ctrl+Shift+F — project search</li><li>Cmd/Ctrl+J — terminal</li><li>Cmd/Ctrl+Alt+A — ask agent about selected code</li><li>F12 / Alt+F12 — definition / references</li><li>F11 — fullscreen</li><li>Cmd/Ctrl+Shift+/ — this help</li><li>Vim on: i, Esc, h/j/k/l, dd, yy, p, u, /</li></ul>';
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
  if (!PANEL_NAMES.has(name)) throw new Error(`Unknown editor panel: ${name}`);
  if (name === 'terminal' || name === 'search') return showPanel(name);
  if (name === 'preview') return ensurePreviewPanel()?.element || null;
  const slot = getRootPart(`[data-editor-panel-slot="${name}"]`);
  emit('panel-request', { panel: name, slot });
  return slot;
}

function teardownRoot() {
  clearTimeout(state.previewTimer);
  state.previewTimer = null;
  if (state.externalPollTimer) clearInterval(state.externalPollTimer);
  state.externalPollTimer = null;
  state.externalPollInFlight = false;
  state.preview?.panel?.destroy();
  state.preview = null;
  state.panels?.terminal?.dispose();
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
    state.previewWidth = null;
    state.activePanel = 'terminal';
  }
  const root = mountRoot();
  root.style.display = 'flex';
  const restoredPaths = state.documents.size ? [] : restore();
  syncLayoutPreferences();
  mountPanels();
  for (const path of restoredPaths) state.documents.set(path, createDocument(path));
  renderTabs();
  const treeHost = getRootPart('#code-editor-file-tree');
  state.tree?.destroy();
  state.tree = await mountFileTree(treeHost, next, { onFileOpen: path => { void openAt(path); } });
  const restoredActive = (() => {
    try { return JSON.parse(localStorage.getItem(persistenceKey()) || '{}').activePath; } catch (_) { return null; }
  })();
  const initialPath = isSafeRelativePath(restoredActive) || restoredPaths[0];
  if (initialPath) await openAt(initialPath);
  const vimButton = getRootPart('[data-editor-action="vim"]');
  if (vimButton) {
    vimButton.textContent = state.vimEnabled ? 'Vim' : 'Vim off';
    vimButton.setAttribute('aria-pressed', String(state.vimEnabled));
  }
  emit('opened', { project: { ...next } });
  return true;
}

/** Bind application events. Safe to call repeatedly. */
export function initCodeEditor() {
  if (state.initialized) return;
  state.initialized = true;
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
