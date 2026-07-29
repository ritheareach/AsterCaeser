/**
 * static/js/aster/editor/preview.js — the editor's preview pane
 *
 * Three kinds of preview, one pane:
 *
 *   typst  Compiles the LIVE BUFFER (not the saved file) to SVG pages via
 *          POST /api/workspace/typst/preview, debounced. Compile diagnostics are
 *          handed back to the caller so they can become Monaco markers.
 *   image  Streams bytes from GET /api/workspace/asset. `.svg` is intentionally
 *          not served by that endpoint, so SVG files keep opening as text.
 *   csv    Parsed and rendered client-side from the buffer — no round trip, so
 *          it updates as you type.
 *
 * ── Why Typst pages render into <img> rather than inline SVG ──
 * A Typst document can embed an external SVG via `image("x.svg")`, and that
 * SVG's markup ends up inside the compiled output. Injecting that with innerHTML
 * would run any `onload=` / `onerror=` attribute it carries — `<script>` set via
 * innerHTML does not execute, but event-handler attributes very much do.
 *
 * Loading the same SVG through `<img src=blob:…>` cannot execute script at all:
 * browsers treat image-embedded SVG as a non-scripted document. The CSP already
 * allows it (`img-src 'self' data: blob:`), so this needs no CSP change and no
 * hand-rolled SVG sanitizer — which is the kind of thing that is wrong in a way
 * nobody notices for a year.
 *
 * The cost is real and worth stating: text in the preview is not selectable and
 * there is no click-to-jump back to source. Getting those needs inline SVG plus
 * a sanitizer, which is a bigger decision than this pane.
 */

const ASSET_API = '/api/workspace/asset';
const TYPST_API = '/api/workspace/typst/preview';

/** Compiling is a subprocess spawn — don't do it on every keystroke. */
const TYPST_DEBOUNCE_MS = 450;
/** CSV is parsed locally, so it can afford to be snappy. */
const CSV_DEBOUNCE_MS = 120;

const MAX_CSV_ROWS = 500;
const MAX_CSV_COLS = 60;

/** Matches the server's `_VIEWABLE_IMAGE_TYPES`. Deliberately excludes `.svg`. */
const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif', '.ico',
]);
const CSV_EXTENSIONS = new Set(['.csv', '.tsv']);

function _ext(name) {
  const s = String(name || '');
  const dot = s.lastIndexOf('.');
  return dot >= 0 ? s.slice(dot).toLowerCase() : '';
}

function _esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, m =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

/** Which preview a filename gets, or null for "no preview available". */
export function previewKindFor(name) {
  const ext = _ext(name);
  if (ext === '.typ') return 'typst';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (CSV_EXTENSIONS.has(ext)) return 'csv';
  return null;
}

/** True when this file cannot go into a Monaco text buffer at all (req 2.7). */
export function isBinaryViewable(name) {
  return IMAGE_EXTENSIONS.has(_ext(name));
}

/**
 * Split one CSV/TSV line-set into rows. Handles quoted fields, doubled quotes
 * inside them, and delimiters or newlines appearing within quotes — a naive
 * `split(',')` mangles every real-world export.
 *
 * Parses the whole input rather than stopping at the display cap: the source is
 * already bounded to the editor's 2MB limit, and stopping early would make the
 * reported row count wrong, which is worse than the work saved.
 */
export function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = String(text == null ? '' : text);

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field === '') { inQuotes = true; continue; }
    if (ch === delimiter) { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += ch;
  }
  // Trailing field/row, unless the file ended on a clean newline.
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function createPreview({
  projectId, container, onStatus, onDiagnostics,
  // Tier 2 (Typst sync). `syncEnabled()` is read for every target/setting refresh;
  // editor.js retargets the active document when the toggle changes.
  syncEnabled = () => false, followCursor = () => true, onJump = null, getBuffer = null,
  syncReadyTimeout = 12_000,
}) {
  let _kind = null;
  let _path = null;
  let _name = null;
  let _timer = null;
  let _seq = 0;              // discards responses from superseded compiles
  let _sync = null;          // ready tier-2 session
  let _syncPending = null;   // { sync, frame, stage, generation, path, ... }
  let _syncFrameCleanup = null;
  let _syncGeneration = 0;   // invalidates async starts after retarget/disable
  let _syncNotice = '';      // appended to tier-1 page status
  let _diagnosticEpoch = 0;  // orders compile-error diagnostics vs later success/content
  let _typstCompileEpoch = 0; // binds pagination continuations to one full compile
  let _pageUrls = [];        // object URLs for the currently displayed pages
  let _lastScroll = 0;
  let _destroyed = false;

  container.classList.add('ed-preview');
  container.setAttribute('role', 'region');
  container.setAttribute('aria-label', 'Preview');

  /**
   * Revoke the object URLs backing the pages currently on screen. Every code
   * path that replaces the pages goes through here — an object URL that is never
   * revoked pins its Blob in memory for the lifetime of the document, and a live
   * preview creates a fresh set on every recompile.
   */
  function _releasePages() {
    for (const url of _pageUrls) {
      try { URL.revokeObjectURL(url); } catch (_) { }
    }
    _pageUrls = [];
  }

  function _body() {
    return container.querySelector('.ed-preview-body');
  }

  function _chrome(label, extra = '') {
    container.innerHTML = `
      <div class="ed-preview-head">
        <span class="aster-slash" aria-hidden="true">//</span>
        <span class="ed-preview-label">${_esc(label)}</span>
        <span class="ed-preview-note" id="ed-preview-note">${extra}</span>
      </div>
      <div class="ed-preview-body aster-scroll" id="ed-preview-body"></div>`;
  }

  function _note(html) {
    const n = container.querySelector('#ed-preview-note');
    if (n) n.innerHTML = html;
  }

  function _message(cls, text) {
    const b = _body();
    if (b) b.innerHTML = `<div class="${cls}">${_esc(text)}</div>`;
  }

  // ── Typst ───────────────────────────────────────────────────────────────

  // Content of the last Typst compile, so "load more pages" can request the
  // next window against the same buffer without another keystroke.
  let _typstContent;

  function _removePaginationControl() {
    const body = _body();
    if (!body) return;
    const oldMore = body.querySelector('.ed-preview-more-wrap');
    if (!oldMore) return;
    const button = oldMore.querySelector('button');
    if (button) button.disabled = true;
    oldMore.remove();
  }

  async function _renderTypst(
    content, pageFrom = 0, append = false, expectedCompileEpoch = null
  ) {
    if (append && expectedCompileEpoch !== _typstCompileEpoch) return;
    const compileEpoch = append ? expectedCompileEpoch : ++_typstCompileEpoch;
    const mySeq = append ? _seq : ++_seq;
    const renderPath = _path;
    if (!append) {
      _typstContent = content;
      // The previous continuation belongs to older content. Remove it before the
      // network await so it cannot join its old offset to this new compile.
      _removePaginationControl();
    }
    const b = _body();
    if (b) _lastScroll = b.scrollTop;
    _note(append
      ? '<span class="ed-preview-busy">loading more pages…</span>'
      : '<span class="ed-preview-busy">compiling…</span>');

    let data;
    try {
      const r = await fetch(TYPST_API, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          path: renderPath,
          content: typeof content === 'string' ? content : undefined,
          page_from: pageFrom,
        }),
      });
      if (mySeq !== _seq || compileEpoch !== _typstCompileEpoch || _destroyed || _path !== renderPath) return;
      if (r.status === 503) {
        _note('');
        _message('ed-preview-unavailable',
          'Typst is not installed on the server. Install the `typst` binary to '
          + 'use the preview pane.');
        return;
      }
      if (!r.ok) {
        let detail = `HTTP ${r.status}`;
        try { detail = (await r.json()).detail || detail; } catch (_) { }
        if (mySeq !== _seq || compileEpoch !== _typstCompileEpoch || _destroyed || _path !== renderPath) return;
        _note('');
        _message('ed-preview-error',
          typeof detail === 'string' ? detail : 'Preview failed');
        return;
      }
      data = await r.json();
    } catch (err) {
      if (mySeq !== _seq || compileEpoch !== _typstCompileEpoch || _destroyed || _path !== renderPath) return;
      _note('');
      _message('ed-preview-error', err.message);
      return;
    }

    // A newer keystroke already kicked off another compile — drop this one.
    if (mySeq !== _seq || compileEpoch !== _typstCompileEpoch || _destroyed || _path !== renderPath) return;

    if (onDiagnostics) {
      try { onDiagnostics(data.diagnostics || [], renderPath); } catch (_) { }
    }

    const errors = (data.diagnostics || []).filter(d => d.severity === 'error');

    if (!data.ok || !data.pages.length) {
      _note(errors.length
        ? `<span class="ed-preview-bad">${errors.length} error${errors.length > 1 ? 's' : ''}</span>`
        : '');
      const b2 = _body();
      if (b2) {
        b2.innerHTML = `
          <div class="ed-preview-error" role="status">
            <div class="ed-preview-error-title">Compile failed</div>
            <ul class="ed-preview-diags">
              ${(data.diagnostics || []).slice(0, 30).map(d => `
                <li>${d.line ? `<span class="ed-diag-pos">${_esc(d.file || '')}:${d.line}:${d.column}</span> ` : ''}${_esc(d.message)}</li>
              `).join('')}
            </ul>
          </div>`;
      }
      return;
    }

    // Success. Keep the previous scroll offset so a recompile mid-document does
    // not throw the user back to page 1.
    // Appending a window must keep the blob URLs already on screen alive.
    if (!append) _releasePages();

    const first = (data.page_from || 0) + 1;
    const total = data.total_pages != null ? data.total_pages : data.page_count;
    const parts = [];
    for (let i = 0; i < data.pages.length; i++) {
      const blob = new Blob([data.pages[i]], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      _pageUrls.push(url);
      parts.push(
        `<img class="ed-preview-page" src="${url}" alt="Page ${first + i} of ${total}" draggable="false">`
      );
    }

    const shownTo = (data.page_from || 0) + data.page_count;
    const notes = [];
    if (_syncNotice) notes.push(_syncNotice);
    if (data.stale) {
      notes.push('<span class="ed-preview-bad">showing saved file — buffer could not be staged</span>');
    }
    if (errors.length) notes.push(`<span class="ed-preview-bad">${errors.length} error(s)</span>`);
    // Report the document's real length and which slice is on screen. Saying
    // "12 pages" for a truncated 34-page document was the actual bug.
    if (total > shownTo || (data.page_from || 0) > 0) {
      notes.push(`pages 1-${shownTo} of ${total}`);
    } else {
      notes.push(`${total} page${total === 1 ? '' : 's'}`);
    }
    _note(notes.join(' · '));

    const b3 = _body();
    if (b3) {
      // Drop the continuation consumed by this response before inserting pages.
      _removePaginationControl();
      if (append) b3.insertAdjacentHTML('beforeend', parts.join(''));
      else b3.innerHTML = parts.join('');

      if (data.next_page != null) {
        const wrap = document.createElement('div');
        wrap.className = 'ed-preview-more-wrap';
        const remaining = total - shownTo;
        wrap.innerHTML =
          `<button type="button" class="ed-preview-more">Load ${remaining} more page${remaining === 1 ? '' : 's'}</button>`;
        wrap.querySelector('.ed-preview-more').addEventListener('click', (ev) => {
          const btn = ev.currentTarget;
          btn.disabled = true;
          btn.textContent = 'loading…';
          _renderTypst(content, data.next_page, true, compileEpoch);
        });
        b3.appendChild(wrap);
      }
      if (!append) b3.scrollTop = _lastScroll;
    }
  }

  // ── Typst tier 2: tinymist sync ─────────────────────────────────────────

  const FRAME_BRIDGE_TYPE = 'odysseus-typst-frame-v1';
  const SYNC_READY_TIMEOUT_MS = Math.max(1, Number(syncReadyTimeout) || 12_000);

  function _bufferContentFor(path) {
    const buf = getBuffer ? getBuffer() : null;
    if (buf && buf.path === path && typeof buf.content === 'string') return buf.content;
    return _typstContent;
  }

  function _showSyncNotice(html) {
    _syncNotice = html;
    const note = container.querySelector('#ed-preview-note');
    if (!note || !html) return;
    const existing = note.querySelector
      ? note.querySelector('[data-typst-sync-notice]')
      : null;
    if (existing) {
      existing.insertAdjacentHTML('beforebegin', html);
      existing.remove();
    } else {
      note.insertAdjacentHTML('afterbegin', `${html}${note.innerHTML ? ' · ' : ''}`);
    }
  }

  function _syncUnavailableNotice() {
    return '<span class="ed-preview-bad" data-typst-sync-notice>standard preview · sync unavailable</span>';
  }

  function _syncOffNotice() {
    return '<span data-typst-sync-notice>standard preview · sync off (enable in Appearance)</span>';
  }

  /**
   * Start Tinymist in the background while tier 1 remains visible. Promotion only
   * happens after BOTH browser-facing channels are proven usable: the editor control
   * socket reports open and the iframe bridge observes its data socket opening.
   */
  function _startSync(content) {
    if (_sync) return Promise.resolve(true);
    if (_syncPending) return _syncPending.promise;

    const generation = ++_syncGeneration;
    const targetPath = _path;
    let resolveStart;
    const pending = {
      generation,
      path: targetPath,
      sync: null,
      frame: null,
      stage: null,
      controlReady: false,
      dataReady: false,
      settled: false,
      timeout: null,
      messageHandler: null,
      cursor: null,
      promise: new Promise(resolve => { resolveStart = resolve; }),
      resolve: (value) => {
        if (pending.settled) return;
        pending.settled = true;
        resolveStart(value);
      },
    };
    _syncPending = pending;
    _showSyncNotice('<span class="ed-preview-busy" data-typst-sync-notice>sync connecting…</span>');

    const current = () => (
      !_destroyed
      && _syncPending === pending
      && _syncGeneration === generation
      && _kind === 'typst'
      && _path === targetPath
      && syncEnabled()
    );

    const removeBridgeListener = () => {
      if (pending.messageHandler) {
        window.removeEventListener('message', pending.messageHandler);
        pending.messageHandler = null;
      }
    };

    const disposeCandidate = () => {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.timeout = null;
      removeBridgeListener();
      if (pending.stage) {
        try { pending.stage.remove(); } catch (_) { }
        pending.stage = null;
      }
      if (pending.sync) {
        try { pending.sync.destroy(); } catch (_) { }
        pending.sync = null;
      }
    };

    const fail = (message) => {
      if (!current()) return;
      console.warn('[editor] typst sync unavailable:', message);
      disposeCandidate();
      _syncPending = null;
      _showSyncNotice(_syncUnavailableNotice());
      pending.resolve(false);
    };

    const promote = () => {
      if (!current() || !pending.sync || !pending.controlReady || !pending.dataReady) return;
      const body = _body();
      if (!body || !pending.frame) { fail('Preview pane disappeared during startup'); return; }

      if (pending.timeout) clearTimeout(pending.timeout);
      pending.timeout = null;
      // Keep the bridge listener for the active frame so a later data-plane failure can
      // degrade in place rather than leaving a frozen, falsely "synced" renderer.
      _syncFrameCleanup = removeBridgeListener;
      _sync = pending.sync;
      _syncPending = null;
      _syncNotice = '';

      // Invalidate a tier-1 compile that may still be in flight, then release its blobs.
      _seq++;
      _typstCompileEpoch++;
      _releasePages();
      const frame = pending.frame;
      frame.hidden = false;
      body.replaceChildren(frame);
      if (pending.stage) {
        try { pending.stage.remove(); } catch (_) { }
      }
      pending.stage = null;
      _note('synced');
      pending.resolve(true);
    };

    (async () => {
      let sync = null;
      try {
        const { createTypstSync } = await import('./typst-sync.js');
        sync = await createTypstSync(
          { projectId, path: targetPath },
          {
            onStatus: (text) => {
              if (!current() && _sync !== sync) return;
              const statusEpoch = ++_diagnosticEpoch;
              if (_sync === sync) _note(_esc(text));
              if (text === 'compile error') {
                _refreshDiagnostics(targetPath, generation, statusEpoch);
              } else if (text === 'synced' && onDiagnostics) {
                onDiagnostics([], targetPath);
              }
            },
            onControlState: (state) => {
              if (!current()) return;
              pending.controlReady = state === 'ready';
              if (pending.controlReady) promote();
            },
            onReady: () => {
              if (!current()) return;
              pending.controlReady = true;
              promote();
            },
            onJump: (rel, line, column) => {
              if ((_sync === sync || current()) && onJump) onJump(rel, line, column);
            },
            onFatal: (message) => {
              if (_sync === sync) {
                console.warn('[editor] typst sync ended:', message);
                const fallbackContent = _bufferContentFor(targetPath);
                _teardownSync();
                if (_kind === 'typst' && _path === targetPath) {
                  _syncNotice = _syncUnavailableNotice();
                  _chrome('Typst preview');
                  _renderTypst(fallbackContent);
                }
              } else {
                fail(message);
              }
            },
            getBuffer: () => (getBuffer ? getBuffer() : null),
          }
        );

        if (!current()) { await sync.destroy(); pending.resolve(false); return; }
        pending.sync = sync;
        if (pending.cursor) {
          sync.syncCursor(pending.cursor.path, pending.cursor.line, pending.cursor.column);
        }

        const stage = document.createElement('div');
        stage.className = 'ed-preview-sync-stage';
        stage.hidden = true;
        const frame = document.createElement('iframe');
        frame.className = 'ed-preview-frame';
        frame.id = 'ed-preview-frame';
        frame.title = 'Typst preview (click to jump to source)';
        frame.referrerPolicy = 'no-referrer';
        pending.stage = stage;
        pending.frame = frame;

        pending.messageHandler = (event) => {
          const active = _sync === pending.sync && _kind === 'typst' && _path === targetPath;
          if ((!current() && !active) || event.origin !== window.location.origin) return;
          if (!pending.frame || event.source !== pending.frame.contentWindow) return;
          const data = event.data;
          if (!data || data.type !== FRAME_BRIDGE_TYPE) return;
          if (data.state === 'data-open') {
            pending.dataReady = true;
            promote();
          } else if (data.state === 'data-error' || data.state === 'data-close') {
            if (_sync && _sync.path === targetPath) {
              const fallbackContent = _bufferContentFor(targetPath);
              _teardownSync();
              if (_kind === 'typst' && _path === targetPath) {
                _syncNotice = _syncUnavailableNotice();
                _chrome('Typst preview');
                _renderTypst(fallbackContent);
              }
            } else {
              fail('The preview renderer could not connect');
            }
          } else if (data.state === 'runtime-error') {
            console.warn('[editor] typst frame error:', data.message || 'unknown error');
          }
        };
        window.addEventListener('message', pending.messageHandler);
        frame.addEventListener('error', () => fail('The preview frame failed to load'), { once: true });
        stage.appendChild(frame);
        container.appendChild(stage);
        frame.src = sync.frameUrl;

        pending.timeout = setTimeout(() => {
          fail('Timed out waiting for the preview renderer and sync channel');
        }, SYNC_READY_TIMEOUT_MS);
        if (typeof content === 'string') sync.syncContent();
        promote();
      } catch (err) {
        if (!current()) { pending.resolve(false); return; }
        fail(err && err.message ? err.message : 'Preview sync could not start');
      }
    })();

    return pending.promise;
  }

  /** Fetch positioned diagnostics only after Tinymist reports a compile error. */
  async function _refreshDiagnostics(
    path = _path,
    generation = _syncGeneration,
    diagnosticEpoch = _diagnosticEpoch
  ) {
    if (!onDiagnostics || !path) return;
    const buf = getBuffer ? getBuffer() : null;
    try {
      const r = await fetch(TYPST_API, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          path,
          content: buf && buf.path === path && typeof buf.content === 'string'
            ? buf.content
            : undefined,
        }),
      });
      if (!r.ok || _destroyed || _path !== path || _syncGeneration !== generation || _diagnosticEpoch !== diagnosticEpoch) return;
      const data = await r.json();
      if (_destroyed || _path !== path || _syncGeneration !== generation || _diagnosticEpoch !== diagnosticEpoch) return;
      onDiagnostics(data.diagnostics || [], path);
    } catch (_) {
      // The compile status already communicates the failure.
    }
  }

  function _teardownSync() {
    _syncGeneration++;
    if (_syncFrameCleanup) {
      try { _syncFrameCleanup(); } catch (_) { }
      _syncFrameCleanup = null;
    }
    if (_syncPending) {
      const pending = _syncPending;
      _syncPending = null;
      if (pending.timeout) clearTimeout(pending.timeout);
      if (pending.messageHandler) {
        window.removeEventListener('message', pending.messageHandler);
      }
      if (pending.stage) {
        try { pending.stage.remove(); } catch (_) { }
      }
      if (pending.sync) {
        try { pending.sync.destroy(); } catch (_) { }
      }
      pending.resolve(false);
    }
    if (_sync) {
      const sync = _sync;
      _sync = null;
      try { sync.destroy(); } catch (_) { }
    }
  }

  /** Cursor moved in Monaco. Queue it even while the two channels are connecting. */
  function cursorMoved(relPath, lineNumber, column) {
    if (!followCursor() || _kind !== 'typst' || relPath !== _path) return;
    if (_sync) {
      _sync.syncCursor(relPath, lineNumber, column);
    } else if (_syncPending && _syncPending.path === relPath) {
      _syncPending.cursor = { path: relPath, line: lineNumber, column };
      if (_syncPending.sync) _syncPending.sync.syncCursor(relPath, lineNumber, column);
    }
  }

  /** True only after both control and renderer data sockets have opened. */
  function isSyncing() { return !!_sync; }

  // ── Image ───────────────────────────────────────────────────────────────

  function _renderImage() {
    const url = `${ASSET_API}?project_id=${encodeURIComponent(projectId)}`
      + `&path=${encodeURIComponent(_path)}&t=${Date.now()}`;
    const b = _body();
    if (!b) return;
    b.innerHTML = `
      <img class="ed-preview-image" src="${_esc(url)}"
           alt="${_esc(_name || _path)}" draggable="false">`;
    const img = b.querySelector('img');
    img.addEventListener('load', () => {
      _note(`${img.naturalWidth} × ${img.naturalHeight}`);
    });
    img.addEventListener('error', () => {
      _note('');
      _message('ed-preview-error', 'Could not load that image.');
    });
  }

  // ── CSV / TSV ───────────────────────────────────────────────────────────

  function _renderCsv(content) {
    const delimiter = _ext(_name) === '.tsv' ? '\t' : ',';
    const rows = parseDelimited(content || '', delimiter);
    const b = _body();
    if (!b) return;

    if (!rows.length) {
      _note('');
      _message('ed-preview-empty', 'No rows.');
      return;
    }

    const truncatedRows = rows.length > MAX_CSV_ROWS;
    const shown = rows.slice(0, MAX_CSV_ROWS);
    const width = Math.min(
      MAX_CSV_COLS, shown.reduce((m, r) => Math.max(m, r.length), 0)
    );
    const truncatedCols = shown.some(r => r.length > MAX_CSV_COLS);

    const header = shown[0] || [];
    const cell = (v) => _esc(v == null ? '' : v);

    b.innerHTML = `
      <table class="ed-preview-table">
        <caption class="sr-only">${_esc(_name || _path)}</caption>
        <thead>
          <tr>
            <th scope="col" class="ed-preview-rownum">#</th>
            ${Array.from({ length: width }, (_, i) =>
      `<th scope="col">${cell(header[i])}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${shown.slice(1).map((r, ri) => `
            <tr>
              <th scope="row" class="ed-preview-rownum">${ri + 2}</th>
              ${Array.from({ length: width }, (_, i) =>
        `<td>${cell(r[i])}</td>`).join('')}
            </tr>`).join('')}
        </tbody>
      </table>`;

    const notes = [`${rows.length} row${rows.length > 1 ? 's' : ''}`];
    if (truncatedRows) notes.push(`showing first ${MAX_CSV_ROWS}`);
    if (truncatedCols) notes.push(`first ${MAX_CSV_COLS} columns`);
    _note(_esc(notes.join(' · ')));
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** Point the pane at a file. Returns the kind chosen, or null. */
  function show(relPath, name, content) {
    const kind = previewKindFor(name || relPath);
    const targetChanged = kind !== _kind || relPath !== _path;
    const wantsSync = kind === 'typst' && syncEnabled();
    const hasSyncTier = !!(_sync || _syncPending);
    const tierChanged = kind === 'typst' && wantsSync !== hasSyncTier;

    if (targetChanged || tierChanged) {
      if (_timer) { clearTimeout(_timer); _timer = null; }
      _seq++;
      _diagnosticEpoch++;
      _typstCompileEpoch++;
      _teardownSync();
      _releasePages();
    }

    _kind = kind;
    _path = relPath;
    _name = name || (relPath || '').split('/').pop();
    if (targetChanged) _lastScroll = 0;

    if (!kind) {
      _syncNotice = '';
      _chrome('Preview');
      _message('ed-preview-empty', 'No preview for this file type.');
      return null;
    }

    // A visibility/settings event may call show for the same target. Do not remove a
    // healthy iframe or restart a connection just because an unrelated setting changed.
    if (!targetChanged && !tierChanged && kind === 'typst') {
      if (_sync) _sync.syncContent();
      else if (_syncPending && _syncPending.sync) _syncPending.sync.syncContent();
      return kind;
    }

    const labels = { typst: 'Typst preview', image: 'Image', csv: 'Table' };
    _chrome(labels[kind] || 'Preview');

    if (kind === 'typst' && wantsSync) {
      // Keep the safe paginated SVG preview visible until the renderer AND control
      // channel prove ready, then atomically promote the staged iframe.
      _syncNotice = '<span class="ed-preview-busy" data-typst-sync-notice>sync connecting…</span>';
      _renderTypst(content);
      _startSync(content);
      return kind;
    }

    _syncNotice = kind === 'typst' ? _syncOffNotice() : '';
    render(content);
    return kind;
  }

  /** Render immediately with the given buffer content. */
  function render(content) {
    if (_destroyed || !_kind) return;
    // Tier 2 owns the pane only after both channels are ready. A staged candidate
    // receives buffer updates but tier 1 remains visible until promotion.
    if (_sync) { if (_kind === 'typst') _sync.syncContent(); return; }
    if (_syncPending && _syncPending.sync && _kind === 'typst') {
      _syncPending.sync.syncContent();
    }
    if (_kind === 'typst') _renderTypst(content);
    else if (_kind === 'image') _renderImage();
    else if (_kind === 'csv') _renderCsv(content);
  }

  /** Debounced render, for the on-every-keystroke path. */
  function update(content) {
    if (_destroyed || !_kind) return;
    if (_kind === 'typst') {
      _diagnosticEpoch++;
      _removePaginationControl();
    }
    if (_sync) { _sync.syncContent(); return; }
    if (_syncPending && _syncPending.sync && _kind === 'typst') {
      _syncPending.sync.syncContent();
    }
    if (_kind === 'image') return;      // bytes only change on save
    const wait = _kind === 'typst' ? TYPST_DEBOUNCE_MS : CSV_DEBOUNCE_MS;
    if (_timer) clearTimeout(_timer);
    _timer = setTimeout(() => { _timer = null; render(content); }, wait);
  }

  function clear() {
    if (_timer) { clearTimeout(_timer); _timer = null; }
    _seq++;
    _diagnosticEpoch++;
    _typstCompileEpoch++;
    _teardownSync();
    _releasePages();
    _syncNotice = '';
    _kind = null;
    _path = null;
    _name = null;
    container.innerHTML = '';
    if (onStatus) onStatus('');
  }

  function destroy() {
    _destroyed = true;
    clear();
    container.classList.remove('ed-preview');
  }

  return {
    show, render, update, clear, destroy,
    cursorMoved, isSyncing,
    kind: () => _kind,
    path: () => _path,
  };
}

export default { createPreview, previewKindFor, isBinaryViewable, parseDelimited };
