import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['skills/**/src/**/*.test.ts', 'skills/**/src/**/*.test.js'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/vault/**',
      '**/active/**',
      '**/docs/**',
      '**/knowledge/**',
      'tests/**',
    ],
  },
});
