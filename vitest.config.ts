import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
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
    // 並列実行を有効化
    threads: true,
    maxThreads: 4,
    minThreads: 1,

    // キャッシングを有効化
    cache: {
      dir: 'node_modules/.vitest',
    },

    // カバレッジ設定
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      exclude: ['node_modules/', 'dist/', '**/*.test.ts', '**/*.d.ts'],
      // 閾値設定
      lines: 60,
      functions: 60,
      branches: 60,
      statements: 60,
    },

    // タイムアウト設定
    testTimeout: 10000,
    hookTimeout: 10000,

    alias: [
      { find: /^@agent\/core\/(.*)$/, replacement: path.resolve(__dirname, './libs/core/$1') },
      { find: '@agent/core', replacement: path.resolve(__dirname, './libs/core/index.ts') },
      {
        find: '@agent/shared-media',
        replacement: path.resolve(__dirname, './libs/shared-media/src/index.ts'),
      },
      {
        find: '@agent/shared-vision',
        replacement: path.resolve(__dirname, './libs/shared-vision/src/index.ts'),
      },
      {
        find: '@agent/shared-network',
        replacement: path.resolve(__dirname, './libs/shared-network/src/index.ts'),
      },
      {
        find: '@agent/shared-business',
        replacement: path.resolve(__dirname, './libs/shared-business/src/index.ts'),
      },
    ],
  },
});
