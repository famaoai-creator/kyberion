---
category: Security
---

- **secure-io no longer writes or reads through symbolic links into another scope** — every write and read helper now checks the canonical (link-resolved) path as well as the literal one, so a persona can no longer plant a link in `active/shared/tmp/` and write through it into a path it may only read (for example `scripts/`), or read `knowledge/personal/` through it. `safeSymlinkSync` (and the orchestrator `symlink` pipeline op) now requires write permission on the link target, refuses targets outside the repository, and accepts only `dir` / `file` links (`junction` is refused). `safeLinkExclusiveSync` requires write permission on the source. Callers that linked to a read-only target, or to a directory outside the checkout such as `os.tmpdir()`, must copy instead.
