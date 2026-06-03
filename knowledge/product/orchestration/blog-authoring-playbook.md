# Blog Authoring Playbook

Use this playbook when the user asks for a blog post, article, editorial draft, or web publication content.
It specializes the shared [Guided Coordination Protocol](knowledge/product/orchestration/guided-coordination-protocol.md) for long-form text production.

## Kyberion Fit

Blog work should be handled as a coordination flow, not as a direct answer.
The value is in brief capture, audience fit, outline quality, claim discipline, and a clear publish boundary.

Use Kyberion when the task has at least one of these properties:

1. It needs a blog post, article, or editorial draft.
2. It depends on audience, tone, or publication intent.
3. It should produce a reusable outline, draft, and publish-ready artifact.
4. It may need source alignment, SEO framing, or review before publication.

## Brief And Format Separation

Keep two layers distinct inside the shared coordination flow:

1. Brief layer: what the article is about, who it is for, and what change it should create.
2. Format layer: how the article should be structured and published.

Use a blog-specific brief profile to store reusable topic hints, the first questions Kyberion should ask, and the publish policy.

## Preflight

Before drafting the article, decide which brief questions and format to use.

1. Read the stored blog preference profile.
2. Pick the brief question set that matches the article purpose.
3. Pick the format set that matches the same audience and channel.
4. Ask only the first 1-3 questions that would materially change the outline, claims, or publish boundary.

Keep this preflight short. It should decide how to frame the article, not write the article itself.

Good fits for this preflight include technical posts, product updates, thought pieces, tutorials, announcements, and comparison articles.

## Workflow

1. Intent capture: preserve the original request and extract known facts.
2. Clarification pass: ask only the questions that change the brief, format, or publish policy.
3. Brief draft: create a blog brief with goal, audience, claims, sources, tone, and constraints.
4. Outline: produce the article structure and section order.
5. Draft: generate the article in markdown or another publishable text format.
6. Approval: pause before publication if source material, claims, rights, or brand risk need confirmation.
7. Publish preparation: prepare the title, excerpt, tags, slug, and channel-specific metadata.
8. Review: propose reusable preference updates for `knowledge/personal/` only when the user approves.

The `media-actuator` document-outline flow and document-generation flow are the closest existing building blocks.
For blog work, treat them as the default implementation path unless a dedicated blog renderer is introduced later.

The current reference implementation is the shell-free pipeline at [`pipelines/blog-article-from-brief.json`](/Users/famao/kyberion/pipelines/blog-article-from-brief.json). It demonstrates the intended blog contract shape: brief first, then outline, then draft artifact.

## Publish Boundary

Treat publication as a separate gate from drafting.

Safe defaults:

- allow the draft to complete
- prepare a draft or unpublished artifact first
- require human approval before public release
- stop if citations, rights, or factual support are missing

## Outputs

Minimum output:

1. Current assumptions and unresolved blocking questions.
2. Brief summary and chosen format.
3. Article outline.
4. Publish preview if anything external or high-risk is needed.

Full output:

1. Blog brief.
2. Format selection summary.
3. Article outline with section intent.
4. Final draft artifact.
5. Publish package and approval preview.
6. Personal preference update proposal.
