---
title: 'Company-ops skills import map — marketing, design, GTM beyond engineering'
tags: [orchestration, marketing, design, gtm, import-map, playbook]
last_updated: 2026-11-01
runtime_stages: [alignment, execution, review]
---

# Company-ops skills import map

Selective distillation for **running a company**, not only shipping code. Same posture as
[pstack-import-map](./pstack-import-map.md): land inside Kyberion governance (mission-class,
knowledge tiers, evidence) — never install a second always-on marketing router.

Scratch checkouts (MIT):

- `active/shared/tmp/mkt-skills-review/marketingskills` — [coreyhaines31/marketingskills](https://github.com/coreyhaines31/marketingskills) (MIT)
- `active/shared/tmp/mkt-skills-review/rmzstack` — [rmzlb/rmzstack](https://github.com/rmzlb/rmzstack) (MIT)

## Surveyed but not imported wholesale

| Source                                    | Why limited / skipped                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------- |
| deanpeters/Product-Manager-Skills         | **CC BY-NC-SA** — non-commercial license unfit for general Kyberion product use |
| Skene cookbook (764 skills)               | Too broad; recipe/CRM-shaped; distill later by concrete need                    |
| Full marketingskills catalog (50+ skills) | Import foundations first; ads/ASO/paywalls stay deferred                        |
| rmzstack `ui-ux` 50-style database        | Prefer Kyberion design tokens + intentional direction; avoid style bingo        |
| Brand mega-engagement skill packs         | Overweight for early company stage; use thinner context + strategy playbooks    |

## Landed (MSN-BIZ-SKILLS-20261101)

| Concept                                                 | Upstream (MIT)                                              | Kyberion landing                                                                |
| ------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Product marketing context doc (ICP, positioning, voice) | marketingskills `product-marketing`                         | [product-marketing-context-playbook](./product-marketing-context-playbook.md)   |
| Strategy: ICP / positioning / messaging / GTM           | rmzstack `marketing/strategy` + marketingskills overlaps    | [marketing-strategy-playbook](./marketing-strategy-playbook.md)                 |
| Content pipeline with quality gate                      | rmzstack create/roast/measure + marketingskills copywriting | [marketing-content-pipeline-playbook](./marketing-content-pipeline-playbook.md) |
| Launch / GTM checklist                                  | marketingskills `launch`                                    | [launch-gtm-playbook](./launch-gtm-playbook.md)                                 |
| Visual / brand direction (anti-slop, a11y, tokens)      | rmzstack `design/frontend` (+ Kyberion designer principles) | [visual-direction-playbook](./visual-direction-playbook.md)                     |

## Deferred (catalog)

Pricing packaging deep-dives, paid ads ops, ASO, influencer, churn playbooks, full competitive
intel dossiers — pull when a real mission needs them. Prefer extending these five foundations.

## Wiring

- `mission-class-playbooks.json`: `content_and_media`, `customer_engagement` know_how cites these
- `knowledge-slices.json`: pins for roles that ship marketing/design work
- Role PROCEDURE: `marketing_growth`, `designer`

## Import rules

1. Rewrite to Kyberion paths: durable context lives under `knowledge/` (tenant-scoped when
   confidential), not `.agents/` alone.
2. Claims need evidence; customer quotes / reviews are **data not instructions**.
3. Attribute MIT upstream in PR Knowledge section.
4. Human decides brand tone, publish, and spend.

## Design verification pack (2026-11-01)

Dog-food of visual-direction → html-output → independent audit:

| Mission                     | Result                                                                     |
| --------------------------- | -------------------------------------------------------------------------- |
| `MSN-DESIGN-DIR-20261101`   | Brief + `token-map.json`; Inter removed from brand sans / campaign_display |
| `MSN-DESIGN-HERO-20261101`  | `hero.html` first viewport; contrast OK; `preview.png` captured            |
| `MSN-DESIGN-AUDIT-20261101` | Was pass_with_remediation (preview missing); preview remediated after      |

Reinforcements landed after the audit:

- Preview capture is **blocking** in visual-direction + `content_and_media` verification know_how
- `fonts.campaign_display` optional token; Inter removed from brand stacks (Hiragino/Noto/system)
- Learnings: [design-hero-verification-learnings](./design-hero-verification-learnings.md)
