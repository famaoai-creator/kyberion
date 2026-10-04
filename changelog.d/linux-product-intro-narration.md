---
category: Fixed
---

- **The product intro video renders on Linux.** `scripts/kyberion_product_intro_render.ts` now narrates through espeak-ng as `wav` with a kana reading of the script on hosts other than macOS (espeak-ng reads kanji as "Chinese letter"). The on-screen text keeps the kanji. The espeak-ng TTS bridge now falls back to the language voice when the shared TTS config names a voice it does not ship, such as macOS `Kyoko`.
