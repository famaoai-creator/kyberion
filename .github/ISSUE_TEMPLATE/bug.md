---
name: Bug Report
about: Something Kyberion did wrong
title: "[bug] "
labels: bug
---

## What happened

<!-- One sentence: what's broken. -->

## How to reproduce

<!-- Step-by-step. The smaller the better. Include exact commands. -->

```bash
# e.g.
pnpm doctor
pnpm pipeline --input pipelines/example.json
```

## Expected behavior

## Actual behavior

<!-- Output / screenshots. Redact any secrets. -->

## Environment

- Kyberion version: <!-- output of `git rev-parse HEAD` and `node -e "console.log(require('./package.json').version)"` -->
- Node version: <!-- `node --version` -->
- pnpm version: <!-- `pnpm --version` -->
- OS: <!-- macOS Sonoma / Ubuntu 22.04 / Windows 11 / etc. -->
- Reasoning backend: <!-- output of `pnpm doctor` re. backend, or `KYBERION_REASONING_BACKEND` -->
- Customer overlay: <!-- `KYBERION_CUSTOMER` value, or "none" -->

## `pnpm doctor` output

<details>
<summary>Click to expand</summary>

```
(paste output here)
```

</details>

## Additional context

<!-- Links to logs, related issues, etc. -->
