---
category: Changed
---

- **Japanese slide titles break on phrases.** PPTX titles that would wrap get explicit, balanced line breaks at phrase boundaries. For example 「…変革の／ご提案」 instead of 「…変革のご／提案」. The text-fit estimator now applies kinsoku, so wrapped lines never start with 、。」 or small kana.
- **Speaker notes reach the deck.** `speaker_notes` on brief sections, storyline slides or slide definitions is written as PowerPoint notes. The deck gets a proper notes master, relationships and content types. Notes content types are now numbered by slide, which also fixes decks where only some slides had notes.
- **Truncated components are reported.** WBS, timeline, org-chart, swimlane and KPI components that drop items past their row cap now record a `structured.<kind>` overflow with `droppedItems` in the slide's `layoutFit`, so layout preflight flags the drop.
