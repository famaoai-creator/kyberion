# Use-Case Quickstarts

Three short paths for users who want to try Kyberion by outcome instead of by subsystem.

## 1. Meeting facilitator

Use this when you want Kyberion to help with meeting participation, prep, or follow-up.

Start here:

```bash
pnpm meeting:participate --help
```

Read the safety and operator flow guide:

- [meeting-facilitator.md](./meeting-facilitator.md)
- [OPERATOR_UX_GUIDE.md](../OPERATOR_UX_GUIDE.md)

## 2. Report generation

Use this when you want a narrated report or summary artifact.

Start here:

```bash
pnpm exec tsx scripts/run_pipeline.ts --input pipelines/trial-narrated-report.json
```

This pipeline generates a report summary and attempts audio/video artifacts when the host supports them.

## 3. Browser research

Use this when you want Kyberion to explore a page, capture state, or produce a browser artifact.

Start here:

```bash
pnpm pipeline --input pipelines/persona-beginner-competitor-research.json
```

For the first clean browser artifact smoke, use:

```bash
pnpm pipeline --input pipelines/verify-session.json
```

If the browser cannot launch, Kyberion now falls back to a non-browser artifact at `active/shared/tmp/first-win-fallback.txt`.

## Choosing a path

- Need meeting help: open the meeting facilitator guide first.
- Need a document or narrated summary: run the report generation pipeline.
- Need to verify the browser runtime: use the first-win smoke and check the fallback artifact if needed.
