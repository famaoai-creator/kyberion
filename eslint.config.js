const globals = require('globals');

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
];
