---
category: Added
---

- Add explicit compact/readable JSON feedback for verified public diagnostic receipts, with immutable parent lineage, a fresh scoped human approval, distinct verified artifact bytes and original-conversation reporting. Default execution mappings remain empty.
- Add Concierge version selection and retry/navigation fencing, plus typed Concierge and Presence API admission; reject stale, concurrent, mismatched and unauthorized revisions without replaying uncertain work.
- Preserve write-policy checks while publishing diagnostic artifact versions atomically without replacement, and fence revision-bearing transcripts as v4. This does not add general content regeneration or Pads integration.
