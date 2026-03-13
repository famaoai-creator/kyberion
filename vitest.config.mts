import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  cacheDir: 'node_modules/.vitest',
  test: {
    include: [
      '**/src/**/*.test.ts',
      '**/src/**/*.test.js',
      'libs/core/**/*.test.ts',
      'libs/actuators/**/*.test.ts',
      'libs/shared-*/**/*.test.ts',
      'scripts/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/vault/**',
      '**/active/**',
      '**/docs/**',
      '**/knowledge/**',
    ],
    threads: true,
    maxThreads: 4,
    minThreads: 1,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      exclude: ['node_modules/', 'dist/', '**/*.test.ts', '**/*.d.ts'],
      lines: 60,
      functions: 60,
      branches: 60,
      statements: 60,
    },
    testTimeout: 10000,
    hookTimeout: 10000,
    alias: [
      { find: /^@agent\/core\/(.*)$/, replacement: path.resolve(rootDir, './libs/core/$1') },
      { find: '@agent/core', replacement: path.resolve(rootDir, './libs/core/index.ts') },
      {
        find: '@agent/shared-media',
        replacement: path.resolve(rootDir, './libs/shared-media/src/index.ts'),
      },
      {
        find: '@agent/shared-vision',
        replacement: path.resolve(rootDir, './libs/shared-vision/src/index.ts'),
      },
      {
        find: '@agent/shared-network',
        replacement: path.resolve(rootDir, './libs/shared-network/src/index.ts'),
      },
      {
        find: '@agent/shared-business',
        replacement: path.resolve(rootDir, './libs/shared-business/src/index.ts'),
      },
    ],
  },
});
