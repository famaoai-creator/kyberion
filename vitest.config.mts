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
      exclude: [
        'node_modules/',
        'dist/',
        '**/*.test.ts',
        '**/*.d.ts',
        // Runtime-only integration surfaces are exercised via operational/integration flows,
        // not isolated unit coverage.
        'libs/core/acp-mediator.ts',
        'libs/core/agent-adapter.ts',
        'libs/core/business-types.ts',
        'libs/core/index.ts',
        'libs/core/kill-switch.ts',
        'libs/core/orchestrator.ts',
        'libs/core/platform.ts',
        'libs/core/policy-engine.ts',
        'libs/core/provider-discovery.ts',
        'libs/core/pty-engine.ts',
        'libs/core/reflex-terminal.ts',
        'libs/core/sensor-engine.ts',
        'libs/core/terminal-bridge.ts',
        'libs/core/voice-synth.ts',
        // Large script refactors are covered indirectly through command/build paths.
        'scripts/refactor/**/*.ts',
      ],
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
