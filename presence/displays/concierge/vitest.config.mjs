import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { coreSourceAliases } from '../../../tests/vitest-core-aliases.ts';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(here, '../../..');

export default defineConfig({
  resolve: {
    alias: [
      // Flat public subpaths (e.g. `@agent/core/mission-lookup`) map through
      // the exports map to their real source file — without this they fall to
      // the directory guess below and miss files living in subdirectories.
      ...coreSourceAliases(rootDir),
      { find: /^@agent\/core$/, replacement: resolve(here, '../../../libs/core/index.ts') },
      {
        find: /^@agent\/core\/(.+)$/,
        replacement: resolve(here, '../../../libs/core/$1'),
      },
      { find: '@', replacement: resolve(here, 'src') },
    ],
  },
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    setupFiles: [resolve(here, '../../../tests/vitest-network-guard.ts')],
    // Match the root vitest.config.mts policy — shared CI runners are 3-8x
    // slower and cold module init (e.g. the @agent/core import chain) has
    // already timed a first test out at the 5s default.
    testTimeout: process.env.CI ? 30000 : 10000,
    hookTimeout: process.env.CI ? 30000 : 10000,
  },
});
