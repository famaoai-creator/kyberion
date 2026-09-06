import { defineConfig } from 'vitest/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

function preferTypeScriptSourceForJsImports() {
  return {
    name: 'prefer-typescript-source-for-js-imports',
    enforce: 'pre' as const,
    resolveId(source: string, importer?: string) {
      if (!importer) return null;
      if (!source.startsWith('.') || (!source.endsWith('.js') && !source.endsWith('.mjs'))) {
        return null;
      }

      const importerPath = importer.startsWith('file://') ? fileURLToPath(importer) : importer;
      const resolved = path.resolve(path.dirname(importerPath), source);
      const base = resolved.slice(0, resolved.lastIndexOf('.'));
      const candidates = [
        `${base}.ts`,
        `${base}.mts`,
        `${base}.tsx`,
        path.join(path.dirname(base), 'index.ts'),
        path.join(path.dirname(base), 'index.mts'),
        path.join(path.dirname(base), 'index.tsx'),
      ];

      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }

      return null;
    },
  };
}

export default defineConfig({
  cacheDir: 'node_modules/.vitest',
  plugins: [preferTypeScriptSourceForJsImports()],
  test: {
    include: [
      '**/src/**/*.test.ts',
      '**/src/**/*.test.js',
      // Presence Studio keeps route/security contract tests beside the
      // server split rather than under src; include them in the root suite
      // so the contracts are not silently skipped by the default glob.
      'presence/displays/presence-studio/**/*.test.ts',
      // The Nexus bridge is a production daemon outside a package src tree;
      // keep its parser/resource-boundary tests in the root suite as well.
      'presence/bridge/**/*.test.ts',
      // Voice Hub is another production daemon outside a package src tree;
      // keep its runtime-boundary tests in the root suite as well.
      'satellites/voice-hub/**/*.test.ts',
      'libs/core/**/*.test.ts',
      'libs/actuators/**/*.test.ts',
      'libs/shared-*/**/*.test.ts',
      'scripts/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.worktrees/**',
      // Provider state dirs hold full repo checkouts (`.claude/worktrees/`).
      // Discovering their test copies runs two instances of the same suite
      // concurrently against the SAME shared fixture paths (e.g.
      // knowledge/confidential/client-a/design/), so they delete each other's
      // temp files — surfacing as spurious ENOENT/ENOTEMPTY failures that look
      // like real regressions. Same root cause as the eslint ignore.
      '**/.claude/**',
      '**/.codex/**',
      '**/vault/**',
      '**/active/**',
      '**/docs/**',
      '**/knowledge/**',
      '**/.pnpm-store/**',
      // Not in pnpm-workspace.yaml's packages list - archived code kept for
      // reference, with no guaranteed-valid tsconfig for vitest to resolve.
      '**/retired/**',
    ],
    // Process-isolated workers: many suites mutate process.env
    // (KYBERION_ROOT tmp roots, MISSION_ROLE, personas). worker_threads share
    // env across concurrently running files, which caused an entire class of
    // combined-run flakes (writes landing in another suite's tmp root).
    pool: 'forks',
    maxWorkers: 4,
    setupFiles: ['./tests/vitest-network-guard.ts'],
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
      // IP-03 baseline ratchet from 2026-07-03 core coverage run.
      // Do not lower these thresholds; raise them as coverage improves.
      thresholds: {
        lines: 67,
        functions: 69,
        branches: 52,
        statements: 65,
      },
    },
    // Shared CI runners are 3-8x slower than a dev Mac; the 10s default
    // produced a steady drip of per-suite timeout whack-a-mole (see
    // kyberion-development-practices §2). Locally the tight bound stays so
    // slow tests are still noticed where they are written.
    testTimeout: process.env.CI ? 30000 : 10000,
    hookTimeout: process.env.CI ? 30000 : 10000,
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
    ],
  },
});
