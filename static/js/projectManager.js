// Project & Workspace management UI — sidebar section, project selector, CRUD views.
import Storage, { KEYS } from './storage.js';
import uiModule from './ui.js';

const API_BASE = window.location.origin;

let _workspaces = [];
let _projects = [];
let _activeProjectId = null;
let _view = 'list'; // 'list' | 'project'

// ── SVG icons ──
const _ICON = {
  workspace: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
  project: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
  chat: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  note: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
  task: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
  editor: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
  plus: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
};


// ── API helpers ──

async function _api(method, path, body) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(`${API_BASE}/api/workspace${path}`, opts);
  if (!res.ok) { const err = await res.text().catch(() => ''); throw new Error(`${res.status}: ${err}`); }
  return res.json();
}

function _getApi(path) { return _api('GET', path); }
function _postApi(path, body) { return _api('POST', path, body); }
function _putApi(path, body) { return _api('PUT', path, body); }
function _delApi(path) { return _api('DELETE', path); }


// ── Data loading ──

async function loadWorkspaces() {
  try {
    const data = await _getApi('');
    _workspaces = data.workspaces || [];
    if (_workspaces.length === 0) {
      // Auto-create default workspace
      const w = await _postApi('', { name: 'My Workspace', description: 'Default workspace' });
      _workspaces = [w];
    }
    return _workspaces;
  } catch (e) {
    console.error('Failed to load workspaces:', e);
    return [];
  }
}

async function loadProjects(wsId) {
  try {
    const data = await _getApi(`/${wsId}/project`);
    _projects = data.projects || [];
    return _projects;
  } catch (e) {
    console.error('Failed to load projects:', e);
    return [];
  }
}


// ── Project selector dropdown (sidebar) ──

function _renderSelector(container) {
  const active = _projects.find(p => p.id === _activeProjectId);
  container.innerHTML = `
    <div class="project-selector" id="project-selector">
      <div class="project-selector-current" id="project-sel-current">
        <span class="project-sel-icon">${_ICON.project}</span>
        <span class="project-sel-name">${active ? uiModule.esc(active.name) : 'No Project'}</span>
        <svg class="project-sel-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
      <div class="project-selector-dropdown" id="project-sel-dropdown" style="display:none">
        ${_projects.map(p => `
          <div class="project-sel-item${p.id === _activeProjectId ? ' active' : ''}" data-id="${p.id}">
            <span class="project-sel-item-icon">${_ICON.project}</span>
            <span class="project-sel-item-name">${uiModule.esc(p.name)}</span>
          </div>
        `).join('')}
        <div class="project-sel-divider"></div>
        <div class="project-sel-item" data-action="manage">
          <span class="project-sel-item-icon">${_ICON.workspace}</span>
          <span class="project-sel-item-name">Manage Projects</span>
        </div>
      </div>
    </div>`;

  const current = container.querySelector('#project-sel-current');
  const dropdown = container.querySelector('#project-sel-dropdown');
  current.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.style.display = dropdown.style.display === 'none' ? '' : 'none';
  });
  dropdown.querySelectorAll('.project-sel-item[data-id]').forEach(el => {
    el.addEventListener('click', () => {
      _activeProjectId = el.dataset.id;
      Storage.set('astercaeser-active-project', _activeProjectId);
      dropdown.style.display = 'none';
      _renderSelector(container);
      _renderMainView();
      document.dispatchEvent(new CustomEvent('project-changed', { detail: { projectId: _activeProjectId } }));
    });
  });
  dropdown.querySelector('[data-action="manage"]')?.addEventListener('click', () => {
    dropdown.style.display = 'none';
    _view = 'list';
    _renderMainView();
  });
  document.addEventListener('click', () => { dropdown.style.display = 'none'; }, { once: true });
}


// ── Main content rendering ──

function _renderMainView() {
  const content = document.getElementById('workspace-main-content');
  if (!content) return;
  if (_view === 'list') _renderWorkspaceList(content);
  else if (_view === 'project') _renderProjectDetail(content);
}

async function _renderWorkspaceList(container) {
  await loadWorkspaces();
  let html = `<div class="workspace-header"><h3>Workspaces</h3></div>`;

  for (const ws of _workspaces) {
    const projs = await loadProjects(ws.id);
    html += `
      <div class="workspace-card">
        <div class="workspace-card-header">
          <span class="workspace-card-icon">${_ICON.workspace}</span>
          <span class="workspace-card-name">${uiModule.esc(ws.name)}</span>
          <span class="workspace-card-count">${projs.length} projects</span>
        </div>
        <div class="workspace-card-projects">
          ${projs.length === 0 ? '<div class="workspace-empty-sm">No projects yet</div>' : ''}
          ${projs.map(p => `
            <div class="workspace-project-row" data-id="${p.id}" data-wsid="${ws.id}">
              <span class="workspace-project-icon">${_ICON.project}</span>
              <span class="workspace-project-name">${uiModule.esc(p.name)}</span>
              ${p.path ? '<span class="workspace-project-path">' + uiModule.esc(p.path) + '</span>' : ''}
              <span class="workspace-project-count">${p.chat_count || 0} chats</span>
            </div>
          `).join('')}
        </div>
      </div>`;
  }

  html += `
    <div class="workspace-actions">
      <button class="workspace-action-btn" id="workspace-new-project-btn">${_ICON.plus} New Project</button>
      <button class="workspace-action-btn" id="workspace-import-btn">${_ICON.project} Import Directory</button>
    </div>`;

  container.innerHTML = html;
  container.querySelectorAll('.workspace-project-row').forEach(row => {
    row.addEventListener('click', () => {
      _activeProjectId = row.dataset.id;
      Storage.set('astercaeser-active-project', _activeProjectId);
      _view = 'project';
      _renderMainView();
      _updateSidebarSelector();
      document.dispatchEvent(new CustomEvent('project-changed', { detail: { projectId: _activeProjectId } }));
    });
  });
  container.querySelector('#workspace-new-project-btn')?.addEventListener('click', _openCreateModal);
  container.querySelector('#workspace-import-btn')?.addEventListener('click', _openImportModal);
}

function _renderProjectDetail(container) {
  const p = _projects.find(x => x.id === _activeProjectId);
  if (!p) { _view = 'list'; _renderMainView(); return; }

  container.innerHTML = `
    <div class="project-detail">
      <div class="project-detail-header">
        <button class="project-back-btn" id="project-back-btn">← Back</button>
        <h3>${uiModule.esc(p.name)}</h3>
        <span class="project-detail-path">${p.path ? uiModule.esc(p.path) : 'No path bound'}</span>
      </div>
      <div class="project-detail-tabs" id="project-detail-tabs">
        <button class="project-tab active" data-tab="overview">Overview</button>
        <button class="project-tab" data-tab="chats">Chats</button>
        <button class="project-tab" data-tab="notes">Notes</button>
        <button class="project-tab" data-tab="tasks">Tasks</button>
        <button class="project-tab" data-tab="settings">Settings</button>
      </div>
      <div class="project-detail-body" id="project-detail-body">
        <div class="project-tab-content" id="project-tab-overview">
          <div class="project-overview-grid">
            <div class="project-stat-card">
              <div class="project-stat-value">${p.chat_count || 0}</div>
              <div class="project-stat-label">Chats</div>
            </div>
            <div class="project-stat-card">
              <div class="project-stat-value">${p.file_count ?? '-'}</div>
              <div class="project-stat-label">Files</div>
            </div>
            <div class="project-stat-card">
              <div class="project-stat-value">${p.dir_count ?? '-'}</div>
              <div class="project-stat-label">Directories</div>
            </div>
          </div>
          <div class="project-quick-actions">
            ${p.path ? `<button class="project-action-btn" id="project-open-editor-btn">${_ICON.editor} Open Editor</button>` : ''}
            <button class="project-action-btn" id="project-new-chat-btn">${_ICON.chat} New Chat</button>
          </div>
        </div>
        <div class="project-tab-content" id="project-tab-chats" style="display:none">
          <div class="project-tab-placeholder">Chat history will appear here.</div>
        </div>
        <div class="project-tab-content" id="project-tab-notes" style="display:none">
          <div class="project-tab-placeholder">Project notes will appear here.</div>
        </div>
        <div class="project-tab-content" id="project-tab-tasks" style="display:none">
          <div class="project-tab-placeholder">Project tasks will appear here.</div>
        </div>
        <div class="project-tab-content" id="project-tab-settings" style="display:none">
          <div class="project-setting-row">
            <label>Project Name</label>
            <input type="text" class="styled-prompt-input" id="project-settings-name" value="${uiModule.esc(p.name)}">
          </div>
          <div class="project-setting-row">
            <label>Description</label>
            <input type="text" class="styled-prompt-input" id="project-settings-desc" value="${uiModule.esc(p.description || '')}">
          </div>
          <div class="project-setting-row">
            <label>Filesystem Path</label>
            <input type="text" class="styled-prompt-input" id="project-settings-path" value="${p.path || ''}" placeholder="/path/to/project">
          </div>
          <div class="project-setting-actions">
            <button class="confirm-btn confirm-btn-primary" id="project-settings-save">Save</button>
            <button class="confirm-btn confirm-btn-danger" id="project-settings-delete">Delete Project</button>
          </div>
        </div>
      </div>
    </div>`;

  container.querySelector('#project-back-btn')?.addEventListener('click', () => {
    _view = 'list'; _renderMainView();
  });
  container.querySelectorAll('.project-tab').forEach(tab => {
    tab.addEventListener('click', async () => {
      container.querySelectorAll('.project-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      container.querySelectorAll('.project-tab-content').forEach(c => c.style.display = 'none');
      const target = document.getElementById('project-tab-' + tab.dataset.tab);
      if (target) target.style.display = '';
      if (tab.dataset.tab === 'chats') {
        try {
          const data = await _getApi(`/${p.workspace_id}/project/${p.id}/chats`);
          const listEl = document.getElementById('project-tab-chats');
          if (data.chats && data.chats.length > 0) {
            listEl.innerHTML = data.chats.map(c =>
              `<div class="project-chat-row" data-id="${c.id}">
                <span class="project-chat-name">${uiModule.esc(c.name)}</span>
                <span class="project-chat-date">${new Date(c.last_accessed || c.created_at).toLocaleDateString()}</span>
              </div>`
            ).join('');
            listEl.querySelectorAll('.project-chat-row').forEach(row => {
              row.addEventListener('click', () => {
                document.dispatchEvent(new CustomEvent('select-chat', { detail: { sessionId: row.dataset.id } }));
              });
            });
          } else {
            listEl.innerHTML = '<div class="project-tab-placeholder">No chats yet. Start a new chat while this project is active.</div>';
          }
        } catch (e) {
          document.getElementById('project-tab-chats').innerHTML = `<div class="project-tab-placeholder">Failed to load chats: ${e.message}</div>`;
        }
      }
    });
  });
  container.querySelector('#project-open-editor-btn')?.addEventListener('click', () => {
    if (p.path) document.dispatchEvent(new CustomEvent('open-editor', { detail: { projectId: p.id, path: p.path } }));
  });
  container.querySelector('#project-new-chat-btn')?.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('start-chat', { detail: { projectId: p.id } }));
  });
  container.querySelector('#project-settings-save')?.addEventListener('click', async () => {
    const name = document.getElementById('project-settings-name')?.value.trim();
    const desc = document.getElementById('project-settings-desc')?.value.trim();
    const path = document.getElementById('project-settings-path')?.value.trim();
    if (!name) return uiModule.showToast?.('Name is required');
    try {
      await _putApi(`/${p.workspace_id}/project/${p.id}`, { name, description: desc, path: path || null });
      uiModule.showToast?.('Project updated');
      _renderMainView();
    } catch (e) { uiModule.showError?.(`Failed: ${e.message}`); }
  });
  container.querySelector('#project-settings-delete')?.addEventListener('click', async () => {
    if (!await uiModule.styledConfirm?.('Delete this project? All associated data will be lost.', { confirmText: 'Delete', danger: true })) return;
    try {
      await _delApi(`/${p.workspace_id}/project/${p.id}`);
      _activeProjectId = null;
      Storage.remove('astercaeser-active-project');
      _view = 'list';
      _renderMainView();
      _updateSidebarSelector();
      uiModule.showToast?.('Project deleted');
    } catch (e) { uiModule.showError?.(`Failed: ${e.message}`); }
  });
}


// ── Create / Import modals ──

function _openCreateModal() {
  const name = prompt('Enter project name:');
  if (!name) return;
  const wsId = _workspaces[0]?.id;
  if (!wsId) return uiModule.showError?.('No workspace available');
  (async () => {
    try {
      const p = await _postApi(`/${wsId}/project`, { name, description: '', workspace_id: wsId });
      _activeProjectId = p.id;
      Storage.set('astercaeser-active-project', p.id);
      _view = 'project';
      _projects.push(p);
      _renderMainView();
      _updateSidebarSelector();
      document.dispatchEvent(new CustomEvent('project-changed', { detail: { projectId: p.id } }));
    } catch (e) { uiModule.showError?.(`Failed: ${e.message}`); }
  })();
}

function _openImportModal() {
  const path = prompt('Enter the directory path to import:');
  if (!path) return;
  const name = path.split(/[/\\]/).filter(Boolean).pop() || 'Imported Project';
  const wsId = _workspaces[0]?.id;
  if (!wsId) return uiModule.showError?.('No workspace available');
  (async () => {
    try {
      const p = await _postApi(`/${wsId}/project`, { name, description: `Imported from ${path}`, path, workspace_id: wsId });
      _activeProjectId = p.id;
      Storage.set('astercaeser-active-project', p.id);
      _view = 'project';
      _projects.push(p);
      _renderMainView();
      _updateSidebarSelector();
      document.dispatchEvent(new CustomEvent('project-changed', { detail: { projectId: p.id } }));
    } catch (e) { uiModule.showError?.(`Failed: ${e.message}`); }
  })();
}


// ── Sidebar integration ──

function _updateSidebarSelector() {
  const container = document.getElementById('project-selector-container');
  if (container) _renderSelector(container);
}

function _buildSidebarHTML() {
  const section = document.getElementById('projects-section');
  if (!section) return;
  section.innerHTML = `
    <div class="section-header-flex" id="projects-section-header">
      <span class="section-title">Workspace</span>
    </div>
    <div id="project-selector-container"></div>
    <div id="workspace-main-content" class="workspace-main-content"></div>`;
  _updateSidebarSelector();
  _renderMainView();
}


// ── Init ──

export async function initProjectManager() {
  _activeProjectId = Storage.get('astercaeser-active-project', null);
  _buildSidebarHTML();
  // Load projects for selector
  await loadWorkspaces();
  if (_workspaces.length > 0) {
    await loadProjects(_workspaces[0].id);
    _updateSidebarSelector();
  }
  if (_activeProjectId) {
    _view = 'project';
    _renderMainView();
  }
}

export function getActiveProjectId() { return _activeProjectId; }

export default { initProjectManager, getActiveProjectId };
