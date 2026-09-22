import { NextRequest, NextResponse } from 'next/server';
import { withExecutionContext } from '@agent/core/authority';
import {
  loadWorkInventoryEntry,
  listWorkInventoryEntries,
  saveWorkInventoryEntry,
} from '@agent/core/work-inventory';
import {
  attachObservationToEntry,
  confirmObservationSummary,
  discardObservationSummary,
  listObservationSummaries,
  loadObservationSummary,
  observationDigestLine,
  type WorkInventoryObservationSummary,
} from '@agent/core/work-inventory-observation';
import { WorkInventoryConsentError } from '@agent/core/work-inventory-consent';
import { requireConciergeMutationAccess } from '../../../../lib/api-guard';
import { readRequestObject } from '../../../../lib/request-input';
import { conciergeErrorResponse, resolveConciergeViewer } from '../../../../lib/viewer-context';
import {
  requireWorkInventoryMember,
  resolveWorkInventoryScopeForViewer,
  workInventoryErrorResponse,
} from '../../../../lib/work-inventory-member';
import { frontDeskText, resolveConciergeLocale } from '../../../../lib/i18n';

export const dynamic = 'force-dynamic';

/** Summary-level fields only — never `proposed_steps` (step descriptions), matching the panel spec. */
function toSummaryView(summary: WorkInventoryObservationSummary) {
  return {
    summary_id: summary.summary_id,
    status: summary.status,
    source: summary.source,
    digest: observationDigestLine(summary),
    apps: summary.apps,
    hosts: summary.hosts,
    step_count: summary.step_count,
    ...(summary.duration_ms !== undefined ? { duration_ms: summary.duration_ms } : {}),
    window: summary.window,
    created_at: summary.created_at,
  };
}

/**
 * WI-15: member-facing "確認待ちの要約" (pending observation summaries) —
 * the viewer's own summaries plus the candidate work-inventory entries in
 * the viewer's own resolved scope (id + title only) to attach one to.
 */
export function GET(req: NextRequest) {
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  const member = requireWorkInventoryMember(req, resolved.context);
  if (member.response) return member.response;
  try {
    const summaries = withExecutionContext('sovereign_concierge', () =>
      listObservationSummaries(member.member.member_id)
    );
    const scope = resolveWorkInventoryScopeForViewer(resolved.context);
    const candidateEntries = scope
      ? withExecutionContext('sovereign_concierge', () =>
          listWorkInventoryEntries(scope).map((entry) => ({
            entry_id: entry.entry_id,
            title: entry.title,
          }))
        )
      : [];
    return NextResponse.json(
      { ok: true, summaries: summaries.map(toSummaryView), candidate_entries: candidateEntries },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    return conciergeErrorResponse(error, 500);
  }
}

export async function POST(req: NextRequest) {
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  const member = requireWorkInventoryMember(req, resolved.context);
  if (member.response) return member.response;
  const locale = resolveConciergeLocale(req.headers.get('accept-language') || undefined);

  const parsedBody = await readRequestObject(req, 'request body', [
    'action',
    'summary_id',
    'entry_id',
  ]);
  if (!parsedBody.ok) {
    return NextResponse.json({ ok: false, error: parsedBody.error }, { status: 400 });
  }
  const { body } = parsedBody;
  const action = body.action;
  const summaryId = typeof body.summary_id === 'string' ? body.summary_id : '';
  const memberId = member.member.member_id;
  const by = { kind: 'human' as const, id: memberId };

  if (!summaryId) {
    return NextResponse.json(
      { ok: false, error: frontDeskText('settings_recording_grant_invalid', locale) },
      { status: 400 }
    );
  }

  try {
    if (action === 'confirm') {
      const summary = withExecutionContext('sovereign_concierge', () =>
        confirmObservationSummary(memberId, summaryId, { by })
      );
      return NextResponse.json({ ok: true, summary: toSummaryView(summary) });
    }

    if (action === 'discard') {
      const summary = withExecutionContext('sovereign_concierge', () =>
        discardObservationSummary(memberId, summaryId, { by })
      );
      return NextResponse.json({ ok: true, summary: toSummaryView(summary) });
    }

    if (action === 'attach') {
      const entryId = typeof body.entry_id === 'string' ? body.entry_id : '';
      if (!entryId) {
        return NextResponse.json(
          { ok: false, error: frontDeskText('settings_recording_grant_invalid', locale) },
          { status: 400 }
        );
      }
      // The entry must be loaded from the viewer's OWN resolved scope — never
      // a client-chosen scope — so attach can only ever reach an entry the
      // viewer already sees.
      const scope = resolveWorkInventoryScopeForViewer(resolved.context);
      if (!scope) {
        return NextResponse.json(
          { ok: false, error: frontDeskText('settings_recording_entry_not_found', locale) },
          { status: 404 }
        );
      }
      const entry = withExecutionContext('sovereign_concierge', () =>
        loadWorkInventoryEntry(scope, entryId)
      );
      if (!entry) {
        return NextResponse.json(
          { ok: false, error: frontDeskText('settings_recording_entry_not_found', locale) },
          { status: 404 }
        );
      }
      const summary = withExecutionContext('sovereign_concierge', () =>
        loadObservationSummary(memberId, summaryId)
      );
      if (!summary) {
        throw new WorkInventoryConsentError(
          'not_found',
          `observation summary ${summaryId} not found`
        );
      }
      const attached = withExecutionContext('sovereign_concierge', () =>
        attachObservationToEntry(entry, summary, { by })
      );
      const saved = withExecutionContext('sovereign_concierge', () =>
        saveWorkInventoryEntry(attached)
      );
      return NextResponse.json({
        ok: true,
        entry: { entry_id: saved.entry_id, title: saved.title, status: saved.status },
      });
    }

    return NextResponse.json(
      { ok: false, error: frontDeskText('settings_recording_grant_invalid', locale) },
      { status: 400 }
    );
  } catch (error) {
    return workInventoryErrorResponse(error);
  }
}
