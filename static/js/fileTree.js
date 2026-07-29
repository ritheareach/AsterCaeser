// File tree component — lazy-loading directory tree with icons, context menu, gitignore filtering.
import uiModule from './ui.js';

const API_BASE = window.location.origin;

let _treeData = {};
let _expandedPaths = new Set();
let _rootPath = '';

async function _api(method, path, body) {
  const opts = { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API_BASE}${path}`, opts);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

const _FILE_ICONS = {
  py: '<svg width="14" height="14" viewBox="0 0 24 24" fill="#3572A5"><ellipse cx="12" cy="12" rx="7" ry="4" transform="rotate(30 12 12)"/></svg>',
  js: '<svg width="14" height="14" viewBox="0 0 24 24" fill="#f7df1e"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>',
  ts: '<svg width="14" height="14" viewBox="0 0 24 24" fill="#3178c6"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>',
  html: '<svg width="14" height="14" viewBox="0 0 24 24" fill="#e34f26"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>',
  css: '<svg width="14" height="14" viewBox="0 0 24 24" fill="#1572b6"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>',
  json: '<svg width="14" height="14" viewBox="0 0 24 24" fill="#5a5a5a"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>',
  md: '<svg width="14" height="14" viewBox="0 0 24 24" fill="#083fa1"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>',
  svg: '<svg width="14" height="14" viewBox="0 0 24 24" fill="#ffb13b"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>',
  yml: '<svg width="14" height="14" viewBox="0 0 24 24" fill="#cb171e"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>',
  yaml: '<svg width="14" height="14" viewBox="0 0 24 24" fill="#cb171e"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>',
  toml: '<svg width="14" height="14" viewBox="0 0 24 24" fill="#8c8c8c"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>',
  sh: '<svg width="14" height="14" viewBox="0 0 24 24" fill="#4eaa25"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>',
  bash: '<svg width="14" height="14" viewBox="0 0 24 24" fill="#4eaa25"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>',
  txt: '<svg width="14" height="14" viewBox="0 0 24 24" fill="#8c8c8c"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>',
};

const _DIR_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';

function _fileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  return _FILE_ICONS[ext] || '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
}

export async function loadDir(projectId, relPath) {
  const data = await _api('POST', `/api/workspace/${projectId}/files/list`, { path: relPath || '.' });
  return data.entries || [];
}

export function setRoot(projectId, path) {
  _rootPath = path;
  _treeData = {};
  _expandedPaths.clear();
}

export async function renderTree(container, projectId) {
  container.innerHTML = '<div class="file-tree-loading">Loading...</div>';
  try {
    const entries = await loadDir(projectId, '.');
    container.innerHTML = _renderNodes(entries, projectId, '', 0);
    _attachHandlers(container, projectId);
  } catch (e) {
    container.innerHTML = `<div class="file-tree-error">Failed to load: ${e.message}</div>`;
  }
}

function _renderNodes(entries, projectId, parentPath, depth) {
  const dirs = entries.filter(e => e.type === 'dir');
  const files = entries.filter(e => e.type === 'file');
  let html = '';
  for (const d of dirs) {
    const fullPath = parentPath ? `${parentPath}/${d.name}` : d.name;
    const expanded = _expandedPaths.has(fullPath);
    html += `
      <div class="file-tree-item file-tree-dir" data-path="${fullPath}" data-expanded="${expanded}" style="padding-left:${depth * 16 + 4}px">
        <span class="file-tree-arrow">${expanded ? '▾' : '▸'}</span>
        <span class="file-tree-icon">${_DIR_ICON}</span>
        <span class="file-tree-name">${uiModule.esc(d.name)}</span>
      </div>
      <div class="file-tree-children" data-parent="${fullPath}" style="display:${expanded ? '' : 'none'}"></div>`;
  }
  for (const f of files) {
    const fullPath = parentPath ? `${parentPath}/${f.name}` : f.name;
    html += `
      <div class="file-tree-item file-tree-file" data-path="${fullPath}" style="padding-left:${depth * 16 + 4}px">
        <span class="file-tree-arrow" style="visibility:hidden">▸</span>
        <span class="file-tree-icon">${_fileIcon(f.name)}</span>
        <span class="file-tree-name">${uiModule.esc(f.name)}</span>
      </div>`;
  }
  return html;
}

function _attachHandlers(container, projectId) {
  container.querySelectorAll('.file-tree-dir').forEach(el => {
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      const path = el.dataset.path;
      const expanded = el.dataset.expanded === 'true';
      const children = container.querySelector(`.file-tree-children[data-parent="${path}"]`);
      if (expanded) {
        _expandedPaths.delete(path);
        el.dataset.expanded = 'false';
        el.querySelector('.file-tree-arrow').textContent = '▸';
        if (children) children.style.display = 'none';
      } else {
        _expandedPaths.add(path);
        el.dataset.expanded = 'true';
        el.querySelector('.file-tree-arrow').textContent = '▾';
        if (children) {
          if (!children.dataset.loaded) {
            children.dataset.loaded = '1';
            try {
              const entries = await loadDir(projectId, path);
              children.innerHTML = _renderNodes(entries, projectId, path, parseInt(el.style.paddingLeft) / 16 + 1);
              _attachHandlers(children, projectId);
            } catch (e) {
              children.innerHTML = '<div class="file-tree-error">Error</div>';
            }
          }
          children.style.display = '';
        }
      }
    });
  });
  container.querySelectorAll('.file-tree-file').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      container.querySelectorAll('.file-tree-item.selected').forEach(s => s.classList.remove('selected'));
      el.classList.add('selected');
      document.dispatchEvent(new CustomEvent('file-selected', { detail: { path: el.dataset.path, projectId } }));
    });
  });
  container.addEventListener('contextmenu', (e) => {
    const item = e.target.closest('.file-tree-item');
    if (!item) return;
    e.preventDefault();
    _showContextMenu(e.clientX, e.clientY, item.dataset.path, item.classList.contains('file-tree-dir'), projectId, container);
  });
}

function _showContextMenu(x, y, path, isDir, projectId, container) {
  const existing = document.querySelector('.file-tree-context-menu');
  if (existing) existing.remove();
  const menu = document.createElement('div');
  menu.className = 'file-tree-context-menu';
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  const items = [
    { label: 'New File', action: 'new-file' },
    { label: 'New Folder', action: 'new-folder' },
    { label: 'Rename', action: 'rename' },
    { label: 'Delete', action: 'delete' },
  ];
  menu.innerHTML = items.map(i => `<div class="file-tree-ctx-item" data-action="${i.action}">${i.label}</div>`).join('');
  document.body.appendChild(menu);
  menu.querySelectorAll('.file-tree-ctx-item').forEach(el => {
    el.addEventListener('click', async () => {
      menu.remove();
      const action = el.dataset.action;
      if (action === 'new-file' || action === 'new-folder') {
        const name = prompt(`Enter ${action === 'new-file' ? 'file' : 'folder'} name:`);
        if (!name) return;
        const fullPath = path ? `${path}/${name}` : name;
        await _api('POST', `/api/workspace/${projectId}/files/create`, { path: fullPath, type: action === 'new-folder' ? 'dir' : 'file' });
        _expandedPaths.clear();
        await renderTree(container, projectId);
      } else if (action === 'rename') {
        const name = prompt('New name:');
        if (!name) return;
        await _api('POST', `/api/workspace/${projectId}/files/rename`, { path, new_name: name });
        _expandedPaths.clear();
        await renderTree(container, projectId);
      } else if (action === 'delete') {
        if (!confirm('Delete ' + path + '?')) return;
        await _api('POST', `/api/workspace/${projectId}/files/delete`, { path });
        _expandedPaths.clear();
        await renderTree(container, projectId);
      }
    });
  });
  document.addEventListener('click', () => { if (menu.parentNode) menu.remove(); }, { once: true });
}

export default { renderTree, setRoot, loadDir };
