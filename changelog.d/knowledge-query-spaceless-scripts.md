---
category: Fixed
---

- **Japanese knowledge queries** — `queryKnowledge` / `queryKnowledgeHybrid` split topics on whitespace only, so a Japanese sentence was one token and matched nothing (e.g. a peer auto reply found no tenant knowledge). Words in spaceless scripts now go through the shared `segmentWords` (Intl.Segmenter); kana-only and one-character segments are dropped.
