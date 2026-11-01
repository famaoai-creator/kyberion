---
title: 'Design hero verification learnings — preview gate and token fidelity'
tags: [orchestration, design, verification, learnings, playbook]
last_updated: 2026-11-01
runtime_stages: [verification, retrospective]
---

# Design hero verification learnings

From the 2026-11-01 dog-food pack (`MSN-DESIGN-DIR` → `HERO` → `AUDIT`).

## What failed closed (keep this)

Independent audit against [visual-direction-playbook](./visual-direction-playbook.md) failed
**preview/screenshot missing** even when contrast math and token mapping looked green. Source-only
judgment is not acceptance. Capture recipe is now in the playbook; `content_and_media` verification
know_how requires `evidence/preview.png` for HTML/hero.

## What held

- Five-line brief + `token-map.json` before HTML prevented palette invent.
- Brand tokens dropped Inter; `fonts.sans` / `campaign_display` use Hiragino/Noto/system stacks.
  Override `campaign_display` only with an evidenced brand decision.
- First-viewport budget (brand / headline / support / CTA / one visual) matched the rendered
  preview once captured.

## Artifact pointers

- Hero: `active/archive/missions/public/shared/MSN-DESIGN-HERO-20261101/evidence/hero.html`
- Preview: same directory `preview.png` (also captured under
  `active/shared/tmp/design-hero-preview-20261101/preview.png`)
- Audit: `…/MSN-DESIGN-AUDIT-20261101/evidence/design-audit.md`

## Open brand decision (human)

`campaign_display` currently mirrors `sans` (no Inter). A distinctive campaign face is still an open
human brand decision — change the token with evidence, then re-preview.
