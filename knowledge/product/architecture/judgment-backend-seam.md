---
title: Judgment Backend Seam
tags: [architecture, seam, judgment, calibration, confidence, tier, egress, classification]
last_updated: 2026-09-21
---

# Judgment Backend Seam

A **judgment** is a bounded, typed question asked over a piece of state —
"which of these six shapes is this?", "is this done?", "how risky is this?" —
answered with a value and a confidence and nothing else.

The executable declaration is `libs/core/judgment-backend.ts`; this document
is the human-facing explanation of why it exists and how to add a provider.

## This is not the reasoning backend

`ReasoningBackend.delegateTask(instruction, context) => string` returns prose
that a caller must parse. A judgment returns a typed value. Do not register a
judgment provider as a reasoning mode, and do not add `delegateTask` to a
judgment provider — the seams answer different questions and have different
failure modes.

## Why it exists

Before this seam, `classifyOrganizationWork` returned one of nine hard-coded
constants as `confidence`, and `onboarding-context.ts` branched on
`confidence < 0.7` to decide whether to ask a human. Measured on mission
`JUDGMENT-SEAM-20260921`:

- The values below the threshold (0.40 / 0.58 / 0.62) and at or above it
  (0.80 … 0.93) were **completely disjoint**. `confidence < 0.7` was exactly
  equivalent to "did any regex match", and the threshold could be moved
  anywhere in (0.62, 0.80] without changing behavior.
- Worse, keyword density is anti-correlated with clarity in this vocabulary,
  so the number moved the **wrong way**: `請求まわり` (two nouns, no
  predicate) scored 0.88 and a three-shape request scored 0.93, both sailing
  past the gate that exists to catch them.
- Nothing in the type recorded any of this. A caller reading `confidence`
  could not tell a fitted estimate from a table lookup.

## `calibrated` is the load-bearing field

`JudgmentAnswer.calibrated` says whether `confidence` is a fitted estimate.
**A provider is not allowed to declare it.** The seam overwrites it from
`resolveCalibration()`, which reads
`knowledge/product/governance/judgment-calibration.json`; a provider is
calibrated only where a fitted entry exists for that question id, and `false`
everywhere else, including when the registry is missing or unreadable.

This is not bureaucracy. Both obvious sources of a model's confidence are
uncalibrated in different ways, measured on the same twelve cases:

- **Self-report** — a local 4B model asked for its own confidence returned
  0.95 on five of six clear cases and 0.85 on the sixth: a stylistic
  constant, not an estimate.
- **Raw token logprobs** — the same model's probability mass over the
  constrained choice averaged 0.788 on clear input and 0.791 on ambiguous
  input. A separation of −0.003, i.e. none.

A provider that says "0.95" about everything must not be able to buy its way
past a caller that requires calibration, so the claim is not the provider's
to make.

## Selection is by tier, never by name

Callers pass `tier` (and optionally `tenantSlug`), never a provider id.
`selectJudgmentBackend()` filters candidates through `checkProviderEgress()`,
so `personal` material can reach only a `local-only` provider and
`confidential` only a tenant-approved one. When nothing survives the filter,
or a provider throws, the call degrades to the built-in rule provider with a
reason rather than failing — a judgment seam must never be able to stop
ordinary work.

## It scores; it does not decide

Route selection stays deterministic and fail-closed in `judge-route.ts`. A
missing, slow, or wrong provider can move a confidence, never a branch. Keep
it that way when adding providers.

Measured rather than assumed: asked the same utterance three times, the
TypeSafe Jev provider returned `routine_operation` (0.39), then
`governance_cadence` (0.41), then `routine_operation` (0.39) for
'来期予算の決裁をお願いしたい'. Same model id, same prompt, different shape. A
provider whose _answer_ moves between runs must never be wired to a branch.

## Ask the gate as its own question, never as an extra option

`JudgmentRequest.questions` is a list because independent questions over one
state belong in one call. This is load-bearing, not a convenience.

The obvious way to let a model say "none of these" is to add an option to the
Choice. Measured on twelve utterances, it goes wrong: the escape competes
with the real options for the same probability mass, so "not confidently any
one of these" becomes "not a work request". Adding `not_a_work_request` as a
seventh shape swallowed three genuinely-ambiguous utterances _and_ one
unambiguous one, at confidences up to 1.000, and flattened the shape
distribution from +0.441 separation to −0.103.

Asking the gate as its own `bool` alongside the six-way Choice, in the same
call, keeps both intact: the same decision quality as the escape version
(10/12, zero silent errors) with the Choice's discrimination preserved
(+0.441). On a genuinely two-shape request, the distribution stays readable —
`routine 0.48 / governance 0.43` — which is what lets a caller ask a human
"which of these two?" rather than only "are you sure?".

So: one question per thing you actually want to know, all in one call.

## Two kinds of wrong

Separate them when evaluating a provider; a single accuracy number hides the
distinction.

- **Noise** — the answer moves between identical runs. Calibration cannot fix
  this, and it is what rules out wiring a provider to a branch.
- **Systematic error** — the same wrong answer every time.
  '顧客対応の窓口を整理したい' came back as `solution_project` on all four
  runs, reading 整理したい as building something. This is addressable through
  the question's `instructions` and per-option descriptions.

Also weigh _where_ the errors land. The rules score 11/12 against Jev's 10/12,
but the rules' single miss proceeds with the wrong shape at 0.80 confidence —
a human never sees it. Both of Jev's misses route to a human. For a gate whose
purpose is catching what should be asked, the second failure mode is the
better one, and the raw count inverts the ranking.

## Two families of provider, and only one of them discriminates

The open implementations of this idea split by architecture, and the split
matters more than any individual project:

| family | examples | separation measured here | determinism |
| --- | --- | --- | --- |
| reads logits from a general LLM | Simple Jev, System One Lite, SemIf, LocalJev, System One Adapter | **-0.003** | not measured |
| trained judgment head | Laya, kev, typed-decisions | **+0.36** | **total** |

The first family is the easy one to reach for: no new model, constrained
decoding over the LLM already installed. A provider was built that way here
before the family was recognised, and it produced well-formed typed answers
whose confidence was identical on clear and ambiguous input — structure
without discrimination. Prefer the second family for anything that gates,
and measure separation before trusting either.

## Which Laya checkpoint

`laya-mlx` ships three. For Japanese there is only one real option, and it
happens to be the small one:

| checkpoint | noul | choice | p50 |
| --- | --- | --- | --- |
| `aac6fef/laya-multilingual-mlx` (mmBERT-base 322M) | 7/8 | **6/6** | **14ms** |
| `aac6fef/laya-mlx` (ModernBERT-large 421M) | 5/8 | 2/6 | 33ms |
| `aac6fef/laya-typed-decisions-mlx` (DeBERTa) | 6/8 | 2/6 | 33ms |

The English checkpoints score near chance on Japanese choices and sit at
~0.5 on nouls, which is no signal at all. Both are larger and slower.

The noul head needs its `{true, false}` descriptions as much as a choice
needs its options described — asked without them it called
'月次レポートを作って' not a work request at 0.002, and asked with them it
is right on seven of eight.

## A state may carry an image, and `acceptsImages` decides who sees it

`JudgmentState` is a string, or text plus a base64 image. The text-only
version was a real limit rather than an omission: `judgePageReadiness` can
read a page's words but not see a spinner, a half-painted layout, or a modal
over the content — the cases where "is it ready" is genuinely in doubt.
`judgePageReadiness` takes a `screenshotBase64` for that.

Seeing pixels is a property of the provider, not of the question, so it is a
capability flag rather than something `supports()` could express. **Absent
means no**, and `selectJudgmentBackend` filters on it at all three paths
that can reach a provider — selection, the built-in floor, and the
failure-degradation path. A text-only provider handed an image would answer
from the caption and look like it had looked at the picture; instead the
caller gets its baseline and a reason saying nothing can see images.

Providers that take pixels exist. PlayJev-0.8B reads one 448px frame and
returns a distribution over the listed options in a single forward pass with
nothing generated, which is exactly this seam's shape; openvons covers text,
images and Japanese voice, and answers the escape-option problem a third way
— it scores a *free hypothesis* alongside the candidates rather than adding
"none of these" as an option that competes for the same probability mass.
Neither has been measured against a call site here, so neither is
registered: per the evaluation rule above, an unmeasured provider is treated
exactly like a bad one.

## Adding a provider

1. Implement `JudgmentBackend`: `judgment_id`, an honest `egress` label,
   `supports()`, `judge()`. Derive confidence from token probabilities over
   the constrained answer, not from asking the model how sure it is.
2. Disable chain-of-thought. Bounded judgment must emit the answer token
   directly. A thinking model measured on this task took 21–62 s per call and
   spent its whole token budget on a reasoning preamble; the same model with
   thinking off answered in 294 ms, and in 0.79 s including model load.
3. Register it with `registerJudgmentBackend()` and add a `local-only` or
   tenant-approved entry to the provider egress policy.
4. Run the separation bench before claiming an improvement. **Accuracy is
   not the metric** — the defect was ambiguous input scoring high, so what
   matters is the gap between clear and ambiguous groups. The bench lives at
   `active/missions/public/JUDGMENT-SEAM-20260921/evidence/bench_separation.ts`.
5. Only after a fit exists, add the provider to
   `judgment-calibration.json`. Until then it reports `calibrated: false`,
   which is correct and does not stop it being used.

## Criteria text is not optional in practice

`JudgmentQuestion.optionDescriptions` is typed optional and behaves like it is
required. Asked with bare identifiers (`incident_response`,
`routine_operation`, …), the Laya-MLX provider got **1 of 6** unambiguous
Japanese requests right. The same six utterances, same model, same threshold,
with one sentence of description per option: **6 of 6** — better than the
rules (5/6) and better than Jev (4/6).

An identifier is legible to whoever named it and to nobody else. Write the
descriptions.

The earlier Jev measurements in this document were taken *before* this was
understood, with option names passed as their own descriptions, so they
understate it. Both providers now go through `describeChoiceOptions()`.

## Providers measured so far

All three asked the same question, with option descriptions:

| | decisions | silent errors | shape on clear input | runs that varied | latency | tiers reachable |
| --- | --- | --- | --- | --- | --- | --- |
| built-in rules | 11/12 | 1 | 5/6 | 0/12 | ~0ms | all |
| local 4B (generative) | — | — | 3/6 | not measured | 294ms | all |
| TypeSafe Jev | 9/12 | 3 | **6/6** | **7/12** | 235-278ms | public only |
| Laya-MLX | 9/12 | 1 | **6/6** | **0/12** | 24ms | **all** |

Jev was re-measured after the description finding, and the correction runs
both ways. Its classification was understated — 4/6 became 6/6, matching
Laya. Its behaviour as a gate was overstated: descriptions made every option
look plausible, so it stopped abstaining, and silent errors went from 0 to 3
while the runs that varied went from a handful to 7 of 12. Descriptions help
recognition and hurt abstention; Laya took the same descriptions without
losing its reticence.

Read the columns, not the totals. Laya and Jev tie on decisions and on
classification; they differ where it matters for a gate — one silent error
against three, and no variance against seven runs in twelve. Laya's two
misses are correct shapes at 0.63 and 0.67 refused by the 0.7 threshold,
which is a calibration problem rather than a comprehension one.

The rules still win overall and remain the built-in provider. Their single
miss is the expensive kind: a wrong shape at 0.80, which nobody is asked
about.

## Every integration goes through `assistWithJudgment`

`judgment-assist.ts` is the only place a judgment is allowed to influence
anything, so the rules that keep a model from breaking the system are
written and tested once instead of at each call site. It never throws, caps
the call in time, keeps the caller's deterministic result below a confidence
floor, declines everything while `requireCalibrated` is set, and lets the
caller refuse an answer it should not act on.

The direction of safety is per call site, and the four that exist differ:

| call site | baseline | a judgment may |
| --- | --- | --- |
| `error-classifier-judgment` | the rules' category | fill in `unknown` only; never override a matched rule |
| `knowledge-relevance-judgment` | keep every document | drop one it is *confidently sure* is irrelevant, never a pinned one, never below `minKeep` |
| `browser-judgment` failure kind | the heuristics' kind | fill in `unknown` only |
| `browser-judgment` readiness | the caller's gate | add "not ready"; never turn a failed gate into a pass |

The pattern is the same each time: a judgment adds information where there
was none, or adds a restriction, and can never remove one. A call site whose
natural baseline is permissive — the context pack, which keeps everything —
gets the asymmetric guards instead, because there a wrong judgment removes
something the worker needed and nobody is asked about it.

## Nothing is calibrated yet, deliberately

`judgment-calibration.json` does not exist, so every provider reports
`calibrated: false`. That is the accurate state, not an oversight.

Laya-MLX is the first eligible candidate and is still not calibrated: twelve
synthetic cases cannot estimate calibration error, and those cases were
written for the bench rather than drawn from real traffic. What it does have
is the precondition — twelve utterances judged five times each returned
byte-identical choices, confidences and noul values, so a fit would describe
something stable. TypeSafe Jev does not clear that bar: asked the same
utterance three times it returned three answers, two of them different
shapes. A fit needs a
labelled corpus of real utterances, repeated runs to measure variance, and a
demonstrated improvement in calibration error.

An uncalibrated provider is still useful — just not as a threshold. Use
`signals.probabilities` to show a person _what the choice is between_, which
needs no calibration to be worth reading.

## Known limitation

The built-in rules discount their priors by a _competition_ signal (how many
shapes claim the utterance specifically) and a _specificity_ signal (whether
a predicate is present at all). Competition counts only rules that matched on
a non-generic term, because `solution_project` carries generic verbs (`作る`,
`導入`, `新しい`) and `service_operation` carries `運用` — plain rule count
scores `今月の運用レポートを作る` and `障害対応の月次レポートを作って承認をもらう`
identically at three matches each, though only the second is genuinely
multi-shape. Tightening the rule vocabularies is the better fix; the discount
is what can be done without moving the shape decision, which stays
first-match-wins.
