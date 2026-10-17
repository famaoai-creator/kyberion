import { findHearingScenario } from '@agent/core/hearing-scenario-catalog';
import { frontDeskRoleFromViewerScope } from '@agent/core/front-desk-identity';
import { withExecutionContext } from '@agent/core/authority';
import { loadState } from '@agent/core/mission/mission-state';
import { loadApprovalRequest } from '@agent/core/governance/approval-store';
import {
  loadWorkInventoryEntry,
  workInventoryScopeKey,
} from '@agent/core/workforce/work-inventory';
import { resolveFrontDeskMenu, readFrontDeskSurfaceUrls } from '@agent/core/front-desk-nav';
import {
  presenceStudioRecordInScope,
  toFrontDeskViewerScope,
  type PresenceStudioViewerContext,
} from './security.js';
import { resolveWorkInventoryScopeForViewer } from './work-inventory-routes.js';
import { hearingNamespace } from './hearing-runtime.js';
import type { HearingRecord } from './hearing.js';
import type { HearingMissionHandoffFields } from './hearing-mission-routes.js';
import type { HearingWorkInventoryHandoffFields } from './hearing-routes.js';

type StoredHearing = HearingRecord &
  HearingMissionHandoffFields &
  HearingWorkInventoryHandoffFields;
export interface HearingCompletion {
  kind: 'mission' | 'inventory';
  status: 'ready' | 'unavailable';
  id?: string;
  next?: { href: string };
}

/** Completion identifiers are projections, never trusted wire fields from storage. */
export function withoutHearingCompletionFields(record: HearingRecord): HearingRecord {
  const sanitized = { ...record } as StoredHearing;
  delete sanitized.mission_id;
  delete sanitized.approval_request_id;
  delete sanitized.handed_off_at;
  delete sanitized.work_inventory_entry_id;
  delete sanitized.work_inventory_scope;
  delete sanitized.work_inventory_steps;
  return sanitized;
}

function completionHref(
  kind: HearingCompletion['kind'],
  viewer: PresenceStudioViewerContext
): string | undefined {
  const item = resolveFrontDeskMenu({
    currentSurface: 'presence-studio',
    urls: readFrontDeskSurfaceUrls(),
    role: frontDeskRoleFromViewerScope(toFrontDeskViewerScope(viewer)),
  }).find((candidate) => candidate.id === (kind === 'mission' ? 'decide' : 'progress'));
  if (!item?.allowed) return undefined;
  const url = new URL(item.href, 'http://hearing.invalid');
  const namespace = hearingNamespace(viewer.tenantSlugs);
  url.searchParams.set(
    'tenant',
    namespace === 'all' || namespace === 'unscoped' ? 'personal' : namespace
  );
  const scope = toFrontDeskViewerScope(viewer);
  for (const [key, values] of [
    ['organizationId', scope.organizationIds],
    ['projectId', scope.projectIds],
  ] as const) {
    if (values === 'all') continue;
    // These destinations accept one hierarchy selection, never an expanded set.
    if (values.length !== 1) return undefined;
    url.searchParams.set(key, values[0]);
  }
  return item.external ? url.href : url.pathname + url.search + url.hash;
}

/** Read-only proof of the handoff. Missing, corrupt and unauthorized targets all
 * yield the same non-actionable marker, without leaking IDs or enabling retries. */
export function readHearingCompletion(
  record: HearingRecord,
  viewer: PresenceStudioViewerContext
): HearingCompletion | undefined {
  const stored = record as StoredHearing;
  const missionMarker = Boolean(
    stored.mission_id || stored.approval_request_id || stored.handed_off_at
  );
  const inventoryMarker = Boolean(
    stored.work_inventory_entry_id ||
    stored.work_inventory_scope ||
    stored.work_inventory_steps !== undefined
  );
  if (!missionMarker && !inventoryMarker) return undefined;
  const kind = inventoryMarker && !missionMarker ? 'inventory' : 'mission';
  const unavailable: HearingCompletion = { kind, status: 'unavailable' };
  if (missionMarker && inventoryMarker) return unavailable;
  try {
    if (
      !record.decided_by ||
      !record.decided_at ||
      !record.requirements?.length ||
      record.requirements.some((requirement) => !requirement.answer?.trim())
    )
      return unavailable;
    const expectedKind =
      findHearingScenario(record.scenario)?.handoff === 'work_inventory' ? 'inventory' : 'mission';
    if (kind !== expectedKind) return unavailable;
    let id: string;
    if (kind === 'mission') {
      if (!stored.mission_id || !stored.approval_request_id) return unavailable;
      const namespace = hearingNamespace(viewer.tenantSlugs);
      if (namespace === 'all' || namespace === 'unscoped') return unavailable;
      const mission = loadState(stored.mission_id);
      if (
        !mission ||
        mission.mission_id !== stored.mission_id ||
        mission.tenant_slug !== namespace ||
        !presenceStudioRecordInScope(viewer, mission)
      )
        return unavailable;
      const approval = loadApprovalRequest('brief', stored.approval_request_id);
      // Existing alignment requests carry a mission source, not always an event
      // scope. Derive visibility only from that exact, already authorized mission.
      if (
        !approval ||
        approval.id !== stored.approval_request_id ||
        approval.kind !== 'mission_gate' ||
        approval.source?.missionId !== mission.mission_id ||
        approval.correlationId !== 'mission-alignment-' + mission.mission_id
      )
        return unavailable;
      if (
        approval.scope &&
        (!presenceStudioRecordInScope(viewer, approval) || approval.scope.tenant_slug !== namespace)
      )
        return unavailable;
      id = mission.mission_id;
    } else {
      if (!stored.work_inventory_entry_id) return unavailable;
      const scope = resolveWorkInventoryScopeForViewer(viewer);
      if (
        !scope ||
        (stored.work_inventory_scope &&
          workInventoryScopeKey(stored.work_inventory_scope) !== workInventoryScopeKey(scope))
      )
        return unavailable;
      const entry = withExecutionContext('ecosystem_architect', () =>
        loadWorkInventoryEntry(scope, stored.work_inventory_entry_id!)
      );
      if (
        !entry ||
        entry.entry_id !== stored.work_inventory_entry_id ||
        workInventoryScopeKey(entry.scope) !== workInventoryScopeKey(scope)
      )
        return unavailable;
      if (scope.tenant_slug) {
        if (!presenceStudioRecordInScope(viewer, entry)) return unavailable;
      } else {
        const allowed = toFrontDeskViewerScope(viewer);
        if (
          viewer.source !== 'loopback' ||
          allowed.organizationIds !== 'all' ||
          allowed.projectIds !== 'all'
        )
          return unavailable;
      }
      id = entry.entry_id;
    }
    const href = completionHref(kind, viewer);
    return href ? { kind, status: 'ready', id, next: { href } } : unavailable;
  } catch {
    // A completion read must not hide the hearing or expose private reader errors.
    return unavailable;
  }
}
