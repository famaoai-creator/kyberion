import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    include: ['**/src/**/*.test.ts', '**/src/**/*.test.js', 'libs/core/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/vault/**',
      '**/active/**',
      '**/docs/**',
      '**/knowledge/**',
    ],
    alias: [
      { find: /^@agent\/core\/(.*)$/, replacement: path.resolve(__dirname, './libs/core/$1') },
      { find: '@agent/core', replacement: path.resolve(__dirname, './libs/core/index.ts') },
    ],
  },
});
