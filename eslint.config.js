import globals from "globals";
import nextPlugin from "@next/eslint-plugin-next";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: [
      "node_modules/**",
      "**/node_modules/**",
      "dist/**",
      "**/dist/**",
      ".next/**",
      "**/.next/**",
      "coverage/**",
      "evidence/**",
      "active/**",
      "work/shared/external/**",
      "vault/**",
      "tests/**",
      "scripts/**",
      "tools/**",
      "libs/core/*.ts",
      "**/*.d.ts",
      "**/*.d.cts",
    ],
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: "off",
    },
  },
  {
    files: ["**/eslint.config.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ["**/*.cjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-unused-vars": "off",
      "no-console": "off",
      "no-undef": "error",
    },
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    ignores: ["**/eslint.config.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-unused-vars": "off",
      "no-console": "off",
      "no-undef": "error",
    },
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
  })),
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/ban-ts-comment": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-unsafe-function-type": "off",
      "prefer-const": "off",
    },
  },
  {
    files: ["presence/displays/chronos-mirror-v2/src/**/*.{ts,tsx}"],
    plugins: {
      "@next/next": nextPlugin,
    },
    settings: {
      next: {
        rootDir: "presence/displays/chronos-mirror-v2/",
      },
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      "@next/next/no-html-link-for-pages": "off",
    },
  },
  {
    files: ["scripts/**/*.ts", "tests/**/*.ts", "libs/shared-*/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "fs",
              message:
                "Violation of AGENTS.md: Use @agent/core/secure-io (safeReadFile, safeWriteFile) instead of direct fs access.",
            },
            {
              name: "node:fs",
              message:
                "Violation of AGENTS.md: Use @agent/core/secure-io (safeReadFile, safeWriteFile) instead of direct node:fs access.",
            },
            {
              name: "child_process",
              message:
                "Violation of AGENTS.md: Use @agent/core/secure-io (safeExec) instead of direct child_process access.",
            },
            {
              name: "node:child_process",
              message:
                "Violation of AGENTS.md: Use @agent/core/secure-io (safeExec) instead of direct node:child_process access.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["libs/actuators/**/*.ts", "satellites/**/*.ts", "presence/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/fs-primitives*"],
              message: "fs-primitives is foundation-only. Use @agent/core/secure-io instead.",
            },
          ],
          paths: [
            {
              name: "fs",
              message: "Use @agent/core/secure-io instead of direct fs access.",
            },
            {
              name: "node:fs",
              message: "Use @agent/core/secure-io instead of direct node:fs access.",
            },
          ],
        },
      ],
    },
  },
];
