/**
 * NI-05: NHI lifecycle governance — offboarding, orphan detection, inventory.
 *
 * OWASP's Non-Human Identities Top 10 puts **Improper Offboarding at #1**: the
 * durable failure mode is not a stolen credential but an identity nobody
 * retired when the work it belonged to ended. NI-01 gave identities a ledger
 * and a lifecycle; NI-02 made a retired identity's claims fail closed under
 * `KYBERION_NHI_ACTOR=enforce`. What was missing is anything that actually
 * MOVES an identity to `retired`, and anything that notices when one was
 * missed.
 *
 * This module closes that loop:
 *
 *  - {@link retireIdentitiesForScope} — scope closure retires its identities.
 *    Hooked into the AL-03 mission finish ceremony, the mission archive verbs
 *    (AL-04 residue GC's siblings) and the AL-04 tenant/project offboarding
 *    verb. Retirement is terminal and idempotent, so every hook can fire
 *    without coordination.
 *  - {@link listOrphanNhiIdentities} — the inverse check: a non-retired
 *    identity whose affiliation scope no longer exists on disk. Surfaced by
 *    baseline-check (→ `needs_attention`) and in the ledger report, because a
 *    missed retirement must be visible rather than silently permanent.
 *  - {@link buildNhiLedgerReport} — the operator-facing inventory: who exists,
 *    who owns them, what state they are in, when they last did anything.
 *
 * External mapping (`docs/developer/NHI_IDENTITY_MAPPING.md`): `lifecycle_status`
 * is the internal analogue of Entra Agent ID's governance states, and this
 * module is the retirement half of that mapping.
 *
 * Contract: best-effort at every call site — a governance sweep must never
 * fail the archive/offboarding that triggered it. Reads are ungated; each
 * retirement goes through NI-01's governed `retireAgentIdentity`, so a
 * non-allowlisted caller degrades to a logged skip (never an escalation).
 */

import * as path from 'node:path';
import * as pathResolver from './path-resolver.js';
import { findMissionPath } from './path-resolver.js';
import { safeExistsSync } from './secure-io.js';
import { readTenantProfile } from './tenant-registry.js';
import { logger } from './core.js';
import { auditChain } from './audit-chain.js';
import {
  listAgentIdentities,
  retireAgentIdentity,
  type AgentIdentityLifecycleStatus,
  type AgentIdentityRecord,
} from './agent-identity.js';

// ---------------------------------------------------------------------------
// Audit seam (NI-02/NI-04 pattern: injectable, best-effort, vitest no-op)
// ---------------------------------------------------------------------------

export const NHI_IDENTITY_RETIRED_EVENT = 'nhi_identity_offboarded';
export const NHI_ORPHAN_DETECTED_EVENT = 'nhi_orphan_detected';

export interface NhiGovernanceAuditEvent {
  action: typeof NHI_IDENTITY_RETIRED_EVENT | typeof NHI_ORPHAN_DETECTED_EVENT;
  nhi_id: string;
  context: string;
  reason: string;
}

type NhiGovernanceAuditSink = (event: NhiGovernanceAuditEvent) => void;

let auditSinkOverride: NhiGovernanceAuditSink | null = null;

export function setNhiGovernanceAuditSinkForTests(sink: NhiGovernanceAuditSink | null): void {
  auditSinkOverride = sink;
}

function recordGovernanceAudit(event: NhiGovernanceAuditEvent): void {
  try {
    if (auditSinkOverride) {
      auditSinkOverride(event);
      return;
    }
    if (process.env.VITEST) return; // hermetic guard — see setNhiGovernanceAuditSinkForTests
    auditChain.record({
      agentId: event.nhi_id,
      action: event.action,
      operation: event.context,
      result: 'allowed',
      reason: event.reason,
      metadata: { nhi_id: event.nhi_id },
    });
  } catch (error) {
    logger.warn(
      `[nhi-lifecycle] audit append failed (best-effort): ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

// ---------------------------------------------------------------------------
// Scope offboarding
// ---------------------------------------------------------------------------

/**
 * Scopes an identity's affiliation can bind it to.
 *
 * Tenant is a first-class affiliation boundary.  The legacy project/org
 * fallback is intentionally not used here: a customer stance or organization
 * is not a tenant and must not cause unrelated identities to be retired.
 */
export type NhiScopeKind = 'mission' | 'project' | 'tenant';

export interface RetireIdentitiesForScopeResult {
  status: 'retired' | 'noop';
  scope: NhiScopeKind;
  scope_id: string;
  /** nhi_ids moved to `retired` by this call. */
  retired: string[];
  /** Identities that matched but could not be retired (e.g. non-allowlisted role). */
  skipped: Array<{ nhi_id: string; reason: string }>;
}

function affiliationMatches(
  record: AgentIdentityRecord,
  scope: NhiScopeKind,
  scopeId: string
): boolean {
  const affiliation = record.affiliation;
  if (scope === 'mission') return affiliation.mission_id === scopeId;
  if (scope === 'project') return affiliation.project_id === scopeId;
  return affiliation.tenant_slug === scopeId;
}

/**
 * Retire every non-retired identity affiliated with a closing scope. Never
 * throws: an identity the caller's role may not retire is reported in
 * `skipped` (NI-01's governed gate is deliberately not bypassed).
 */
export function retireIdentitiesForScope(input: {
  scope: NhiScopeKind;
  scopeId: string;
  reason: string;
}): RetireIdentitiesForScopeResult {
  const scopeId = String(input.scopeId || '').trim();
  const result: RetireIdentitiesForScopeResult = {
    status: 'noop',
    scope: input.scope,
    scope_id: scopeId,
    retired: [],
    skipped: [],
  };
  if (!scopeId) return result;

  let candidates: AgentIdentityRecord[];
  try {
    candidates = listAgentIdentities().filter(
      (record) =>
        record.lifecycle_status !== 'retired' && affiliationMatches(record, input.scope, scopeId)
    );
  } catch (error) {
    logger.warn(
      `[nhi-lifecycle] could not read the identity ledger for ${input.scope} '${scopeId}': ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return result;
  }
  if (candidates.length === 0) return result;

  for (const record of candidates) {
    try {
      retireAgentIdentity(record.nhi_id, input.reason);
      result.retired.push(record.nhi_id);
      recordGovernanceAudit({
        action: NHI_IDENTITY_RETIRED_EVENT,
        nhi_id: record.nhi_id,
        context: `nhi-lifecycle.retireIdentitiesForScope(${input.scope})`,
        reason: input.reason,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.skipped.push({ nhi_id: record.nhi_id, reason: message });
      logger.warn(`[nhi-lifecycle] could not retire ${record.nhi_id}: ${message}`);
    }
  }
  if (result.retired.length > 0) result.status = 'retired';
  return result;
}

/** Best-effort wrapper for lifecycle hooks: never throws, returns the retired count. */
export function retireIdentitiesForScopeBestEffort(input: {
  scope: NhiScopeKind;
  scopeId: string;
  reason: string;
}): number {
  try {
    return retireIdentitiesForScope(input).retired.length;
  } catch (error) {
    logger.warn(
      `[nhi-lifecycle] best-effort scope retirement failed for ${input.scope} '${input.scopeId}': ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Orphan detection
// ---------------------------------------------------------------------------

export type NhiOrphanReason =
  'mission_scope_missing' | 'project_scope_missing' | 'tenant_scope_missing';

export interface NhiOrphanIdentity {
  nhi_id: string;
  lifecycle_status: AgentIdentityLifecycleStatus;
  accountable_human_id: string;
  reason: NhiOrphanReason;
  /** The affiliation value that no longer resolves. */
  missing_scope_id: string;
}

const SCOPE_TIERS = ['personal', 'confidential', 'public'] as const;

function projectScopeExists(projectId: string): boolean {
  return SCOPE_TIERS.some((tier) =>
    safeExistsSync(path.join(pathResolver.rootDir(), 'active', 'projects', tier, projectId))
  );
}

/**
 * Non-retired identities whose affiliation scope is gone — the symptom of a
 * missed offboarding (OWASP NHI #1). Mission affiliation is checked against
 * the live mission roots: an archived mission no longer resolves, which is
 * exactly the case {@link retireIdentitiesForScope} should have handled at
 * archive time.
 */
export function listOrphanNhiIdentities(): NhiOrphanIdentity[] {
  let records: AgentIdentityRecord[];
  try {
    records = listAgentIdentities();
  } catch (error) {
    logger.warn(
      `[nhi-lifecycle] orphan scan could not read the ledger: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return [];
  }

  const orphans: NhiOrphanIdentity[] = [];
  for (const record of records) {
    if (record.lifecycle_status === 'retired') continue;
    const missionId = record.affiliation.mission_id;
    const projectId = record.affiliation.project_id;
    const tenantSlug = record.affiliation.tenant_slug;
    try {
      if (tenantSlug && !readTenantProfile(tenantSlug)) {
        orphans.push({
          nhi_id: record.nhi_id,
          lifecycle_status: record.lifecycle_status,
          accountable_human_id: record.accountable_human_id,
          reason: 'tenant_scope_missing',
          missing_scope_id: tenantSlug,
        });
        continue;
      }
      if (missionId && !findMissionPath(missionId)) {
        orphans.push({
          nhi_id: record.nhi_id,
          lifecycle_status: record.lifecycle_status,
          accountable_human_id: record.accountable_human_id,
          reason: 'mission_scope_missing',
          missing_scope_id: missionId,
        });
        continue;
      }
      if (projectId && !projectScopeExists(projectId)) {
        orphans.push({
          nhi_id: record.nhi_id,
          lifecycle_status: record.lifecycle_status,
          accountable_human_id: record.accountable_human_id,
          reason: 'project_scope_missing',
          missing_scope_id: projectId,
        });
      }
    } catch {
      // An unreadable scope is not evidence of an orphan — skip, never accuse.
    }
  }
  return orphans;
}

/** True when no active identity has lost its scope — the baseline-check predicate. */
export function isNhiLedgerHealthy(orphans?: NhiOrphanIdentity[]): boolean {
  const found = orphans ?? listOrphanNhiIdentities();
  if (found.length > 0) {
    for (const orphan of found) {
      recordGovernanceAudit({
        action: NHI_ORPHAN_DETECTED_EVENT,
        nhi_id: orphan.nhi_id,
        context: 'nhi-lifecycle.isNhiLedgerHealthy',
        reason: `${orphan.reason}: ${orphan.missing_scope_id}`,
      });
    }
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Ledger report (operator inventory)
// ---------------------------------------------------------------------------

export interface NhiLedgerEntry {
  nhi_id: string;
  kind: AgentIdentityRecord['kind'];
  display_name: string;
  accountable_human_id: string;
  lifecycle_status: AgentIdentityLifecycleStatus;
  affiliation: AgentIdentityRecord['affiliation'];
  /** Newest of: bound runtime instances, retirement, creation. */
  last_activity_at: string;
  runtime_instances: number;
}

export interface NhiLedgerReport {
  generated_at: string;
  total: number;
  by_status: Record<AgentIdentityLifecycleStatus, number>;
  orphans: NhiOrphanIdentity[];
  identities: NhiLedgerEntry[];
}

function lastActivityAt(record: AgentIdentityRecord): string {
  const stamps = [record.created_at, record.retired_at ?? ''];
  for (const instance of record.runtime_instances ?? []) stamps.push(instance.bound_at);
  return stamps.filter(Boolean).sort().at(-1) ?? record.created_at;
}

/**
 * The NHI inventory an operator can actually read: nhi_id, owner, state,
 * affiliation, last activity — plus the orphans that need a decision. Pure
 * read, safe to call from any surface.
 */
export function buildNhiLedgerReport(options?: { nowIso?: string }): NhiLedgerReport {
  const byStatus: Record<AgentIdentityLifecycleStatus, number> = {
    provisioned: 0,
    active: 0,
    suspended: 0,
    retired: 0,
  };
  let records: AgentIdentityRecord[] = [];
  try {
    records = listAgentIdentities();
  } catch (error) {
    logger.warn(
      `[nhi-lifecycle] ledger report could not read the ledger: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  const identities: NhiLedgerEntry[] = records.map((record) => {
    byStatus[record.lifecycle_status] += 1;
    return {
      nhi_id: record.nhi_id,
      kind: record.kind,
      display_name: record.display_name,
      accountable_human_id: record.accountable_human_id,
      lifecycle_status: record.lifecycle_status,
      affiliation: record.affiliation,
      last_activity_at: lastActivityAt(record),
      runtime_instances: record.runtime_instances?.length ?? 0,
    };
  });

  return {
    generated_at: options?.nowIso ?? new Date().toISOString(),
    total: identities.length,
    by_status: byStatus,
    orphans: listOrphanNhiIdentities(),
    identities,
  };
}
