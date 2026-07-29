// Preview tools — Markdown, Typst, Web view panels.
import uiModule from '../ui.js';

let _previewMode = null; // 'md' | 'typst' | 'web'
let _currentFile = null;

function _getPreviewContainer() {
  let el = document.getElementById('editor-preview-panel');
  if (!el) {
    el = document.createElement('div');
    el.id = 'editor-preview-panel';
    el.className = 'editor-preview-panel';
    el.innerHTML = `
      <div class="preview-toolbar">
        <span class="preview-title" id="preview-title">Preview</span>
        <div class="preview-actions">
          <button class="preview-action-btn" id="preview-reload" title="Reload">↻</button>
          <button class="preview-action-btn" id="preview-open-browser" title="Open in browser">↗</button>
          <button class="preview-action-btn" id="preview-close" title="Close preview">✕</button>
        </div>
      </div>
      <div class="preview-content" id="preview-content"></div>
    `;
    document.body.appendChild(el);
    el.querySelector('#preview-reload').addEventListener('click', () => refresh());
    el.querySelector('#preview-open-browser').addEventListener('click', () => {
      const iframe = el.querySelector('iframe');
      if (iframe && iframe.src) window.open(iframe.src, '_blank');
    });
    el.querySelector('#preview-close').addEventListener('click', () => { el.style.display = 'none'; });
  }
  return el;
}

function _simpleMarkdown(text) {
  let html = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/^\- (.+)$/gm, '<li>$1</li>')
    .replace(/(```\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>');
  return '<p>' + html + '</p>';
}

export async function showPreview(filePath, content, projectId) {
  _currentFile = filePath;
  const ext = filePath.split('.').pop().toLowerCase();
  const el = _getPreviewContainer();
  const contentEl = el.querySelector('#preview-content');
  const titleEl = el.querySelector('#preview-title');

  if (ext === 'md') {
    _previewMode = 'md';
    titleEl.textContent = `Preview: ${filePath}`;
    contentEl.innerHTML = _simpleMarkdown(content);
    el.style.display = 'flex';
  } else if (ext === 'typ') {
    _previewMode = 'typst';
    titleEl.textContent = `Preview: ${filePath}`;
    contentEl.innerHTML = '<div class="preview-loading">Rendering Typst...</div>';
    el.style.display = 'flex';
    try {
      const res = await fetch(`/api/workspace/${projectId}/files/read`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath }),
      });
      const data = await res.json();
      contentEl.innerHTML = `<pre class="preview-typst-fallback">${uiModule.esc(data.content || '')}</pre>`;
    } catch (e) {
      contentEl.innerHTML = `<div class="preview-error">Typst preview unavailable: ${e.message}</div>`;
    }
  } else {
    el.style.display = 'none';
  }
}

export function showWebView(url) {
  const el = _getPreviewContainer();
  _previewMode = 'web';
  el.querySelector('#preview-title').textContent = `Web View: ${url}`;
  el.querySelector('#preview-content').innerHTML = `<iframe src="${uiModule.esc(url)}" class="preview-iframe" sandbox="allow-scripts allow-same-origin"></iframe>`;
  el.style.display = 'flex';
}

export async function refresh() {
  if (_previewMode === 'md' && _currentFile) {
    const textarea = document.getElementById('code-editor-textarea');
    if (textarea) showPreview(_currentFile, textarea.value);
  } else if (_previewMode === 'web') {
    const iframe = document.querySelector('.preview-iframe');
    if (iframe) iframe.src = iframe.src;
  }
}

export default { showPreview, showWebView, refresh };
