/** Local xterm client for one authenticated, project-root terminal session. */
import { FitAddon, Terminal } from '../vendor/aster-editor-vendor.js';

const XTERM_STYLESHEET = '/static/js/vendor/xterm.css';

function terminalUrl(context) {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  let url = `${scheme}//${window.location.host}/api/workspace/${encodeURIComponent(context.workspaceId)}`
    + `/project/${encodeURIComponent(context.projectId)}/terminal`;
  if (context.terminalSessionId) {
    url += `?session_id=${encodeURIComponent(context.terminalSessionId)}`;
  }
  return url;
}

function ensureStylesheet() {
  if (document.querySelector('link[data-aster-xterm-styles]')) return;
  const stylesheet = document.createElement('link');
  stylesheet.rel = 'stylesheet';
  stylesheet.href = XTERM_STYLESHEET;
  stylesheet.dataset.asterXtermStyles = 'true';
  document.head.appendChild(stylesheet);
}

function editorTheme(container) {
  const styles = window.getComputedStyle(container);
  const color = name => styles.getPropertyValue(name).trim();
  const background = color('--bg') || '#101318';
  const foreground = color('--fg') || '#d8dee9';
  const accent = color('--accent') || color('--red') || '#56c7d9';
  const danger = color('--red') || '#e06c75';
  const success = color('--green') || '#98c379';
  const warning = color('--warn') || '#e5c07b';
  const muted = color('--color-muted') || '#5c6773';
  return {
    background,
    foreground,
    cursor: accent,
    selectionBackground: accent,
    black: background, red: danger, green: success, yellow: warning,
    blue: accent, magenta: accent, cyan: accent, white: foreground,
    brightBlack: muted, brightRed: danger, brightGreen: success,
    brightYellow: warning, brightBlue: accent, brightMagenta: accent,
    brightCyan: accent, brightWhite: foreground,
  };
}

/**
 * `ProjectTerminal` owns one xterm instance and exactly one project-scoped
 * WebSocket. `dispose()` closes both, so no background shell survives after an
 * editor closes or switches projects.
 */
export class ProjectTerminal {
  constructor(host, context, { onState } = {}) {
    this.host = host;
    this.context = { ...context };
    this.onState = onState;
    this.socket = null;
    this.terminal = null;
    this.fitAddon = null;
    this.resizeObserver = null;
    this.dataSubscription = null;
    this.disposed = false;
    this.resizeFrame = null;
    this.decoder = new TextDecoder();
  }

  open() {
    if (this.disposed) return;
    ensureStylesheet();
    this.host.replaceChildren();
    this.host.style.height = '100%';
    this.host.style.minHeight = '0';
    this.terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: "'Fira Code', 'Cascadia Code', 'JetBrains Mono', monospace",
      fontSize: 13,
      scrollback: 5_000,
      theme: editorTheme(this.host),
    });
    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.open(this.host);
    this.dataSubscription = this.terminal.onData(data => this._send({ type: 'input', data }));
    this.resizeObserver = new ResizeObserver(() => this._scheduleResize());
    this.resizeObserver.observe(this.host);
    this._setState('connecting', 'Connecting to project shell…');
    this.terminal.writeln('\x1b[90mConnecting to the project shell…\x1b[0m');
    requestAnimationFrame(() => {
      this.refresh();
      this._connect();
    });
  }

  refresh() {
    if (this.disposed || !this.fitAddon || !this.terminal) return;
    try {
      this.fitAddon.fit();
      this._send({ type: 'resize', cols: this.terminal.cols, rows: this.terminal.rows });
    } catch (_) {
      // A hidden panel has no measurable size. The next visible resize retries.
    }
  }

  focus() {
    if (!this.disposed) this.terminal?.focus();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.resizeFrame) cancelAnimationFrame(this.resizeFrame);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.dataSubscription?.dispose();
    this.dataSubscription = null;
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) this.socket.close(1000, 'Editor panel closed');
    this.socket = null;
    this.terminal?.dispose();
    this.terminal = null;
    this.fitAddon = null;
    this.host.replaceChildren();
    this._setState('closed', 'Terminal closed');
  }

  _connect() {
    if (this.disposed) return;
    let socket;
    try {
      socket = new WebSocket(terminalUrl(this.context));
    } catch (error) {
      this._fail(`Could not create terminal connection: ${error.message}`);
      return;
    }
    this.socket = socket;
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('open', () => {
      if (this.disposed || socket !== this.socket) return;
      this._setState('connected', 'Project shell connected');
      this.terminal?.writeln('\x1b[90mConnected. Shell runs in this project root.\x1b[0m');
      this.refresh();
    });
    socket.addEventListener('message', event => this._receive(event));
    socket.addEventListener('error', () => {
      if (!this.disposed) this._setState('error', 'Terminal connection error');
    });
    socket.addEventListener('close', event => {
      if (this.disposed) return;
      const wasError = ![1000, 1001].includes(event.code);
      const message = event.code === 1006
        ? 'Terminal connection was rejected. Reload the page and sign in again if needed.'
        : wasError
          ? `Terminal connection failed (${event.code})`
          : 'Terminal connection closed';
      this._setState(wasError ? 'error' : 'closed', message);
      this.terminal?.writeln(`\r\n\x1b[90mTerminal connection closed (${event.code}).\x1b[0m`);
    });
  }

  _receive(event) {
    if (this.disposed || !this.terminal) return;
    if (typeof event.data === 'string') {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === 'error') {
          this._fail(payload.message || 'Terminal server error');
          return;
        }
        if (payload.type === 'init') {
          this.onState?.({ kind: 'init', shell: payload.shell });
          return;
        }
      } catch (_) { /* A text frame may be terminal output; render it below. */ }
      this.terminal.write(event.data);
      return;
    }
    if (event.data instanceof Blob) {
      void event.data.arrayBuffer().then(buffer => this._writeBytes(new Uint8Array(buffer)));
      return;
    }
    const bytes = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : event.data;
    if (bytes instanceof Uint8Array) this._writeBytes(bytes);
  }

  _writeBytes(bytes) {
    if (!this.disposed && this.terminal) this.terminal.write(this.decoder.decode(bytes, { stream: true }));
  }

  _scheduleResize() {
    if (this.resizeFrame || this.disposed) return;
    this.resizeFrame = requestAnimationFrame(() => {
      this.resizeFrame = null;
      this.refresh();
    });
  }

  _send(payload) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(payload));
  }

  _fail(message) {
    this._setState('error', message);
    this.terminal?.writeln(`\r\n\x1b[31m${message}\x1b[0m`);
  }

  _setState(kind, message) {
    this.onState?.({ kind, message });
  }
}

export default { ProjectTerminal };
