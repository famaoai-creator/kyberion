const globals = require('globals');
const tseslint = require('typescript-eslint');

module.exports = [
  {
    ignores: [
      'node_modules/',
      '**/node_modules/',
      'dist/',
      '**/dist/',
      'coverage/',
      'evidence/',
      'active/shared/',
      'scripts/_archive/',
      '.gemini/',
      'vault/',
      'tests/',
      'libs/core/*.ts',
      '**/*.d.ts',
    ],
  },
  // JS Config
  {
    files: ['**/*.cjs', '**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-console': 'off',
      'no-undef': 'error',
    },
  },
  // TS Config
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
  })),
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-require-imports': 'warn',
    },
  },
];
