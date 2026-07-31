// Workspace and project control plane.
//
// This module owns one normalized view of workspaces/projects.  It never
// manufactures a default workspace and never falls back to workspace[0]: a
// selection is either explicit, restored from storage, or intentionally empty.
import Storage from './storage.js';
import uiModule from './ui.js';
import { makeWindowDraggable } from './windowDrag.js';

const API_BASE = window.location.origin;
const ACTIVE_WORKSPACE_KEY = 'astercaeser-active-workspace';
const ACTIVE_PROJECT_KEY = 'astercaeser-active-project';

const state = {
  initialized: false,
  initPromise: null,
  workspacesById: new Map(),
  workspaceIds: [],
  projectsById: new Map(),
  projectIdsByWorkspace: new Map(),
  activeWorkspaceId: null,
  activeProjectId: null,
  view: 'workspace',
  activeTab: 'overview',
  loading: false,
  error: '',
  renderToken: 0,
};

const ICON = {
  workspace: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="1"/><path d="M8 21h8M12 17v4"/></svg>',
  project: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>',
  chat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2Z"/></svg>',
  note: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5M9 13h6M9 17h5"/></svg>',
  task: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 12 3 3 6-7"/><path d="M19 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9"/></svg>',
  editor: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 9-3 3 3 3M16 9l3 3-3 3M14 5l-4 14"/></svg>',
  add: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  more: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h.01M12 12h.01M19 12h.01"/></svg>',
  folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0 2 5"/><path d="M20 4v7h-7"/></svg>',
};

function esc(value) {
  const string = String(value ?? '');
  return uiModule.esc ? uiModule.esc(string) : string.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function icon(name) {
  return `<span class="workspace-icon workspace-icon-${name}">${ICON[name] || ''}</span>`;
}

function isEditableTarget(target) {
  return !!target?.closest?.('input, textarea, select, [contenteditable="true"], [contenteditable=""]');
}

function currentProject() {
  return state.activeProjectId ? state.projectsById.get(state.activeProjectId) || null : null;
}

function currentWorkspace() {
  return state.activeWorkspaceId ? state.workspacesById.get(state.activeWorkspaceId) || null : null;
}

function projectIds(workspaceId) {
  return state.projectIdsByWorkspace.get(workspaceId) || [];
}

function projectsForWorkspace(workspaceId) {
  return projectIds(workspaceId).map(id => state.projectsById.get(id)).filter(Boolean);
}

function _setStored(key, value) {
  if (value) Storage.set(key, value);
  else Storage.remove(key);
}

function _setActiveProject(projectId, { openProject = false, notify = true } = {}) {
  const project = projectId ? state.projectsById.get(projectId) : null;
  state.activeProjectId = project ? project.id : null;
  if (project) state.activeWorkspaceId = project.workspace_id;
  _setStored(ACTIVE_PROJECT_KEY, state.activeProjectId);
  _setStored(ACTIVE_WORKSPACE_KEY, state.activeWorkspaceId);
  if (openProject && project) state.view = 'project';
  if (notify) {
    document.dispatchEvent(new CustomEvent('project-changed', {
      detail: {
        projectId: state.activeProjectId,
        workspaceId: state.activeWorkspaceId,
        project: project || null,
      },
    }));
  }
}

function _setActiveWorkspace(workspaceId, { clearProject = false } = {}) {
  const workspace = workspaceId ? state.workspacesById.get(workspaceId) : null;
  state.activeWorkspaceId = workspace ? workspace.id : null;
  if (clearProject || (state.activeProjectId && currentProject()?.workspace_id !== state.activeWorkspaceId)) {
    _setActiveProject(null);
  } else {
    _setStored(ACTIVE_WORKSPACE_KEY, state.activeWorkspaceId);
  }
}

async function request(method, path, body) {
  const options = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(`${API_BASE}${path}`, options);
  if (!response.ok) {
    let detail = '';
    try {
      const payload = await response.json();
      detail = payload.detail || payload.message || JSON.stringify(payload);
    } catch (_) {
      detail = await response.text().catch(() => '');
    }
    const error = new Error(detail || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  if (response.status === 204) return null;
  return response.json();
}

const workspaceRequest = (method, path, body) => request(method, `/api/workspace${path}`, body);
const coreRequest = (method, path, body) => request(method, `/api${path}`, body);

function _normaliseData(workspaces, projectsByWorkspace) {
  state.workspacesById.clear();
  state.projectsById.clear();
  state.projectIdsByWorkspace.clear();
  state.workspaceIds = [];

  for (const workspace of workspaces) {
    if (!workspace?.id) continue;
    state.workspacesById.set(workspace.id, workspace);
    state.workspaceIds.push(workspace.id);
    const projects = projectsByWorkspace.get(workspace.id) || [];
    const ids = [];
    for (const project of projects) {
      if (!project?.id) continue;
      state.projectsById.set(project.id, project);
      ids.push(project.id);
    }
    state.projectIdsByWorkspace.set(workspace.id, ids);
  }

  // Restore only valid persisted selections.  Deliberately do not select the
  // first workspace/project when nothing was chosen by the user.
  const storedProject = Storage.get(ACTIVE_PROJECT_KEY, null);
  const storedWorkspace = Storage.get(ACTIVE_WORKSPACE_KEY, null);
  if (state.activeProjectId && !state.projectsById.has(state.activeProjectId)) state.activeProjectId = null;
  if (state.activeWorkspaceId && !state.workspacesById.has(state.activeWorkspaceId)) state.activeWorkspaceId = null;
  if (!state.activeProjectId && storedProject && state.projectsById.has(storedProject)) {
    state.activeProjectId = storedProject;
  }
  if (state.activeProjectId) {
    state.activeWorkspaceId = state.projectsById.get(state.activeProjectId).workspace_id;
  } else if (!state.activeWorkspaceId && storedWorkspace && state.workspacesById.has(storedWorkspace)) {
    state.activeWorkspaceId = storedWorkspace;
  }
  _setStored(ACTIVE_PROJECT_KEY, state.activeProjectId);
  _setStored(ACTIVE_WORKSPACE_KEY, state.activeWorkspaceId);
}

async function refreshWorkspaceState({ quiet = false } = {}) {
  state.loading = true;
  state.error = '';
  if (!quiet) render();
  try {
    const data = await workspaceRequest('GET', '');
    const workspaces = Array.isArray(data?.workspaces) ? data.workspaces : [];
    const projectResponses = await Promise.all(workspaces.map(async workspace => {
      const response = await workspaceRequest('GET', `/${encodeURIComponent(workspace.id)}/project`);
      return [workspace.id, Array.isArray(response?.projects) ? response.projects : []];
    }));
    _normaliseData(workspaces, new Map(projectResponses));
  } catch (error) {
    state.error = error.message || 'Workspace service is unavailable.';
  } finally {
    state.loading = false;
    render();
  }
}

function mount() {
  const section = document.getElementById('projects-section');
  const tab = document.getElementById('workspace-tab');
  const selector = document.getElementById('project-selector-container');
  const modal = document.getElementById('workspace-main-content');
  const content = document.getElementById('workspace-manager-body');
  if (!section || !tab || !selector || !modal || !content) return false;

  // The workspace manager is a real tool window, not a sidebar expansion.
  // Use the same shared movement, resizing, and dock behavior as every other
  // floating tool instead of merely borrowing the modal CSS.
  const dialog = modal.querySelector('.workspace-manager-modal-content');
  const header = modal.querySelector('.modal-header');
  if (dialog && header && !modal.dataset.windowDragWired) {
    makeWindowDraggable(modal, {
      content: dialog,
      header,
      skipSelector: 'button, input, select, textarea, [contenteditable="true"]',
      minWidth: 460,
      minHeight: 360,
    });
    modal.dataset.windowDragWired = 'true';
  }

  const setWorkspaceOpen = open => {
    modal.classList.toggle('hidden', !open);
    tab.setAttribute('aria-expanded', String(open));
  };

  tab.addEventListener('click', () => {
    state.view = 'workspace';
    setWorkspaceOpen(modal.classList.contains('hidden'));
    render();
    if (!modal.classList.contains('hidden')) content.querySelector('button, [tabindex="0"]')?.focus({ preventScroll: true });
  });
  tab.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' && !modal.classList.contains('hidden')) {
      event.preventDefault();
      content.querySelector('button, [tabindex="0"]')?.focus();
    }
  });
  modal.querySelector('#workspace-manager-close')?.addEventListener('click', () => {
    setWorkspaceOpen(false);
    tab.focus();
  });
  modal.addEventListener('pointerdown', event => {
    if (event.target === modal && !document.querySelector('.workspace-modal')) setWorkspaceOpen(false);
  });

  document.addEventListener('keydown', event => {
    if (isEditableTarget(event.target)) return;
    if ((event.ctrlKey || event.altKey) && event.key.toLowerCase() === 'w') {
      event.preventDefault();
      state.view = 'workspace';
      setWorkspaceOpen(true);
      render();
      tab.focus();
      return;
    }
    if (event.key === 'Escape' && state.view === 'project' && !document.querySelector('.workspace-modal')) {
      state.view = 'workspace';
      render();
    } else if (event.key === 'Escape' && !modal.classList.contains('hidden') && !document.querySelector('.workspace-modal')) {
      setWorkspaceOpen(false);
      tab.focus();
    }
  });
  return true;
}

function render() {
  const tab = document.getElementById('workspace-tab');
  const selector = document.getElementById('project-selector-container');
  const modal = document.getElementById('workspace-main-content');
  const content = document.getElementById('workspace-manager-body');
  if (!tab || !selector || !modal || !content) return;
  const expanded = !modal.classList.contains('hidden');
  tab.classList.toggle('active', expanded);
  tab.setAttribute('aria-expanded', String(expanded));
  tab.querySelector('.workspace-tab-status').textContent = state.loading ? 'SYNCING' : (currentProject() ? 'ACTIVE' : 'UNSCOPED');
  renderSelector(selector);
  if (state.loading) {
    content.innerHTML = skeleton();
    return;
  }
  if (state.error) {
    content.innerHTML = errorState(state.error, 'Retry workspace sync');
    content.querySelector('[data-action="retry"]')?.addEventListener('click', () => refreshWorkspaceState());
    return;
  }
  if (state.view === 'project' && currentProject()) renderProject(content, currentProject());
  else renderWorkspace(content);
}

function skeleton() {
  return `<div class="workspace-loading" aria-live="polite"><span class="workspace-loading-label">Loading workspace state</span><span class="workspace-skeleton"></span><span class="workspace-skeleton"></span><span class="workspace-skeleton short"></span></div>`;
}

function errorState(message, action) {
  return `<div class="workspace-state workspace-error" role="alert"><strong>Workspace unavailable</strong><span>${esc(message)}</span><button type="button" class="workspace-secondary-btn" data-action="retry">${icon('refresh')}${esc(action)}</button></div>`;
}

function emptyState(title, message, action, actionName) {
  return `<div class="workspace-state"><strong>${esc(title)}</strong><span>${esc(message)}</span>${action ? `<button type="button" class="workspace-primary-btn" data-action="${esc(actionName)}">${icon('add')}${esc(action)}</button>` : ''}</div>`;
}

function renderSelector(container) {
  const project = currentProject();
  const workspace = currentWorkspace();
  const allProjects = state.workspaceIds.flatMap(id => projectsForWorkspace(id));
  container.innerHTML = `
    <div class="project-selector" data-open="false">
      <button type="button" class="project-selector-current" id="project-selector-toggle" aria-haspopup="listbox" aria-expanded="false" aria-label="Select project">
        ${icon('project')}
        <span class="project-selector-copy"><span class="project-sel-name">${project ? esc(project.name) : 'Unscoped chats'}</span><span class="project-selector-meta">${workspace ? esc(workspace.name) : 'All workspaces'}</span></span>
        <span class="project-selector-chevron">⌄</span>
      </button>
      <div class="project-selector-dropdown" id="project-selector-menu" role="listbox" aria-label="Projects" hidden>
        <button type="button" class="project-sel-item${project ? '' : ' active'}" role="option" aria-selected="${project ? 'false' : 'true'}" data-action="unscoped">${icon('chat')}<span>Unscoped chats</span></button>
        ${allProjects.length ? state.workspaceIds.map(workspaceId => {
          const ws = state.workspacesById.get(workspaceId);
          const projects = projectsForWorkspace(workspaceId);
          if (!projects.length) return '';
          return `<div class="project-selector-group"><span>${esc(ws.name)}</span>${projects.map(item => `<button type="button" class="project-sel-item${item.id === state.activeProjectId ? ' active' : ''}" role="option" aria-selected="${item.id === state.activeProjectId}" data-project-id="${esc(item.id)}">${icon('project')}<span>${esc(item.name)}</span></button>`).join('')}</div>`;
        }).join('') : '<div class="project-selector-empty">No projects available</div>'}
        <div class="project-sel-divider"></div>
        <button type="button" class="project-sel-item project-sel-manage" data-action="manage">${icon('workspace')}<span>Manage workspaces</span></button>
      </div>
    </div>`;

  const toggle = container.querySelector('#project-selector-toggle');
  const menu = container.querySelector('#project-selector-menu');
  let closeTimer = null;
  const close = () => {
    if (!menu) return;
    menu.hidden = true;
    toggle?.setAttribute('aria-expanded', 'false');
  };
  const open = () => {
    if (!menu) return;
    menu.hidden = false;
    toggle?.setAttribute('aria-expanded', 'true');
    menu.querySelector('.project-sel-item.active, .project-sel-item')?.focus();
  };
  toggle?.addEventListener('click', () => menu.hidden ? open() : close());
  toggle?.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
  });
  menu?.addEventListener('keydown', event => {
    const items = [...menu.querySelectorAll('button.project-sel-item')];
    const index = items.indexOf(document.activeElement);
    if (event.key === 'ArrowDown') { event.preventDefault(); items[(index + 1 + items.length) % items.length]?.focus(); }
    if (event.key === 'ArrowUp') { event.preventDefault(); items[(index - 1 + items.length) % items.length]?.focus(); }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); toggle?.focus(); }
  });
  menu?.querySelector('[data-action="unscoped"]')?.addEventListener('click', () => {
    _setActiveProject(null);
    state.view = 'workspace';
    close();
    render();
  });
  menu?.querySelectorAll('[data-project-id]').forEach(button => button.addEventListener('click', () => {
    _setActiveProject(button.dataset.projectId, { openProject: false });
    close();
    render();
  }));
  menu?.querySelector('[data-action="manage"]')?.addEventListener('click', () => {
    state.view = 'workspace';
    const modal = document.getElementById('workspace-main-content');
    modal?.classList.remove('hidden');
    document.getElementById('workspace-tab')?.setAttribute('aria-expanded', 'true');
    close();
    render();
  });
  document.addEventListener('pointerdown', event => {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      if (!container.contains(event.target)) close();
    });
  }, { once: true });
}

function renderWorkspace(container) {
  const selectedWorkspace = currentWorkspace();
  const editorProject = currentProject()?.path ? currentProject() : null;
  const workspaceCards = state.workspaceIds.map(workspaceId => renderWorkspaceCard(state.workspacesById.get(workspaceId))).join('');
  container.innerHTML = `
    <div class="workspace-view" data-view="workspace">
      <div class="workspace-view-header">
        <div><span class="workspace-eyebrow">WORKSPACE CONTROL</span><h2>${selectedWorkspace ? esc(selectedWorkspace.name) : 'All workspaces'}</h2><p>${selectedWorkspace ? esc(selectedWorkspace.description || 'Projects, files, chats, notes, and tasks.') : 'Choose a workspace or create one to organize project-scoped work.'}</p></div>
        <div class="workspace-header-actions"><button type="button" class="workspace-icon-btn" data-action="refresh" title="Refresh workspace data">${icon('refresh')}</button>${editorProject ? `<button type="button" class="workspace-secondary-btn" data-action="open-active-editor">${icon('editor')}Open editor</button>` : ''}<button type="button" class="workspace-primary-btn" data-action="new-workspace">${icon('add')}New workspace</button></div>
      </div>
      ${state.workspaceIds.length ? `<div class="workspace-card-list">${workspaceCards}</div>` : emptyState('No workspaces yet', 'Create a workspace before adding projects.', 'Create workspace', 'new-workspace')}
    </div>`;
  container.querySelectorAll('[data-action="refresh"]').forEach(button => button.addEventListener('click', () => refreshWorkspaceState()));
  container.querySelectorAll('[data-action="open-active-editor"]').forEach(button => button.addEventListener('click', () => {
    if (!editorProject) return;
    document.dispatchEvent(new CustomEvent('open-editor', { detail: { projectId: editorProject.id, workspaceId: editorProject.workspace_id, path: editorProject.path, project: editorProject } }));
  }));
  container.querySelectorAll('[data-action="new-workspace"]').forEach(button => button.addEventListener('click', () => openWorkspaceModal()));
  container.querySelectorAll('[data-action="new-project"]').forEach(button => button.addEventListener('click', () => openProjectModal(button.dataset.workspaceId)));
  container.querySelectorAll('[data-action="edit-workspace"]').forEach(button => button.addEventListener('click', () => openWorkspaceModal(state.workspacesById.get(button.dataset.workspaceId))));
  container.querySelectorAll('[data-action="delete-workspace"]').forEach(button => button.addEventListener('click', () => deleteWorkspace(button.dataset.workspaceId)));
  container.querySelectorAll('[data-action="select-workspace"]').forEach(button => button.addEventListener('click', () => {
    const workspaceId = button.dataset.workspaceId;
    _setActiveWorkspace(workspaceId, { clearProject: currentProject()?.workspace_id !== workspaceId });
    state.view = 'workspace';
    render();
  }));
  container.querySelectorAll('[data-project-id]').forEach(button => button.addEventListener('click', () => {
    _setActiveProject(button.dataset.projectId, { openProject: true });
    render();
  }));
}

function renderWorkspaceCard(workspace) {
  if (!workspace) return '';
  const projects = projectsForWorkspace(workspace.id);
  return `<article class="workspace-card${workspace.id === state.activeWorkspaceId ? ' selected' : ''}">
    <header class="workspace-card-header"><button type="button" class="workspace-card-title" data-action="select-workspace" data-workspace-id="${esc(workspace.id)}">${icon('workspace')}<span>${esc(workspace.name)}</span><small>${projects.length} project${projects.length === 1 ? '' : 's'}</small></button><div class="workspace-card-actions"><button type="button" class="workspace-icon-btn" data-action="edit-workspace" data-workspace-id="${esc(workspace.id)}" aria-label="Edit ${esc(workspace.name)}">${icon('more')}</button></div></header>
    ${workspace.description ? `<p class="workspace-card-description">${esc(workspace.description)}</p>` : ''}
    <div class="workspace-project-list" role="listbox" aria-label="Projects in ${esc(workspace.name)}">
      ${projects.length ? projects.map(project => `<button type="button" class="workspace-project-row${project.id === state.activeProjectId ? ' active' : ''}" role="option" aria-selected="${project.id === state.activeProjectId}" data-project-id="${esc(project.id)}">${icon('project')}<span class="workspace-project-copy"><strong>${esc(project.name)}</strong><small>${project.path ? esc(project.path) : 'No path bound'} · ${Number(project.chat_count || 0)} chats</small></span><span class="workspace-project-open">›</span></button>`).join('') : '<div class="workspace-empty-sm">No projects in this workspace.</div>'}
    </div>
    <footer class="workspace-card-footer"><button type="button" class="workspace-secondary-btn" data-action="new-project" data-workspace-id="${esc(workspace.id)}">${icon('add')}New project</button><button type="button" class="workspace-link-btn" data-action="delete-workspace" data-workspace-id="${esc(workspace.id)}">Delete workspace</button></footer>
  </article>`;
}

function renderProject(container, project) {
  const workspace = state.workspacesById.get(project.workspace_id);
  container.innerHTML = `
    <div class="project-detail" data-project-id="${esc(project.id)}">
      <header class="project-detail-header"><button type="button" class="workspace-back-btn" data-action="back">${icon('back')}Workspaces</button><div class="project-detail-title"><span class="workspace-eyebrow">${esc(workspace?.name || 'Workspace')}</span><h2>${esc(project.name)}</h2><p>${esc(project.description || (project.path ? project.path : 'No path bound'))}</p></div><div class="project-detail-actions"><button type="button" class="workspace-icon-btn" data-action="project-refresh" title="Refresh project">${icon('refresh')}</button>${project.path ? `<button type="button" class="workspace-primary-btn" data-action="open-editor">${icon('editor')}Open editor</button>` : ''}</div></header>
      <div class="project-detail-tabs" role="tablist" aria-label="${esc(project.name)} views">${['overview', 'chats', 'notes', 'tasks', 'settings'].map(tab => `<button type="button" class="project-tab${tab === state.activeTab ? ' active' : ''}" data-tab="${tab}" role="tab" aria-selected="${tab === state.activeTab}">${tab[0].toUpperCase() + tab.slice(1)}</button>`).join('')}</div>
      <div class="project-detail-body" id="project-detail-body" role="tabpanel" aria-live="polite">${skeleton()}</div>
    </div>`;
  container.querySelector('[data-action="back"]')?.addEventListener('click', () => { state.view = 'workspace'; render(); });
  container.querySelector('[data-action="project-refresh"]')?.addEventListener('click', () => loadProjectTab(project));
  container.querySelector('[data-action="open-editor"]')?.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('open-editor', { detail: { projectId: project.id, workspaceId: project.workspace_id, path: project.path, project } }));
  });
  container.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => {
    state.activeTab = button.dataset.tab;
    renderProject(container, project);
  }));
  loadProjectTab(project);
}

async function fetchProjectSnapshot(project) {
  const encodedWorkspace = encodeURIComponent(project.workspace_id);
  const encodedProject = encodeURIComponent(project.id);
  const calls = [
    workspaceRequest('GET', `/${encodedWorkspace}/project/${encodedProject}`),
    workspaceRequest('GET', `/${encodedWorkspace}/project/${encodedProject}/chats`),
    coreRequest('GET', `/notes?project_id=${encodedProject}`),
    coreRequest('GET', `/tasks?project_id=${encodedProject}`),
  ];
  if (project.path) calls.push(workspaceRequest('POST', `/${encodedWorkspace}/project/${encodedProject}/files/list`, { path: '' }));
  // These are all part of one scoped dashboard.  Do not turn permission or
  // backend failures into a misleading empty project view.
  const results = await Promise.all(calls);
  return {
    detail: results[0],
    chats: results[1]?.chats || [],
    notes: results[2]?.notes || [],
    tasks: results[3]?.tasks || [],
    files: results[4]?.entries || [],
  };
}

async function loadProjectTab(project) {
  const body = document.getElementById('project-detail-body');
  if (!body || project.id !== state.activeProjectId) return;
  const token = ++state.renderToken;
  body.innerHTML = skeleton();
  try {
    const snapshot = await fetchProjectSnapshot(project);
    if (token !== state.renderToken || project.id !== state.activeProjectId) return;
    if (snapshot.detail) {
      const updated = { ...project, ...snapshot.detail };
      state.projectsById.set(project.id, updated);
      project = updated;
    }
    if (state.activeTab === 'overview') renderOverview(body, project, snapshot);
    if (state.activeTab === 'chats') renderChats(body, project, snapshot.chats);
    if (state.activeTab === 'notes') renderNotes(body, project, snapshot.notes);
    if (state.activeTab === 'tasks') renderTasks(body, project, snapshot.tasks);
    if (state.activeTab === 'settings') renderSettings(body, project);
  } catch (error) {
    if (token !== state.renderToken) return;
    body.innerHTML = errorState(error.message || 'Unable to load project data.', 'Retry project');
    body.querySelector('[data-action="retry"]')?.addEventListener('click', () => loadProjectTab(project));
  }
}

function renderOverview(body, project, snapshot) {
  const recentChats = snapshot.chats.slice(0, 5);
  const recentTasks = snapshot.tasks.slice(0, 5);
  const recentFiles = snapshot.files.slice(0, 5);
  body.innerHTML = `<div class="project-overview-grid"><div class="project-stat-card"><strong>${snapshot.chats.length}</strong><span>Chats</span></div><div class="project-stat-card"><strong>${project.file_count ?? (project.path ? snapshot.files.length : '—')}</strong><span>Files</span></div><div class="project-stat-card"><strong>${project.dir_count ?? '—'}</strong><span>Directories</span></div></div>
    <div class="project-quick-actions"><button type="button" class="workspace-primary-btn" data-action="new-chat">${icon('chat')}New chat</button><button type="button" class="workspace-secondary-btn" data-action="new-note">${icon('note')}New note</button><button type="button" class="workspace-secondary-btn" data-action="new-task">${icon('task')}New task</button></div>
    <div class="project-dashboard-grid"><section><h3>Recent chats</h3>${recentChats.length ? recentChats.map(chatRow).join('') : compactEmpty('No chats yet', 'Start a new project chat.')}</section><section><h3>Recent files</h3>${recentFiles.length ? recentFiles.map(file => `<button type="button" class="project-data-row" data-file-path="${esc(file.path)}">${icon('folder')}<span>${esc(file.path)}</span><small>${formatDate(file.modified_at)}</small></button>`).join('') : compactEmpty(project.path ? 'No visible files' : 'No path bound', project.path ? 'Refresh after adding files.' : 'Bind a project path in Settings.')}</section><section><h3>Recent tasks</h3>${recentTasks.length ? recentTasks.map(taskRow).join('') : compactEmpty('No tasks yet', 'Create a scoped scheduled task.')}</section></div>`;
  body.querySelector('[data-action="new-chat"]')?.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('start-chat', { detail: { projectId: project.id, workspaceId: project.workspace_id } }));
  });
  body.querySelector('[data-action="new-note"]')?.addEventListener('click', () => createNote(project));
  body.querySelector('[data-action="new-task"]')?.addEventListener('click', () => openTaskModal(project));
  body.querySelectorAll('[data-session-id]').forEach(row => row.addEventListener('click', () => document.dispatchEvent(new CustomEvent('select-chat', { detail: { sessionId: row.dataset.sessionId } }))));
  body.querySelectorAll('[data-file-path]').forEach(row => row.addEventListener('click', () => document.dispatchEvent(new CustomEvent('open-editor', { detail: { projectId: project.id, workspaceId: project.workspace_id, path: project.path, filePath: row.dataset.filePath, project } }))));
}

function chatRow(chat) {
  return `<button type="button" class="project-data-row" data-session-id="${esc(chat.id)}">${icon('chat')}<span>${esc(chat.name || 'Untitled chat')}</span><small>${esc(chat.model || 'model')} · ${formatDate(chat.last_accessed || chat.updated_at || chat.created_at)}</small></button>`;
}

function taskRow(task) {
  return `<button type="button" class="project-data-row" data-task-id="${esc(task.id)}">${icon('task')}<span>${esc(task.name || 'Untitled task')}</span><small>${esc(task.status || 'active')} · ${formatDate(task.next_run || task.updated_at)}</small></button>`;
}

function compactEmpty(title, detail) {
  return `<div class="project-empty-inline"><strong>${esc(title)}</strong><span>${esc(detail)}</span></div>`;
}

function renderChats(body, project, chats) {
  body.innerHTML = `<div class="project-tab-toolbar"><span>${chats.length} project chat${chats.length === 1 ? '' : 's'}</span><button type="button" class="workspace-primary-btn" data-action="new-chat">${icon('add')}New chat</button></div>${chats.length ? `<div class="project-data-list">${chats.map(chatRow).join('')}</div>` : emptyState('No chats in this project', 'New chats created while this project is active stay here.', 'New chat', 'new-chat')}`;
  body.querySelectorAll('[data-action="new-chat"]').forEach(button => button.addEventListener('click', () => document.dispatchEvent(new CustomEvent('start-chat', { detail: { projectId: project.id, workspaceId: project.workspace_id } }))));
  body.querySelectorAll('[data-session-id]').forEach(row => row.addEventListener('click', () => document.dispatchEvent(new CustomEvent('select-chat', { detail: { sessionId: row.dataset.sessionId } }))));
}

function renderNotes(body, project, notes) {
  body.innerHTML = `<div class="project-tab-toolbar"><span>${notes.length} project note${notes.length === 1 ? '' : 's'}</span><button type="button" class="workspace-primary-btn" data-action="new-note">${icon('add')}New note</button></div>${notes.length ? `<div class="project-data-list">${notes.map(note => `<button type="button" class="project-data-row project-note-row" data-note-id="${esc(note.id)}">${icon('note')}<span>${esc(note.title || 'Untitled note')}<em>${esc((note.content || '').replace(/\s+/g, ' ').slice(0, 96))}</em></span><small>${formatDate(note.updated_at || note.created_at)}</small></button>`).join('')}</div>` : emptyState('No notes in this project', 'Create a note here to associate it with this project.', 'New note', 'new-note')}`;
  body.querySelectorAll('[data-action="new-note"]').forEach(button => button.addEventListener('click', () => createNote(project)));
  body.querySelectorAll('[data-note-id]').forEach(row => row.addEventListener('click', () => openNoteModal(project, notes.find(note => note.id === row.dataset.noteId))));
}

function renderTasks(body, project, tasks) {
  body.innerHTML = `<div class="project-tab-toolbar"><span>${tasks.length} project task${tasks.length === 1 ? '' : 's'}</span><button type="button" class="workspace-primary-btn" data-action="new-task">${icon('add')}New task</button></div>${tasks.length ? `<div class="project-data-list">${tasks.map(taskRow).join('')}</div>` : emptyState('No tasks in this project', 'Create a scoped scheduled task to keep automation with this project.', 'New task', 'new-task')}`;
  body.querySelectorAll('[data-action="new-task"]').forEach(button => button.addEventListener('click', () => openTaskModal(project)));
  body.querySelectorAll('[data-task-id]').forEach(row => row.addEventListener('click', () => openTaskModal(project, tasks.find(task => task.id === row.dataset.taskId))));
}

function renderSettings(body, project) {
  body.innerHTML = `<form class="project-settings-form" id="project-settings-form"><div class="workspace-form-grid"><label>Project name<input name="name" required value="${esc(project.name)}"></label><label>Description<textarea name="description" rows="3">${esc(project.description || '')}</textarea></label><label class="workspace-path-field">Project directory<input name="path" value="${esc(project.path || '')}" autocomplete="off" spellcheck="false" placeholder="/absolute/path/to/project"><span>Enter an existing absolute directory on this server.</span></label></div><div class="workspace-form-actions"><span class="workspace-form-spacer"></span><button type="button" class="workspace-link-btn workspace-danger-link" data-action="delete-project">Delete project</button><button type="submit" class="workspace-primary-btn">Save settings</button></div></form>`;
  const form = body.querySelector('#project-settings-form');
  form?.addEventListener('submit', async event => {
    event.preventDefault();
    const values = new FormData(form);
    const name = String(values.get('name') || '').trim();
    if (!name) return setFormError(form, 'A project name is required.');
    try {
      const nextPath = String(values.get('path') || '').trim();
      const payload = { name, description: String(values.get('description') || '').trim() };
      // Omitting an unchanged path keeps ordinary metadata edits available to
      // non-admin collaborators; the API remains the authority for any bind.
      if (nextPath !== (project.path || '')) payload.path = nextPath || null;
      await workspaceRequest('PUT', `/${encodeURIComponent(project.workspace_id)}/project/${encodeURIComponent(project.id)}`, payload);
      uiModule.showToast?.('Project settings saved');
      await refreshWorkspaceState({ quiet: true });
      state.view = 'project';
      render();
    } catch (error) { setFormError(form, error.message); }
  });
  body.querySelector('[data-action="delete-project"]')?.addEventListener('click', () => deleteProject(project));
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function openModal({ title, body, onMount, wide = false }) {
  const modal = document.createElement('div');
  modal.className = 'modal workspace-modal';
  modal.dataset.workspaceModal = 'true';
  modal.innerHTML = `<div class="modal-content workspace-modal-content${wide ? ' workspace-modal-wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="workspace-modal-title"><div class="modal-header"><h4 id="workspace-modal-title">${esc(title)}</h4><button type="button" class="close-btn" aria-label="Close ${esc(title)}">✕</button></div><div class="modal-body workspace-modal-body">${body}</div></div>`;
  const close = () => modal.remove();
  modal.querySelector('.close-btn').addEventListener('click', close);
  modal.addEventListener('click', event => { if (event.target === modal) close(); });
  modal.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  });
  document.body.appendChild(modal);
  // Child forms use the shared modal frame.  Keep their functional setup
  // independent of optional drag/dock behavior; the persistent Workspace
  // manager above is the movable tool window.
  onMount?.(modal, close);
  queueMicrotask(() => modal.querySelector('input, textarea, select, button')?.focus());
  return { modal, close };
}

function setFormError(form, message) {
  let error = form.querySelector('.workspace-form-error');
  if (!error) { error = document.createElement('p'); error.className = 'workspace-form-error'; form.prepend(error); }
  error.textContent = message || 'Unable to save changes.';
}

function openWorkspaceModal(workspace = null) {
  const isEdit = !!(workspace && typeof workspace === 'object' && !(workspace instanceof Event));
  const { modal, close } = openModal({
    title: isEdit ? 'Edit workspace' : 'New workspace',
    body: `<form class="workspace-form"><label>Workspace name<input name="name" required maxlength="120" value="${esc(workspace?.name || '')}" autocomplete="off"></label><label>Description<textarea name="description" rows="3" maxlength="500">${esc(workspace?.description || '')}</textarea></label><div class="workspace-form-actions"><button type="button" class="workspace-secondary-btn" data-action="cancel">Cancel</button><button type="submit" class="workspace-primary-btn">${isEdit ? 'Save workspace' : 'Create workspace'}</button></div></form>`,
  });
  const form = modal.querySelector('form');
  modal.querySelector('[data-action="cancel"]')?.addEventListener('click', close);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const values = new FormData(form);
    const name = String(values.get('name') || '').trim();
    if (!name) return setFormError(form, 'A workspace name is required.');
    try {
      const payload = { name, description: String(values.get('description') || '').trim() };
      const saved = isEdit
        ? await workspaceRequest('PUT', `/${encodeURIComponent(workspace.id)}`, payload)
        : await workspaceRequest('POST', '', payload);
      state.activeWorkspaceId = saved.id;
      _setStored(ACTIVE_WORKSPACE_KEY, saved.id);
      close();
      await refreshWorkspaceState({ quiet: true });
      state.view = 'workspace';
      render();
      uiModule.showToast?.(isEdit ? 'Workspace updated' : 'Workspace created');
    } catch (error) { setFormError(form, error.message); }
  });
}

function openProjectModal(workspaceId, existingProject = null, selectedPath = '') {
  const workspace = state.workspacesById.get(workspaceId || state.activeWorkspaceId);
  if (!workspace && !existingProject) {
    uiModule.showError?.('Select or create a workspace before creating a project.');
    return;
  }
  const project = existingProject || null;
  const targetWorkspaceId = project?.workspace_id || workspace?.id;
  const { modal, close } = openModal({
    title: project ? 'Edit project' : 'New project',
    body: `<form class="workspace-form"><label>Workspace<select name="workspace_id" ${project ? 'disabled' : ''}>${state.workspaceIds.map(id => `<option value="${esc(id)}" ${id === targetWorkspaceId ? 'selected' : ''}>${esc(state.workspacesById.get(id)?.name || '')}</option>`).join('')}</select></label><label>Project name<input name="name" required maxlength="120" value="${esc(project?.name || '')}" autocomplete="off"></label><label>Description<textarea name="description" rows="3" maxlength="500">${esc(project?.description || '')}</textarea></label><label class="workspace-path-field">Project directory<input name="path" value="${esc(selectedPath || project?.path || '')}" autocomplete="off" spellcheck="false" placeholder="/absolute/path/to/project"><span>Enter an existing absolute directory on this server.</span></label><div class="workspace-form-actions"><span class="workspace-form-spacer"></span><button type="button" class="workspace-secondary-btn" data-action="cancel">Cancel</button><button type="submit" class="workspace-primary-btn">${project ? 'Save project' : 'Create project'}</button></div></form>`,
  });
  const form = modal.querySelector('form');
  modal.querySelector('[data-action="cancel"]')?.addEventListener('click', close);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const values = new FormData(form);
    const name = String(values.get('name') || '').trim();
    const selectedWorkspace = project?.workspace_id || String(values.get('workspace_id') || '');
    if (!name) return setFormError(form, 'A project name is required.');
    if (!selectedWorkspace || !state.workspacesById.has(selectedWorkspace)) return setFormError(form, 'Choose a valid workspace.');
    try {
      const payload = { name, description: String(values.get('description') || '').trim(), path: String(values.get('path') || '').trim() || null, workspace_id: selectedWorkspace };
      const saved = project
        ? await workspaceRequest('PUT', `/${encodeURIComponent(project.workspace_id)}/project/${encodeURIComponent(project.id)}`, payload)
        : await workspaceRequest('POST', `/${encodeURIComponent(selectedWorkspace)}/project`, payload);
      close();
      await refreshWorkspaceState({ quiet: true });
      _setActiveProject(saved.id, { openProject: true });
      render();
      uiModule.showToast?.(project ? 'Project updated' : 'Project created');
    } catch (error) { setFormError(form, error.message); }
  });
}

async function deleteWorkspace(workspaceId) {
  const workspace = state.workspacesById.get(workspaceId);
  if (!workspace) return;
  const confirmed = await uiModule.styledConfirm?.(`Delete workspace “${workspace.name}”? Its projects are removed; scoped chats, notes, and tasks return to Unscoped.`, { confirmText: 'Delete workspace', danger: true });
  if (!confirmed) return;
  try {
    await workspaceRequest('DELETE', `/${encodeURIComponent(workspace.id)}`);
    if (state.activeWorkspaceId === workspace.id) _setActiveProject(null);
    await refreshWorkspaceState({ quiet: true });
    state.view = 'workspace';
    render();
    uiModule.showToast?.('Workspace deleted');
  } catch (error) { uiModule.showError?.(`Could not delete workspace: ${error.message}`); }
}

async function deleteProject(project) {
  const confirmed = await uiModule.styledConfirm?.(`Delete project “${project.name}”? Its chats, notes, and tasks are preserved as Unscoped.`, { confirmText: 'Delete project', danger: true });
  if (!confirmed) return;
  try {
    await workspaceRequest('DELETE', `/${encodeURIComponent(project.workspace_id)}/project/${encodeURIComponent(project.id)}`);
    if (state.activeProjectId === project.id) _setActiveProject(null);
    await refreshWorkspaceState({ quiet: true });
    state.view = 'workspace';
    render();
    uiModule.showToast?.('Project deleted');
  } catch (error) { uiModule.showError?.(`Could not delete project: ${error.message}`); }
}

async function createNote(project) {
  try {
    const note = await coreRequest('POST', '/notes', { title: 'Untitled note', content: '', project_id: project.id });
    document.dispatchEvent(new CustomEvent('project-content-changed', { detail: { projectId: project.id, type: 'note', noteId: note.id } }));
    openNoteModal(project, note);
  } catch (error) { uiModule.showError?.(`Could not create note: ${error.message}`); }
}

function openNoteModal(project, note) {
  if (!note) return;
  const { modal, close } = openModal({
    title: 'Project note',
    wide: true,
    body: `<form class="workspace-form"><label>Title<input name="title" required value="${esc(note.title || '')}"></label><label>Content<textarea name="content" rows="10" placeholder="Write a project note…">${esc(note.content || '')}</textarea></label><div class="workspace-form-actions"><button type="button" class="workspace-secondary-btn" data-action="cancel">Cancel</button><button type="submit" class="workspace-primary-btn">Save note</button></div></form>`,
  });
  const form = modal.querySelector('form');
  modal.querySelector('[data-action="cancel"]')?.addEventListener('click', close);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const values = new FormData(form);
    const title = String(values.get('title') || '').trim();
    if (!title) return setFormError(form, 'A note title is required.');
    try {
      await coreRequest('PUT', `/notes/${encodeURIComponent(note.id)}`, { title, content: String(values.get('content') || ''), project_id: project.id });
      close();
      document.dispatchEvent(new CustomEvent('project-content-changed', { detail: { projectId: project.id, type: 'note', noteId: note.id } }));
      if (currentProject()?.id === project.id) loadProjectTab(project);
      uiModule.showToast?.('Project note saved');
    } catch (error) { setFormError(form, error.message); }
  });
}

function openTaskModal(project, task = null) {
  const isEdit = !!task;
  const { modal, close } = openModal({
    title: isEdit ? 'Project task' : 'New project task',
    wide: true,
    body: `<form class="workspace-form"><label>Task name<input name="name" required value="${esc(task?.name || '')}" placeholder="Review release notes"></label><label>Prompt<textarea name="prompt" required rows="6" placeholder="What should this scheduled task do?">${esc(task?.prompt || '')}</textarea></label><div class="workspace-form-grid compact"><label>Schedule<select name="schedule"><option value="daily" ${(task?.schedule || 'daily') === 'daily' ? 'selected' : ''}>Daily</option><option value="weekly" ${task?.schedule === 'weekly' ? 'selected' : ''}>Weekly</option><option value="monthly" ${task?.schedule === 'monthly' ? 'selected' : ''}>Monthly</option></select></label><label>Time<input name="scheduled_time" type="time" value="${esc(task?.scheduled_time || '09:00')}"></label></div><div class="workspace-form-actions"><button type="button" class="workspace-secondary-btn" data-action="cancel">Cancel</button><button type="submit" class="workspace-primary-btn">${isEdit ? 'Save task' : 'Create task'}</button></div></form>`,
  });
  const form = modal.querySelector('form');
  modal.querySelector('[data-action="cancel"]')?.addEventListener('click', close);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const values = new FormData(form);
    const name = String(values.get('name') || '').trim();
    const prompt = String(values.get('prompt') || '').trim();
    if (!name || !prompt) return setFormError(form, 'Name and prompt are required.');
    const payload = { name, prompt, task_type: 'llm', trigger_type: 'schedule', schedule: String(values.get('schedule') || 'daily'), scheduled_time: String(values.get('scheduled_time') || '09:00'), project_id: project.id };
    try {
      if (task) await coreRequest('PUT', `/tasks/${encodeURIComponent(task.id)}`, payload);
      else await coreRequest('POST', '/tasks', payload);
      close();
      document.dispatchEvent(new CustomEvent('project-content-changed', { detail: { projectId: project.id, type: 'task', taskId: task?.id || null } }));
      if (currentProject()?.id === project.id) loadProjectTab(project);
      uiModule.showToast?.(task ? 'Project task saved' : 'Project task created');
    } catch (error) { setFormError(form, error.message); }
  });
}

export async function initProjectManager() {
  if (state.initPromise) return state.initPromise;
  state.initPromise = (async () => {
    if (!mount()) return;
    state.initialized = true;
    state.activeWorkspaceId = Storage.get(ACTIVE_WORKSPACE_KEY, null);
    state.activeProjectId = Storage.get(ACTIVE_PROJECT_KEY, null);
    await refreshWorkspaceState();
  })();
  return state.initPromise;
}

export function getActiveProjectId() { return state.activeProjectId; }
export function getActiveWorkspaceId() { return state.activeWorkspaceId; }
export function refreshProjectManager() { return refreshWorkspaceState(); }

export default { initProjectManager, getActiveProjectId, getActiveWorkspaceId, refreshProjectManager };
