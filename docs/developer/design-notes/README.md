# Design decision ledger

This ledger records design decisions that affect Kyberion's runtime or governance.

- `proposed/`: a decision still awaiting implementation or review.
- `implemented/`: a decision adopted in code, with verifiable evidence.
- `rejected/`: a considered option that is intentionally not adopted, with the reason preserved.

Every note starts with frontmatter containing `title`, `status`, `decision_date`, `scope`, and
`decision`. Implemented notes also require `evidence`; rejected notes require `rationale`.
Run `pnpm check -- --scope full --only design-ledger` before delivery.
