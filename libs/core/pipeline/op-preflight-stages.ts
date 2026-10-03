/**
 * SC-05: the standard governance stages that turn service-actuator's
 * one-off enforcement into the op-level waterfall contract.
 *
 * - `introductionResult` (preflight): write/egress ops must have an
 *   introduction for the stamped resource — mode per rollout policy.
 * - `taintResult` (preflight): egress ops get the mission's taint
 *   projection stamped for the monotonic guard (SC-06 consumes it).
 * - `recordOpObservation` (post-op): read ops aggregate into the
 *   control-plane observation journal.
 *
 * Identity comes from the active scope envelope first, then the op's
 * trusted scope input — never from client-supplied tenant fields.
 */

import { pathResolver } from '../path-resolver.js';
import { readJsonIfPresent } from '../foundation/json.js';
import { currentScopeEnvelope } from '../scope-envelope.js';
import { sharedControlPlane } from '../cloudflare-os-shared.js';
import { evaluateProvenanceEgress } from '../provenance-taint.js';
import type { OsKnowledgeTier, ProvenanceTaint } from '../cloudflare-os-control-plane.js';
import { OP_GOVERNANCE_STAMP_KEYS } from './op-preflight.js';
import type { OpPreflightCall, OpPreflightListenerResult } from './op-preflight.js';

/**
 * Keys the governance stages stamp onto the repaired preflight input.
 * They carry stage metadata between the waterfall and the execute choke
 * points — never the op's validated input, so they are stripped before
 * `options.execute`/`handlers.*` runs.
 */
export const GOVERNANCE_STAMP_KEYS = OP_GOVERNANCE_STAMP_KEYS;

/** Input minus the governance stamps — safe to hand to the op schema. */
export function stripGovernanceInputStamps(
  input: Record<string, unknown>
): Record<string, unknown> {
  const cleaned = { ...input };
  for (const key of GOVERNANCE_STAMP_KEYS) delete cleaned[key];
  return cleaned;
}

type StageName = 'introduction' | 'taint' | 'observation' | 'egress';
type StageMode = 'off' | 'warn' | 'enforce';

interface RolloutPolicy {
  stages?: Record<StageName, { default?: StageMode; families?: Record<string, StageMode> }>;
}

const ROLLOUT_POLICY_PATH = 'knowledge/product/governance/op-preflight-rollout.json';
const STAGE_MODES = new Set<StageMode>(['off', 'warn', 'enforce']);

let rolloutCache: RolloutPolicy | undefined;
const stageModeCounts = new Map<string, number>();

/** Test seam: drop the cached rollout policy and stage counters. */
export function resetOpPreflightStagesForTests(): void {
  rolloutCache = undefined;
  stageModeCounts.clear();
}

/** Test seam: inject a rollout policy instead of reading the JSON. */
export function setOpPreflightRolloutForTests(policy: RolloutPolicy | undefined): void {
  rolloutCache = policy;
}

function rolloutPolicy(): RolloutPolicy {
  if (rolloutCache === undefined) {
    rolloutCache =
      readJsonIfPresent<RolloutPolicy>(pathResolver.rootResolve(ROLLOUT_POLICY_PATH)) ?? {};
  }
  return rolloutCache;
}

function stageMode(stage: StageName, family: string): StageMode {
  const policy = rolloutPolicy().stages?.[stage];
  const candidate = policy?.families?.[family] ?? policy?.default ?? 'warn';
  return STAGE_MODES.has(candidate) ? candidate : 'warn';
}

function noteStage(stage: StageName, outcome: 'warn' | 'denied' | 'skipped'): void {
  const key = `${stage}:${outcome}`;
  stageModeCounts.set(key, (stageModeCounts.get(key) ?? 0) + 1);
}

/** Rollout visibility for the warn → enforce promotion review. */
export function opPreflightStageCounts(): Record<string, number> {
  return Object.fromEntries(stageModeCounts);
}

function opFamily(op: string): string {
  return op.split(':')[0] || 'core';
}

interface StageIdentity {
  missionId?: string;
  taskId?: string;
  tenantSlug?: string;
  tier: OsKnowledgeTier;
  purpose?: string;
}

/**
 * Scope identity for stage evaluation: minted envelope first, then the
 * input's trusted security_scope — matching the scope stage's contract.
 */
function stageIdentity(call: OpPreflightCall, input: Record<string, unknown>): StageIdentity {
  const envelope = currentScopeEnvelope();
  const scope = (input.security_scope ?? call.context?.security_scope) as
    Record<string, unknown> | undefined;
  const readTiers = Array.isArray(scope?.read_tiers) ? (scope.read_tiers as string[]) : [];
  const tier = (envelope?.identity.tier ??
    (readTiers.includes('personal')
      ? 'personal'
      : readTiers.includes('confidential')
        ? 'confidential'
        : 'public')) as OsKnowledgeTier;
  return {
    missionId:
      envelope?.identity.mission_id ??
      (typeof scope?.mission_id === 'string' ? scope.mission_id : undefined) ??
      (typeof input.mission_id === 'string' ? input.mission_id : undefined),
    taskId:
      envelope?.identity.task_id ??
      (typeof scope?.task_id === 'string' ? scope.task_id : undefined) ??
      (typeof input.task_id === 'string' ? input.task_id : undefined),
    tenantSlug:
      envelope?.identity.tenant_slug ??
      (typeof scope?.tenant_slug === 'string'
        ? scope.tenant_slug
        : typeof scope?.tenant_id === 'string'
          ? scope.tenant_id
          : undefined),
    tier,
    purpose:
      envelope?.policy.purpose ?? (typeof scope?.purpose === 'string' ? scope.purpose : undefined),
  };
}

/**
 * Preflight: write/egress ops require a resource introduction for the
 * stamped `_resource_ref`. Rollout `warn` audits without blocking;
 * `enforce` throws POLICY_VIOLATION through the listener waterfall.
 */
export function introductionResult(
  call: OpPreflightCall,
  input: Record<string, unknown>
): OpPreflightListenerResult | void {
  const effect = input._effect;
  if (effect !== 'write' && effect !== 'egress') return;
  const mode = stageMode('introduction', opFamily(call.op));
  if (mode === 'off') return;
  const resourceRef = typeof input._resource_ref === 'string' ? input._resource_ref : undefined;
  if (!resourceRef) return;
  const identity = stageIdentity(call, input);
  if (!identity.missionId) {
    noteStage('introduction', 'skipped');
    return;
  }
  const service =
    (typeof input.service_id === 'string' && input.service_id.trim()) || opFamily(call.op);
  const introduced = sharedControlPlane().enforceIntroduction({
    missionId: identity.missionId,
    taskId: identity.taskId,
    service,
    resourceRef,
    scope: 'write',
    mode,
  });
  noteStage('introduction', introduced ? 'warn' : 'denied');
}

/**
 * Preflight: egress ops get the mission's taint projection stamped so the
 * monotonic guard can enforce tier/tenant rules (consumed by SC-06).
 */
export function taintResult(
  call: OpPreflightCall,
  input: Record<string, unknown>
): OpPreflightListenerResult | void {
  if (input._effect !== 'egress') return;
  const mode = stageMode('taint', opFamily(call.op));
  if (mode === 'off') return;
  const identity = stageIdentity(call, input);
  if (!identity.missionId) {
    noteStage('taint', 'skipped');
    return;
  }
  const taint = sharedControlPlane().projectTaint(identity.missionId);
  return {
    repaired_input: {
      _egress_taint: taint,
    },
  };
}

/**
 * SC-06: monotonic provenance-egress guard for `effect = egress` ops.
 * Consumes the `_egress_taint` stamped by `taintResult`; a declared target
 * audience/tenant is evaluated against the shared rule, and a declassified
 * payloadHash bypasses exactly one artifact's destination.
 */
export function provenanceEgressResult(
  call: OpPreflightCall,
  input: Record<string, unknown>
): OpPreflightListenerResult | void {
  if (input._effect !== 'egress') return;
  const mode = stageMode('egress', opFamily(call.op));
  if (mode === 'off') return;
  const identity = stageIdentity(call, input);
  if (!identity.missionId) {
    noteStage('egress', 'skipped');
    return;
  }
  const targetAudience = readAudience(input);
  const targetTenant =
    typeof input.target_tenant === 'string'
      ? input.target_tenant
      : typeof input.tenant_slug === 'string'
        ? input.tenant_slug
        : undefined;
  const payloadHash =
    typeof input.payload_hash === 'string'
      ? input.payload_hash
      : typeof input.payloadHash === 'string'
        ? input.payloadHash
        : undefined;
  const controlPlane = sharedControlPlane();
  if (
    payloadHash &&
    targetAudience &&
    controlPlane.isDeclassified(identity.missionId, payloadHash, targetAudience, targetTenant)
  ) {
    return;
  }
  const taint =
    (input._egress_taint as ProvenanceTaint | undefined) ??
    controlPlane.projectTaint(identity.missionId);
  if (!targetAudience) {
    noteStage('egress', 'skipped');
    return;
  }
  const verdict = evaluateProvenanceEgress(taint, targetAudience, targetTenant);
  if (verdict.allowed) return;
  if (mode === 'warn') {
    noteStage('egress', 'denied');
    return;
  }
  return {
    decision: 'block',
    reason: `[OP_EGRESS_DENIED] ${verdict.reason}`,
    terminate: true,
  };
}

function readAudience(input: Record<string, unknown>): OsKnowledgeTier | 'external' | undefined {
  const candidate =
    (typeof input.target_audience === 'string' && input.target_audience) ||
    (typeof input.audience === 'string' && input.audience) ||
    undefined;
  if (candidate === 'external') return 'external';
  if (candidate === 'public' || candidate === 'confidential' || candidate === 'personal') {
    return candidate;
  }
  return undefined;
}

/**
 * Post-op: read ops aggregate an observation into the control plane.
 * Best effort — the op already ran, so recording failure never throws
 * back into the caller's retry loop.
 */
export function recordOpObservation(
  op: string,
  input: Record<string, unknown>,
  context?: Record<string, unknown>
): void {
  if (input._effect !== 'read') return;
  const mode = stageMode('observation', opFamily(op));
  if (mode === 'off') return;
  const resourceRef = typeof input._resource_ref === 'string' ? input._resource_ref : undefined;
  if (!resourceRef) return;
  const identity = stageIdentity({ op, params: {}, context, source: 'pipeline' }, input);
  if (!identity.missionId || !identity.tenantSlug) {
    noteStage('observation', 'skipped');
    return;
  }
  const service = (typeof input.service_id === 'string' && input.service_id.trim()) || opFamily(op);
  try {
    sharedControlPlane().recordObservation({
      missionId: identity.missionId,
      taskId: identity.taskId,
      service,
      resourceRef,
      tier: identity.tier,
      tenantSlug: identity.tenantSlug,
      purpose: identity.purpose || op,
      summary: `${op} -> ${resourceRef}`,
    });
  } catch {
    noteStage('observation', 'warn');
    return;
  }
  noteStage('observation', 'warn');
}
