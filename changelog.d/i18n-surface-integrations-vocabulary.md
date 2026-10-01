---
category: Changed
---

- **Surface and Slack integration replies now render through the vocabulary catalog (IT-02 part 1)** — about 280 hard-coded Japanese user-facing strings in `libs/core/surface/**` and `libs/core/integrations/**` (mission steering, steering rejections, approval ask-why/decision replies, task-session and knowledge-query replies, calendar agenda, operator notification labels, UX-contract repair rules, Slack onboarding) moved to `surface:*` / `integrations:*` keys with en and ja text. Replies follow the active locale (`resolveLocale()`, or an explicit `locale`) instead of a forced `ja`; English renders use the `State:` / `Result:` / `Next action:` labels so they satisfy the surface UX contract. The i18n hardcoding baseline dropped accordingly.
