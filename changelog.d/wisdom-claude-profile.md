---
category: Fixed
---

- **`pnpm mission distill` can use the `claude` CLI.** `wisdom-policy.json` gains a `claude` profile (`claude -p {prompt} --output-format json`, `json_envelope`), tried after the codex and gemini profiles. On a host with only `claude` installed, distillation now uses an LLM instead of falling back to structural distillation. The probe and the run use the same binary: `KYBERION_CLAUDE_CLI_BIN` / managed provider env first, then, when no binary is pinned, an installed `claude` outside `node_modules/.bin` (so the pnpm placeholder shim does not hide it).
