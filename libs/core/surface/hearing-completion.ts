import { findHearingScenario } from './hearing-scenario-catalog.js';
import { frontDeskRoleFromViewerScope } from './front-desk-identity.js';
import { withExecutionContext } from '../authority.js';
import { parseEventScopeFromRecord } from '../event/event-scope.js';
import { loadState } from '../mission/mission-state.js';
import type { MissionState } from '../mission/mission-types.js';
import { loadApprovalRequest } from '../governance/approval-store.js';
import {
  loadWorkInventoryEntry,
  workInventoryScopeKey,
  type WorkInventoryScope,
} from '../workforce/work-inventory.js';
import {
  resolveFrontDeskDestination,
  readFrontDeskSurfaceUrls,
  type FrontDeskSurfaceId,
} from './front-desk-nav.js';
import { progressRecordInScope } from './front-desk-progress.js';
import type { SurfaceViewerScope } from './surface-viewer-scope-contract.js';
import { hearingNamespace } from './hearing-runtime.js';
import { hearingScopedUrl } from './hearing-scope.js';
import type { HearingRecord } from './hearing.js';

/** Additive fields the mission hand-off owns on the hearing record. `hearing.ts`
 * (the base `HearingRecord` contract, `decided_by`/`decided_at` included) never
 * carries them — they are only ever read/written via an intersection type.
 * Used by: Studio (hearing-mission-routes), Concierge (next). */
export interface HearingMissionHandoffFields {
  mission_id?: string;
  approval_request_id?: string;
  handed_off_at?: string;
}

/** WI-08: additive fields the work-inventory hand-off owns on the hearing
 * record, mirroring `HearingMissionHandoffFields` — never added to the base
 * interface. Used by: Studio (hearing-routes), Concierge (next). */
export interface HearingWorkInventoryHandoffFields {
  work_inventory_entry_id?: string;
  work_inventory_scope?: WorkInventoryScope;
  work_inventory_steps?: number;
}

/** WI-11 / WI-15: the one work-inventory scope rule the hearing hand-off
 * reads and writes with. The viewer's first tenant slug -> that tenant's
 * scope. Without a concrete tenant — no tenant, or the loopback fallback
 * `'all'` a local owner gets when no tenant is configured — only a loopback
 * session (the local machine owner) resolves to the personal scope; a remote
 * viewer resolves to `null` (no single scope), never to someone's personal
 * inventory. Used by: Studio (work-inventory-routes), Concierge (next).
 * OWNER CHECK: "the local owner" here is `viewer.source === 'loopback'` (Studio's
 * meaning). A signed-in Concierge owner has `source: 'token'`; never pass a
 * viewer with a synthesized `source: 'loopback'` to get past this. Decide the owner
 * with the surface's own owner check and make it an explicit input first
 * (kyberion-development-practices.md, "The local owner is not the credential source").
 */
export function hearingWorkInventoryScope(
  viewer: Pick<SurfaceViewerScope, 'tenantSlugs' | 'source'>
): WorkInventoryScope | null {
  const namespace = hearingNamespace(viewer.tenantSlugs);
  if (namespace === 'all' || namespace === 'unscoped') {
    return viewer.source === 'loopback' ? {} : null;
  }
  return { tenant_slug: namespace };
}

/**
 * Concierge's selection value for the personal view (`PERSONAL_SELECTION` in
 * `presence/displays/concierge/src/lib/tenant-context.ts`). A reserved tier
 * name, so it can never collide with a tenant slug.
 */
const CONCIERGE_PERSONAL_SELECTION = 'personal';

/**
 * Where the work-inventory hand-off sends the person (仕事 › 依頼 on
 * Concierge, `scopedHref` already carries the viewer's scope). An entry filed
 * under the personal scope is listed there only in the personal view, so the
 * link selects it; a tenant-scoped entry keeps its `tenant`.
 * Used by: Studio (work-inventory-routes), Concierge (next).
 */
export function hearingWorkInventoryHandoffHref(
  scopedHref: string,
  viewer: Pick<SurfaceViewerScope, 'tenantSlugs' | 'source'>
): string {
  const scope = hearingWorkInventoryScope(viewer);
  if (!scope || scope.tenant_slug) return scopedHref;
  const base = 'http://handoff.invalid';
  const url = new URL(scopedHref, base);
  url.searchParams.set('tenant', CONCIERGE_PERSONAL_SELECTION);
  return url.origin === base ? url.pathname + url.search + url.hash : url.href;
}

/** Where completion links are resolved from. Used by: Studio, Concierge (next). */
export interface HearingCompletionOptions {
  /** The surface rendering the hearing; front-desk destinations hosted there stay relative. */
  currentSurface: FrontDeskSurfaceId;
}

type StoredHearing = HearingRecord &
  HearingMissionHandoffFields &
  HearingWorkInventoryHandoffFields;
/** Used by: Studio, Concierge (next). */
export interface HearingCompletion {
  kind: 'mission' | 'inventory';
  status: 'ready' | 'unavailable';
  id?: string;
  next?: { href: string };
}

/** Completion identifiers are projections, never trusted wire fields from storage.
 * Used by: Studio, Concierge (next). */
export function withoutHearingCompletionFields(record: HearingRecord): HearingRecord {
  const sanitized = { ...record } as StoredHearing;
  delete sanitized.handoff_pending;
  delete sanitized.decision_receipts;
  delete sanitized.current_decision_operation_id;
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
  viewer: SurfaceViewerScope,
  options: HearingCompletionOptions
): string | undefined {
  const item = resolveFrontDeskDestination(kind === 'mission' ? 'inbox' : 'progress', {
    currentSurface: options.currentSurface,
    urls: readFrontDeskSurfaceUrls(),
    role: frontDeskRoleFromViewerScope(viewer),
  });
  if (!item?.allowed) return undefined;

  const scope = viewer;
  for (const values of [scope.organizationIds, scope.projectIds]) {
    if (values === 'all') continue;
    // These destinations accept one hierarchy selection, never an expanded set.
    if (values.length !== 1) return undefined;
  }
  const scoped = hearingScopedUrl(item.href, viewer);
  return kind === 'inventory' ? hearingWorkInventoryHandoffHref(scoped, viewer) : scoped;
}

/** Mission project membership is canonical under relationships, unlike inventory scope.
 * Project it only when legacy flat/nested claims do not contradict that membership. */
function missionInHearingScope(viewer: SurfaceViewerScope, mission: MissionState): boolean {
  const projected = { ...mission } as unknown as Record<string, unknown>;
  const organizationId = mission.relationships?.organization?.organization_id;
  const projectId = mission.relationships?.project?.project_id;
  for (const [key, value] of [
    ['organization_id', organizationId],
    ['project_id', projectId],
  ] as const) {
    if (!value) continue;
    if (projected[key] !== undefined && projected[key] !== value) return false;
    projected[key] = value;
  }
  const parsed = parseEventScopeFromRecord(projected);
  if (!parsed.invalid) return progressRecordInScope(viewer, projected);
  // Older project-linked missions may lack a canonical organization parent.
  // Preserve only their tenant-wide view, without inventing narrower membership.
  const allowed = viewer;
  const original = mission as unknown as Record<string, unknown>;
  return Boolean(
    projectId &&
    !projected.organization_id &&
    original.project_id === undefined &&
    original.scope === undefined &&
    original.scope_context === undefined &&
    allowed.organizationIds === 'all' &&
    allowed.projectIds === 'all' &&
    !parseEventScopeFromRecord(original).invalid &&
    progressRecordInScope(viewer, original)
  );
}

/** Read-only proof of the handoff. Missing, corrupt and unauthorized targets all
 * yield the same non-actionable marker, without leaking IDs or enabling retries.
 * `viewer` is the surface's server-resolved viewer scope. Used by: Studio, Concierge (next).
 * OWNER CHECK: "the local owner" here is `viewer.source === 'loopback'` (Studio's
 * meaning). A signed-in Concierge owner has `source: 'token'`; never pass a
 * viewer with a synthesized `source: 'loopback'` to get past this. Decide the owner
 * with the surface's own owner check and make it an explicit input first
 * (kyberion-development-practices.md, "The local owner is not the credential source").
 * The decision scope key also takes the surface's own `tierAccess`, so a receipt
 * written on one surface may not replay on another (it fails closed as a conflict).
 */
export function readHearingCompletion(
  record: HearingRecord,
  viewer: SurfaceViewerScope,
  options: HearingCompletionOptions
): HearingCompletion | undefined {
  const stored = record as StoredHearing;
  if (stored.handoff_pending) return { kind: stored.handoff_pending.kind, status: 'unavailable' };
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
      const mission = withExecutionContext(
        'ecosystem_architect',
        () => loadState(stored.mission_id!),
        undefined,
        namespace
      );
      if (
        !mission ||
        mission.mission_id !== stored.mission_id ||
        mission.tenant_slug !== namespace ||
        !missionInHearingScope(viewer, mission)
      )
        return unavailable;
      const approval = withExecutionContext(
        'ecosystem_architect',
        () => loadApprovalRequest('brief', stored.approval_request_id!),
        undefined,
        namespace
      );
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
        (!progressRecordInScope(viewer, approval) || approval.scope.tenant_slug !== namespace)
      )
        return unavailable;
      id = mission.mission_id;
    } else {
      if (!stored.work_inventory_entry_id) return unavailable;
      const scope = hearingWorkInventoryScope(viewer);
      if (
        !scope ||
        (stored.work_inventory_scope &&
          workInventoryScopeKey(stored.work_inventory_scope) !== workInventoryScopeKey(scope))
      )
        return unavailable;
      const entry = withExecutionContext(
        'ecosystem_architect',
        () => loadWorkInventoryEntry(scope, stored.work_inventory_entry_id!),
        undefined,
        scope.tenant_slug
      );
      if (
        !entry ||
        entry.entry_id !== stored.work_inventory_entry_id ||
        workInventoryScopeKey(entry.scope) !== workInventoryScopeKey(scope)
      )
        return unavailable;
      if (scope.tenant_slug) {
        if (!progressRecordInScope(viewer, entry)) return unavailable;
      } else {
        const allowed = viewer;
        if (
          viewer.source !== 'loopback' ||
          allowed.organizationIds !== 'all' ||
          allowed.projectIds !== 'all'
        )
          return unavailable;
      }
      id = entry.entry_id;
    }
    const href = completionHref(kind, viewer, options);
    return href ? { kind, status: 'ready', id, next: { href } } : unavailable;
  } catch {
    // A completion read must not hide the hearing or expose private reader errors.
    return unavailable;
  }
}
