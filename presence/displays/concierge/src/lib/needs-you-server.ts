import { NextRequest, NextResponse } from 'next/server';
import { resolveSurfaceBrowserUrl } from '@agent/core/surface/surface-url';
import { withExecutionContext } from '@agent/core/authority';
import {
  listMemoryPromotionCandidates,
  type MemoryCandidate,
} from '@agent/core/knowledge/memory-promotion-queue';
import type { NeedsYouKnowledgeInput, NeedsYouSourceData } from '@agent/core/surface/needs-you';
import {
  NEEDS_YOU_READ_LIMIT,
  needsYouKnowledgeFromCandidate,
} from '@agent/core/surface/needs-you-sources';
import { invokeSurfaceOperation } from '@agent/core/surface/surface-operation-registry';
import { readConciergeHome } from './headless-projections';
import { listHygieneInquiries } from './hygiene-server';
import { memoryCandidateVisibleToViewer } from './memory-candidate-visibility';
import { resolveConciergeSelectedViewer, type ConciergeSelectedViewer } from './selected-tenant';
import { PERSONAL_SELECTION, SYSTEM_SELECTION } from './tenant-context';
import {
  conciergeErrorResponse,
  narrowConciergeScope,
  toSurfaceAuthorizationContext,
  type ConciergeViewerContext,
} from './viewer-context';

/**
 * The unified shell's needs-you reader: the same stores the old `/` inbox read
 * (`/api/summary` approval queue + owner-authenticated personal approvals,
 * deliverable inbox, exception feed, `/api/hygiene`, `/api/memory-queue`),
 * fed to the one builder in `@agent/core/surface/needs-you`.
 */

/** A scoped SOP is curated in the knowledge library, not decided from the queue. */
function learningReviewUrl(candidate: MemoryCandidate): string | undefined {
  if (!(candidate.scope && candidate.proposed_memory_kind === 'sop')) return undefined;
  const url = new URL(resolveSurfaceBrowserUrl('chronos'));
  url.searchParams.set('section', 'knowledge');
  url.searchParams.set('candidateKey', needsYouKnowledgeFromCandidate(candidate).candidateKey!);
  if (candidate.scope.tenant_slug) url.searchParams.set('tenant', candidate.scope.tenant_slug);
  return url.href;
}

/** Undecided memory candidates the viewer may see, newest first. */
export function listConciergeMemoryQueue(viewer: ConciergeViewerContext): NeedsYouKnowledgeInput[] {
  return withExecutionContext('sovereign_concierge', () => listMemoryPromotionCandidates())
    .filter((candidate) => candidate.status === 'queued')
    .filter((candidate) => memoryCandidateVisibleToViewer(candidate, viewer))
    .sort((a, b) => String(b.queued_at).localeCompare(String(a.queued_at)))
    .map((candidate) => needsYouKnowledgeFromCandidate(candidate, learningReviewUrl(candidate)));
}

export function readConciergeNeedsYou(viewer: ConciergeViewerContext): NeedsYouSourceData {
  const home = readConciergeHome(viewer, { limit: NEEDS_YOU_READ_LIMIT });
  return {
    approvals: home.approval_queue,
    outcomes: home.outcome_feed,
    failures: home.exception_feed,
    clarifications: listHygieneInquiries(viewer),
    knowledge: listConciergeMemoryQueue(viewer),
  };
}

/** Reads every view and concatenates; the builder dedupes records seen twice. */
export function readConciergeNeedsYouViews(
  views: readonly ConciergeViewerContext[]
): NeedsYouSourceData {
  const parts = views.map(readConciergeNeedsYou);
  return {
    approvals: parts.flatMap((part) => part.approvals),
    outcomes: parts.flatMap((part) => part.outcomes),
    failures: parts.flatMap((part) => part.failures),
    clarifications: parts.flatMap((part) => part.clarifications),
    knowledge: parts.flatMap((part) => part.knowledge),
  };
}

/**
 * The views a selection reads. A company or the system view is one view. The
 * personal view is the viewer's own work (owner-authenticated personal
 * approvals) plus each company it may see, each read through a viewer
 * narrowed to that company — the same aggregate `/api/personal-summary`
 * builds — and, for an all-company viewer, the company-less items.
 */
export function conciergeNeedsYouViews(
  selected: Pick<ConciergeSelectedViewer, 'selection' | 'context' | 'allowedTenants'>,
  narrowed: ConciergeViewerContext
): ConciergeViewerContext[] {
  if (selected.selection.mode !== 'personal') return [narrowed];
  const companies = selected.allowedTenants.filter(
    (slug) => narrowed.tenantSlugs === 'all' || narrowed.tenantSlugs.includes(slug)
  );
  const views: ConciergeViewerContext[] = [{ ...narrowed, tenantSlugs: [] }];
  for (const slug of companies) views.push({ ...narrowed, tenantSlugs: [slug] });
  if (narrowed.tenantSlugs === 'all')
    views.push({ ...narrowed, tenantSlugs: [], includeUntenanted: true });
  return views;
}

const NO_STORE = { 'Cache-Control': 'private, no-store' };
const NARROWING_PARAMS = ['tenant', 'organization_id', 'project_id'] as const;

/**
 * `GET /api/v1/needs-you[/summary]`. The viewer and the shell's company
 * selection are resolved server-side; a `tenant` / `organization_id` /
 * `project_id` query value only narrows that scope (outside it → 403).
 */
export function handleNeedsYouRequest(
  req: NextRequest,
  operation: 'needs-you.list' | 'needs-you.summary'
): NextResponse {
  const resolved = resolveConciergeSelectedViewer(req);
  if (resolved.response) return resolved.response;
  const params = req.nextUrl.searchParams;
  let viewer: ConciergeViewerContext;
  try {
    // `tenant` is also the shell's selection hint (personal / shared are
    // selections, not tenants); the selection above already applied it.
    const tenant = params.get('tenant');
    // The personal view aggregates every company the viewer may see, so its
    // narrowing starts from the full viewer; any other selection from itself.
    const base = resolved.selection.mode === 'personal' ? resolved.viewer : resolved.context;
    const narrowed = narrowConciergeScope(base, {
      tenant: tenant === PERSONAL_SELECTION || tenant === SYSTEM_SELECTION ? null : tenant,
      organizationId: params.get('organization_id'),
      projectId: params.get('project_id'),
    });
    viewer = { ...base, ...narrowed };
  } catch (error) {
    return conciergeErrorResponse(error);
  }
  const input: Record<string, string> = {};
  for (const [key, value] of params) {
    // The narrowing is already applied to the viewer above.
    if ((NARROWING_PARAMS as readonly string[]).includes(key)) continue;
    if (operation === 'needs-you.summary') continue;
    input[key] = value;
  }
  const result = invokeSurfaceOperation(operation, input, {
    viewer: toSurfaceAuthorizationContext(viewer),
    needsYou: () => readConciergeNeedsYouViews(conciergeNeedsYouViews(resolved, viewer)),
  });
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error_code: result.error_code, error: result.error },
      { status: result.status, headers: NO_STORE }
    );
  }
  return NextResponse.json(result.data, { headers: NO_STORE });
}
