---
category: Security
---

- **GitHub Dependabot and code-scanning alerts resolved** — removed the stale npm `package-lock.json` (23 alerts against an unused manifest; installs are pnpm-only) and added version-scoped overrides so `graphql-yoga`/`@graphql-yoga/plugin-defer-stream` resolve `@graphql-tools/utils@^12`, `katex` resolves to the supported `0.19.0` line (all `0.18.x` are deprecated upstream), and `postcss-selector-parser` resolves to `7.1.6`. HTML/XML stripping helpers now iterate until stable, accept `</tag ...>` close variants, and decode `&amp;` last; backtracking-prone regexes were replaced with linear scans; the browser-onboarding voice-sample guard and `core:transform` sandbox compile cleanly under CodeQL.
