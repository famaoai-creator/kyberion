import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@agent\/core$/, replacement: resolve(here, '../../../libs/core/index.ts') },
      { find: '@', replacement: resolve(here, 'src') },
    ],
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
