import { withExecutionContext } from '@agent/core/authority';
import { createLogger } from '@agent/core/logger';
import { readFrontDeskSurfaceUrls, resolveFrontDeskDestination } from '@agent/core/front-desk-nav';
import {
  listWorkInventoryEntries,
  type WorkEntryStatus,
  type WorkInventoryEntry,
  type WorkInventoryScope,
} from '@agent/core/workforce/work-inventory';
import {
  loadWorkInventoryCalibration,
  rankWorkInventoryCandidates,
} from '@agent/core/workforce/work-inventory-scoring';
import { listWorkInventoryConsents } from '@agent/core/workforce/work-inventory-consent';
import { listObservationSummaries } from '@agent/core/workforce/work-inventory-observation';
import type { ConciergeViewerContext } from './viewer-context';
import {
  resolveWorkInventoryMember,
  resolveWorkInventoryScopeForViewer,
} from './work-inventory-member';

/**
 * 仕事 › 依頼's 業務の自動化候補 panel, moved from presence-studio's 進み具合
 * page (`GET /api/front-desk/work-inventory`, WI-11; Kyberion server phase 2).
 * Summary level only: each candidate is its title, status and score
 * components — never an entry's steps or observations.
 *
 * Scope: the selected company's inventory (`resolveWorkInventoryScopeForViewer`).
 * Tier rule: a company inventory is confidential and needs `confidential` in
 * the viewer's tier access.
 *
 * Conscious tier exception (same decision as `work-inventory-member.ts`
 * `resolveWorkInventoryScopeForViewer`, and as presence-studio's panel): in
 * the personal view, the loopback localadmin — the local machine owner —
 * sees their own personal inventory, because that is where the
 * work-inventory hearing files an entry saved without a single company, and
 * its hand-off links here. Concierge's tier mask otherwise excludes
 * `personal`; no other viewer, and no other view, ever lists it.
 *
 * The consent line reads the viewer's own personal consent and observation
 * summary records (`knowledge/personal/members/<own member id>/`) — counts
 * only, never another member's. Reads run as `sovereign_concierge`, as the
 * other work-inventory routes do.
 */
const READ_ROLE = 'sovereign_concierge';
const CANDIDATE_LIMIT = 5;
const logger = createLogger('concierge-work-inventory-panel');

export interface WorkInventoryCandidateView {
  entry_id: string;
  title: string;
  score: number;
  hours_per_month: number;
  automatable_ratio: number;
  status: WorkEntryStatus;
}

export type WorkInventoryStatusCounts = Record<WorkEntryStatus, number>;

export interface WorkInventoryPanel {
  ok: true;
  /** False when no inventory is in view (nothing is listed). */
  scoped: boolean;
  candidates: WorkInventoryCandidateView[];
  counts: WorkInventoryStatusCounts;
  consent?: { active: number; expires_soonest?: string; pending_summaries: number };
  /** Starts the inventory hearing on 頼む (still a presence-studio page). */
  start_href: string;
  /** The `pnpm work:inventory` hint is for the local operator only. */
  operator_hint: boolean;
}

/** 頼む's work-inventory hearing, resolved through the shared destination catalog. */
function inventoryStartHref(): string {
  const ask = resolveFrontDeskDestination('ask', {
    currentSurface: 'concierge',
    urls: readFrontDeskSurfaceUrls(),
  });
  return (ask?.href ?? '/ask') + '?mode=hearing&scenario=work_inventory';
}

const zeroCounts = (): WorkInventoryStatusCounts => ({
  draft: 0,
  confirmed: 0,
  candidate: 0,
  promoted: 0,
  retired: 0,
});

function readFailed(what: string, error: unknown): void {
  logger.warn(
    `work inventory ${what} unreadable — ${error instanceof Error ? error.message : String(error)} | next: the panel shows no ${what}; check the work-inventory store | evidence: role=${READ_ROLE}`
  );
}

/** The local machine owner: a loopback localadmin session. */
function isLocalOwner(viewer: ConciergeViewerContext): boolean {
  return viewer.source === 'loopback' && viewer.role === 'localadmin';
}

/**
 * The inventory in view, or null: the selected company's (confidential), or —
 * the tier exception above — the local owner's own personal inventory in the
 * personal view.
 */
export function workInventoryPanelScope(
  viewer: ConciergeViewerContext,
  options: { personalView?: boolean } = {}
): WorkInventoryScope | null {
  const scope = resolveWorkInventoryScopeForViewer(viewer);
  if (!scope) return null;
  if (!scope.tenant_slug) {
    return options.personalView && isLocalOwner(viewer) ? scope : null;
  }
  return viewer.tierAccess.includes('confidential') ? scope : null;
}

function readCandidates(scope: WorkInventoryScope) {
  try {
    return withExecutionContext(READ_ROLE, () => {
      const entries: WorkInventoryEntry[] = listWorkInventoryEntries(scope);
      const counts = zeroCounts();
      for (const entry of entries) counts[entry.status] += 1;
      const calibration = loadWorkInventoryCalibration({ tenant_slug: scope.tenant_slug });
      const byId = new Map(entries.map((entry) => [entry.entry_id, entry]));
      const candidates = rankWorkInventoryCandidates(entries, {
        calibration,
        limit: CANDIDATE_LIMIT,
      }).map((result) => ({
        entry_id: result.entry_id,
        title: byId.get(result.entry_id)?.title ?? result.entry_id,
        score: result.score,
        hours_per_month: result.components.hours_per_month,
        automatable_ratio: result.components.automatable_ratio,
        status: byId.get(result.entry_id)?.status ?? ('draft' as const),
      }));
      return { candidates, counts };
    });
  } catch (error) {
    readFailed('candidates', error);
    return { candidates: [], counts: zeroCounts() };
  }
}

function readConsent(viewer: ConciergeViewerContext): WorkInventoryPanel['consent'] {
  try {
    const member = resolveWorkInventoryMember(viewer);
    if (!member) return undefined;
    return withExecutionContext(READ_ROLE, () => {
      const now = Date.now();
      const active = listWorkInventoryConsents(member.member_id).filter((consent) => {
        const expires = Date.parse(consent.expires_at);
        return !consent.revoked_at && Number.isFinite(expires) && expires > now;
      });
      const pending = listObservationSummaries(member.member_id).filter(
        (summary) => summary.status === 'pending_review'
      ).length;
      const soonest = active.map((consent) => consent.expires_at).sort()[0];
      return {
        active: active.length,
        ...(soonest ? { expires_soonest: soonest } : {}),
        pending_summaries: pending,
      };
    });
  } catch (error) {
    readFailed('consent', error);
    return undefined;
  }
}

/** Never throws: an unreadable store yields an empty panel, logged. */
export function readWorkInventoryPanel(
  viewer: ConciergeViewerContext,
  options: { personalView?: boolean } = {}
): WorkInventoryPanel {
  const scope = workInventoryPanelScope(viewer, options);
  const { candidates, counts } = scope
    ? readCandidates(scope)
    : { candidates: [], counts: zeroCounts() };
  const consent = readConsent(viewer);
  return {
    ok: true,
    scoped: Boolean(scope),
    candidates,
    counts,
    ...(consent ? { consent } : {}),
    start_href: inventoryStartHref(),
    operator_hint: isLocalOwner(viewer),
  };
}
