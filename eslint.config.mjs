import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Native apps (Kotlin/Swift) have their own toolchains.
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'apps/android/**',
      'apps/ios/**',
      'e2e-artifacts/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    files: ['**/*.test.ts', '**/test/**'],
    languageOptions: { globals: { ...globals.jest } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
