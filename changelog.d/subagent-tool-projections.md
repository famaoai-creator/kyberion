---
category: Fixed
---

- **Per-provider subagent tool projections now deliver what the capability tier promises** — AGY `implementer` agents can finally create files (`write_to_file`, `multi_replace_file_content` added from the verified agy 1.4.11 vocabulary behind a checked `AGY_KNOWN_TOOLS` set), Claude explorer/reviewer tiers gain `LS`, `WebFetch`, `WebSearch` (matching their `network:fetch` ops) and implementers gain `BashOutput`/`KillShell` plus the same read/web tools, and the governed `canUseTool` gate + harness ceiling were synced so newly advertised tools are not denied at call time. Generated role coverage expanded to six roles across all five provider projections — codex planner files are no longer emitted, since a `read-only` sandbox still runs shell commands and cannot satisfy the no-execution tier.
