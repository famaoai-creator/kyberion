---
category: Fixed
---

- **Japanese text now scores in similarity and keyword matching** — the best-of-providers agreement judge, the local hash embedding, experience-library cue lookup, memory-notebook queries, procedure phrase overlap, intent-compiler knowledge hints, audio-text WER and the terminal-hud command palette tokenized on whitespace, which made a Japanese sentence one token. They now use the shared ICU segmenter (`segmentWords` / new `segmentKeywordTerms` in `@agent/core/locale-normalize`). The local hash embedding's cache identity changed, so its knowledge-index disk cache is rebuilt once; no action needed.
