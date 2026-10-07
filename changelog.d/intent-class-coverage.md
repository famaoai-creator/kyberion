---
category: Fixed
---

- **Every ontology intent now classifies into its declared mission class** — about 80 task- and reply-shaped intents (service operations, knowledge lifecycle, voice/media, onboarding, customer replies) no longer fall to the `code_change` default; nine generic reasoning-pattern intents are deliberately excluded. Classification-policy utterance patterns written as regexes (`.*`, `(a|b)`) are now evaluated as regexes instead of never matching.
