import globals from 'globals';

/**
 * The extension ships unbundled, so files fall into three groups that need different
 * globals and module settings: the service worker (ESM, worker globals), the options
 * page (ESM, browser globals), and the classic scripts Chrome injects directly.
 */
export default [
  {
    ignores: ['node_modules/**', 'logo-concepts/**']
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, chrome: 'readonly' }
    },
    linterOptions: {
      reportUnusedDisableDirectives: true
    },
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-undef': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'smart'],
      'no-implicit-globals': 'error',
      'no-return-await': 'error',
      'no-throw-literal': 'error',
      'require-atomic-updates': 'off'
    }
  },
  {
    files: ['background.js', 'src/shared/**/*.js'],
    languageOptions: {
      globals: { ...globals.serviceworker, chrome: 'readonly' }
    }
  },
  {
    // Chrome injects these as classic scripts; they cannot use import/export.
    files: ['content.js', 'popup.js'],
    languageOptions: {
      sourceType: 'script'
    },
    rules: {
      'no-implicit-globals': 'off'
    }
  },
  {
    files: ['test/**/*.js'],
    languageOptions: {
      globals: { ...globals.node }
    }
  }
];
