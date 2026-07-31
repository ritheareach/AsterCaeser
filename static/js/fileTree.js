// Project-local file tree for the code editor.
//
// Public contract:
//   mountFileTree(element, { workspaceId, projectId }, { onFileOpen })
// creates a lazily-loaded tree. It emits `aster:editor-file-selected` with
// { context, path } as well, so editor extensions never need to reach into
// this module's DOM.
import uiModule from './ui.js';

const API_ROOT = '/api/workspace';
const ALWAYS_HIDDEN = new Set(['.git', 'node_modules', '__pycache__']);

const FILE_ICONS = {
  py: '◆', js: '◆', mjs: '◆', cjs: '◆', ts: '◆', tsx: '◆', jsx: '◆',
  html: '◇', htm: '◇', css: '◇', scss: '◇', sass: '◇', json: '◇',
  md: '◆', typ: '◆', yml: '◇', yaml: '◇', toml: '◇', sh: '◆', bash: '◆',
  zsh: '◆', sql: '◆', rs: '◆', go: '◆', txt: '·',
};

function safePath(path) {
  const value = String(path || '').replaceAll('\\', '/').replace(/^\.\//, '');
  if (!value || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..')) {
    return '';
  }
  return value;
}

function joinPath(parent, name) {
  const child = safePath(name);
  if (!child || child.includes('/')) return '';
  return parent ? `${parent}/${child}` : child;
}

function apiPath(context, suffix) {
  return `${API_ROOT}/${encodeURIComponent(context.workspaceId)}/project/${encodeURIComponent(context.projectId)}/files/${suffix}`;
}

async function api(context, suffix, body) {
  const response = await fetch(apiPath(context, suffix), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const data = await response.json();
      message = data.detail || data.message || message;
    } catch (_) { /* Non-JSON errors still have a useful status. */ }
    throw new Error(message);
  }
  return response.json();
}

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function ignoreMatcher(contents) {
  const patterns = String(contents || '').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  return (path, isDir) => {
    const rootName = path.split('/')[0];
    if (ALWAYS_HIDDEN.has(rootName)) return true;
    let ignored = false;
    for (let raw of patterns) {
      let negate = false;
      if (raw.startsWith('!')) { negate = true; raw = raw.slice(1); }
      const directoryOnly = raw.endsWith('/');
      if (directoryOnly) raw = raw.slice(0, -1);
      if (!raw || (directoryOnly && !isDir)) continue;
      const anchored = raw.startsWith('/');
      if (anchored) raw = raw.slice(1);
      let pattern = '';
      for (let index = 0; index < raw.length; index += 1) {
        const character = raw[index];
        if (character === '*' && raw[index + 1] === '*') {
          pattern += '.*';
          index += 1;
        } else if (character === '*') {
          pattern += '[^/]*';
        } else if (character === '?') {
          pattern += '[^/]';
        } else {
          pattern += escapeRegExp(character);
        }
      }
      const expression = anchored
        ? new RegExp(`^${pattern}(?:/|$)`)
        : new RegExp(`(?:^|/)${pattern}(?:/|$)`);
      if (expression.test(path)) ignored = !negate;
    }
    return ignored;
  };
}

function entryIcon(entry) {
  if (entry.type === 'dir') return '▸';
  const name = String(entry.name || '');
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  return FILE_ICONS[ext] || '·';
}

function normaliseContext(context) {
  const workspaceId = String(context?.workspaceId || context?.workspace_id || '');
  const projectId = String(context?.projectId || context?.project_id || context?.id || '');
  if (!workspaceId || !projectId) throw new Error('A workspace and project are required to load files.');
  return { workspaceId, projectId };
}

export class FileTree {
  constructor(container, context, { onFileOpen } = {}) {
    this.container = container;
    this.context = normaliseContext(context);
    this.onFileOpen = onFileOpen;
    this.expanded = new Set();
    this.cache = new Map();
    this.ignore = ignoreMatcher('');
    this.destroyed = false;
    this._onContextMenu = this._onContextMenu.bind(this);
    this.container.addEventListener('contextmenu', this._onContextMenu);
  }

  async mount() {
    this.container.replaceChildren(this._status('Loading files…'));
    await this._loadIgnoreFile();
    try {
      await this._load('');
      this._render();
    } catch (error) {
      this.container.replaceChildren(this._status(`Failed to load files: ${error.message}`, true));
    }
    return this;
  }

  async refresh() {
    this.cache.clear();
    return this.mount();
  }

  destroy() {
    this.destroyed = true;
    this.container.removeEventListener('contextmenu', this._onContextMenu);
    document.querySelector('.file-tree-context-menu')?.remove();
  }

  async _loadIgnoreFile() {
    try {
      const result = await api(this.context, 'read', { path: '.gitignore' });
      this.ignore = ignoreMatcher(result.content);
    } catch (_) {
      // .gitignore is optional; protected defaults remain hidden.
      this.ignore = ignoreMatcher('');
    }
  }

  async _load(path) {
    const key = safePath(path);
    if (this.cache.has(key)) return this.cache.get(key);
    const result = await api(this.context, 'list', { path: key });
    const entries = (result.entries || [])
      .map(entry => ({
        name: String(entry.name || ''),
        path: joinPath(key, entry.name),
        type: entry.type === 'dir' ? 'dir' : 'file',
      }))
      .filter(entry => entry.path && !this.ignore(entry.path, entry.type === 'dir'))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    this.cache.set(key, entries);
    return entries;
  }

  async _toggle(path) {
    if (this.expanded.has(path)) {
      this.expanded.delete(path);
      this._render();
      return;
    }
    try {
      await this._load(path);
      this.expanded.add(path);
      this._render();
    } catch (error) {
      uiModule.showError?.(`Could not load ${path}: ${error.message}`);
    }
  }

  _status(message, isError = false) {
    const status = document.createElement('div');
    status.className = isError ? 'file-tree-error' : 'file-tree-loading';
    status.textContent = message;
    return status;
  }

  _render() {
    if (this.destroyed) return;
    const list = document.createElement('ul');
    list.className = 'file-tree-list';
    list.style.listStyle = 'none';
    list.style.margin = '0';
    list.style.padding = '0';
    this._renderEntries(list, this.cache.get('') || [], 0);
    this.container.replaceChildren(list);
  }

  _renderEntries(list, entries, depth) {
    for (const entry of entries) {
      const row = document.createElement('li');
      row.className = `file-tree-item file-tree-${entry.type}`;
      row.dataset.path = entry.path;
      row.dataset.type = entry.type;
      row.style.paddingLeft = `${depth * 16 + 4}px`;
      row.setAttribute('title', entry.path);

      const arrow = document.createElement('span');
      arrow.className = 'file-tree-arrow';
      arrow.textContent = entry.type === 'dir' ? (this.expanded.has(entry.path) ? '▾' : '▸') : '▸';
      if (entry.type !== 'dir') arrow.style.visibility = 'hidden';
      const icon = document.createElement('span');
      icon.className = 'file-tree-icon';
      icon.textContent = entryIcon(entry);
      const name = document.createElement('span');
      name.className = 'file-tree-name';
      name.textContent = entry.name;
      row.append(arrow, icon, name);
      row.addEventListener('click', () => {
        if (entry.type === 'dir') void this._toggle(entry.path);
        else this._open(entry.path, row);
      });
      list.appendChild(row);

      if (entry.type === 'dir' && this.expanded.has(entry.path)) {
        const children = document.createElement('ul');
        children.className = 'file-tree-children';
        children.style.listStyle = 'none';
        children.style.margin = '0';
        children.style.padding = '0';
        this._renderEntries(children, this.cache.get(entry.path) || [], depth + 1);
        list.appendChild(children);
      }
    }
  }

  _open(path, row) {
    this.container.querySelectorAll('.file-tree-item.selected').forEach(item => item.classList.remove('selected'));
    row.classList.add('selected');
    const detail = { context: { ...this.context }, path };
    document.dispatchEvent(new CustomEvent('aster:editor-file-selected', { detail }));
    this.onFileOpen?.(path);
  }

  _onContextMenu(event) {
    const item = event.target.closest('.file-tree-item');
    if (!item || !this.container.contains(item)) return;
    event.preventDefault();
    this._showContextMenu(event.clientX, event.clientY, item.dataset.path, item.dataset.type === 'dir');
  }

  _showContextMenu(x, y, path, isDirectory) {
    document.querySelector('.file-tree-context-menu')?.remove();
    const menu = document.createElement('div');
    menu.className = 'file-tree-context-menu';
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    const actions = [
      ['New File', () => this._create(path, isDirectory, 'file')],
      ['New Folder', () => this._create(path, isDirectory, 'dir')],
      ['Rename', () => this._rename(path)],
      ['Delete', () => this._delete(path)],
    ];
    for (const [label, action] of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'file-tree-ctx-item';
      button.style.cssText = 'display:block;width:100%;border:0;background:transparent;color:inherit;text-align:left;';
      button.textContent = label;
      button.addEventListener('click', () => { menu.remove(); void action(); });
      menu.appendChild(button);
    }
    document.body.appendChild(menu);
    document.addEventListener('click', () => menu.remove(), { once: true });
  }

  async _create(path, isDirectory, type) {
    const name = window.prompt(`New ${type === 'dir' ? 'folder' : 'file'} name:`)?.trim();
    if (!name) return;
    const parent = isDirectory ? path : path.split('/').slice(0, -1).join('/');
    const target = joinPath(parent, name);
    if (!target) return uiModule.showError?.('Names must not contain path separators.');
    try {
      await api(this.context, 'create', { path: target, type });
      await this.refresh();
      if (type === 'file') {
        const detail = { context: { ...this.context }, path: target };
        document.dispatchEvent(new CustomEvent('aster:editor-file-selected', { detail }));
        this.onFileOpen?.(target);
      }
    } catch (error) {
      uiModule.showError?.(`Could not create ${name}: ${error.message}`);
    }
  }

  async _rename(path) {
    const oldName = path.split('/').pop();
    const name = window.prompt('New name:', oldName)?.trim();
    if (!name || name === oldName) return;
    if (name.includes('/') || name.includes('\\')) return uiModule.showError?.('Names must not contain path separators.');
    try {
      await api(this.context, 'rename', { path, new_name: name });
      await this.refresh();
    } catch (error) {
      uiModule.showError?.(`Could not rename ${oldName}: ${error.message}`);
    }
  }

  async _delete(path) {
    if (!window.confirm(`Delete ${path}? This cannot be undone.`)) return;
    try {
      await api(this.context, 'delete', { path });
      await this.refresh();
    } catch (error) {
      uiModule.showError?.(`Could not delete ${path}: ${error.message}`);
    }
  }
}

export async function mountFileTree(container, context, options) {
  const tree = new FileTree(container, context, options);
  await tree.mount();
  return tree;
}

// Compatibility aliases for callers that only need a project tree. New code
// should use mountFileTree and pass the full workspace/project context.
export const renderTree = mountFileTree;

export default { FileTree, mountFileTree, renderTree };
