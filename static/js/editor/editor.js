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
  terminalSessions: [],
  activeTerminalSessionId: null,
  toolsPosition: 'bottom',
  aiModel: '',
  aiEndpointUrl: '',
  aiEndpointId: '',
  draggedPanelName: null,
  // Latest text snapshot streamed up from the web preview iframe via the
  // postMessage bridge (see sendAiMessage). The webview is cross-origin, so
  // the iframe's DOM can't be read directly — the embedded page sends it.
  webviewSnapshot: null,
};

let aiMirrorObserver = null;

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
        { key: 'Mod-s', run: () => { void saveActiveFile(); return true; } },
        { key: 'Mod-\\', run: () => { toggleFileTree(); return true; } },
        { key: 'Mod-Shift-j', run: () => { toggleToolsPanel(); return true; } },
        { key: 'Mod-j', run: () => { showPanel('terminal'); return true; } },
        { key: 'Mod-Alt-a', run: () => { askAgentForSelection(); return true; } },
        { key: 'Mod-k', run: () => { showCommandPalette(); return true; } },
        { key: 'Ctrl-Space', run: () => { void checkInlineCompletion(); return true; } },
        { key: 'Alt-/', run: () => { void checkInlineCompletion(); return true; } },
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
      <div class="code-editor-breadcrumb" id="ce-breadcrumb" aria-label="File path"></div>
      <div class="code-editor-actions">
        <button class="code-editor-action-btn" type="button" data-editor-action="tree" aria-pressed="true" title="Hide files (Cmd/Ctrl+\\ or Cmd/Ctrl+Alt+F)">Files</button>
        <button class="code-editor-action-btn" type="button" data-editor-action="tools" aria-pressed="true" title="Hide terminal and search (Cmd/Ctrl+Shift+J or Cmd/Ctrl+Alt+T)">Terminal</button>
        <button class="code-editor-action-btn" type="button" data-editor-action="ask-agent" disabled title="Select code to ask the agent about it">Ask agent</button>
        <button class="code-editor-action-btn" type="button" data-editor-action="definition" title="Go to definition (F12)">Definition</button>
        <button class="code-editor-action-btn" type="button" data-editor-action="references" title="Find references (Alt+F12)">References</button>
        <button class="code-editor-action-btn" type="button" data-editor-action="completion" title="Check inline completion availability">Complete</button>
        <button class="code-editor-action-btn" type="button" data-editor-action="preview" aria-pressed="false" disabled title="Preview the active Markdown or Typst file (Cmd/Ctrl+Alt+P)">Preview</button>
        <button class="code-editor-action-btn" type="button" data-editor-action="web-preview" title="Open a validated HTTP(S) web preview (Cmd/Ctrl+Alt+W)">Web view</button>
        <button class="code-editor-action-btn" type="button" data-editor-action="vim" aria-pressed="true" title="Toggle Vim mode (Cmd/Ctrl+Alt+V)">Vim</button>
        <button class="code-editor-action-btn" type="button" data-editor-action="layout" aria-expanded="false" title="Editor layout and tab size (Cmd/Ctrl+Alt+L)">Layout</button>
        <button class="code-editor-action-btn" type="button" data-editor-action="commands" title="Command palette (Cmd/Ctrl+K)">Command</button>
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
        <button id="ce-panel-tab-ai" class="ce-panel-tab" type="button" role="tab" aria-controls="ce-panel-ai" data-editor-panel="ai">AI</button>
        <button class="ce-panel-tab" type="button" data-editor-panel-action="close-terminal" title="Close terminal session" aria-label="Close terminal session" style="margin-left:auto">Close terminal</button>
      </div>
      <div id="ce-panel-terminal" class="code-editor-panel-content" data-editor-panel-slot="terminal" role="tabpanel" aria-labelledby="ce-panel-tab-terminal" style="padding:0;overflow:hidden;position:relative;display:flex;flex-direction:row">
        <div id="ce-terminal-host" style="flex:1;min-width:0;height:100%;position:relative"></div>
        <div id="ce-terminal-sidebar" style="width:160px;flex-shrink:0;background:var(--panel);border-left:1px solid var(--border);display:flex;flex-direction:column;overflow-y:auto;box-sizing:border-box">
          <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-bottom:1px solid var(--border);flex-shrink:0;height:32px;box-sizing:border-box">
            <span style="font-size:10px;font-weight:600;opacity:0.6;text-transform:uppercase;letter-spacing:0.5px">Sessions</span>
            <button id="ce-terminal-add" style="background:none;border:none;color:var(--fg);cursor:pointer;opacity:0.7;font-size:14px;padding:0 4px;line-height:1" title="Open new terminal">+</button>
          </div>
          <div id="ce-terminal-list" style="display:flex;flex-direction:column;flex:1;overflow-y:auto;padding:4px 0"></div>
        </div>
        <div id="ce-terminal-status" role="status" aria-live="polite" style="position:absolute;left:8px;top:5px;font-size:10px;opacity:.65;pointer-events:none;z-index:10"></div>
      </div>
      <div id="ce-panel-search" class="code-editor-panel-content" data-editor-panel-slot="search" role="tabpanel" aria-labelledby="ce-panel-tab-search" hidden></div>
      <div id="ce-panel-ai" class="code-editor-panel-content" data-editor-panel-slot="ai" role="tabpanel" aria-labelledby="ce-panel-tab-ai" hidden style="padding:0;overflow:hidden;position:relative;display:flex;flex-direction:row;height:100%">
        <div style="flex:1;min-width:0;height:100%;display:flex;flex-direction:column;position:relative">
          <div id="ce-ai-messages" style="flex:1;min-height:0;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:12px;font-size:12px;line-height:1.45;box-sizing:border-box"></div>
          <div id="ce-ai-input-wrap" style="display:flex;flex-wrap:wrap;background:var(--panel);border-top:1px solid var(--border);padding:6px 8px;gap:6px;align-items:flex-end;flex-shrink:0;min-height:42px;height:auto;box-sizing:border-box">
            <textarea id="ce-ai-textarea" placeholder="Ask AI about your code..." rows="1" style="flex:1 1 180px;min-width:120px;min-height:30px;max-height:140px;overflow-y:auto;resize:none;background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:4px;padding:6px;font-size:12px;outline:none;font-family:inherit;box-sizing:border-box;line-height:1.35"></textarea>
            <button id="ce-ai-pick-element" type="button" style="padding:0 8px;height:30px;font-size:11px;background:var(--panel);border:1px solid var(--border);color:var(--fg);border-radius:4px;cursor:pointer;white-space:nowrap" title="Select an element from the webview">Pick element</button>
            <select id="ce-ai-model" aria-label="AI model" title="Choose the model for editor chat" style="height:30px;max-width:150px;min-width:100px;background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:4px;padding:0 4px;font-size:11px;outline:none">
              <option value="">Current model</option>
            </select>
            <button id="ce-ai-new" style="padding:0px 10px;height:30px;font-size:12px;display:flex;align-items:center;background:var(--panel);border:1px solid var(--border);color:var(--fg);border-radius:4px;cursor:pointer;font-weight:500;white-space:nowrap" title="Start new session">New Chat</button>
            <button id="ce-ai-send" style="padding:0px 12px;height:30px;font-size:12px;display:flex;align-items:center;background:var(--panel);border:1px solid var(--border);color:var(--fg);border-radius:4px;cursor:pointer;font-weight:500" title="Send message">Send</button>
          </div>
        </div>
        <div id="ce-ai-sidebar" style="width:160px;flex-shrink:0;background:var(--panel);border-left:1px solid var(--border);display:flex;flex-direction:column;overflow-y:auto;box-sizing:border-box">
          <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-bottom:1px solid var(--border);flex-shrink:0;height:32px;box-sizing:border-box">
            <span style="font-size:10px;font-weight:600;opacity:0.6;text-transform:uppercase;letter-spacing:0.5px">Sessions</span>
            <button id="ce-ai-add" style="background:none;border:none;color:var(--fg);cursor:pointer;opacity:0.7;font-size:14px;padding:0 4px;line-height:1" title="Start new session">+</button>
          </div>
          <div id="ce-ai-session-list" style="display:flex;flex-direction:column;flex:1;overflow-y:auto;padding:4px 0"></div>
        </div>
      </div>
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
  root.querySelector('[data-editor-action="commands"]')?.addEventListener('click', showCommandPalette);
  root.querySelector('[data-editor-action="help"]')?.addEventListener('click', showKeyboardHelp);
  root.querySelector('[data-editor-action="fullscreen"]')?.addEventListener('click', () => { void toggleFullscreen(); });
  root.querySelector('[data-editor-action="close"]')?.addEventListener('click', () => { void closeEditor(); });
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

  root.querySelector('[data-editor-panel-action="close-terminal"]')?.addEventListener('click', closeTerminalPanel);
  root.querySelector('#ce-terminal-add')?.addEventListener('click', () => {
    const newSession = createTerminalSession();
    selectTerminalSession(newSession.id);
  });

  const triggerNewAiChat = () => {
    window.document.dispatchEvent(new CustomEvent('start-chat', { detail: { projectId: state.context?.projectId } }));
    const targetLog = getRootPart('#ce-ai-messages');
    if (targetLog) targetLog.replaceChildren();
    notice('Started a new chat session.');
    getRootPart('#ce-ai-textarea')?.focus();
    renderAiSessionList();
  };

  root.querySelector('#ce-ai-add')?.addEventListener('click', triggerNewAiChat);

  const aiNew = root.querySelector('#ce-ai-new');
  if (aiNew) {
    aiNew.addEventListener('click', triggerNewAiChat);
  }

  const aiSend = root.querySelector('#ce-ai-send');
  const aiTextarea = root.querySelector('#ce-ai-textarea');
  const aiPickElement = root.querySelector('#ce-ai-pick-element');
  if (aiPickElement) aiPickElement.addEventListener('click', pickWebviewElement);
  const aiModel = root.querySelector('#ce-ai-model');
  if (aiModel) {
    aiModel.addEventListener('change', () => {
      const option = aiModel.selectedOptions?.[0];
      state.aiModel = aiModel.value;
      state.aiEndpointUrl = option?.dataset.endpointUrl || '';
      state.aiEndpointId = option?.dataset.endpointId || '';
      persist();
      void applyEditorAiModel();
    });
    void refreshEditorAiModels();
  }
  if (aiSend) aiSend.addEventListener('click', sendAiMessage);
  if (aiTextarea) {
    const resizeAiTextarea = () => {
      aiTextarea.style.height = 'auto';
      aiTextarea.style.height = `${Math.min(Math.max(aiTextarea.scrollHeight, 30), 140)}px`;
    };
    aiTextarea.addEventListener('input', resizeAiTextarea);
    resizeAiTextarea();
    aiTextarea.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendAiMessage();
      }
    });
  }
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
    // Browser-safe toolbar chords: the extra Alt/Option modifier keeps these
    // away from common browser bindings such as Cmd/Ctrl+F, W, L, and T.
    if ((event.metaKey || event.ctrlKey) && event.altKey && !event.shiftKey) {
      const shortcutActions = {
        KeyF: 'tree',
        KeyT: 'tools',
        KeyP: 'preview',
        KeyW: 'web-preview',
        KeyV: 'vim',
        KeyL: 'layout',
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

  for (const name of ['terminal', 'search', 'ai']) {
    const panel = getRootPart(`#ce-panel-${name}`);
    if (!panel) continue;
    
    if (panel.parentNode === main) {
      panels.appendChild(panel);
    }
    
    const isThisVirtualActive = activePath === `virtual://${name}`;
    if (isThisVirtualActive) {
      main.appendChild(panel);
      panel.hidden = false;
      panel.style.setProperty('display', name === 'search' ? 'block' : 'flex', 'important');
      panel.style.setProperty('flex', '1', 'important');
      panel.style.setProperty('height', '100%', 'important');
      
      if (name === 'terminal') {
        const session = state.terminalSessions?.find(s => s.id === state.activeTerminalSessionId);
        if (session && session.terminal) {
          requestAnimationFrame(() => {
            try { session.terminal.resize(); } catch (_) {}
            try { session.terminal.focus(); } catch (_) {}
          });
        }
      } else if (name === 'ai') {
        startAiMirroring();
        requestAnimationFrame(() => {
          getRootPart('#ce-ai-textarea')?.focus();
        });
      }
    } else {
      const isActiveInBottom = state.activePanel === name && !isVirtual;
      panel.hidden = !isActiveInBottom;
      if (isActiveInBottom) {
        panel.style.setProperty('display', name === 'search' ? 'block' : 'flex', 'important');
      } else {
        panel.style.setProperty('display', 'none', 'important');
      }
    }
  }

  if (!isVirtual) {
    stopAiMirroring();
    if (state.activePanel === 'terminal') {
      const session = state.terminalSessions?.find(s => s.id === state.activeTerminalSessionId);
      requestAnimationFrame(() => {
        try { session?.terminal?.resize(); } catch (_) {}
      });
    } else if (state.activePanel === 'ai') {
      startAiMirroring();
    }
  }
}

function applyToolsPosition() {
  const panels = getRootPart('.code-editor-panels');
  const body = getRootPart('.code-editor-body');
  const root = getRootPart('#code-editor-root');
  if (!panels || !body || !root) return;

  const isSide = state.toolsPosition === 'side';
  if (isSide) {
    if (panels.parentNode !== body) {
      body.appendChild(panels);
    }
    panels.style.setProperty('width', '380px', 'important');
    panels.style.setProperty('height', '100%', 'important');
    panels.style.setProperty('border-top', 'none', 'important');
    panels.style.setProperty('border-left', '1px solid var(--border)', 'important');
  } else {
    if (panels.parentNode !== root) {
      root.appendChild(panels);
    }
    panels.style.removeProperty('width');
    panels.style.removeProperty('height');
    panels.style.removeProperty('border-top');
    panels.style.removeProperty('border-left');
  }
  
  requestAnimationFrame(() => {
    state.terminalSessions?.forEach(s => {
      if (s.terminal) {
        try { s.terminal.resize(); } catch (_) {}
      }
    });
  });
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
  if (!state.toolsVisible) deactivateTerminal();
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
  const minimumWidth = 240;
  
  resizeHandle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || panel.element.hidden || window.matchMedia('(max-width: 768px)').matches) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = panel.element.getBoundingClientRect().width;
    const sidebar = getRootPart('.code-editor-sidebar');
    const editorBody = getRootPart('.code-editor-body');
    const maxWidth = Math.max(
      minimumWidth,
      (editorBody?.clientWidth || document.body.clientWidth) - (sidebar?.getBoundingClientRect().width || 0) - 320,
    );
    resizeHandle.classList.add('dragging');
    resizeHandle.setPointerCapture?.(event.pointerId);
    
    const move = moveEvent => {
      const nextWidth = Math.min(maxWidth, Math.max(minimumWidth, startWidth + startX - moveEvent.clientX));
      state.previewWidth = nextWidth;
      applyPreviewWidth(panel, nextWidth);
    };
    
    const finish = () => {
      resizeHandle.classList.remove('dragging');
      try { resizeHandle.releasePointerCapture(event.pointerId); } catch (_) {}
      resizeHandle.removeEventListener('pointermove', move);
      resizeHandle.removeEventListener('pointerup', finish);
      resizeHandle.removeEventListener('pointercancel', finish);
      persist();
    };
    
    resizeHandle.addEventListener('pointermove', move);
    resizeHandle.addEventListener('pointerup', finish);
    resizeHandle.addEventListener('pointercancel', finish);
  });
  
  resizeHandle.addEventListener('dblclick', () => {
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

async function openWebPreview() {
  const value = await uiModule.styledPrompt('Enter local port number (e.g., 5020 or 3000):', {
    title: 'Web Preview',
    defaultValue: '5020',
    placeholder: '5020',
    confirmText: 'Open',
    cancelText: 'Cancel'
  });
  if (value === null) return false;
  let url = value.trim();
  if (/^\d+$/.test(url)) {
    url = `${window.location.protocol}//${window.location.hostname}:${url}/`;
  }
  const panel = ensurePreviewPanel();
  if (!panel) return false;
  // Provision the bridge in the active project before loading its web app.
  // This is idempotent and keeps the webview feature working across projects
  // without requiring users to edit each app's template by hand.
  if (state.context?.workspaceId && state.context?.projectId) {
    try {
      await fetch(
        `${API_ROOT}/${encodeURIComponent(state.context.workspaceId)}/project/${encodeURIComponent(state.context.projectId)}/webview-bridge/provision`,
        { method: 'POST', credentials: 'same-origin' },
      );
    } catch (_) {
      // A bridge failure must not prevent the normal web preview from opening.
    }
  }
  panel.openWebPreview(url);
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
  if (document.content.length > MAX_LIVE_EDITOR_CHARS) {
    notice('Live preview paused for large files; use Preview manually after saving.', 4200);
    return;
  }
  clearTimeout(state.previewTimer);
  state.previewTimer = setTimeout(() => {
    state.previewTimer = null;
    const current = state.documents.get(state.activePath);
    if (current?.path === document.path && panel.mode === 'markdown' && !panel.element.hidden) {
      void panel.renderPreview(previewDocument());
    }
  }, 180);
}

function renderTerminalList() {
  const listContainer = getRootPart('#ce-terminal-list');
  if (!listContainer) return;
  listContainer.replaceChildren();

  state.terminalSessions.forEach(session => {
    const item = document.createElement('div');
    item.style.display = 'flex';
    item.style.alignItems = 'center';
    item.style.justifyContent = 'space-between';
    item.style.padding = '6px 10px';
    item.style.margin = '2px 6px';
    item.style.borderRadius = '4px';
    item.style.fontSize = '12px';
    item.style.cursor = 'pointer';
    item.style.userSelect = 'none';

    const isActive = session.id === state.activeTerminalSessionId;
    if (isActive) {
      item.style.background = 'color-mix(in srgb, var(--accent, #56c7d9) 15%, var(--panel))';
      item.style.color = 'var(--accent, #56c7d9)';
      item.style.fontWeight = '600';
    } else {
      item.style.background = 'none';
      item.style.color = 'var(--fg)';
      item.style.opacity = '0.8';
    }

    item.addEventListener('mouseenter', () => {
      if (!isActive) {
        item.style.background = 'color-mix(in srgb, var(--fg) 5%, transparent)';
        item.style.opacity = '1';
      }
    });
    item.addEventListener('mouseleave', () => {
      if (!isActive) {
        item.style.background = 'none';
        item.style.opacity = '0.8';
      }
    });

    const leftPart = document.createElement('div');
    leftPart.style.display = 'flex';
    leftPart.style.alignItems = 'center';
    leftPart.style.gap = '8px';
    leftPart.style.overflow = 'hidden';

    const icon = document.createElement('span');
    icon.style.opacity = '0.7';
    icon.style.fontFamily = 'monospace';
    icon.style.fontSize = '12px';
    icon.textContent = '❯_';

    const nameSpan = document.createElement('span');
    nameSpan.textContent = session.name;
    nameSpan.style.whiteSpace = 'nowrap';
    nameSpan.style.overflow = 'hidden';
    nameSpan.style.textOverflow = 'ellipsis';

    leftPart.append(icon, nameSpan);
    item.append(leftPart);

    if (state.terminalSessions.length > 1) {
      const closeBtn = document.createElement('button');
      closeBtn.textContent = '✕';
      closeBtn.style.background = 'none';
      closeBtn.style.border = 'none';
      closeBtn.style.color = 'inherit';
      closeBtn.style.cursor = 'pointer';
      closeBtn.style.opacity = '0.4';
      closeBtn.style.fontSize = '10px';
      closeBtn.style.padding = '2px 4px';

      closeBtn.addEventListener('mouseenter', () => closeBtn.style.opacity = '1');
      closeBtn.addEventListener('mouseleave', () => closeBtn.style.opacity = '0.4');
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        killTerminalSession(session.id);
      });
      item.append(closeBtn);
    }

    item.addEventListener('click', () => {
      selectTerminalSession(session.id);
    });

    listContainer.append(item);
  });
}

function renderAiSessionList() {
  const listContainer = getRootPart('#ce-ai-session-list');
  if (!listContainer) return;
  listContainer.replaceChildren();

  const sessionsModule = window.sessionModule;
  if (!sessionsModule || !sessionsModule.getSessions) return;

  const rawSessions = sessionsModule.getSessions() || [];
  const activeProjectId = state.context?.projectId;
  const currentSessionId = sessionsModule.getCurrentSessionId?.();

  let chatSessions = rawSessions.filter(s =>
    s && !s.archived && s.folder !== 'Assistant' && s.folder !== 'Tasks' &&
    (s.name || '').trim() !== 'Nobody' && (s.name || '').trim() !== 'Incognito'
  );

  if (activeProjectId) {
    const projSessions = chatSessions.filter(s => s.project_id === activeProjectId);
    if (projSessions.length > 0) {
      chatSessions = projSessions;
    }
  }

  if (chatSessions.length === 0) {
    const emptyState = document.createElement('div');
    emptyState.style.padding = '8px 10px';
    emptyState.style.fontSize = '11px';
    emptyState.style.opacity = '0.5';
    emptyState.textContent = 'No sessions';
    listContainer.append(emptyState);
    return;
  }

  chatSessions.forEach(session => {
    const item = document.createElement('div');
    item.style.display = 'flex';
    item.style.alignItems = 'center';
    item.style.justifyContent = 'space-between';
    item.style.padding = '6px 10px';
    item.style.margin = '2px 6px';
    item.style.borderRadius = '4px';
    item.style.fontSize = '12px';
    item.style.cursor = 'pointer';
    item.style.userSelect = 'none';

    const isActive = String(session.id) === String(currentSessionId);
    if (isActive) {
      item.style.background = 'color-mix(in srgb, var(--accent, #56c7d9) 15%, var(--panel))';
      item.style.color = 'var(--accent, #56c7d9)';
      item.style.fontWeight = '600';
    } else {
      item.style.background = 'none';
      item.style.color = 'var(--fg)';
      item.style.opacity = '0.8';
    }

    item.addEventListener('mouseenter', () => {
      if (!isActive) {
        item.style.background = 'color-mix(in srgb, var(--fg) 5%, transparent)';
        item.style.opacity = '1';
      }
    });
    item.addEventListener('mouseleave', () => {
      if (!isActive) {
        item.style.background = 'none';
        item.style.opacity = '0.8';
      }
    });

    const leftPart = document.createElement('div');
    leftPart.style.display = 'flex';
    leftPart.style.alignItems = 'center';
    leftPart.style.gap = '8px';
    leftPart.style.overflow = 'hidden';

    const icon = document.createElement('span');
    icon.style.opacity = '0.7';
    icon.style.fontSize = '12px';
    icon.textContent = '💬';

    const nameSpan = document.createElement('span');
    let titleText = session.name || session.first_message || 'Untitled Chat';
    nameSpan.textContent = titleText;
    nameSpan.style.whiteSpace = 'nowrap';
    nameSpan.style.overflow = 'hidden';
    nameSpan.style.textOverflow = 'ellipsis';
    nameSpan.title = titleText;

    leftPart.append(icon, nameSpan);
    item.append(leftPart);

    if (chatSessions.length > 1) {
      const closeBtn = document.createElement('button');
      closeBtn.textContent = '✕';
      closeBtn.style.background = 'none';
      closeBtn.style.border = 'none';
      closeBtn.style.color = 'inherit';
      closeBtn.style.cursor = 'pointer';
      closeBtn.style.opacity = '0.4';
      closeBtn.style.fontSize = '10px';
      closeBtn.style.padding = '2px 4px';

      closeBtn.addEventListener('mouseenter', () => closeBtn.style.opacity = '1');
      closeBtn.addEventListener('mouseleave', () => closeBtn.style.opacity = '0.4');
      closeBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await fetch(`/api/session/${session.id}`, { method: 'DELETE' });
        } catch (_) {}
        if (sessionsModule.loadSessions) {
          await sessionsModule.loadSessions();
        }
        renderAiSessionList();
      });
      item.append(closeBtn);
    }

    item.addEventListener('click', async () => {
      if (String(session.id) === String(currentSessionId)) return;
      if (sessionsModule.selectSession) {
        await sessionsModule.selectSession(session.id);
      } else {
        window.document.dispatchEvent(new CustomEvent('select-chat', { detail: { sessionId: session.id } }));
      }
      renderAiSessionList();
      syncAiMessages();
    });

    listContainer.append(item);
  });
}

function selectTerminalSession(sessionId) {
  state.activeTerminalSessionId = sessionId;
  persist();
  renderTerminalList();

  const host = getRootPart('#ce-terminal-host');
  if (!host) return;

  state.terminalSessions.forEach(session => {
    if (session.container) {
      session.container.style.display = session.id === sessionId ? 'block' : 'none';
    }
  });

  const activeSession = state.terminalSessions.find(s => s.id === sessionId);
  if (activeSession && !activeSession.terminal) {
    initTerminalSession(activeSession);
  } else if (activeSession && activeSession.terminal) {
    activeSession.terminal.refresh();
    activeSession.terminal.focus();
  }
}

function initTerminalSession(session) {
  const host = getRootPart('#ce-terminal-host');
  if (!host) return;

  const container = document.createElement('div');
  container.className = 'ce-terminal-session-container';
  container.style.width = '100%';
  container.style.height = '100%';
  container.style.display = session.id === state.activeTerminalSessionId ? 'block' : 'none';
  host.append(container);
  session.container = container;

  const terminalContext = { ...state.context, terminalSessionId: session.id };
  const terminal = new ProjectTerminal(container, terminalContext, {
    onState: (tsState) => {
      if (tsState.kind === 'init' && tsState.shell) {
        session.name = tsState.shell;
        persist();
        renderTerminalList();
      }
      if (session.id === state.activeTerminalSessionId) {
        setTerminalStatus(tsState);
      }
    }
  });
  session.terminal = terminal;

  try {
    terminal.open();
  } catch (error) {
    session.terminal = null;
    container.textContent = `Could not start terminal: ${error.message}`;
  }
}

function createTerminalSession(name = null) {
  const id = `${state.context.projectId}-terminal-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  const index = state.terminalSessions.length + 1;
  const sessionName = name || `Terminal ${index}`;
  const session = { id, name: sessionName, terminal: null, container: null };
  state.terminalSessions.push(session);
  persist();
  return session;
}

function killTerminalSession(sessionId) {
  const index = state.terminalSessions.findIndex(s => s.id === sessionId);
  if (index === -1) return;

  const session = state.terminalSessions[index];
  if (session.terminal) {
    try {
      session.terminal._send({ type: 'kill' });
    } catch (_) {}
    session.terminal.dispose();
  }
  if (session.container) {
    session.container.remove();
  }

  state.terminalSessions.splice(index, 1);

  if (state.activeTerminalSessionId === sessionId) {
    const nextActive = state.terminalSessions[Math.max(0, index - 1)];
    state.activeTerminalSessionId = nextActive ? nextActive.id : null;
  }

  persist();
  if (state.activeTerminalSessionId) {
    selectTerminalSession(state.activeTerminalSessionId);
  }
}

function ensureTerminal() {
  if (!state.context) return null;

  if (state.terminalSessions.length === 0) {
    createTerminalSession();
  }

  if (!state.activeTerminalSessionId || !state.terminalSessions.some(s => s.id === state.activeTerminalSessionId)) {
    state.activeTerminalSessionId = state.terminalSessions[0].id;
  }

  renderTerminalList();

  state.terminalSessions.forEach(session => {
    if (!session.container) {
      initTerminalSession(session);
    }
  });

  const activeSession = state.terminalSessions.find(s => s.id === state.activeTerminalSessionId);
  return activeSession?.terminal || null;
}

function deactivateTerminal() {
  state.terminalSessions.forEach(session => {
    if (session.terminal) {
      session.terminal.dispose();
      session.terminal = null;
    }
    session.container = null;
  });
  const host = getRootPart('#ce-terminal-host');
  if (host) host.replaceChildren();
}

function closeTerminalPanel() {
  if (state.toolsVisible) {
    toggleToolsPanel();
  }
}

function showPanel(name, { focus = true } = {}) {
  if (!['terminal', 'search', 'ai'].includes(name) || !state.panels) return null;
  
  const isVirtualActive = state.activePath?.startsWith('virtual://');
  if (isVirtualActive) {
    void openAt(`virtual://${name}`);
    return getRootPart(`[data-editor-panel-slot="${name}"]`);
  }

  if (!state.toolsVisible) {
    state.toolsVisible = true;
    syncLayoutPreferences();
  }
  state.activePanel = name;
  for (const panelName of ['terminal', 'search', 'ai']) {
    const panel = getRootPart(`#ce-panel-${panelName}`);
    const tab = getRootPart(`#ce-panel-tab-${panelName}`);
    const active = panelName === name;
    if (panel) {
      panel.hidden = !active;
      if (active) {
        if (panelName === 'terminal' || panelName === 'ai') {
          panel.style.setProperty('display', 'flex', 'important');
        } else {
          panel.style.removeProperty('display');
        }
      } else {
        panel.style.setProperty('display', 'none', 'important');
      }
    }
    if (tab) {
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    }
  }
  if (name !== 'ai') {
    stopAiMirroring();
  }
  if (name === 'terminal') {
    const terminal = ensureTerminal();
    requestAnimationFrame(() => {
      terminal?.refresh();
      if (focus) terminal?.focus();
    });
  } else if (name === 'ai') {
    startAiMirroring();
    renderAiSessionList();
    if (focus) {
      requestAnimationFrame(() => {
        const textarea = getRootPart('#ce-ai-textarea');
        if (textarea) textarea.focus();
      });
    }
  } else if (focus) {
    requestAnimationFrame(() => state.panels?.search?.focus());
  }
  applyActiveView();
  persist();
  emit('panel-request', { panel: name, slot: getRootPart(`[data-editor-panel-slot="${name}"]`) });
  return getRootPart(`[data-editor-panel-slot="${name}"]`);
}

function startAiMirroring() {
  const sourceLog = document.getElementById('chat-history');
  const targetLog = getRootPart('#ce-ai-messages');
  if (!sourceLog || !targetLog) return;

  syncAiMessages();

  if (aiMirrorObserver) aiMirrorObserver.disconnect();
  aiMirrorObserver = new MutationObserver(() => {
    syncAiMessages();
  });
  aiMirrorObserver.observe(sourceLog, { childList: true, subtree: true, characterData: true });
}

function stopAiMirroring() {
  if (aiMirrorObserver) {
    aiMirrorObserver.disconnect();
    aiMirrorObserver = null;
  }
}

function syncAiMessages() {
  const sourceLog = document.getElementById('chat-history');
  const targetLog = getRootPart('#ce-ai-messages');
  if (!sourceLog || !targetLog) return;

  const messages = Array.from(sourceLog.querySelectorAll('.msg'));
  targetLog.innerHTML = '';

  messages.forEach(msg => {
    const isUser = msg.classList.contains('msg-user');
    const isAi = msg.classList.contains('msg-ai');
    const bodyEl = msg.querySelector('.body');
    if (!bodyEl) return;
    
    const bubble = document.createElement('div');
    bubble.style.padding = '6px 10px';
    bubble.style.borderRadius = '6px';
    bubble.style.maxWidth = '85%';
    bubble.style.wordBreak = 'break-word';
    bubble.style.fontSize = '12px';
    
    if (isUser) {
      bubble.style.alignSelf = 'flex-end';
      bubble.style.background = 'var(--accent, #58a6ff)';
      bubble.style.color = '#fff';
      bubble.textContent = bodyEl.textContent;
    } else if (isAi) {
      bubble.style.alignSelf = 'flex-start';
      bubble.style.background = 'var(--panel)';
      bubble.style.border = '1px solid var(--border)';
      bubble.style.color = 'var(--fg)';
      bubble.innerHTML = bodyEl.innerHTML;
    } else {
      bubble.style.alignSelf = 'center';
      bubble.style.background = 'rgba(236, 106, 92, 0.15)';
      bubble.style.border = '1px solid var(--accent, #ec6a5c)';
      bubble.style.color = 'var(--accent, #ec6a5c)';
      bubble.style.fontSize = '11px';
      bubble.textContent = bodyEl.textContent;
    }

    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.flexDirection = 'column';
    row.style.alignItems = isUser ? 'flex-end' : (isAi ? 'flex-start' : 'center');
    row.style.width = '100%';
    row.style.margin = '4px 0';
    row.appendChild(bubble);

    targetLog.appendChild(row);
  });

  targetLog.scrollTop = targetLog.scrollHeight;
}

function editorAiModelSelect() {
  return getRootPart('#ce-ai-model');
}

function populateEditorAiModels() {
  const select = editorAiModelSelect();
  if (!select) return;
  const previous = state.aiModel;
  const currentSession = window.sessionModule?.getSessions?.().find(
    session => String(session.id) === String(window.sessionModule?.getCurrentSessionId?.()),
  );
  if (!state.aiModel && currentSession?.model) {
    state.aiModel = currentSession.model;
    state.aiEndpointUrl = currentSession.endpoint_url || '';
    state.aiEndpointId = currentSession.endpoint_id || '';
  }

  select.replaceChildren();
  const currentOption = document.createElement('option');
  currentOption.value = '';
  currentOption.textContent = state.aiModel ? 'Selected model' : 'Current model';
  select.appendChild(currentOption);

  const items = window.modelsModule?.getCachedItems?.() || [];
  const seen = new Set();
  for (const item of items) {
    if (item?.model_type === 'image') continue;
    const models = (item?.models || []).concat(item?.models_extra || []);
    const displays = (item?.models_display || []).concat(item?.models_extra_display || []);
    models.forEach((modelId, index) => {
      const key = `${item.url || ''}\n${modelId}`;
      if (!modelId || seen.has(key)) return;
      seen.add(key);
      const option = document.createElement('option');
      option.value = modelId;
      option.textContent = displays[index] || String(modelId).split('/').pop();
      option.title = `${modelId}${item.endpoint_name ? ` — ${item.endpoint_name}` : ''}`;
      option.dataset.endpointUrl = item.url || '';
      option.dataset.endpointId = item.endpoint_id || '';
      select.appendChild(option);
    });
  }

  if (state.aiModel && !Array.from(select.options).some(option => option.value === state.aiModel)) {
    const option = document.createElement('option');
    option.value = state.aiModel;
    option.textContent = `${String(state.aiModel).split('/').pop()} (unavailable)`;
    option.dataset.endpointUrl = state.aiEndpointUrl;
    option.dataset.endpointId = state.aiEndpointId;
    select.appendChild(option);
  }
  select.value = state.aiModel || '';
  if (previous !== state.aiModel) persist();
}

async function refreshEditorAiModels() {
  try {
    if (window.modelsModule?.refreshModels) await window.modelsModule.refreshModels(false);
  } catch (_) { /* The selector still works with the current session model. */ }
  populateEditorAiModels();
}

async function applyEditorAiModel() {
  const modelId = state.aiModel;
  if (!modelId || !state.aiEndpointUrl || !window.sessionModule) return true;
  const sessionModule = window.sessionModule;
  const sessionId = sessionModule.getCurrentSessionId?.();
  if (!sessionId) {
    sessionModule.createDirectChat?.(state.aiEndpointUrl, modelId, state.aiEndpointId || undefined);
    notice(`Using ${String(modelId).split('/').pop()}`);
    return true;
  }
  const session = sessionModule.getSessions?.().find(item => String(item.id) === String(sessionId));
  if (session?.model === modelId && (session.endpoint_url || '') === state.aiEndpointUrl) return true;
  const form = new FormData();
  form.append('model', modelId);
  form.append('endpoint_url', state.aiEndpointUrl);
  if (state.aiEndpointId) form.append('endpoint_id', state.aiEndpointId);
  try {
    const response = await fetch(`/api/session/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH', body: form, credentials: 'same-origin',
    });
    if (!response.ok) throw new Error(`Model update failed (${response.status})`);
    if (session) {
      session.model = modelId;
      session.endpoint_url = state.aiEndpointUrl;
      session.endpoint_id = state.aiEndpointId;
    }
    notice(`Using ${String(modelId).split('/').pop()}`);
    return true;
  } catch (error) {
    notice(error.message || 'Could not change model', 3000);
    return false;
  }
}

const _WEBVIEW_SNAPSHOT_TYPE = 'astercaeser-webview-snapshot';
const _WEBVIEW_SNAPSHOT_REQUEST_TYPE = 'astercaeser-webview-snapshot-request';
const _WEBVIEW_ELEMENT_SELECTED_TYPE = 'astercaeser-webview-element-selected';
// Snapshots older than this are treated as stale: the URL is still appended,
// but the content is dropped so the agent doesn't read an outdated page.
const _WEBVIEW_SNAPSHOT_MAX_AGE_MS = 30_000;

// The web preview iframe is cross-origin, so the parent cannot read its DOM.
// Pages that embed the AsterCaeser bridge script (base.html of the previewed
// app) postMessage their text content up; we cache the latest one and append
// it to the agent context when the user asks about the webview.
function installWebviewSnapshotBridge() {
  window.addEventListener('message', event => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    const frame = document.querySelector('.editor-web-preview-frame');
    if (!frame || event.source !== frame.contentWindow) return;
    if (data.type === _WEBVIEW_ELEMENT_SELECTED_TYPE) {
      if (!data.element || typeof data.element !== 'object') return;
      state.webviewElementSelection = data.element;
      window.dispatchEvent(new CustomEvent('astercaeser:webview-element-selected', { detail: data.element }));
      return;
    }
    if (data.type !== _WEBVIEW_SNAPSHOT_TYPE) return;
    if (typeof data.text !== 'string' || !data.text.trim()) return;
    state.webviewSnapshot = {
      url: typeof data.url === 'string' ? data.url : frame.src,
      title: typeof data.title === 'string' ? data.title : '',
      text: data.text.slice(0, 40_000),
      elements: Array.isArray(data.elements) ? data.elements.slice(0, 300) : [],
      at: Date.now(),
    };
    window.dispatchEvent(new CustomEvent('astercaeser:webview-snapshot'));
  });
}

function pickWebviewElement() {
  const frame = document.querySelector('.editor-web-preview-frame');
  if (!frame || !frame.isConnected) {
    notice('Open a webview before selecting an element.', 3000);
    return;
  }
  try {
    frame.contentWindow.postMessage({ type: 'astercaeser-webview-select-element' }, '*');
    notice('Click an element in the webview…', 3000);
  } catch (_) {
    notice('Could not start webview element selection.', 3000);
  }
}

window.addEventListener('astercaeser:webview-element-selected', event => {
  const textarea = getRootPart('#ce-ai-textarea');
  const element = event.detail;
  if (!textarea || !element) return;
  const snippet = `Selected web element:\n${JSON.stringify(element, null, 2)}`;
  textarea.value = textarea.value.trim() ? `${textarea.value.trim()}\n\n${snippet}` : snippet;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.focus();
  notice('Element added to the AI message.');
});

async function webviewContextSuffix() {
  const frame = document.querySelector('.editor-web-preview-frame');
  if (!frame || !frame.src || !frame.isConnected) return '';
  let suffix = `\n\n[Context: The active webview is loaded with URL: ${frame.src}]`;
  // Same-origin previews can be read immediately. Cross-origin previews use
  // the opt-in postMessage bridge below instead of attempting to bypass the
  // browser's frame security boundary.
  try {
    const bodyText = frame.contentDocument?.body?.innerText?.trim();
    if (bodyText) {
      const title = frame.contentDocument.title ? `${frame.contentDocument.title} — ` : '';
      suffix += `\n[Live webview content — use this data directly; do not use Chrome or web_fetch for this page: ${title}${bodyText.slice(0, 40_000)}]`;
      return suffix;
    }
  } catch (_) { /* Cross-origin frame: use the message bridge. */ }
  // Always ping the page for a fresh snapshot: postMessage is asynchronous,
  // so this one lands in time for the NEXT message; the cached one below
  // covers the current message.
  try {
    frame.contentWindow.postMessage({ type: _WEBVIEW_SNAPSHOT_REQUEST_TYPE }, '*');
  } catch (_) {}
  // Wait for the bridge on the first request as well as subsequent requests.
  // Without this small handshake, the prompt was submitted before the
  // cross-origin iframe had time to return its snapshot.
  await new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.removeEventListener('astercaeser:webview-snapshot', finish);
      resolve();
    };
    window.addEventListener('astercaeser:webview-snapshot', finish, { once: true });
    setTimeout(finish, 500);
  });
  const snap = state.webviewSnapshot;
  if (!snap || !snap.text) return suffix;
  if (Date.now() - snap.at > _WEBVIEW_SNAPSHOT_MAX_AGE_MS) return suffix;
  const samePage = snap.url === frame.src
    || snap.url.startsWith(frame.src)
    || (snap.url.endsWith('/') && frame.src.startsWith(snap.url));
  if (!samePage) return suffix;
  const title = snap.title ? `${snap.title} — ` : '';
  const elements = Array.isArray(snap.elements) && snap.elements.length
    ? `\n[Visible webview elements:\n${JSON.stringify(snap.elements)}]`
    : '';
  suffix += `\n[Live webview content — use this data directly; do not use Chrome or web_fetch for this page: ${title}${snap.text}]${elements}`;
  return suffix;
}

async function sendAiMessage() {
  const textarea = getRootPart('#ce-ai-textarea');
  if (!textarea) return;
  let val = textarea.value.trim();
  if (!val) return;
  const visibleMessage = val;

  // If a webview frame is active and loaded, append the URL + the page's
  // text snapshot (via the postMessage bridge) as context for the agent.
  const webviewContext = await webviewContextSuffix();
  if (webviewContext) {
    val += `\n\n[ASTERCAESER_WEBVIEW_CONTEXT]\n${webviewContext}\n[/ASTERCAESER_WEBVIEW_CONTEXT]`;
  }

  const mainInput = document.getElementById('message');
  const sendBtn = document.querySelector('.send-btn') || document.getElementById('submit');
  if (!mainInput || !sendBtn) {
    notice('Chat interface is not ready.');
    return;
  }

  if (state.aiModel && !(await applyEditorAiModel())) return;

  mainInput.value = val;
  // The full context is sent to the model, but the ordinary chat renderer
  // should show only what the user typed.
  mainInput.dataset.astercaeserDisplayMessage = visibleMessage;
  mainInput.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.value = '';
  textarea.style.height = '30px';
  sendBtn.click();
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
      previewWidth: state.previewWidth,
      activePanel: state.activePanel,
      terminalSessions: state.terminalSessions.map(s => ({ id: s.id, name: s.name })),
      activeTerminalSessionId: state.activeTerminalSessionId,
      toolsPosition: state.toolsPosition,
      aiModel: state.aiModel,
      aiEndpointUrl: state.aiEndpointUrl,
      aiEndpointId: state.aiEndpointId,
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
    if (saved.activePanel === 'terminal' || saved.activePanel === 'search' || saved.activePanel === 'ai') state.activePanel = saved.activePanel;
    if (saved.toolsPosition === 'bottom' || saved.toolsPosition === 'side') state.toolsPosition = saved.toolsPosition;
    if (typeof saved.aiModel === 'string') state.aiModel = saved.aiModel;
    if (typeof saved.aiEndpointUrl === 'string') state.aiEndpointUrl = saved.aiEndpointUrl;
    if (typeof saved.aiEndpointId === 'string') state.aiEndpointId = saved.aiEndpointId;
    if (Array.isArray(saved.terminalSessions)) {
      state.terminalSessions = saved.terminalSessions.map(s => ({
        id: s.id,
        name: s.name,
        terminal: null,
        container: null
      }));
    } else {
      state.terminalSessions = [];
    }
    if (saved.activeTerminalSessionId) {
      state.activeTerminalSessionId = saved.activeTerminalSessionId;
    } else {
      state.activeTerminalSessionId = null;
    }
    return Array.isArray(saved.openPaths)
      ? saved.openPaths.map(p => p.startsWith('virtual://') ? p : isSafeRelativePath(p)).filter(Boolean).slice(0, 24)
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
  updatePreviewAction();
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
    void refreshPreviewForActiveDocument();
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
        if (!document.dirty) void refreshPreviewForActiveDocument();
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
  root.classList.toggle('code-editor-fullscreen');
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
    ['Open terminal', () => showPanel('terminal')],
    ['Toggle files sidebar', () => toggleFileTree()],
    ['Toggle Vim mode', () => toggleVim()],
    ['Toggle fullscreen', () => toggleFullscreen()],
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
  card.innerHTML = '<strong>Editor shortcuts</strong><ul><li>Cmd/Ctrl+S — save</li><li>Cmd/Ctrl+Shift+F — project search</li><li>Cmd/Ctrl+J — terminal</li><li>Cmd/Ctrl+Alt+F/T — files / terminal</li><li>Cmd/Ctrl+Alt+P/W — preview / web view</li><li>Cmd/Ctrl+Alt+V/L — Vim / layout</li><li>Ctrl+Space / Alt+/ — AI Copilot completion</li><li>Cmd/Ctrl+Alt+A — ask agent about selected code</li><li>F12 / Alt+F12 — definition / references</li><li>F11 — fullscreen</li><li>Cmd/Ctrl+Shift+/ — this help</li><li>Vim on: i, Esc, h/j/k/l, dd, yy, p, u, /</li></ul>';
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
  stopAiMirroring();
  clearTimeout(state.previewTimer);
  state.previewTimer = null;
  if (state.externalPollTimer) clearInterval(state.externalPollTimer);
  state.externalPollTimer = null;
  state.externalPollInFlight = false;
  state.preview?.panel?.destroy();
  state.preview = null;
  state.terminalSessions.forEach(session => {
    if (session.terminal) {
      session.terminal.dispose();
      session.terminal = null;
    }
    session.container = null;
  });
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
    state.terminalSessions.forEach(session => {
      if (session.terminal) {
        try { session.terminal._send({ type: 'kill' }); } catch (_) {}
        session.terminal.dispose();
      }
    });
    state.terminalSessions = [];
    state.activeTerminalSessionId = null;
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
  installWebviewSnapshotBridge();
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
  document.addEventListener('aster:sessions-updated', () => {
    renderAiSessionList();
  });
  document.addEventListener('session-switched', () => {
    renderAiSessionList();
    syncAiMessages();
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
