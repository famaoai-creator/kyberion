---
category: Added
---

- **Claude Haiku 5.5 is registered** — `anthropic:claude-haiku-5-5` joins the model registry (fast tier, 1M context, 128K output) and the Claude provider model list, with base cost rates of $0.10 / $0.50 per MTok in the cost registry. The Claude defaults and the `haiku` alias still point at Haiku 4.5; the backend does not send `output_config.effort` to it until that support is verified.
