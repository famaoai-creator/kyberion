# Vertical Template: Finance / Ringi Approval Automation

Automate the recurring shape of a **稟議承認** flow:

1. Open the workflow system.
2. List pending approval items assigned to me.
3. For each: read the request, surface key figures, decide approve / reject / hold.
4. Record decisions and follow-up notes.

This is one of the highest-value automation patterns in Japanese corporate operations.

## Customer-specific inputs to fill in

Edit `pipeline.json` and replace `{{}}` placeholders, or set them via env / mission inputs:

| Input | Where to find it | Example |
|---|---|---|
| `WORKFLOW_BASE_URL` | Customer's intranet workflow / ringi system root | `https://intra.acme.example.com/workflow` |
| `LOGIN_USERNAME` | (read from secret-actuator at runtime) | — |
| `LOGIN_PASSWORD` | (read from secret-actuator at runtime) | — |
| `INBOX_PATH` | URL path for "my pending approvals" | `/approvals/pending?assignee=me` |
| `APPROVE_BUTTON_SELECTOR` | CSS selector for the approve button | `button[data-action="approve"]` |
| `REJECT_BUTTON_SELECTOR` | CSS selector for reject | `button[data-action="reject"]` |
| `MAX_AMOUNT_AUTO_APPROVE` | Threshold above which approval requires human | `1000000` (yen) |

## Customizing decision policy

`mission-seed.json` defines the approval policy used by `wisdom-actuator` to decide each item:

```json
"policy": {
  "auto_approve_below": 1000000,
  "require_human_above": 1000000,
  "reject_keywords": ["再提出"],
  "hold_if_missing": ["budget_code"]
}
```

Edit per customer — these are the levers that change between engagements.

## What this template DOES

- Logs in via `pipelines/fragments/intra-login.json` (the shared login subroutine — replace if the customer uses SSO).
- Iterates each pending item.
- Captures a screenshot per decision (evidence for audit).
- Emits a Trace per item (Phase B-1).
- Records the count of approve / reject / hold in the mission state.

## What this template does NOT do

- Doesn't handle multi-step approval workflows (only single-stage for now).
- Doesn't auto-attach budget proofs (left as a future extension).
- Doesn't handle CAPTCHA or 2FA — if the customer has these, see [`pipelines/fragments/`](../../../pipelines/fragments/) for auth fragments to compose.

## Smoke test

```bash
KYBERION_REASONING_BACKEND=stub pnpm pipeline --input templates/verticals/finance-ringi-approval/pipeline.json
```

The stub backend skips actual decisions but verifies pipeline structural integrity.
