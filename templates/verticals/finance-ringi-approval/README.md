# Vertical Template: Finance / Ringi Approval Automation

Automate the recurring shape of a **稟議承認** flow:

1. Open the workflow system.
2. List pending approval items assigned to me.
3. For each: read the request, surface key figures, decide approve / reject / hold.
4. Record decisions and follow-up notes.

This is one of the highest-value automation patterns in Japanese corporate operations.

## Customer-specific inputs to fill in

Edit `pipeline.json` and replace `{{}}` placeholders, or set them via env / mission inputs:

| Input                           | Where to find it                                                                                                                       | Example                                   |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `WORKFLOW_BASE_URL`             | Customer's intranet workflow / ringi system root                                                                                       | `https://intra.acme.example.com/workflow` |
| `LOGIN_USER_SECRET`             | Secret-store key holding the login user name (read at runtime via `browser:fill_secret_ref`; never written to the ADF or action_trail) | `saas.workflow.user`                      |
| `LOGIN_PASSWORD_SECRET`         | Secret-store key holding the login password                                                                                            | `saas.workflow.password`                  |
| `LOGIN_USER` / `LOGIN_PASSWORD` | Legacy plaintext fallbacks — do not use for real credentials (values are recorded in the action trail)                                 | —                                         |
| `INBOX_PATH`                    | URL path for "my pending approvals"                                                                                                    | `/approvals/pending?assignee=me`          |
| `PENDING_ITEM_SELECTOR`         | CSS selector matching each pending approval row                                                                                        | `tr[data-pending-item]`                   |
| `APPROVE_BUTTON_SELECTOR`       | CSS selector for the approve button                                                                                                    | `button[data-action="approve"]`           |
| `REJECT_BUTTON_SELECTOR`        | CSS selector for reject                                                                                                                | `button[data-action="reject"]`            |
| `OK_BUTTON_SELECTOR`            | Confirmation dialog button after approve/reject                                                                                        | `button.ok, input[value='OK']`            |
| `POLICY_AUTO_APPROVE_BELOW`     | Threshold above which the policy says hold                                                                                             | `1000000` (yen)                           |

## Customizing decision policy

`mission-seed.json` defines the approval policy surfaced to the `reasoning:analyze` judge step (edit the instruction or `POLICY_AUTO_APPROVE_BELOW` input to change the thresholds):

```json
"policy": {
  "auto_approve_below": 1000000,
  "reject_keywords": ["再提出"],
  "hold_if_missing": ["budget_code"]
}
```

Items decided `hold` are left untouched and logged — approve/reject is only applied on a verdict of `approve`/`reject`.

Edit per customer — these are the levers that change between engagements.

## What this template DOES

- Logs in via `pipelines/fragments/intra-login.json` (the shared login subroutine — replace if the customer uses SSO). Credentials resolve from the secret store via `LOGIN_USER_SECRET`/`LOGIN_PASSWORD_SECRET` (`browser:fill_secret_ref`, redacted in the action trail); plaintext vars remain only as a legacy fallback.
- Opens each pending item and asks `reasoning:analyze` for a JSON verdict against the policy, then applies approve (via `pipelines/fragments/ringi-approve-single.json`) or reject (inline clicks); `hold` items are only logged.
- Captures a screenshot per decision (evidence for audit) and appends every verdict to `decisions.jsonl`.

## What this template does NOT do

- Doesn't handle multi-step approval workflows (only single-stage for now).
- Doesn't auto-attach budget proofs (left as a future extension).
- Doesn't handle CAPTCHA or 2FA — if the customer has these, see [`pipelines/fragments/`](../../../pipelines/fragments/) for auth fragments to compose.

## Smoke test

Project-local pipelines are trust-gated: loading requires an approved project-trust decision, otherwise the run fails fast with `[TRUST_REQUIRED]`. Structural validation without a browser:

```bash
# 1. Request the project-trust approval for this pipeline path (human approves once)
# 2. Then run the structural/dry-run validation:
KYBERION_REASONING_BACKEND=stub pnpm pipeline --input templates/verticals/finance-ringi-approval/pipeline.json --project-trust-approval <approved-request-id>
```

The stub backend skips actual decisions but verifies pipeline structural integrity.
