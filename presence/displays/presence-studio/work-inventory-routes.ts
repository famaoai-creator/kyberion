// WI-11: the presence-studio front-desk "進み具合" (progress) page's
// work-inventory automation-candidate panel, split into its own module the
// same way `hearing-routes.ts` / `training-routes.ts` were — registered
// from `server.ts` at the same position (same `/api` + `/a2ui` guard and
// rate limiter run ahead of it) so this file stays a one-line addition
// there. See docs/developer/improvement-plans-2026-08/WORK_INVENTORY_PLAN_2026-09-22.ja.md
// §3 WI-11.
import type express from 'express';
import { t as catalogT } from '@agent/core/t';
import { normalizeLocale } from '@agent/core/locale-normalize';
import { readSurfaceStringParam } from '@agent/core/surface-request-input';
import { withExecutionContext } from '@agent/core/authority';
import { logger } from '@agent/core/core';
import { resolveMemberByPrincipal } from '@agent/core/member-registry';
import {
  listWorkInventoryEntries,
  type WorkEntryStatus,
  type WorkInventoryEntry,
  type WorkInventoryScope,
} from '@agent/core/work-inventory';
import {
  loadWorkInventoryCalibration,
  rankWorkInventoryCandidates,
  type WorkInventoryScoreBasisEffort,
  type WorkInventoryScoreBasisRuns,
} from '@agent/core/work-inventory-scoring';
import { listWorkInventoryConsents } from '@agent/core/work-inventory-consent';
import { listObservationSummaries } from '@agent/core/work-inventory-observation';
import {
  PresenceStudioViewerError,
  resolvePresenceStudioViewerContext,
  type PresenceStudioViewerContext,
} from './security.js';
import { hearingNamespace } from './hearing-runtime.js';
import * as presenceStudioData from './presence-studio-runtime-data.js';

// WI-11: exactly the `front_desk` keys `static/progress.js` renders for the
// "業務の自動化候補" panel. Mirrors `TRAINING_VOCABULARY_KEYS` in
// `training-routes.ts` — its own `/api/work-inventory-vocabulary` endpoint
// (same read-only, viewer-scoped, no client-supplied widening shape as
// `/api/progress-vocabulary`) rather than extending `PROGRESS_VOCABULARY_KEYS`
// (owned by the FD-05 route split).
export const WORK_INVENTORY_VOCABULARY_KEYS = [
  'front_desk:progress_work_inventory_title',
  'front_desk:progress_work_inventory_score_label',
  'front_desk:progress_work_inventory_hours_label',
  'front_desk:progress_work_inventory_automatable_label',
  'front_desk:progress_work_inventory_status_draft',
  'front_desk:progress_work_inventory_status_confirmed',
  'front_desk:progress_work_inventory_status_candidate',
  'front_desk:progress_work_inventory_status_promoted',
  'front_desk:progress_work_inventory_status_retired',
  'front_desk:progress_work_inventory_consent_line',
  'front_desk:progress_work_inventory_consent_line_no_expiry',
  'front_desk:progress_work_inventory_consent_none',
  'front_desk:progress_work_inventory_start',
  'front_desk:progress_work_inventory_operator_hint',
  'front_desk:progress_work_inventory_empty',
] as const;

export interface WorkInventoryCandidateSummary {
  entry_id: string;
  title: string;
  score: number;
  hours_per_month: number;
  automatable_ratio: number;
  confidence: number;
  risk: number;
  status: WorkEntryStatus;
  basis: { runs: WorkInventoryScoreBasisRuns; effort: WorkInventoryScoreBasisEffort };
}

export interface WorkInventoryStatusCounts {
  draft: number;
  confirmed: number;
  candidate: number;
  promoted: number;
  retired: number;
}

export interface WorkInventoryConsentSummary {
  active: number;
  expires_soonest?: string;
  pending_summaries: number;
}

export interface WorkInventoryPanelPayload {
  ok: true;
  scope: WorkInventoryScope | null;
  candidates: WorkInventoryCandidateSummary[];
  counts: WorkInventoryStatusCounts;
  consent?: WorkInventoryConsentSummary;
}

const CANDIDATE_LIMIT = 5;

function zeroCounts(): WorkInventoryStatusCounts {
  return { draft: 0, confirmed: 0, candidate: 0, promoted: 0, retired: 0 };
}

function countByStatus(entries: WorkInventoryEntry[]): WorkInventoryStatusCounts {
  const counts = zeroCounts();
  for (const entry of entries) {
    counts[entry.status] += 1;
  }
  return counts;
}

/**
 * The one scope resolution for work inventory reads (this panel) and writes
 * (the hearing hand-off): the viewer's first tenant slug -> that tenant's
 * scope. Without a concrete tenant — no tenant, or the loopback fallback
 * `'all'` a local owner gets when no tenant is configured — only a loopback
 * session (the local machine owner) resolves to the personal scope; a remote
 * viewer resolves to `null` (no single scope), never to someone's personal
 * inventory.
 */
export function resolveWorkInventoryScopeForViewer(
  viewer: PresenceStudioViewerContext
): WorkInventoryScope | null {
  const namespace = hearingNamespace(viewer.tenantSlugs);
  if (namespace === 'all' || namespace === 'unscoped') {
    return viewer.source === 'loopback' ? {} : null;
  }
  return { tenant_slug: namespace };
}

function logWorkInventoryReadFailure(what: string, error: unknown): void {
  logger.warn(
    `[presence-studio][work-inventory] failed to read ${what}: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
}

/**
 * Top `CANDIDATE_LIMIT` automation candidates + status counts for `scope`.
 * Never throws — a taxonomy/calibration/entry read failure is logged and
 * yields empty candidates / zeroed counts, per WI-11 task 1 ("errors reading
 * -> empty lists, logged, never 500 with internals"). Deliberately picks
 * only `title`/`status` off each `WorkInventoryEntry` — never `steps` or
 * `observations`, so no step description or observation digest ever reaches
 * this summary-level response.
 */
function readWorkInventoryCandidates(scope: WorkInventoryScope): {
  candidates: WorkInventoryCandidateSummary[];
  counts: WorkInventoryStatusCounts;
} {
  try {
    const entries = withExecutionContext('ecosystem_architect', () =>
      listWorkInventoryEntries(scope)
    );
    const counts = countByStatus(entries);
    const calibration = withExecutionContext('ecosystem_architect', () =>
      loadWorkInventoryCalibration({ tenant_slug: scope.tenant_slug })
    );
    const ranked = rankWorkInventoryCandidates(entries, { calibration, limit: CANDIDATE_LIMIT });
    const entryById = new Map(entries.map((entry) => [entry.entry_id, entry]));
    const candidates: WorkInventoryCandidateSummary[] = ranked.map((result) => {
      const entry = entryById.get(result.entry_id);
      return {
        entry_id: result.entry_id,
        title: entry?.title ?? result.entry_id,
        score: result.score,
        hours_per_month: result.components.hours_per_month,
        automatable_ratio: result.components.automatable_ratio,
        confidence: result.components.confidence,
        risk: result.components.risk,
        status: entry?.status ?? 'draft',
        basis: result.basis,
      };
    });
    return { candidates, counts };
  } catch (error) {
    logWorkInventoryReadFailure('work inventory entries', error);
    return { candidates: [], counts: zeroCounts() };
  }
}

/**
 * The viewer's own consent standing — never another member's. `member` is
 * resolved server-side from the viewer principal exactly like
 * `hearing-routes.ts`'s `/decide` and `training-routes.ts`'s
 * `/api/training/progress`; there is no client-supplied member id anywhere
 * on this path. Returns `undefined` (omitted from the response) when no
 * member resolves or when the read fails — never a 500.
 */
function readViewerConsentSummary(
  viewer: PresenceStudioViewerContext
): WorkInventoryConsentSummary | undefined {
  try {
    const member = withExecutionContext('ecosystem_architect', () =>
      resolveMemberByPrincipal({ principalId: viewer.principalId, source: viewer.source })
    );
    if (!member) return undefined;
    const consents = withExecutionContext('ecosystem_architect', () =>
      listWorkInventoryConsents(member.member_id)
    );
    const nowMs = Date.now();
    const active = consents.filter((consent) => {
      if (consent.revoked_at) return false;
      const expiresMs = Date.parse(consent.expires_at);
      return Number.isFinite(expiresMs) && expiresMs > nowMs;
    });
    const summaries = withExecutionContext('ecosystem_architect', () =>
      listObservationSummaries(member.member_id)
    );
    const pending = summaries.filter((summary) => summary.status === 'pending_review').length;
    const expiresSoonest = active.length
      ? active.map((consent) => consent.expires_at).sort()[0]
      : undefined;
    return {
      active: active.length,
      ...(expiresSoonest ? { expires_soonest: expiresSoonest } : {}),
      pending_summaries: pending,
    };
  } catch (error) {
    logWorkInventoryReadFailure('work inventory consent', error);
    return undefined;
  }
}

export function registerWorkInventoryRoutes(app: express.Express): void {
  // WI-11: read-only, any viewer allowed to see progress (same posture as
  // `/api/progress`) — server-resolved scope only, never a client-supplied
  // tenant or member id. See `resolveWorkInventoryScopeForViewer` above.
  app.get('/api/front-desk/work-inventory', (req, res) => {
    let viewer: PresenceStudioViewerContext;
    try {
      viewer = resolvePresenceStudioViewerContext(req);
    } catch (error) {
      const status = error instanceof PresenceStudioViewerError ? error.status : 500;
      res.status(status).json(presenceStudioData.presenceStudioWireError(error, status));
      return;
    }

    const scope = resolveWorkInventoryScopeForViewer(viewer);
    const { candidates, counts } = scope
      ? readWorkInventoryCandidates(scope)
      : { candidates: [], counts: zeroCounts() };
    const consent = readViewerConsentSummary(viewer);

    const payload: WorkInventoryPanelPayload = {
      ok: true,
      scope,
      candidates,
      counts,
      ...(consent ? { consent } : {}),
    };
    res.setHeader('Cache-Control', 'no-store');
    res.json(payload);
  });

  // WI-11: exactly the `front_desk` keys `static/progress.js`'s
  // work-inventory panel renders. Mirrors `/api/training/vocabulary` /
  // `/api/progress-vocabulary`'s shape.
  app.get('/api/work-inventory-vocabulary', (req, res) => {
    const locale = normalizeLocale(readSurfaceStringParam(req.query.locale)) ?? 'en';
    const texts = Object.fromEntries(
      WORK_INVENTORY_VOCABULARY_KEYS.map((key) => [key, catalogT(key, undefined, locale)])
    );
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, locale, texts });
  });
}
