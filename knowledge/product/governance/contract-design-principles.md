---
title: 'Contract Design Principles — Absence, Failure, and Backend Opacity'
tags: [governance, contracts, api-design, reasoning-backend, reports]
kind: evergreen
last_updated: 2026-11-05
---

# Contract Design Principles — Absence, Failure, and Backend Opacity

**Purpose**: three rules for any result shape Kyberion hands to a caller — a
report contract (`libs/core/report-contract.ts`), a task result, a CLI
`--json` envelope, a delegated-work reply. They are written in the same
rule → why → anti-pattern form as
[working-philosophy](./working-philosophy.md) so reviewers can apply them
mechanically.

Inspired by the Unified Harness Protocol design principles (Apache-2.0);
re-stated here for Kyberion, not copied.

---

### 1. Absent ≠ empty ≠ zero

**Rule**: When a value is unknown, omit the field. Use an empty list only when
you checked and found nothing; use `0` only when you measured zero. Never fill
an unknown with a placeholder, an estimate, or a zero.
**Why**: A caller cannot tell an invented value from a real one. A `0` cost
that means "not measured" gets summed into a budget; an `[]` that means "could
not read" tells the next step there is nothing to do. Omission is the only
encoding that keeps "I don't know" distinguishable.
**Anti-pattern**: `{ "tokens": 0, "missing_connections": [] }` from a run that
never reached the provider; `"rationale": "N/A"` standing in
for a field the model did not return.

### 2. Failure is a first-class result

**Rule**: A failed operation returns the same envelope as a successful one,
with `status: "failed"` and a machine-readable failure class (plus a human
message and a next step). Expected failures do not escape as exceptions or as
free text the caller has to parse.
**Why**: Callers branch on outcomes. If success is a typed object and failure
is a thrown string, every caller writes its own string matching, and a new
failure mode silently becomes "unknown error". A class lets routing, retry and
repair logic decide without reading prose.
**Anti-pattern**: returning `null` for both "nothing found" and "backend
down"; logging a warning and returning an empty success; an error message
whose only structure is a `[TAG]` prefix.

### 3. The caller cannot tell which backend ran the work — unless it asks

**Rule**: Results from different backends/providers have identical shape,
field names, units and error classes. Provider identity appears only in an
explicit, opt-in provenance field the caller requested.
**Why**: Every observable difference is a leak: once a caller can detect the
provider, it starts depending on it, and swapping or failing over the backend
becomes a breaking change. Opacity is what makes the reasoning backend
replaceable.
**Anti-pattern**: a `claude-cli` reply that includes a `session_id` the
`codex` reply lacks; error text that quotes one provider's HTTP status; a
field that is a string from one backend and an array from another.

---

## Where this applies

- Report phase contracts — `libs/core/report-contract.ts`.
- Organization drafting envelopes — `libs/core/organization/role-intent-draft.ts`
  (`status: drafted | failed`, `failure.class`, unknown values omitted).
- Any new `--json` CLI output or delegated-work result shape.

When a review finds a contract that violates one of these, fix the shape (not
the caller) and name the rule in the review note.
