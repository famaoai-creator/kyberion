---
category: Security
---

- **`pnpm mission distill` checks provider egress and can use the `claude` CLI.**
  - Confidential and personal missions are no longer sent to an LLM provider unless that provider passes the tier egress gate (`provider-egress-policy.json`: a tenant attestation of `training_use: none`, local-only, or an approved exception). Before, distill sent the mission state and evidence to codex or gemini regardless of tier. Denied providers are skipped; when none is allowed, distill uses structural (no-LLM) distillation. Public missions are unchanged.
  - The mission LLM helpers (`runAdaptiveStructuredLlmProfile`, `runStructuredLlmProfile`, `invokeLlm`) apply the same gate and treat an undeclared data tier as confidential. Callers sending public content must pass `egress: { dataTier: 'public' }`. The provider is identified by the command a shell profile actually runs; a profile whose adapter and command name different providers is denied above public.
  - `wisdom-policy.json` gains a `claude` profile, tried after the codex and gemini profiles. It runs `claude -p --output-format json` as a single tool-less turn (`--max-turns 1 --tools "" --strict-mcp-config --setting-sources= --disable-slash-commands --no-session-persistence`) from an empty scratch directory, with the system prompt and prompt on stdin. On a host with only `claude` installed, public missions now get LLM distillation. Shell profiles can set `prompt_via: "stdin"` so the prompt never appears in argv (process table, argument-size limit).
  - The `claude` profile runs the same binary its probe checked: `KYBERION_CLAUDE_CLI_BIN` / managed provider env first, then, when no binary is pinned, an installed `claude` outside `node_modules/.bin`.
