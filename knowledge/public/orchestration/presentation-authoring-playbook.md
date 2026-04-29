# Presentation Authoring Playbook

Use this playbook when the user asks for a PowerPoint deck, slides, a briefing pack, or a presentation artifact.

## Kyberion Fit

Presentation work should be handled as a coordination flow, not as a direct answer.
The value is in brief capture, audience fit, theme selection, source alignment, and reviewable structure.

Use Kyberion when the task has at least one of these properties:

1. It needs a deck, slide outline, or slide-ready narrative.
2. It depends on audience, tone, or brand style.
3. It should compare options, explain a process, or support an approval.
4. It should produce a reusable presentation artifact with source references.

## Brief And Theme Separation

Keep two layers distinct:

1. Brief layer: what the deck is about, who it is for, and what decision it supports.
2. Theme layer: how the deck should look and feel.

Use `presentation-preference-profile` to store the reusable theme and the first questions Kyberion should ask.

On first use, Kyberion should register the profile through the
`register-presentation-preference-profile` intent and persist it in the
presentation preference registry. That keeps theme selection and brief
questions out of code and lets the operator refine them as knowledge grows.

## Preflight

Before drafting slides, decide which brief questions and theme to use.

1. Read the stored `presentation-preference-profile`.
2. Pick the brief question set that matches the deck purpose.
3. Pick the theme set that matches the same purpose and audience.
4. Ask only the first 1-3 questions that would materially change the outline or the visual approach.
5. If no profile exists yet, create one in the personal overlay before drafting.

Keep this preflight short. It should decide how to frame the deck, not write the deck itself.

Good fits for this preflight include proposal decks, internal updates, briefing packs, marketing decks, training decks, and comparison slides.

## Workflow

1. Intent capture: preserve the original request and extract known facts.
2. Clarification pass: ask only the questions that change the content brief or theme.
3. Brief draft: create a presentation brief with goal, audience, sources, and constraints.
4. Theme selection: choose a theme hint from the profile, or ask if the choice is unclear.
5. Outline: produce the slide story and section structure.
6. Approval: pause before generating a final deck if source material or style needs confirmation.
7. Generate: build the deck with the selected brief and theme.
8. Review: propose reusable preference updates for `knowledge/personal/` only when the user approves.

## Outputs

Minimum output:

1. Current assumptions and unresolved blocking questions.
2. Brief summary and chosen theme.
3. Slide outline.
4. Approval preview if anything external or high-risk is needed.

Full output:

1. Presentation brief.
2. Theme selection summary.
3. Slide outline with speaker intent.
4. Final deck artifact.
5. Personal preference update proposal.
