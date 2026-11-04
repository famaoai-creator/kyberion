/**
 * Default store readers for the needs-you queue (`needs-you.ts`).
 *
 * The MCP facade and any caller without its own reader use these. The
 * unified shell (Concierge) passes a richer reader of the same shape — it adds
 * owner-authenticated personal approvals and PR previews — so both surfaces
 * count with the one builder.
 *
 * Admission is conservative: tier and tenant come from the server-resolved
 * viewer; a memory candidate with an audience or an owner restriction is left
 * out because this reader cannot prove who the caller is.
 */

import { withExecutionContext } from '../authority.js';
import { buildCeoSurfaceSummary } from '../ceo-surface-summary.js';
import {
  listMemoryPromotionCandidates,
  memoryPromotionCandidateKey,
  type MemoryCandidate,
} from '../knowledge/memory-promotion-queue.js';
import { collectMissionHygieneReport } from '../mission/mission-hygiene.js';
import { loadState } from '../mission/mission-state.js';
import { createLogger } from '../logger.js';
import type {
  NeedsYouClarificationInput,
  NeedsYouKnowledgeInput,
  NeedsYouSourceData,
} from './needs-you.js';
import type { SurfaceAuthorizationContext } from './surface-authorization.js';

const logger = createLogger('needs-you-sources');

/** Enough to count every open item; the queue never shows a truncated total. */
export const NEEDS_YOU_READ_LIMIT = 1000;
const SUMMARY_MAX_CHARS = 400;

type Tier = 'personal' | 'confidential' | 'public';
const TIERS: readonly Tier[] = ['personal', 'confidential', 'public'];

function tiersOf(viewer: SurfaceAuthorizationContext): Tier[] {
  return TIERS.filter((tier) => tier !== 'personal' && viewer.tierAccess.includes(tier));
}

function tenantAllowed(viewer: SurfaceAuthorizationContext, tenant: string | undefined): boolean {
  if (viewer.tenantSlugs === 'all') return true;
  return Boolean(tenant && viewer.tenantSlugs.includes(tenant));
}

/** A memory candidate as the queue card shows it (summary clamped, origin humanized). */
export function needsYouKnowledgeFromCandidate(
  candidate: MemoryCandidate,
  learningReviewUrl?: string
): NeedsYouKnowledgeInput {
  const summary = String(candidate.summary || '').trim();
  return {
    ...(candidate.scope ? { candidateKey: memoryPromotionCandidateKey(candidate) } : {}),
    ...(learningReviewUrl ? { learningReviewUrl } : {}),
    id: candidate.candidate_id,
    kind: candidate.proposed_memory_kind,
    summary:
      summary.length > SUMMARY_MAX_CHARS ? `${summary.slice(0, SUMMARY_MAX_CHARS)}…` : summary,
    source: String(candidate.source_ref || '').replace(/^[a-z_]+:/, ''),
    source_type: candidate.source_type,
    sensitivity_tier: candidate.sensitivity_tier,
    occurrences: Math.max(1, Number(candidate.occurrences) || 1),
    queued_at: candidate.queued_at,
    status: candidate.status,
    ...(candidate.scope?.tenant_slug ? { tenant_slug: candidate.scope.tenant_slug } : {}),
    ...(candidate.scope?.organization_id
      ? { organization_id: candidate.scope.organization_id }
      : {}),
    ...(candidate.scope?.project_id ? { project_id: candidate.scope.project_id } : {}),
  };
}

function knowledgeFor(viewer: SurfaceAuthorizationContext): NeedsYouKnowledgeInput[] {
  const tiers = tiersOf(viewer);
  return withExecutionContext('sovereign_concierge', () => listMemoryPromotionCandidates())
    .filter((candidate) => candidate.status === 'queued')
    .filter((candidate) => {
      const scope = candidate.scope;
      const sourceTier = (scope?.tier ?? candidate.sensitivity_tier) as Tier;
      if (!tiers.includes(candidate.sensitivity_tier as Tier) || !tiers.includes(sourceTier))
        return false;
      if (scope?.allowed_audience?.length || scope?.owner_nhi) return false;
      return sourceTier === 'public' || tenantAllowed(viewer, scope?.tenant_slug);
    })
    .map((candidate) => needsYouKnowledgeFromCandidate(candidate));
}

function clarificationsFor(viewer: SurfaceAuthorizationContext): NeedsYouClarificationInput[] {
  const tiers = tiersOf(viewer);
  const report = withExecutionContext('sovereign_concierge', () => collectMissionHygieneReport());
  return [...report.abandoned, ...report.stale]
    .filter((finding) => tiers.includes(finding.tier as Tier))
    .filter((finding) => finding.tier === 'public' || tenantAllowed(viewer, finding.tenant_slug))
    .map((finding) => {
      let goal = '';
      let since: string | undefined;
      try {
        const state = withExecutionContext('sovereign_concierge', () =>
          loadState(finding.mission_id)
        );
        goal = state?.intent?.goal_summary?.trim() || '';
        since = state?.history?.find((entry) => entry.ts)?.ts;
      } catch {
        // Display only: an unreadable state keeps the finding with its id.
      }
      return {
        mission_id: finding.mission_id,
        title: goal ? goal.slice(0, 120) : finding.mission_id,
        reason: finding.reason,
        tier: finding.tier,
        ...(finding.tenant_slug ? { tenant_slug: finding.tenant_slug } : {}),
        ...(finding.organization_id ? { organization_id: finding.organization_id } : {}),
        age_days: finding.age_days,
        ...(since ? { waiting_since: since } : {}),
      };
    });
}

function guarded<T>(label: string, read: () => T[]): T[] {
  try {
    return read();
  } catch (error) {
    logger.warn(
      `needs-you ${label} unreadable — those items are left out of the queue | next: check the ${label} store | evidence: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return [];
  }
}

/** Default reader: approval store, deliverable inbox, memory queue, hygiene report, notifications. */
export function readNeedsYouSources(viewer: SurfaceAuthorizationContext): NeedsYouSourceData {
  const tenantSlugs = viewer.tenantSlugs === 'all' ? 'all' : [...viewer.tenantSlugs];
  const summary = withExecutionContext(
    'sovereign_concierge',
    () =>
      buildCeoSurfaceSummary({
        scope: {
          tiers: tiersOf(viewer),
          tenantSlugs,
          organizationIds: viewer.organizationIds === 'all' ? 'all' : [...viewer.organizationIds],
          projectIds: viewer.projectIds === 'all' ? 'all' : [...viewer.projectIds],
        },
        limit: NEEDS_YOU_READ_LIMIT,
      }),
    undefined,
    Array.isArray(tenantSlugs) && tenantSlugs.length === 1 ? tenantSlugs[0] : undefined
  );
  return {
    approvals: summary.approval_queue,
    outcomes: summary.outcome_feed,
    failures: summary.exception_feed,
    knowledge: guarded('memory queue', () => knowledgeFor(viewer)),
    clarifications: guarded('mission hygiene', () => clarificationsFor(viewer)),
  };
}
