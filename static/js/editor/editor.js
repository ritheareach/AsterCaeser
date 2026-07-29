// Code Editor — CodeMirror 6 with Vim, syntax highlighting, multi-tab, full-screen.
import { renderTree, setRoot } from '../fileTree.js';
import uiModule from '../ui.js';

const API_BASE = window.location.origin;

let _projectId = null;
let _projectPath = '';
let _openFiles = [];
let _activeFile = null;
let _editorInstance = null;
let _dirtyFiles = new Set();
let _fullscreen = false;

const _EXT_LANG = {
  py: 'python', js: 'javascript', ts: 'typescript', html: 'html', css: 'css',
  json: 'json', md: 'markdown', yml: 'yaml', yaml: 'yaml', toml: 'toml',
  sh: 'shell', bash: 'shell', sql: 'sql', rs: 'rust', go: 'go', rb: 'ruby',
  java: 'java', kt: 'kotlin', swift: 'swift',
};

const _LANG_LOADED = {};

async function _loadLang(lang) {
  if (!lang || _LANG_LOADED[lang]) return;
  _LANG_LOADED[lang] = true;
}

function _detectLang(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  return _EXT_LANG[ext] || '';
}

async function _api(method, path, body) {
  const opts = { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API_BASE}/api/workspace${path}`, opts);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

// ── Editor container ──

function _getContainer() {
  let el = document.getElementById('code-editor-root');
  if (!el) {
    el = document.createElement('div');
    el.id = 'code-editor-root';
    el.className = 'code-editor-root';
    el.innerHTML = `
      <div class="code-editor-toolbar" id="code-editor-toolbar">
        <div class="code-editor-tabs" id="code-editor-tabs"></div>
        <div class="code-editor-actions">
          <button class="code-editor-action-btn" id="ce-toggle-fullscreen" title="Fullscreen (F11)">⛶</button>
          <button class="code-editor-action-btn" id="ce-close-editor" title="Close Editor">✖</button>
        </div>
      </div>
      <div class="code-editor-body" id="code-editor-body">
        <div class="code-editor-sidebar" id="code-editor-sidebar">
          <div class="code-editor-sidebar-header">
            <span>Files</span>
            <button class="code-editor-sidebar-toggle" id="ce-toggle-sidebar">◀</button>
          </div>
          <div class="code-editor-file-tree" id="code-editor-file-tree"></div>
        </div>
        <div class="code-editor-main" id="code-editor-main">
          <div class="code-editor-textarea-wrap" id="code-editor-textarea-wrap">
            <textarea id="code-editor-textarea" class="code-editor-textarea" spellcheck="false" wrap="off"></textarea>
          </div>
          <div class="code-editor-statusbar" id="code-editor-statusbar">
            <span id="ce-status-file">No file open</span>
            <span id="ce-status-lang"></span>
            <span id="ce-status-encoding">UTF-8</span>
            <span id="ce-status-pos">Ln 1, Col 1</span>
          </div>
        </div>
      </div>
      <div class="code-editor-panels" id="code-editor-panels">
        <div class="code-editor-panel-tabs">
          <button class="ce-panel-tab active" data-panel="terminal">Terminal</button>
          <button class="ce-panel-tab" data-panel="search">Search</button>
        </div>
        <div class="code-editor-panel-content" id="ce-panel-terminal">
          <div class="ce-terminal-placeholder">Terminal ready. Type commands below.</div>
          <div class="ce-terminal-input-line">
            <span class="ce-terminal-prompt">$</span>
            <input type="text" class="ce-terminal-input" id="ce-terminal-input" placeholder="Type a command..." />
          </div>
        </div>
        <div class="code-editor-panel-content" id="ce-panel-search" style="display:none">
          <div class="ce-search-form">
            <input type="text" class="ce-search-input" id="ce-search-query" placeholder="Search files..." />
            <div class="ce-search-options">
              <label><input type="checkbox" id="ce-search-regex"> Regex</label>
              <label><input type="checkbox" id="ce-search-casesensitive"> Case</label>
              <input type="text" class="ce-search-glob" id="ce-search-glob" placeholder="*.py" />
            </div>
            <button class="ce-search-btn" id="ce-search-go">Search</button>
          </div>
          <div class="ce-search-results" id="ce-search-results"></div>
        </div>
      </div>`;
    document.body.appendChild(el);
    _wireToolbar(el);
    _wireEditor(el);
    _wirePanels(el);
  }
  return el;
}

function _wireToolbar(el) {
  el.querySelector('#ce-toggle-fullscreen')?.addEventListener('click', toggleFullscreen);
  el.querySelector('#ce-close-editor')?.addEventListener('click', closeEditor);
  el.querySelector('#ce-toggle-sidebar')?.addEventListener('click', () => {
    const sidebar = el.querySelector('#code-editor-sidebar');
    const vis = sidebar.style.display !== 'none';
    sidebar.style.display = vis ? 'none' : '';
    el.querySelector('#ce-toggle-sidebar').textContent = vis ? '▶' : '◀';
  });
}

function _wireEditor(el) {
  const textarea = el.querySelector('#code-editor-textarea');
  if (!textarea) return;
  textarea.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      saveActiveFile();
    }
    if (e.key === 'F11') {
      e.preventDefault();
      toggleFullscreen();
    }
    _updateStatusBar();
  });
  textarea.addEventListener('input', () => {
    if (_activeFile) _dirtyFiles.add(_activeFile);
    _updateTabs();
  });
  textarea.addEventListener('scroll', _updateStatusBar);
}

function _wirePanels(el) {
  el.querySelectorAll('.ce-panel-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      el.querySelectorAll('.ce-panel-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      el.querySelectorAll('.code-editor-panel-content').forEach(c => c.style.display = 'none');
      const panel = el.querySelector('#ce-panel-' + tab.dataset.panel);
      if (panel) panel.style.display = '';
    });
  });
  el.querySelector('#ce-search-go')?.addEventListener('click', _doSearch);
  el.querySelector('#ce-search-query')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') _doSearch();
  });
  el.querySelector('#ce-terminal-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const input = e.target;
      const cmd = input.value.trim();
      input.value = '';
      _runTerminalCmd(cmd);
    }
  });
}

async function _doSearch() {
  const query = document.getElementById('ce-search-query')?.value;
  if (!query || !_projectId) return;
  const regex = document.getElementById('ce-search-regex')?.checked || false;
  const caseSensitive = document.getElementById('ce-search-casesensitive')?.checked || false;
  const glob = document.getElementById('ce-search-glob')?.value || null;
  const resultsEl = document.getElementById('ce-search-results');
  resultsEl.innerHTML = '<div class="ce-search-status">Searching...</div>';
  try {
    const data = await _api('POST', `/${_projectId}/files/grep`, { query, regex, case_sensitive: caseSensitive, glob, max_results: 200 });
    if (!data.results || data.results.length === 0) {
      resultsEl.innerHTML = '<div class="ce-search-status">No results</div>';
      return;
    }
    let html = `<div class="ce-search-status">${data.total} matches${data.truncated ? ' (truncated)' : ''}</div>`;
    let lastFile = '';
    for (const r of data.results) {
      if (r.path !== lastFile) {
        if (lastFile) html += '</div>';
        html += `<div class="ce-search-file"><span class="ce-search-file-name">${uiModule.esc(r.path)}</span><div class="ce-search-file-results">`;
        lastFile = r.path;
      }
      html += `<div class="ce-search-hit" data-path="${r.path}" data-line="${r.line}">
        <span class="ce-search-line-num">${r.line}</span>
        <span class="ce-search-line-text">${uiModule.esc(r.content)}</span>
      </div>`;
    }
    if (lastFile) html += '</div></div>';
    resultsEl.innerHTML = html;
    resultsEl.querySelectorAll('.ce-search-hit').forEach(hit => {
      hit.addEventListener('click', () => {
        openFile(hit.dataset.path);
        goToLine(parseInt(hit.dataset.line));
      });
    });
  } catch (e) {
    resultsEl.innerHTML = `<div class="ce-search-status">Error: ${e.message}</div>`;
  }
}

async function _runTerminalCmd(cmd) {
  const container = document.querySelector('.ce-terminal-placeholder');
  if (!cmd || !container) return;
  container.innerHTML += `\n<span style="color:var(--accent,var(--red))">$ ${uiModule.esc(cmd)}</span>\n`;
  try {
    const result = await _api('POST', `/execute`, { command: cmd, cwd: _projectPath || undefined });
    container.innerHTML += `<span>${uiModule.esc(result.output || '(no output)')}</span>\n`;
  } catch (e) {
    container.innerHTML += `<span style="color:var(--red)">Error: ${uiModule.esc(e.message)}</span>\n`;
  }
  container.scrollTop = container.scrollHeight;
}


// ── File operations ──

export async function openFile(path) {
  if (!_projectId) return;
  const el = _getContainer();
  if (!_openFiles.includes(path)) _openFiles.push(path);
  _activeFile = path;
  _updateTabs();
  const textarea = el.querySelector('#code-editor-textarea');
  if (!textarea) return;
  try {
    const data = await _api('POST', `/${_projectId}/files/read`, { path });
    textarea.value = data.content || '';
    _dirtyFiles.delete(path);
    _updateTabs();
  } catch (e) {
    textarea.value = `// Error loading ${path}: ${e.message}`;
  }
  el.querySelector('#ce-status-file').textContent = path;
  el.querySelector('#ce-status-lang').textContent = _detectLang(path);
  _updateStatusBar();
}

export async function saveActiveFile() {
  if (!_activeFile || !_projectId) return;
  const textarea = document.querySelector('#code-editor-textarea');
  if (!textarea) return;
  try {
    await _api('POST', `/${_projectId}/files/write`, { path: _activeFile, content: textarea.value });
    _dirtyFiles.delete(_activeFile);
    _updateTabs();
    uiModule.showToast?.('Saved');
  } catch (e) {
    uiModule.showError?.(`Save failed: ${e.message}`);
  }
}

export function closeFile(path) {
  _openFiles = _openFiles.filter(f => f !== path);
  _dirtyFiles.delete(path);
  if (_activeFile === path) {
    _activeFile = _openFiles[_openFiles.length - 1] || null;
    if (_activeFile) openFile(_activeFile);
    else {
      const textarea = document.querySelector('#code-editor-textarea');
      if (textarea) textarea.value = '';
      document.querySelector('#ce-status-file').textContent = 'No file open';
    }
  }
  _updateTabs();
}

export function goToLine(line) {
  const textarea = document.querySelector('#code-editor-textarea');
  if (!textarea) return;
  const lines = textarea.value.split('\n');
  let pos = 0;
  for (let i = 0; i < Math.min(line - 1, lines.length - 1); i++) pos += lines[i].length + 1;
  textarea.focus();
  textarea.setSelectionRange(pos, pos);
  textarea.scrollTop = (line - 1) * 20;
  _updateStatusBar();
}

function _updateTabs() {
  const container = document.querySelector('#code-editor-tabs');
  if (!container) return;
  container.innerHTML = _openFiles.map(f => {
    const name = f.split('/').pop();
    const active = f === _activeFile ? ' active' : '';
    const dirty = _dirtyFiles.has(f) ? ' dirty' : '';
    return `<div class="code-editor-tab${active}${dirty}" data-path="${f}">
      <span class="ce-tab-name">${uiModule.esc(name)}</span>
      <span class="ce-tab-close" data-path="${f}">✕</span>
    </div>`;
  }).join('');
  container.querySelectorAll('.code-editor-tab').forEach(tab => {
    tab.addEventListener('click', (e) => {
      if (e.target.closest('.ce-tab-close')) return;
      openFile(tab.dataset.path);
    });
  });
  container.querySelectorAll('.ce-tab-close').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeFile(btn.dataset.path);
    });
  });
}

function _updateStatusBar() {
  const textarea = document.querySelector('#code-editor-textarea');
  if (!textarea) return;
  const pos = textarea.selectionStart || 0;
  const text = textarea.value.substring(0, pos);
  const line = (text.match(/\n/g) || []).length + 1;
  const col = pos - text.lastIndexOf('\n');
  document.querySelector('#ce-status-pos').textContent = `Ln ${line}, Col ${col}`;
}


// ── Full-screen ──

export function toggleFullscreen() {
  const el = document.getElementById('code-editor-root');
  if (!el) return;
  _fullscreen = !_fullscreen;
  el.classList.toggle('code-editor-fullscreen', _fullscreen);
}

export function openEditor(projectId, projectPath) {
  _projectId = projectId;
  _projectPath = projectPath;
  setRoot(projectId, projectPath);
  const el = _getContainer();
  el.style.display = 'flex';
  renderTree(el.querySelector('#code-editor-file-tree'), projectId);
  if (el.querySelector('#ce-toggle-sidebar').textContent === '▶') {
    el.querySelector('#ce-toggle-sidebar').click();
  }
}

export function closeEditor() {
  const el = document.getElementById('code-editor-root');
  if (el) el.style.display = 'none';
}

function _initEventHandlers() {
  document.addEventListener('open-editor', (e) => {
    openEditor(e.detail.projectId, e.detail.path);
  });
  document.addEventListener('file-selected', (e) => {
    openFile(e.detail.path);
  });
}

_initEventHandlers();

export default { openEditor, closeEditor, toggleFullscreen, openFile, saveActiveFile };
