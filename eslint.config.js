import js from '@eslint/js';

const nodeGlobals = {
  Buffer: 'readonly', console: 'readonly', process: 'readonly', require: 'readonly',
  module: 'writable', __dirname: 'readonly', __filename: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
  URL: 'readonly', URLSearchParams: 'readonly', globalThis: 'writable', performance: 'readonly',
  fetch: 'readonly', AbortSignal: 'readonly', setImmediate: 'readonly', clearImmediate: 'readonly', queueMicrotask: 'readonly',
};
const browserGlobals = {
  window: 'readonly', document: 'readonly', localStorage: 'readonly', sessionStorage: 'readonly',
  fetch: 'readonly', FormData: 'readonly', DOMPurify: 'readonly', marked: 'readonly',
  hljs: 'readonly', uPlot: 'readonly', requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
  requestIdleCallback: 'readonly', WebSocket: 'readonly', CustomEvent: 'readonly', history: 'readonly',
  navigator: 'readonly', location: 'readonly', AbortSignal: 'readonly', Blob: 'readonly',
  FileReader: 'readonly', getComputedStyle: 'readonly', __wb: 'writable', openDropdown: 'writable',
  setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
  console: 'readonly', URL: 'readonly', URLSearchParams: 'readonly', process: 'readonly',
};

export default [
  { ignores: ['node_modules/**', 'public/vendor/**', 'remotion/**', 'promo/**', 'dist/**', 'build/**', 'pkg-build/**', 'pkg/**', 'stage/**', 'installer/**', 'tauri/target/**', 'docs/**'] },
  js.configs.recommended,
  {
    files: ['server.mjs', 'zip.mjs', 'ledger.mjs', 'mcp-bridge.js', 'electron-main.cjs', 'extensions/**/*.js', 'tools/**/*.cjs', 'scripts/**'],
    languageOptions: {ecmaVersion: 2024, sourceType: 'module', globals: nodeGlobals},
    rules: {
      'no-empty': ['error', {allowEmptyCatch: true}],
      'no-unused-vars': ['warn', {args: 'none', caughtErrors: 'none'}],
      'no-undef': 'error',
    },
  },
  {
    files: ['tests/**/*.mjs'],
    languageOptions: {ecmaVersion: 2024, sourceType: 'module', globals: {...nodeGlobals, process: 'readonly'}},
    rules: {'no-empty': ['error', {allowEmptyCatch: true}], 'no-unused-vars': ['warn', {args: 'none', caughtErrors: 'none'}], 'no-undef': 'error'},
  },
  {
    files: ['public/app.js'],
    languageOptions: {ecmaVersion: 2024, sourceType: 'script', globals: {...browserGlobals, openDropdown: 'readonly', __wb: 'writable'}},
    rules: {'no-func-assign': 'off'},
  },
  {
    files: ['public/dropdowns.js'],
    languageOptions: {ecmaVersion: 2024, sourceType: 'script', globals: {...browserGlobals}},
    rules: {'no-redeclare': 'off'},
  },
  {
    files: ['public/**/*.js'],
    languageOptions: {ecmaVersion: 2024, sourceType: 'script', globals: browserGlobals},
    rules: {
      'no-empty': ['error', {allowEmptyCatch: true}],
      'no-unused-vars': ['warn', {args: 'none', caughtErrors: 'none', varsIgnorePattern: '^(marked|hljs|uPlot|DOMPurify)$'}],
      'no-undef': 'error',
    },
  },
];
