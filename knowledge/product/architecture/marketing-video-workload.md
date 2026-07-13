# Marketing And Video Workload

## Responsibility Boundaries

- Strategy reads research and produces briefs, message maps, KPIs, and claim registers. It has no external write authority.
- Creative produces copy, scripts, storyboards, media, captions, thumbnails, and metadata. It has no publication authority.
- Review independently attempts to refute acceptance. Reviews bind to artifact SHA-256 and are reusable only for the same hash.
- Distribution alone may request an external effect. Execution remains blocked until the shared approval system proves authenticated human approval for the exact effect.

## Gates

| Gate                    | Input                                                                                    | Pass condition                                                             | Evidence                          | Failure behavior                 |
| ----------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------- | -------------------------------- |
| G0 Intake               | outcome, audience, owner, channels, deliverables, deadline, criteria, tier, intent, risk | Required fields and public approver/claim IDs exist                        | validated intake                  | remain intake pending            |
| G1 Classification       | source/artifact classifications                                                          | no prohibited tier crossing; redaction complete                            | scan/classification report        | block production/publication     |
| G2 Brief/Claim          | claim IDs and register                                                                   | verified, sourced, public-use claim permitted on channel                   | approved brief and claim register | return to brief                  |
| G3 Technical            | media/text/image inspection                                                              | all channel specs pass                                                     | technical validation report       | technical review failed          |
| G4 Expert Review        | artifacts, hashes, structured reviews                                                    | required roles present, same hashes, no blocking finding                   | review IDs/results                | changes requested or invalidated |
| G5 Publication Approval | exact artifacts and effect payload                                                       | unexpired authenticated human approval, required count, all bindings match | approval ID and hashes            | publication denied               |
| G6 Verification         | publication result                                                                       | URL, visibility, hash, CTA, captions, thumbnail verified                   | verification record/screenshot    | Mission cannot complete          |

Risk controls are resolved from `knowledge/product/governance/marketing-risk-policy.json` with a customer overlay at `customer/<slug>/policy/marketing-risk-policy.json`. Dry-runs never represent an external publication.

## Executable Dry-run Publisher

`scripts/marketing_publish_dry_run.ts` is the governed local publisher path. It accepts an immutable approval record, re-hashes every approved artifact immediately before execution, requires authenticated human decisions, validates expiry and exact effect bindings, and writes a local HTML preview plus G6 verification evidence. It never edits the approval record and never performs network access. The ADF `publish-youtube-dry-run.json` remains an explicitly unapproved UI fixture and cannot satisfy G5.

Publication approval records bind to the shared approval infrastructure through `shared_approval.storage_channel`, `request_id`, `payload_hash`, and `effect_binding`. The publisher loads the request from `approval-store`, requires `status=approved`, `finalDecision=human_only`, and verifies that each named publication approver has a matching authenticated human workflow decision for the same payload and effect. The publication executor cannot manufacture or mutate this request.

Before G5 evaluation, the publisher scans the title, description, captions, Markdown, text, HTML, and JSON artifacts for PII-like and secret-like content. Evidence contains only category, logical location, and counts; raw suspected values are never copied into the scan result or error log. The video dry-run runs ffmpeg `blackdetect` and `silencedetect`, records their actual completion status and maximum detected duration, and probes thumbnail metadata for location, author, comment, and related sensitive keys. A detector failure is a G3 failure, not a skipped success.

`scripts/marketing_review_aggregate.ts` is the executable G4 path. It reloads and hashes the current review-package artifacts, resolves required reviewer roles from the risk policy, accepts suggestion-only findings, and blocks missing roles, blocking findings, non-approved verdicts, or reviews bound to a prior artifact hash. The resulting JSON is Mission Evidence and includes `ready_for_approval`; it does not create an approval.

For marketing, campaign, and publication Mission types, the existing Mission finish quality gate discovers the newest `completion-evidence.json`, recomputes every bound artifact hash, and calls the marketing completion evaluator. Missing evidence, failed required gates, public dry-runs, sensitive-data findings, or changed artifacts block the existing finish lifecycle. No parallel marketing lifecycle is introduced.

Customer policy resolution is exercised through real temporary `customer/<slug>/policy/marketing-risk-policy.json` overlays. Distinct `KYBERION_CUSTOMER` values resolve distinct channel and CTA policies; no-customer execution falls back to the product policy. Test fixtures are created and removed through governed mission-controller authority rather than bypassing secure I/O.
