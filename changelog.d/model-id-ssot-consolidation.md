---
category: Changed
---

- **Model ids resolve through the provider-config SSOT** — Claude CLI/Agent backends, the meeting-actuator extractor label, the concierge setup surface, and the devin-cli backend no longer embed `'opus'`/`'sonnet'`/`'haiku'`/`'swe'` literals; they resolve via `resolveRuntimeModelId()` (`provider-config.json` `runtime_defaults`). A new `anthropic-standard` role (`claude-sonnet-5`) carries the standard tier, overridable via `KYBERION_ANTHROPIC_STANDARD_MODEL` / `KYBERION_CLAUDE_STANDARD_MODEL`.
