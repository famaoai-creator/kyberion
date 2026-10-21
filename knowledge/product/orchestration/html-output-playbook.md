---
title: HTML Output Playbook — pages a person will read, present, or print
tags: [orchestration, html, presentation, authoring, playbook]
last_updated: 2026-10-05
runtime_stages: [alignment, execution]
---

# HTML Output Playbook

Use this whenever the deliverable is HTML a person will read, present, or print: a briefing, a report, a committee paper, a deck exported as HTML. Application UI, email templates, and test fixtures are out of scope.

The HTML file is the last step. Write the notes for steps 1–6 first (a task-session payload, or a short note beside the output path). Do not open the HTML file until step 6 passes.

## 1. Preconditions

Record these before any page exists:

- **Audience.** Who decides, who presents, and who only needs to follow. Name the roles.
- **Time.** The presentation or reading budget, and how it splits across sections.
- **Design system.** The organization's own guide when it has one. Use only its colors, type, and components. When it has none, use `resolveCreativeDesign` and the engine design-defaults. Do not invent a palette for the file.
- **Sources.** What was fetched, the as-of date, and what is still unfetched. An unfetched section says so. Do not fill it with an older number.

## 2. Scenario

For each audience role, one sentence: what they can decide or do after reading.

Then one line per page: the single thing that page must convey. The page count equals that list. Cut a page that serves no role.

## 3. Necessary and sufficient

Match the scenario to the sources.

- Required and missing: go back and fetch it, or mark the page "not fetched today".
- Present and unused by any role: cut it, or move it to an appendix.

Do not cover a gap with extra sentences.

## 4. Layout

One hero per page, so the point is visible before the sentences:

| The point        | The hero           |
| ---------------- | ------------------ |
| Change over time | A band or bars     |
| A comparison     | Cards side by side |
| A cause          | An arrow           |
| A checklist      | One row per item   |

Motion is what HTML adds over a slide: click a step to open its detail, switch a toggle and watch the dependent numbers change, step through a timeline, hover a segment to read what it is. Use motion to let the reader explore one point at a time. Do not use it to decorate.

Default form is a scrolling page: a short hero, numbered sections, one interactive element per section where it helps, full sentences. Do not imitate a slide deck unless the page will be projected one screen at a time; in that case, and only then, fix a 16:9 canvas.

Limits: a table has at most 4 columns and 7 rows. Body text is at least 15px. If the point does not fit, split the section.

On print, each section starts on its own page (`break-before: page` on `section`), interactive panels show their default state, and nothing depends on hover.

## 5. Language

Read every sentence in the reader's language. One idea per sentence. Each sentence has a subject. Write at natural length: a sentence that explains why is better than a clipped label the reader has to decode.

When the page is in Japanese, drop 「〜について」「〜等」「〜の実施」「〜に関して」, and keep the connective that makes the reasoning follow (「〜ため」「〜ので」「〜が」). On first use, give an in-house acronym its plain words.

Rewrite any sentence that stumbles when read aloud.

## 6. Read-back

Read as the decision-maker: can they decide from these pages alone?

Read as the presenter: does the page count fit the time budget?

If either answer fails, return to step 2. The HTML file stays unwritten.

## 7. Write the file

One self-contained HTML file. No external CSS, fonts, or images. Inline the tokens from step 1. One `section` per page from step 2. The page count matches step 2.

When a person will mark the file up, open it through report-review (`scripts/report-review/server.ts`) on 127.0.0.1. Saving strips the review layer. The stored file stays the clean HTML.
