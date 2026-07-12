# Cross-tool Productivity Tasks

Use the productivity task planner when one request spans calendars, meetings, email, documents, presentations, browser work, or connected systems.

## Preview first

```bash
pnpm cli -- task plan "Collect the latest project data, prepare tomorrow's meeting deck, and draft the attendee email"
```

The result identifies:

- detected work domains;
- the existing actuator capability for each step;
- the effect level of each step;
- missing inputs;
- steps blocked on human approval;
- expected evidence.

The planner never executes external effects. Every step is emitted as `preview_only`, and the plan records `external_effects_executed: false`.

## Create a task session

```bash
pnpm cli -- task start "Collect the latest project data and prepare a meeting deck"
```

This stores a governed Task Session and the matching plan under `active/shared/`. It does not fetch remote data, update a calendar, join a meeting, send email, control a browser, or make a payment.

Use `--output` to choose the plan artifact path:

```bash
pnpm cli -- task plan "Check tomorrow's calendar" --output active/shared/tmp/tomorrow-plan.json
```

## Effect levels

| Level              | Typical work                                            | Boundary                                                                 |
| ------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------ |
| `read`             | Calendar lookup, status checks, information collection  | Read-only executor may be attached later                                 |
| `draft`            | Email draft, DOCX, PPTX                                 | Local artifact generation only                                           |
| `external_write`   | Calendar changes, meeting participation, email delivery | Authenticated human approval required                                    |
| `financial_commit` | Checkout, order confirmation, payment                   | Bound human approval, amount controls, and receipt verification required |

`task plan` is not an approval record. An executor must still pass the existing approval gate with the exact effect payload before any external write.

## Validate the review package

```bash
pnpm pipeline --input knowledge/product/pipeline-templates/productivity-task-orchestration.json
```

The template reads a productivity plan, checks the dry-run boundary, and writes:

- `review-package.json`;
- `execution-receipt.json`.

The receipt explicitly states that no external effect or network access occurred.

## Current limits

- The planner prepares work; it does not yet dispatch live cross-tool execution.
- Calendar writes, meeting participation, email sending, and browser checkout remain separate governed executor paths.
- Production payment execution is not included.
- Customer-specific provider defaults and payment limits are a follow-up overlay.

For repeatable saved routines, use the TaskScenario commands (`pnpm task:list`, `pnpm task:init`, and `pnpm task:run`). The productivity planner is the free-text entry point for ad hoc cross-tool work.
