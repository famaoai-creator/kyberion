import globals from 'globals';
import nextPlugin from '@next/eslint-plugin-next';
import importPlugin from 'eslint-plugin-import';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: [
      '.tmp-mulmoclaude/**',
      '.pnpm-store/**',
      '.worktrees/**',
      // Provider state dirs are gitignored and regenerated via generation
      // ceremonies (AGENTS.md §1). `.claude/worktrees/` holds full repo
      // checkouts, so linting into them makes typescript-eslint see multiple
      // candidate tsconfigRootDirs and fail across the whole repo. Only .md and
      // .json are tracked under .claude/, so nothing lintable is lost.
      '.claude/**',
      '.codex/**',
      '.tmp-agency-agents/**',
      'node_modules/**',
      '**/node_modules/**',
      '.venv/**',
      'dist/**',
      '**/dist/**',
      '.next/**',
      '**/.next/**',
      'coverage/**',
      'evidence/**',
      'active/**',
      'work/shared/external/**',
      'vault/**',
      'tools/**',
      'libs/core/**/*.js',
      'libs/core/**/*.js.map',
      '**/*.d.ts',
      '**/*.d.cts',
    ],
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
  },
  {
    files: ['**/eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': 'off',
      'no-console': 'off',
      'no-undef': 'error',
    },
  },
  {
    // Playwright operation scripts: the driver half runs in Node, but the
    // callbacks passed to page.evaluate() are serialized and run inside the
    // browser, where `document` and friends genuinely exist. Without this the
    // browser half reads as undefined globals. (These errors predate the
    // .claude/** ignore above — they were masked while the parser failed
    // repo-wide.)
    files: ['knowledge/**/operations/scripts/**/*.cjs'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    ignores: ['**/eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': 'off',
      'no-console': 'off',
      'no-undef': 'error',
    },
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
  })),
  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: {
      import: importPlugin,
    },
    settings: {
      'import/resolver': {
        typescript: true,
      },
      'import/extensions': ['.js', '.mjs', '.cjs', '.ts', '.tsx'],
    },
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      // Default off; the widened ratchet below turns it on for libs/,
      // scripts/, satellites/ and presence/ (see that block for the three
      // named, counted carve-outs).
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      // IP-11 Task 3: @ts-ignore silently suppresses real type errors with no
      // trace of why; @ts-expect-error fails loudly if the error stops
      // reproducing, and is required to carry a reason.
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-ignore': true,
          'ts-expect-error': 'allow-with-description',
          'ts-nocheck': true,
          'ts-check': false,
        },
      ],
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
      'prefer-const': 'off',
      // IP-08: an empty catch must carry a reason comment (no-empty ignores
      // blocks that contain a comment).
      'no-empty': ['error', { allowEmptyCatch: false }],
    },
  },
  {
    // SX phase-2: the no-unused-vars ratchet now covers the whole maintained
    // source surface, not the 10-file allowlist it started as. Dead locals,
    // helpers, types and missed imports are removed at the source; `_` is
    // reserved for bindings a signature or destructuring position forces to
    // exist. `args`/`caughtErrors` stay off so interface-conforming handler
    // params and `catch (err)` are not churned.
    files: [
      'libs/**/*.ts',
      'scripts/**/*.ts',
      'satellites/**/*.ts',
      'presence/**/*.ts',
      'presence/**/*.tsx',
    ],
    ignores: ['**/*.test.ts', '**/*.spec.ts', '**/*.generated.ts', '**/dist/**'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'none',
          caughtErrors: 'none',
          ignoreRestSiblings: true,
          varsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // Keep the editor rule on the maintained production trees. The module
    // boundary checker remains the authoritative full-graph ratchet.
    files: ['libs/**/*.ts', 'scripts/**/*.ts'],
    plugins: {
      import: importPlugin,
    },
    settings: {
      'import/resolver': {
        typescript: true,
      },
      'import/extensions': ['.js', '.mjs', '.cjs', '.ts', '.tsx'],
    },
    rules: {
      'import/no-cycle': ['error', { maxDepth: 1 }],
    },
  },
  {
    files: [
      'libs/**/*.ts',
      'scripts/**/*.ts',
      'satellites/**/*.ts',
      'presence/**/*.ts',
      'presence/**/*.tsx',
    ],
    ignores: [
      '**/*.test.ts',
      '**/*.spec.ts',
      'libs/core/secure-io.ts',
      'libs/core/fs-primitives.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.object.name='fs'][callee.property.name=/^(read|write|append|rm|unlink|mkdir|stat|lstat|readdir)Sync$/]",
          message: 'Use the governed secure-io boundary instead of direct filesystem calls.',
        },
      ],
    },
  },
  {
    files: ['presence/displays/chronos-mirror-v2/src/**/*.{ts,tsx}'],
    plugins: {
      '@next/next': nextPlugin,
    },
    settings: {
      next: {
        rootDir: 'presence/displays/chronos-mirror-v2/',
      },
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      '@next/next/no-html-link-for-pages': 'off',
    },
  },
  {
    files: ['libs/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'fs',
              message:
                'Violation of AGENTS.md §1: Use @agent/core/secure-io instead of direct fs access.',
            },
            {
              name: 'node:fs',
              message:
                'Violation of AGENTS.md §1: Use @agent/core/secure-io instead of direct node:fs access.',
            },
            {
              name: 'child_process',
              allowTypeImports: true,
              message:
                'Violation of AGENTS.md §1: Use @agent/core/secure-io safeExec/managed-process wrappers instead of direct child_process access.',
            },
            {
              name: 'node:child_process',
              allowTypeImports: true,
              message:
                'Violation of AGENTS.md §1: Use @agent/core/secure-io safeExec/managed-process wrappers instead of direct node:child_process access.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['libs/core/secure-io.ts', 'libs/core/fs-primitives.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
  {
    files: ['scripts/**/*.ts', 'tests/**/*.ts', 'libs/shared-*/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'fs',
              message:
                'Violation of AGENTS.md: Use @agent/core/secure-io (safeReadFile, safeWriteFile) instead of direct fs access.',
            },
            {
              name: 'node:fs',
              message:
                'Violation of AGENTS.md: Use @agent/core/secure-io (safeReadFile, safeWriteFile) instead of direct node:fs access.',
            },
            {
              name: 'child_process',
              message:
                'Violation of AGENTS.md: Use @agent/core/secure-io (safeExec) instead of direct child_process access.',
            },
            {
              name: 'node:child_process',
              message:
                'Violation of AGENTS.md: Use @agent/core/secure-io (safeExec) instead of direct node:child_process access.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['scripts/ts-loader.mjs', 'tests/**/*.ts', '**/*.test.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
  {
    // IP-08 Task 5.3: library code must not call process.exit — throw and let
    // the CLI entry guard decide. Excluded files are CLI/harness surfaces.
    files: ['libs/**/*.ts'],
    ignores: [
      'libs/**/src/index.ts',
      'libs/**/examples/**',
      'libs/core/cli-utils.ts',
      'libs/core/test-utils.ts',
      'libs/core/skill-wrapper.ts',
      '**/*.test.ts',
    ],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'exit',
          message:
            'IP-08: library code must throw instead of process.exit; exits belong to CLI entry guards (see IP-08 plan Task 5).',
        },
      ],
    },
  },
  {
    files: [
      'libs/actuators/**/*.ts',
      'satellites/**/*.ts',
      'presence/**/*.ts',
      'presence/**/*.tsx',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/fs-primitives*'],
              message: 'fs-primitives is foundation-only. Use @agent/core/secure-io instead.',
            },
          ],
          paths: [
            {
              name: 'fs',
              message: 'Use @agent/core/secure-io instead of direct fs access.',
            },
            {
              name: 'node:fs',
              message: 'Use @agent/core/secure-io instead of direct node:fs access.',
            },
          ],
        },
      ],
    },
  },
];
