#!/usr/bin/env node
/**
 * Bundle the editor runtime as one browser-native ES module.
 *
 * The application is served by FastAPI as static files, so this deliberately
 * does not start a dev server or leave bare npm specifiers in browser code.
 */
import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = resolve(repoRoot, 'static/js/vendor');
const vendorModule = resolve(vendorDir, 'aster-editor-vendor.js');
const xtermStylesheet = resolve(vendorDir, 'xterm.css');

// Keeping the public surface here makes the generated module's contract
// reviewable without checking in a second, hand-maintained dependency entry.
const entry = `
export {
  Annotation, AnnotationType, ChangeSet, Compartment, EditorSelection,
  EditorState, RangeSetBuilder, StateEffect, StateField, Transaction
} from '@codemirror/state';

export {
  Decoration, EditorView, GutterMarker, ViewPlugin, WidgetType,
  drawSelection, dropCursor, highlightActiveLine, highlightActiveLineGutter,
  highlightSpecialChars, keymap, lineNumbers, placeholder,
  rectangularSelection, scrollPastEnd
} from '@codemirror/view';

export {
  defaultKeymap, history, historyKeymap, indentMore, indentLess,
  indentWithTab, redo, redoDepth, selectAll, toggleComment, undo, undoDepth
} from '@codemirror/commands';

export {
  bracketMatching, defaultHighlightStyle, foldAll, foldCode, foldGutter,
  foldKeymap, indentOnInput, StreamLanguage, syntaxHighlighting
} from '@codemirror/language';

export {
  autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap
} from '@codemirror/autocomplete';

export {
  gotoLine, highlightSelectionMatches, openSearchPanel, replaceAll,
  search, searchKeymap
} from '@codemirror/search';

export { basicSetup, minimalSetup } from 'codemirror';
export { Vim, vim } from '@replit/codemirror-vim';

import { javascript as javascriptSupport } from '@codemirror/lang-javascript';
import { python as pythonSupport } from '@codemirror/lang-python';
import { html as htmlSupport } from '@codemirror/lang-html';
import { css as cssSupport } from '@codemirror/lang-css';
import { sass as sassSupport } from '@codemirror/lang-sass';
import { markdown as markdownSupport } from '@codemirror/lang-markdown';
import { yaml as yamlSupport } from '@codemirror/lang-yaml';
import { sql as sqlSupport } from '@codemirror/lang-sql';
import { rust as rustSupport } from '@codemirror/lang-rust';
import { go as goSupport } from '@codemirror/lang-go';
import { StreamLanguage } from '@codemirror/language';
import { shell as shellMode } from '@codemirror/legacy-modes/mode/shell';
import { toml as tomlMode } from '@codemirror/legacy-modes/mode/toml';

export const javascript = javascriptSupport;
export const typescript = (config = {}) => javascriptSupport({ ...config, typescript: true });
export const jsx = (config = {}) => javascriptSupport({ ...config, jsx: true });
export const tsx = (config = {}) => javascriptSupport({ ...config, typescript: true, jsx: true });
export const json = (config = {}) => javascriptSupport({ ...config, json: true });
export const python = pythonSupport;
export const html = htmlSupport;
export const css = cssSupport;
export const scss = sassSupport;
export const sass = (config = {}) => sassSupport({ ...config, indented: true });
export const markdown = markdownSupport;
export const yaml = yamlSupport;
export const sql = sqlSupport;
export const rust = rustSupport;
export const go = goSupport;

// CodeMirror publishes Shell and TOML as maintained legacy stream modes.
export const shell = () => StreamLanguage.define(shellMode);
export const toml = () => StreamLanguage.define(tomlMode);

// A maintained CM6 Typst parser is not available in npm. This intentional
// fallback keeps .typ files editable as plain text until one is selected.
export const typst = () => [];

export { Terminal } from '@xterm/xterm';
export { FitAddon } from '@xterm/addon-fit';
`;

await mkdir(vendorDir, { recursive: true });
await build({
  absWorkingDir: repoRoot,
  bundle: true,
  format: 'esm',
  legalComments: 'none',
  mainFields: ['module', 'main'],
  minify: true,
  outfile: vendorModule,
  platform: 'browser',
  sourcemap: false,
  stdin: {
    contents: entry,
    loader: 'js',
    resolveDir: repoRoot,
    sourcefile: 'aster-editor-vendor-entry.js',
  },
  target: ['es2020'],
});

await copyFile(
  resolve(repoRoot, 'node_modules/@xterm/xterm/css/xterm.css'),
  xtermStylesheet,
);

console.log('Built static/js/vendor/aster-editor-vendor.js and xterm.css');
