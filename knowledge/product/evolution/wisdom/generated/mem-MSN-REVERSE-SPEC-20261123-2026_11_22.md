---
record_id: mem-MSN-REVERSE-SPEC-20261123-2026_11_22
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-REVERSE-SPEC-20261123-2026_11_22
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-11-22T19:17:10.089Z
source_branch: feat/code-graph-extraction-20261123
source_commit: 21f44a377ad076b16abde13918642e1fa8cc2e7a
---

# Coverage gates must re-derive their denominator; web-tree-sitter and actuator dependency pitfalls

From MSN-REVERSE-SPEC-20261123 (reverse_spec / legacy_migration mission types and modeling:extract_code_graph): gates that prove coverage must recompute the denominator from the source with shared rules; web-tree-sitter predicate grouping, root-level dependency resolution for compiled actuators, ESM .js specifiers, fingerprint-safe source roots and object-anchored utterance markers.

## Hint Scope

mission

## Trigger Phrases

- ## When to apply

Adding a governed gate or extractor that proves coverage (a denominator) or parses source with web-tree-sitter in Kyberion.

## Lessons

1. **Never let a gate trust the artifact's own counts.** A first code_graph gate checked reconciliation rows and nodes against each other; an independent reviewer showed that dropping a node and lowering its counts still passed, and the source fingerprint still matched. The fix was to re-derive the denominator from the source tree with the same governed rules the extractor uses (shared module in core), so an omission needs an explicit, reasoned scope declaration.
2. **web-tree-sitter (0.27) silently ignores predicates written after a pattern unless the pattern and its predicates share one parenthesized group** — `((call_expression ...) @marker (#match? @o "^app$"))`. Alternations with predicates inside branches also misbehave; use one wrapped group per alternative and keep a contract test that compiles every rule query against its grammar.
3. **Compiled actuators run from repo-root `dist/` and resolve packages from the root `node_modules`.** A dependency added only to the actuator's package.json passes vitest (source paths) but fails `pnpm pipeline` with "Cannot find package". Pin runtime deps in the root package.json as well, and run the real pipeline once.
4. **TypeScript ESM sources import `./x.js` for `./x.ts`.** An import resolver that only appends extensions produced zero edges on real Kyberion code; map emitted `.js/.mjs/.cjs/.jsx` specifiers back to `.ts/.mts/.cts/.tsx`.
5. **A source fingerprint used for "source intact" must not cover trees the workflow writes to.** Reject source roots that contain or sit inside `active/` (except staging/tmp floors), `knowledge/` or `vault/`; otherwise the audit can never pass and higher-tier paths leak into evidence.
6. **Utterance promotion markers must name the object, not the deliverable.** 「仕様書を起こ」 promoted forward-development and document requests to reverse_spec; anchor markers on 「既存コード」「ソースコード」「レガシー」 and keep negative tests for document-authoring phrasing.
7. Grammar packages carry `install: node-gyp-build`; using only their prebuilt WASM means `allowBuilds: false` plus an install-script-allowlist reason per package, and a lockfile review record whose sha256 matches the committed lockfile.

## Recommended References

- active/missions/public/MSN-REVERSE-SPEC-20261123/evidence/distillation.md
- active/missions/public/MSN-REVERSE-SPEC-20261123/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-REVERSE-SPEC-20261123/evidence/implementation-report.md
- active/missions/public/MSN-REVERSE-SPEC-20261123/evidence/test-report.md

## Evidence

- active/missions/public/MSN-REVERSE-SPEC-20261123/evidence/distillation.md
- active/missions/public/MSN-REVERSE-SPEC-20261123/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-REVERSE-SPEC-20261123/evidence/implementation-report.md
- active/missions/public/MSN-REVERSE-SPEC-20261123/evidence/test-report.md

## Artifacts
