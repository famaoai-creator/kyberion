---
category: Fixed
---

- **Intent keywords no longer misroute ordinary requests** — equal-confidence intent matches are now broken by keyword rarity instead of catalog order, English keywords match whole words only (`search` no longer fires inside `research`), generic keywords (`実行`, `追加して`, `テスト`, `更新`) were removed from reasoning-pattern, reminder, booking and remediation intents, and meeting minutes, recordings and slide requests no longer resolve to calendar agenda reads. Measured on an unseen utterance set, intent accuracy rose from 44% to 71%; the new intent-resolution corpus guards it with dev, holdout and negative cases.
