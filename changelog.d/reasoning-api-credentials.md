---
category: Added
---

- Add `pnpm kyberion reasoning credentials register|status|verify --provider <mode>`. Registration reuses governed secret introduction, hidden input and the OS secret store; model selection is separate from the key and an existing selection can be reused. `verify --model <id> --allow-paid` sends one synthetic request, capped at 128 output tokens, with no retries, redirects or CLI fallback, and stores metadata only in the current physical scope.
- API proof protocols and endpoints are declared in the existing `reasoning-providers/*.json` descriptors, so a compatible provider needs configuration rather than caller edits. Add OpenAI Responses as a direct API backend, separate from Codex CLI login, and proof metadata for Anthropic, Gemini, OpenRouter, NVIDIA Nemotron and Grok. Existing tenant credential binding and egress policy remain enforced.
