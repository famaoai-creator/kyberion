---
title: Rubric Scope Disclosure Template
category: Procedure
tags: [counterfactual, rubric, disclosure, governance, audit]
importance: 7
last_updated: 2026-04-27
---

# Rubric Scope Disclosure Template

When the output of `wisdom:simulate_all` (or its ensemble form,
`wisdom:simulate_all_ensemble`) is presented as evidence in an executive
meeting, regulatory submission, or external audit, this disclosure
**must** be attached. It exists to prevent the
`simulation-quality.json` rubric from being misread as a guarantee of
analytical correctness.

The template is intentionally short: it tells the reader what the rubric
**does** and **does not** verify, and what they need to do about the
distinction.

---

## Rubric Scope Disclosure

The deterministic checks in `simulation-quality.json` (the "Rubric") and
the convergence checks in the ensemble report verify **structural
soundness only**. They do **not** verify the **logical** or **causal**
validity of the underlying analysis.

### What the Rubric verifies (structural)

| Check | Verifies | Does not verify |
|---|---|---|
| `has_branches` | At least one branch was simulated | Whether those branches are the *right* branches |
| `failure_xor_success` | No branch reports both terminal modes | Whether the chosen terminal mode is the correct one |
| `unique_branch_ids` | Each branch_id appears once | Whether the branches collectively cover the decision space |
| `reaches_terminal_mode` | At least one branch reached a conclusion | Whether the conclusion is sound |
| `outcome_balance` | Outcomes are not all-failure or all-success | Whether the outcome split reflects reality |
| `non_trivial_termination_depth` | Branches simulated for more than zero steps | Whether the simulation steps were meaningful |
| `mean_convergence` (ensemble) | Re-runs agree on the dominant outcome | Whether the agreed outcome is correct |

### What the Rubric does **not** verify (logical / causal)

The following remain dependent on the underlying reasoning model and
human judgement, and the Rubric provides **no protection** against
errors in any of them:

- Economic, legal, or regulatory premises used by the simulation
- Direction of causal arrows (does A cause B, or does B cause A?)
- Plausibility of counterfactual transitions (would the world really
  evolve this way given the perturbation?)
- Completeness of the branch set (have we considered the right
  scenarios?)
- Calibration of probability claims, even when they are verbalized
- Coherence with established domain knowledge that was not provided in
  the prompt

### What this means for decisions based on this output

1. **Rubric-pass is necessary but not sufficient** for using the
   simulation as evidence.
2. The **logical / causal validity** of the simulation must be reviewed
   by a domain expert before it informs a decision with material
   consequence.
3. Where the decision is **regulated** (e.g. covered by SR 11-7 or
   J-SOX), an independent validation per the Independent Validation
   Evidence Package is also required (see
   [`../../governance/independent-validation-evidence-package.md`](knowledge/public/governance/independent-validation-evidence-package.md)).

### Mandatory companion artefacts

- `simulation-summary.json` — the underlying LLM output
- `simulation-quality.json` — the Rubric report
- `simulation-ensemble.json` — when more than one run was executed
- `audit-chain` excerpts covering the simulation generation, all reruns,
  and any `rubric.override_accepted` events

---

## How to attach this disclosure

When sharing simulation output:

1. Copy the **Rubric Scope Disclosure** section above verbatim into the
   meeting / report deck (or include this file as an appendix).
2. Confirm the companion artefacts are attached or referenced.
3. If the rubric severity is `warn` or `poor`, additionally attach the
   relevant `rubric-warn-banner` / `rubric-poor-banner` text from
   [`../../governance/counterfactual-degradation-policy.json`](knowledge/public/governance/counterfactual-degradation-policy.json).

This disclosure is canonical and English-first. Localized labels for the
column headers may use the governed vocabulary catalog. The body text
remains unchanged.
