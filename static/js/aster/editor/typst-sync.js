const SESSION_API = '/api/workspace/typst/session';
const CONTROL_COMMAND_API = '/api/workspace/typst/sync/command';
const CONTROL_EVENTS_API = '/api/workspace/typst/sync/events';
const CURSOR_DEBOUNCE_MS = 120;
const CONTENT_DEBOUNCE_MS = 180;
const SUPPRESS_MS = 150;
const SESSION_START_TIMEOUT_MS = 30000;
const INBOUND_COLUMN_BASE = 0;

export async function createTypstSync({ projectId, path, mode = 'document' }, handlers = {}) {
  const { onStatus = () => {}, onJump = () => {}, onFatal = () => {}, getBuffer = () => null } = handlers;
  const controller = new AbortController();
  const startTimer = setTimeout(() => controller.abort(), SESSION_START_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(SESSION_API, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: projectId, path, mode }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('Timed out starting sync preview');
    throw err;
  } finally { clearTimeout(startTimer); }
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try { detail = (await response.json()).detail || detail; } catch (_) {}
    throw new Error(typeof detail === 'string' ? detail : 'Preview sync unavailable');
  }
  const session = await response.json();
  let _closed = false, _fatalReported = false, _suppress = false, _suppressTimer = null;
  let _cursorTimer = null, _contentTimer = null, _ignoredJumpCursor = null;
  let _pendingCursor = null, _currentCursor = null, _bufferPending = true, _forceBuffer = true, _lastSentBuffer = null;

  function _reportFatal(m) { if (!_closed && !_fatalReported) { _fatalReported = true; onFatal(m); } }
  function _sendNow(payload) {
    if (_closed) return false;
    fetch(CONTROL_COMMAND_API, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: session.token, payload }),
    }).then(r => { if (!r.ok && !_closed) _reportFatal('Preview session changed before sync connected'); })
      .catch(() => { if (!_closed) _reportFatal('Preview control channel unavailable'); });
    return true;
  }
  function _flushOutbound() {
    if (_closed || _suppress) return;
    if (_bufferPending) {
      const buf = getBuffer();
      if (buf && buf.path && typeof buf.content === 'string') {
        const unchanged = !!(_lastSentBuffer && _lastSentBuffer.path === buf.path && _lastSentBuffer.content === buf.content);
        if ((_forceBuffer || !unchanged) && _sendNow({ event: 'updateMemoryFiles', files: { [buf.path]: buf.content } })) {
          _lastSentBuffer = { path: buf.path, content: buf.content };
          _bufferPending = false; _forceBuffer = false;
        } else if (!_forceBuffer && unchanged) { _bufferPending = false; }
      }
    }
    if (_pendingCursor && _sendNow({ event: 'panelScrollTo', filepath: _pendingCursor.path, line: _pendingCursor.line, character: _pendingCursor.character })) {
      _pendingCursor = null;
    }
  }
  function _holdOutbound() {
    _suppress = true;
    if (_cursorTimer) clearTimeout(_cursorTimer); _cursorTimer = null;
    _pendingCursor = null; _currentCursor = null;
    if (_suppressTimer) clearTimeout(_suppressTimer);
    _suppressTimer = setTimeout(() => { _suppress = false; _suppressTimer = null; _flushOutbound(); }, SUPPRESS_MS);
  }
  function _queueBuffer(force = false) { _bufferPending = true; _forceBuffer = _forceBuffer || force; _flushOutbound(); }
  function syncCursor(relPath, lineNumber, column) {
    if (_closed || _suppress || !relPath) return;
    const next = { path: relPath, line: Math.max(0, (lineNumber | 0) - 1), character: Math.max(0, (column | 0) - 1) };
    if (_ignoredJumpCursor && _ignoredJumpCursor.path === next.path && _ignoredJumpCursor.line === next.line && _ignoredJumpCursor.character === next.character) { _ignoredJumpCursor = null; return; }
    if (_currentCursor && _currentCursor.path === next.path && _currentCursor.line === next.line) return;
    _currentCursor = next;
    if (_cursorTimer) clearTimeout(_cursorTimer);
    _cursorTimer = setTimeout(() => { _cursorTimer = null; _pendingCursor = _currentCursor; _flushOutbound(); }, CURSOR_DEBOUNCE_MS);
  }
  function syncContent() {
    if (_closed) return;
    if (_contentTimer) clearTimeout(_contentTimer);
    _contentTimer = setTimeout(() => { _contentTimer = null; _queueBuffer(false); }, CONTENT_DEBOUNCE_MS);
  }
  function _handleMessage(raw) {
    let event; try { event = JSON.parse(raw); } catch (_) { return; }
    if (!event || typeof event !== 'object') return;
    switch (event.event) {
      case 'editorScrollTo': _handleJump(event); break;
      case 'compileStatus': {
        const kind = String(event.kind || '');
        if (kind === 'Compiling') onStatus('compiling…');
        else if (kind === 'CompileSuccess') onStatus('synced');
        else if (kind === 'CompileError') onStatus('compile error');
        else onStatus(kind.toLowerCase());
        break;
      }
      case 'syncEditorChanges': _queueBuffer(true); break;
    }
  }
  function _handleJump(event) {
    const rel = event.filepath, end = Array.isArray(event.end) ? event.end : null, start = Array.isArray(event.start) ? event.start : null;
    const pos = end || start;
    if (!rel || !pos || pos.length < 2) return;
    const row = Number(pos[0]), col = Number(pos[1]);
    if (!Number.isFinite(row) || !Number.isFinite(col)) return;
    _ignoredJumpCursor = { path: rel, line: Math.max(0, row), character: Math.max(0, col - INBOUND_COLUMN_BASE) };
    _holdOutbound();
    onJump(rel, Math.max(1, row + 1), Math.max(1, col + 1 - INBOUND_COLUMN_BASE));
  }
  let revision = 0, _pollAbort = null;
  (async function poll() {
    while (!_closed) {
      _pollAbort = new AbortController();
      try {
        const r = await fetch(`${CONTROL_EVENTS_API}?token=${encodeURIComponent(session.token)}&after=${revision}`, { credentials: 'same-origin', signal: _pollAbort.signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const batch = await r.json();
        revision = Math.max(revision, Number(batch.revision) || revision);
        const events = batch.events || [];
        for (const ev of events) _handleMessage(JSON.stringify(ev));
        if (!events.length) await new Promise(resolve => setTimeout(resolve, 50));
      } catch (err) { if (_closed || (err && err.name === 'AbortError')) return; _reportFatal('Preview control channel unavailable'); return; }
      finally { _pollAbort = null; }
    }
  })();
  async function destroy() {
    if (_closed) return;
    if (session.path) _sendNow({ event: 'removeMemoryFiles', files: [session.path] });
    _closed = true;
    if (_pollAbort) { try { _pollAbort.abort(); } catch (_) {} _pollAbort = null; }
    for (const timer of [_suppressTimer, _cursorTimer, _contentTimer]) { if (timer) clearTimeout(timer); }
    _suppressTimer = _cursorTimer = _contentTimer = null;
    try { await fetch(SESSION_API, { method: 'DELETE', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: session.token }), keepalive: true }); } catch (_) {}
  }
  return { frameUrl: session.frame_url, token: session.token, path: session.path || path, tinymistVersion: session.tinymist_version || null, syncCursor, syncContent, destroy, isReady: () => !_closed, isClosed: () => _closed };
}
export default { createTypstSync, INBOUND_COLUMN_BASE };
