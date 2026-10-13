---
category: Fixed
---

- **Japanese intent matching now sees real words** — utterances in spaceless scripts were tokenized as one whole sentence, so surface-example overlap scoring never fired for Japanese input. Tokenization now uses `Intl.Segmenter` word granularity via `segmentWords()` (locale-agnostic, delimiter fallback), and trigger matching additionally unifies half-width katakana, word-final prolonged marks (サーバー == サーバ), honorific お/ご prefixes, and trailing request endings (〜してください, 〜ます). Surface-example overlap now requires two shared tokens, so a lone common verb can no longer hijack the ranking.
