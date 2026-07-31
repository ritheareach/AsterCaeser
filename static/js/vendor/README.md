# Local editor runtime assets

Build the browser assets with:

```bash
npm run build:editor-vendor
```

This creates browser-native ES modules with no runtime CDN or bare npm imports:

- `aster-editor-vendor.js` — CodeMirror 6, the Replit Vim extension, language helpers, xterm, and the fit addon.
- `xterm.css` — copied from the pinned `@xterm/xterm` package and loaded by the editor shell with a normal local stylesheet link.

Import named exports from `/static/js/vendor/aster-editor-vendor.js` (or the equivalent relative static URL). `basicSetup`, `EditorState`, `EditorView`, `vim`, `Terminal`, and `FitAddon` are direct exports. Language helpers are functions, for example `typescript()`, `json()`, `shell()`, `toml()`, and `scss()`.

`shell()` and `toml()` use CodeMirror's maintained `@codemirror/legacy-modes` stream modes because standalone CM6 `lang-shell` and `lang-toml` packages do not exist. `typst()` intentionally returns a plain-text extension: no maintained CodeMirror 6 Typst parser is available in npm. It is kept as a stable, explicit fallback rather than pretending that Typst syntax is highlighted.
