---
title: 'Provenance, authorization and recoverable repair boundaries'
tags: [security, provenance, memory, authorization, repair, evaluation]
last_updated: 2026-10-24
runtime_stages: [preflight, execution, verification]
---

# Provenance, authorization and recoverable repair boundaries

Provenance records where information came from. It does not grant permission to
execute an operation. Keep confidentiality (tier and tenant), evidence eligibility
(current source versions and corrections), and execution authority (human consent
or a current delegated grant) as separate checks. An agent's confidence, repeated
summaries or a successful task outcome cannot substitute for these checks.

## Exact operations at commit

The trusted host installs the current tool interface resolver and any attested
argument origins. Action JSON and mutable Markdown cannot install either. The
pipeline host fingerprints the resolved actuator manifest, local schema graph and
candidate operations. Approval and delegated-effect bindings include this identity.
The external-effect boundary checks the current effect and protection identity
again immediately before calling the transport. Drift requires a new decision;
repairing an argument does not retain consent to the old argument.

Reviewed destination fields require user/policy origins or exact human consent.
Unknown mutation shapes conservatively require consent to their whole effect.
An exact, existing target-scoped grant remains subject to its original matching,
scope, expiry and revocation rules. A recorded memory source is only current
evidence; its existence never turns external text into a user's instruction.
Revoked argument sources cannot be used even with a previously captured descriptor.

Direct approvals are reloaded at commit for status, expiry, revocation, exact
payload and operation binding. Standing charters are checked for current identity,
expiry and stops without charging their budget a second time.

Request creation is a separate dependency from decision handling and mission
steering. A producer that only creates or reads a request must not pull in the
decision executor. Creating a pending record confers no execution authority.

Remote MCP calls use the connected server's actual `tools/list`, including the
selected input schema and candidate list. All awaited discovery and argument
validation finishes before final local admission and immediate `callTool` dispatch.
Server-side changes after that last observation still require cooperation from the
remote service; local hashes cannot provide a remote atomic transaction.

Starting a stdio MCP server executes code and requires its own approval. A trusted
host may supply a bounded `onApprovalRequired` continuation to keep the same client
alive while the exact tool decision is made; the callback does not itself grant
permission. A stateless pipeline restart cannot replay a consumed startup. It
requires an explicitly selected, separately approved host startup attempt; never
automatically respawn the process or delete the prior reservation.

## Memory lineage and current eligibility

Governed producers register the exact artifact bytes and verified parent source
references. The scoped memory runtime state stores source families, transitive
ancestors and monotonically advanced revocation generations. The state is outside
mission checkpoints and search caches. Keep revocation tombstones: deleting them
would destroy the evidence needed to reject restored old descriptors.

Retrieval checks current eligibility before selecting the highest ranked
representative from each source family. Independent sources remain available.
Corrections and revocations retain history while removing old derivatives from
current decision context. Source-family declarations in unverified frontmatter do
not mint protected ancestry. Content hashes can deduplicate identical legacy text;
they cannot identify every paraphrase of an unregistered source.

Source families and retraction tombstones survive mission/task/project context
changes within the same physical tenant/owner partition. Context changes cannot
resurrect old bytes. Existing contextual restrictions form a conservative
per-document ceiling: broader re-publication requires a separately governed
migration/declassification, not this registration API or a revoked historical grant.

## Completion and authorization are separate evaluations

A scenario's optional authorization contract states its purpose, completion
operations, allowed and forbidden operations, and allowed write paths. Reports and
trajectories distinguish authorized completion, unauthorized completion, authorized
incompletion and unauthorized incompletion. Missing or incomplete observations are
indeterminate. Failed apply operations may still have changed external state, so
they remain relevant to authorization evaluation. These contracts evaluate traces;
they do not authorize execution or replace resource-side checks.
For a declared contract, the CLI suite succeeds only for observed, authorized
completion; safe but incomplete work does not become a passing result.

## Unattended repair

Measure the real validator against reviewed positive and negative controls before
using it to admit a repair. Constant approval, constant rejection, errors or false
admissions refuse unattended repair. Preserve and hash-check the original bytes on
the governed scratch floor. Request an advisory, read-only candidate; the host
validates it, rechecks existing trust requirements and commits the candidate.
Restore the saved bytes when a repair fails after changing the target.
Restoration is limited to the last host-owned content digest. If another writer
changes the target before or after a host commit, preserve those newer bytes and
report `rollback_refused` rather than overwrite that writer's work.

This is a contract/schema calibration, not a statistical guarantee of semantic
correctness. Exact file restoration does not undo messages, payments or other
external effects. In-process snapshot branding is not a process-restart recovery
protocol. Broader self-improvement needs separate measured controls and durable
recovery policy before it may run unattended.

## Verification and limits

Run the affected memory, external-operation, approval, scenario and ADF-repair
tests, plus `tests/provenance-authorization.integration.test.ts`. Include unchanged
authorized cases as well as payload drift, schema drift, forged lineage, source
family saturation, correction, stale checkpoint descriptors and constant verifiers.
Use isolated synthetic state and never exercise a real external effect for a probe.

The controls cover the governed producers, retrieval and execution paths that use
these boundaries. They are not a sandbox for arbitrary code, a detector for all
prompt injection, or a proof that information is factually true. Legacy unregistered
memory has weaker lineage guarantees. A compromised host or policy writer is outside
the model/frontmatter threat boundary. Local schema fingerprints do not prove a
remote service's implementation has retained the same semantics.

Legacy tenantless confidential publications and personal publications without an
authenticated owner retain their existing workflow, but do not mint protected
lineage. A shared prefix or a sensitivity label never supplies the missing tenant
or owner. These records remain unverified legacy evidence and confer no execution
authority.

## Research provenance

These implementation choices are informed by [SkillRelayGuard](https://arxiv.org/abs/2610.13227),
[Memory Echo](https://arxiv.org/abs/2610.17763),
[Hard-KLAIM](https://www.sciencedirect.com/science/article/pii/S2352220826000830),
[enterprise responsibility boundaries](https://arxiv.org/abs/2610.14818),
[ClawMMU](https://arxiv.org/abs/2610.28093),
[PROVISO](https://arxiv.org/abs/2610.27115),
[AuthorizationBench](https://arxiv.org/abs/2610.27548),
[recoverability and verifier strength](https://arxiv.org/abs/2610.27465), and
[interface drift](https://arxiv.org/abs/2610.23342).
The local tests validate these implementation contracts, not the papers' reported
attack-success or accuracy numbers. ClawMMU describes an unimplemented design;
none of its proposed guarantees should be presented as a reproduced experiment.
