---
category: Fixed
---

- Preserve binary attachment bytes during S3 deal-home migration; relink only JSON and JSONL text.
- Preflight all tenants and reject unsupported entries, including invalid README nodes, before copying or deleting source data. Destination writes refuse overwrites.
- Exercise migration dry-run, binary preservation and source-preserving failure with real policies and isolated synthetic fixtures in registration checks.
