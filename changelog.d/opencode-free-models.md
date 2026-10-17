---
category: Added
---

- **OpenCode backend runs the live free-model catalog with image input** — the governed model registry now lists ten probed OpenCode free models (GLM-5.3-Flash Free, MiMo, DeepSeek, Nemotron family, Beam, Space Bunny, LongCat, Big Pickle) with measured capability evidence (two-round text probes, vision probes, latency), promotes eight to `approved`, blocks the unreachable `nemotron-3-ultra-free`, and marks `nemotron-3.5-lightning-free` slow. A new `opencode-cli-glm-free` route profile selects GLM-5.3-Flash Free. `OpencodeCliReasoningBackend` gains governed `promptWithImages` support (`--file` attachments with count, path, size, and magic-bytes validation), `supportsVision` descriptor input modalities now include image, and the backend no longer passes the removed `--dir` flag so real CLI calls succeed on opencode 2.x.
