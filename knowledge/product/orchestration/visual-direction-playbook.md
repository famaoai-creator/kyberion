---
title: 'Visual Direction Playbook — intentional aesthetics, a11y, Kyberion tokens'
tags: [orchestration, design, brand, ui, playbook]
last_updated: 2026-11-01
runtime_stages: [alignment, execution, verification]
---

# Visual Direction Playbook

Distilled from rmzstack `design/frontend` (+ a11y priorities from `ui-ux`) and aligned with Kyberion
designer working principles (MIT upstream; see
[company-ops-skills-import-map](./company-ops-skills-import-map.md)).

Use when choosing or reviewing look-and-feel for product UI, landing pages, decks, or brand-facing
artifacts. Does **not** replace media-specific authoring playbooks — it sets direction first.
For HTML a person will read/present, follow [html-output-playbook](./html-output-playbook.md)
**after** this brief exists (HTML file last).

## Token sources (concrete)

| Need                      | Path                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| Brand colors / type roles | `knowledge/public/design-patterns/brand-tokens/kyberion.json` (+ `kyberion-foundation.json`) |
| Semantic / media defaults | `knowledge/public/design-patterns/semantic-design-tokens.json` and `media-templates/`        |
| Web theme pack            | `knowledge/public/design-patterns/web/chronos-web-theme-pack.json`                           |
| Pattern catalog index     | `knowledge/public/design-patterns/README.md`                                                 |

**Typography:** brand `fonts.sans` / `fonts.campaign_display` lead with Helvetica Neue / Arial, then
JP faces (Hiragino / Noto / Yu Gothic / Meiryo) and system-ui — **not** Inter. Keep product and
campaign aligned with those tokens; override `campaign_display` only with an evidenced brand decision.

## Principles

1. **Commit to one aesthetic direction** (tone + differentiation) before polishing pixels.
2. **Reuse tokens** above — no ad-hoc hex sprawl. Gap = note it; do not invent a parallel system.
3. **Accessibility gates first** — contrast ≥4.5:1 body / ≥3:1 large; visible focus; keyboard order;
   alt text / aria for icon-only controls. Compute contrast against the actual bg/fg pair.
4. **Avoid AI-default composition** — purple-on-white gradients, icon-above-every-heading rows,
   empty “premium” glass cards, pill-stat strips in the first viewport. Typography defaults follow
   the token tension note above.
5. **Judge the rendered artifact** (screenshot/preview), not only source.
6. **One job per section / one hero per first viewport** for landing-style work (aligns with
   html-output and frontend design rules in AGENTS user guidance).

## Design brief template (required deliverable)

Write these five lines before any prototype:

1. **Purpose** — what decision or action this surface enables
2. **Audience** — who sees it (role)
3. **Tone** — one extreme (e.g. industrial utilitarian, editorial quiet, luminous ops)
4. **Constraints** — tokens, light/dark, locale, time budget
5. **Differentiator** — the one memorable visual idea (not a feature list)

## Steps

1. Fill the brief template; store under mission `evidence/design-brief.md`.
2. Map brief → token keys (colors, type roles, spacing). Record `evidence/token-map.json`.
3. Prototype **only** the first viewport / hero; pause for human direction approval when external.
4. Implement with the relevant media/HTML/UI playbook (html-output, presentation, etc.).
5. Capture a **rendered** preview into mission `evidence/preview.png` (recipe below), then run the
   acceptance checklist. Source + contrast math alone is **not** done.
6. Independent audit (different actor) scores the checklist against the preview; promote accepted
   direction into marketing context Learnings or design-patterns notes.

## Preview capture (blocking)

HTML / landing / hero work is incomplete until `evidence/preview.png` (or equivalent path recorded
in the audit) exists. Preferred local capture:

```bash
# macOS Chrome — first viewport
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --hide-scrollbars \
  --window-size=1440,900 \
  --screenshot="evidence/preview.png" \
  "file://$PWD/evidence/hero.html"
```

Otherwise use the browser actuator screenshot path. Then judge the **image** (brand weight, clutter,
contrast in situ), not only the HTML source. Dog-food: MSN-DESIGN-AUDIT-20261101 failed this item
until a preview was added.

## Acceptance checklist (verification)

Blocking — all must pass before `verify` / “design done”:

- [ ] Brief has all five lines
- [ ] Every color in the prototype maps to a named token (or an evidenced exception)
- [ ] Body text contrast ≥ 4.5:1 on its background (state the pair and ratio)
- [ ] First viewport: brand/product signal + one headline + one support line + one CTA group + one
      dominant visual — no stat strip / promo cluster
- [ ] Focus styles visible for interactive controls
- [ ] `evidence/preview.png` (or recorded path) exists and was judged as a rendered artifact

## Related

- Designer role PROCEDURE + working-principles designer addendum
- [html-output-playbook](./html-output-playbook.md) / presentation / video authoring
- [marketing-content-pipeline-playbook](./marketing-content-pipeline-playbook.md) for copy gates
- [product-marketing-context-playbook](./product-marketing-context-playbook.md)
- [design-hero-verification-learnings](./design-hero-verification-learnings.md)
