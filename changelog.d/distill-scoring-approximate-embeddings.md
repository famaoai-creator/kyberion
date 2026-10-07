---
category: Fixed
---

- **Distill retrieval no longer returns unrelated notes by default.** The default embedding backend is a hash approximation that rates almost every pair of texts as similar, so any query filled the hint budget with distills and `minScore` had no effect. With an approximate backend, only distills that clear the lexical `minScore` are returned, and the semantic score only re-orders them. Returned scores are back on the 0..1 lexical scale, so a relevant distill is no longer always outranked by tenant documents in the context pack. A real semantic backend can still add matches without word overlap, such as cross-lingual queries.
