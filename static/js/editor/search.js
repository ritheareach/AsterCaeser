/** Project-scoped grep and replace panel. It never calls a non-project route. */
const API_ROOT = '/api/workspace';

function endpoint(context, action) {
  return `${API_ROOT}/${encodeURIComponent(context.workspaceId)}/project/${encodeURIComponent(context.projectId)}/files/${action}`;
}

async function request(context, action, body) {
  const response = await fetch(endpoint(context, action), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const detail = await response.json();
      message = detail.detail || detail.message || message;
    } catch (_) { /* Keep the HTTP status as the fallback. */ }
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function queryMatcher(query, regex, caseSensitive) {
  if (!query) return null;
  try {
    return new RegExp(regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'g' : 'gi');
  } catch (_) {
    return null;
  }
}

function highlightedText(element, source, matcher) {
  if (!matcher) { element.textContent = source; return; }
  let index = 0;
  matcher.lastIndex = 0;
  for (let match = matcher.exec(source); match; match = matcher.exec(source)) {
    element.append(document.createTextNode(source.slice(index, match.index)));
    const mark = document.createElement('mark');
    mark.textContent = match[0];
    element.append(mark);
    index = match.index + match[0].length;
    if (!match[0]) matcher.lastIndex += 1;
  }
  element.append(document.createTextNode(source.slice(index)));
}

/**
 * The callbacks deliberately keep editor state out of this module. This makes
 * result navigation and post-replace reloads explicit at the integration seam.
 */
export class ProjectSearchPanel {
  constructor(host, context, { onOpenAt, onBeforeReplace, onFilesChanged } = {}) {
    this.host = host;
    this.context = { ...context };
    this.onOpenAt = onOpenAt;
    this.onBeforeReplace = onBeforeReplace;
    this.onFilesChanged = onFilesChanged;
    this.results = [];
    this.replaceVisible = false;
    this.controls = {};
  }

  mount() {
    this.host.replaceChildren();
    const form = document.createElement('form');
    form.className = 'ce-search-form';
    form.addEventListener('submit', event => { event.preventDefault(); void this.search(); });

    const query = document.createElement('input');
    query.type = 'search'; query.className = 'ce-search-input'; query.placeholder = 'Search files…';
    query.setAttribute('aria-label', 'Search project files'); query.autocomplete = 'off';
    const regex = this._checkbox('Regex');
    const caseSensitive = this._checkbox('Case');
    const glob = document.createElement('input');
    glob.type = 'text'; glob.className = 'ce-search-glob'; glob.placeholder = '*.py'; glob.setAttribute('aria-label', 'File glob');
    const maximum = document.createElement('input');
    maximum.type = 'number'; maximum.className = 'ce-search-glob'; maximum.value = '200'; maximum.min = '1'; maximum.max = '500'; maximum.setAttribute('aria-label', 'Maximum results');
    const search = document.createElement('button');
    search.type = 'submit'; search.className = 'ce-search-btn'; search.textContent = 'Search';
    const replaceToggle = document.createElement('button');
    replaceToggle.type = 'button'; replaceToggle.className = 'ce-search-btn'; replaceToggle.textContent = 'Replace';
    replaceToggle.addEventListener('click', () => this._toggleReplace());
    const options = document.createElement('div');
    options.className = 'ce-search-options'; options.append(regex.label, caseSensitive.label, glob, maximum);
    form.append(query, options, search, replaceToggle);
    const replace = document.createElement('div');
    replace.className = 'ce-search-form'; replace.hidden = true;
    const replacement = document.createElement('input');
    replacement.type = 'text'; replacement.className = 'ce-search-input'; replacement.placeholder = 'Replace with…'; replacement.setAttribute('aria-label', 'Replacement text');
    const replaceAll = document.createElement('button');
    replaceAll.type = 'button'; replaceAll.className = 'ce-search-btn'; replaceAll.textContent = 'Replace all';
    replaceAll.addEventListener('click', () => { void this.replaceAll(); });
    replace.append(replacement, replaceAll);
    const status = document.createElement('div'); status.className = 'ce-search-status'; status.setAttribute('role', 'status');
    const results = document.createElement('div'); results.className = 'ce-search-results'; results.setAttribute('aria-live', 'polite');
    this.host.append(form, replace, status, results);
    this.controls = { query, regex: regex.input, caseSensitive: caseSensitive.input, glob, maximum, replace, replacement, status, results };
    return this;
  }

  focus() {
    this.controls.query?.focus();
  }

  async search() {
    const query = this.controls.query.value.trim();
    if (!query) { this._status('Enter text to search.'); this._renderResults([]); return; }
    const body = this._body(query);
    this._status('Searching…');
    try {
      const result = await request(this.context, 'grep', body);
      this.results = result.results || [];
      this._status(`${result.total ?? this.results.length} match${(result.total ?? this.results.length) === 1 ? '' : 'es'}${result.truncated ? ' (truncated)' : ''}`);
      this._renderResults(this.results);
    } catch (error) {
      this.results = [];
      this._status(`Search failed: ${error.message}`);
      this._renderResults([]);
    }
  }

  async replaceAll() {
    const query = this.controls.query.value.trim();
    if (!query) return this._status('Enter text to replace.');
    const count = this.results.length;
    if (!window.confirm(`Replace all matches in this project${count ? ` (currently ${count} shown)` : ''}?`)) return;
    if (this.onBeforeReplace && !await this.onBeforeReplace()) {
      this._status('Replace cancelled because an open document could not be saved.');
      return;
    }
    this._status('Replacing…');
    try {
      const result = await request(this.context, 'replace', {
        ...this._body(query),
        replacement: this.controls.replacement.value,
      });
      const files = (result.files || []).map(file => typeof file === 'string' ? file : file.path).filter(Boolean);
      await this.onFilesChanged?.(files);
      const summary = `${result.replaced || 0} replacement${result.replaced === 1 ? '' : 's'} in ${files.length} file${files.length === 1 ? '' : 's'}${result.truncated ? ' (truncated)' : ''}`;
      await this.search();
      this._status(summary);
    } catch (error) {
      this._status(error.status === 404 ? 'Replace is unavailable on this server.' : `Replace failed: ${error.message}`);
    }
  }

  _body(query) {
    const maximum = Math.max(1, Math.min(500, Number.parseInt(this.controls.maximum.value, 10) || 200));
    return {
      query,
      regex: this.controls.regex.checked,
      case_sensitive: this.controls.caseSensitive.checked,
      glob: this.controls.glob.value.trim() || null,
      max_results: maximum,
    };
  }

  _checkbox(label) {
    const wrapper = document.createElement('label');
    const input = document.createElement('input'); input.type = 'checkbox';
    wrapper.append(input, document.createTextNode(` ${label}`));
    return { label: wrapper, input };
  }

  _toggleReplace() {
    this.replaceVisible = !this.replaceVisible;
    this.controls.replace.hidden = !this.replaceVisible;
    if (this.replaceVisible) this.controls.replacement.focus();
  }

  _status(message) {
    if (this.controls.status) this.controls.status.textContent = message;
  }

  _renderResults(results) {
    const host = this.controls.results;
    if (!host) return;
    host.replaceChildren();
    const matcher = queryMatcher(this.controls.query.value, this.controls.regex.checked, this.controls.caseSensitive.checked);
    const groups = new Map();
    for (const result of results) {
      if (!groups.has(result.path)) groups.set(result.path, []);
      groups.get(result.path).push(result);
    }
    for (const [path, matches] of groups) {
      const group = document.createElement('section'); group.className = 'ce-search-file';
      const heading = document.createElement('button'); heading.type = 'button'; heading.className = 'ce-search-file-name';
      heading.textContent = `${path} (${matches.length})`; heading.setAttribute('aria-expanded', 'true');
      const hits = document.createElement('div'); hits.className = 'ce-search-file-results';
      heading.addEventListener('click', () => {
        const hidden = hits.hidden = !hits.hidden;
        heading.setAttribute('aria-expanded', String(!hidden));
      });
      for (const result of matches) {
        const hit = document.createElement('button'); hit.type = 'button'; hit.className = 'ce-search-hit';
        const line = document.createElement('span'); line.className = 'ce-search-line-num'; line.textContent = String(result.line_number || result.line);
        const content = document.createElement('span'); content.className = 'ce-search-line-text';
        highlightedText(content, String(result.content || ''), matcher);
        hit.append(line, content);
        hit.addEventListener('click', () => { void this.onOpenAt?.(result.path, { line: result.line_number || result.line }); });
        hits.appendChild(hit);
      }
      group.append(heading, hits); host.appendChild(group);
    }
  }
}

export default { ProjectSearchPanel };
