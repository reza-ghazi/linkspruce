import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/**', 'dist-e2e/**', 'release/**', 'node_modules/**', 'private/**', 'coverage/**', 'test-results/**', 'playwright-report/**'] },
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node, chrome: 'readonly' } },
    rules: {
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-properties': ['error',
        { property: 'innerHTML', message: 'Render untrusted values with textContent / el() helpers.' },
        { property: 'outerHTML', message: 'Do not inject HTML.' },
        { property: 'insertAdjacentHTML', message: 'Do not inject HTML.' }],
      'no-restricted-globals': ['error', { name: 'eval', message: 'No eval.' }],
    },
  },
);
