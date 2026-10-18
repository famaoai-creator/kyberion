import { createHash } from 'node:crypto';
import { withExecutionContext } from '@agent/core/authority';
import { resolveMemberByPrincipal } from '@agent/core/organization/member-registry';
import { findHearingScenario } from '@agent/core/hearing-scenario-catalog';
import { hearingRequirementsKey, hearingRevision, type HearingRecord } from './hearing.js';
import { HearingConflictError, HearingOperationError } from './hearing-runtime.js';
import { hearingDecisionScopeKey } from './hearing-storage-access.js';
import { readHearingCompletion, withoutHearingCompletionFields } from './hearing-completion.js';
import type { PresenceStudioViewerContext } from './security.js';

export interface HearingHandoffSnapshot {
  version: 1;
  token: string;
}

/** A freshness validator, never an authorization capability. Current viewer and
 * destination authorization are re-resolved for every read and POST. Missing
 * pre-upgrade decision revisions are zero; subsequent decisions always advance. */
export function hearingHandoffSnapshot(
  record: HearingRecord,
  viewer: PresenceStudioViewerContext
): HearingHandoffSnapshot | undefined {
  if (
    record.handoff_pending ||
    !record.decided_at ||
    !record.decided_by ||
    !record.requirements.length ||
    record.requirements.some((item) => !item.answer?.trim())
  )
    return undefined;
  try {
    const completion = readHearingCompletion(record, viewer);
    if (completion && completion.status !== 'ready') return undefined;
    const member = withExecutionContext('ecosystem_architect', () =>
      resolveMemberByPrincipal({
        principalId: viewer.principalId,
        source: viewer.source,
        registrationLabel: viewer.principal?.registrationLabel,
        memberId: viewer.principal?.memberId,
      })
    );
    if (!member) return undefined;
    const kind =
      findHearingScenario(record.scenario)?.handoff === 'work_inventory' ? 'inventory' : 'mission';
    const token = createHash('sha256')
      .update(
        JSON.stringify([
          1,
          hearingDecisionScopeKey(viewer),
          viewer.principalId,
          viewer.source,
          member.member_id,
          record.session_id,
          record.scenario,
          kind,
          hearingRevision(record.requirements_revision),
          hearingRequirementsKey(record),
          hearingRevision(record.decision_revision),
          record.current_decision_operation_id ?? null,
          record.decided_at,
          record.decided_by.kind,
          record.decided_by.id,
          record.decided_by.role,
          record.decided_by.display_name ?? null,
        ])
      )
      .digest('hex');
    return { version: 1, token };
  } catch {
    // Ordinary reads remain usable when actor/target proof is unavailable.
    return undefined;
  }
}

/** Keep proof and the exact displayed record in one atomic client assignment.
 * Never persist or trust a snapshot field accidentally present in stored data. */
export function withHearingHandoffSnapshot(
  record: HearingRecord,
  viewer: PresenceStudioViewerContext
): HearingRecord & { handoff_snapshot?: HearingHandoffSnapshot } {
  const sanitized: HearingRecord & { handoff_snapshot?: HearingHandoffSnapshot } =
    withoutHearingCompletionFields(record);
  delete sanitized.handoff_snapshot;
  const snapshot = hearingHandoffSnapshot(record, viewer);
  return snapshot ? { ...sanitized, handoff_snapshot: snapshot } : sanitized;
}

/** Validate before preparation or replay. The reservation's semantic CAS then
 * carries this same viewed decision across any asynchronous preparation. */
export function assertHearingHandoffSnapshot(
  body: unknown,
  record: HearingRecord,
  viewer: PresenceStudioViewerContext
): HearingHandoffSnapshot {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    !('handoff_snapshot' in body)
  )
    throw new HearingOperationError('A displayed hearing handoff snapshot is required.');
  const snapshot = body.handoff_snapshot;
  if (
    !snapshot ||
    typeof snapshot !== 'object' ||
    Array.isArray(snapshot) ||
    Object.keys(snapshot).length !== 2 ||
    !('version' in snapshot) ||
    snapshot.version !== 1 ||
    !('token' in snapshot) ||
    typeof snapshot.token !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(snapshot.token)
  )
    throw new HearingOperationError('Invalid versioned hearing handoff snapshot.');
  const expected = hearingHandoffSnapshot(record, viewer);
  if (!expected || snapshot.token !== expected.token)
    throw new HearingConflictError('stale_snapshot');
  return { version: 1, token: snapshot.token };
}
