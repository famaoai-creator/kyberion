---
category: Fixed
---

- **The product intro video renders on Linux.** `scripts/kyberion_product_intro_render.ts` now narrates through espeak-ng as `wav` with a kana reading of the script on hosts other than macOS (espeak-ng reads kanji as "Chinese letter"). The on-screen text keeps the kanji. The espeak-ng TTS bridge now falls back to the language voice when the shared TTS config names a voice it does not ship, such as macOS `Kyoko`.
- **Narrated videos without a storyboard look less broken.** Headlines keep whole sentences and break on Japanese phrase boundaries (`word-break: auto-phrase` plus balanced wrapping) instead of ending in `…` or leaving a lone kana on its own line. The process scene now shows steps taken from its own sentence instead of repeating the other scenes' titles. Beats are timed by their share of the script instead of a fixed 33/45/22 split. The product intro follows the narration length instead of stopping at 60 seconds.
