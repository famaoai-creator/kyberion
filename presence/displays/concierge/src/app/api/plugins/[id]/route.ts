import { NextRequest, NextResponse } from 'next/server';
import { decideApprovalRequest, loadApprovalRequest } from '@agent/core/approval-store';
import {
  listManagedPlugins,
  refreshManagedPluginActivation,
} from '@agent/core/plugin-managed-install';
import { withExecutionContext } from '@agent/core/authority';
import { requireConciergeMutationAccess } from '../../../../lib/api-guard';
import { readRequestObject } from '../../../../lib/request-input';
import {
  conciergeText,
  resolveConciergeLocale,
  type ConciergeMessageKey,
} from '../../../../lib/i18n';

export const dynamic = 'force-dynamic';

/**
 * CS-03 プラグイン承認の1画面化 — record the HUMAN decision on a pending
 * plugin activation. This collapses the three-step CLI ceremony
 * (`approvals` → `approve <id>` → re-run `plugin:install`) into one screen:
 * decide the bound approval request via the shared approval store, then
 * refresh the persisted activation status and report it honestly.
 *
 * KD-06 trust model stays untouched: this route never stages, copies, or
 * executes plugin code — only official or `activatable` managed copies are
 * ever loaded (libs/core/skill-plugin-loader.ts), and `activatable` is only
 * reachable through exactly this human decision.
 */

const ALLOWED_DECISIONS = ['approve', 'deny'] as const;
type PluginDecision = (typeof ALLOWED_DECISIONS)[number];

// Mirrors normalizePluginId in libs/core/plugin-managed-install.ts.
const PLUGIN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;

  const locale = resolveConciergeLocale(req.headers.get('accept-language') || undefined);
  const t = (key: ConciergeMessageKey, params?: Record<string, string | number>) =>
    conciergeText(key, locale, params);

  try {
    const { id } = await context.params;
    const parsedBody = await readRequestObject(req);
    if (!parsedBody.ok)
      return NextResponse.json({ ok: false, error: parsedBody.error }, { status: 400 });
    const { body } = parsedBody;
    const decision = ALLOWED_DECISIONS.includes(body?.decision as PluginDecision)
      ? (body.decision as PluginDecision)
      : null;
    const note =
      typeof body?.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 2000) : '';
    if (!id || !PLUGIN_ID_PATTERN.test(id) || !decision) {
      return NextResponse.json({ ok: false, error: t('api.plugin.invalid') }, { status: 400 });
    }

    // Only managed-copy installs carry a decidable approval request. The list
    // is re-read server-side — the route never trusts client-supplied state.
    const record = withExecutionContext('sovereign_concierge', () => listManagedPlugins()).find(
      (entry) => entry.pluginId === id
    );
    if (!record) {
      return NextResponse.json({ ok: false, error: t('api.plugin.not_found') }, { status: 404 });
    }
    if (record.activationStatus === 'blocked_broken_manifest') {
      // A broken manifest stays permanently non-activatable; approving it
      // would be a lie (plugin-managed-install.ts keeps it blocked anyway).
      return NextResponse.json({ ok: false, error: t('api.plugin.broken') }, { status: 409 });
    }
    if (record.trust === 'official' || record.activationStatus === 'activatable') {
      return NextResponse.json(
        { ok: false, error: t('api.plugin.no_decision_needed') },
        { status: 409 }
      );
    }
    if (!record.approvalRequestId || !record.approvalChannel) {
      // e.g. a hand-placed directory: provenance unknown, no approval bound.
      return NextResponse.json({ ok: false, error: t('api.plugin.no_approval') }, { status: 409 });
    }

    const approval = loadApprovalRequest(record.approvalChannel, record.approvalRequestId);
    if (!approval) {
      return NextResponse.json({ ok: false, error: t('api.plugin.no_approval') }, { status: 409 });
    }
    if (approval.status !== 'pending') {
      // Someone (CLI or another surface) already decided — refresh the
      // persisted status so the screen converges, and say so honestly.
      const refreshed = withExecutionContext('sovereign_concierge', () =>
        refreshManagedPluginActivation(record.pluginId)
      );
      return NextResponse.json(
        {
          ok: false,
          error: t('api.plugin.already_decided'),
          plugin: {
            id: record.pluginId,
            trust: record.trust,
            status: (refreshed ?? record).activationStatus,
            approval_status: approval.status,
          },
        },
        { status: 409 }
      );
    }

    // Same decision call shape as the approvals queue route — plugin approval
    // requests live in the same store, just on their own channel.
    const updated = decideApprovalRequest('sovereign_concierge', {
      channel: record.approvalChannel,
      storageChannel: record.approvalChannel,
      requestId: record.approvalRequestId,
      decision: decision === 'approve' ? 'approved' : 'rejected',
      decidedBy: 'concierge',
      decidedByRole: 'sovereign',
      authMethod: 'surface_session',
      decidedByType: 'human',
      authenticated: true,
      payloadHash: approval.accountability?.payloadHash,
      effectBinding: approval.accountability?.effectBinding,
      note: note || 'Decision captured from the concierge (秘書室) plugin screen.',
    });

    // Re-derive the persisted activation status from the decided request —
    // the response reports what is now true on disk, not what we hoped.
    const refreshed =
      withExecutionContext('sovereign_concierge', () =>
        refreshManagedPluginActivation(record.pluginId)
      ) ?? record;

    const approvedAndActive =
      decision === 'approve' && refreshed.activationStatus === 'activatable';
    const message =
      decision === 'deny'
        ? t('api.plugin.denied', { id: record.pluginId })
        : approvedAndActive
          ? t('api.plugin.approved', { id: record.pluginId })
          : t('api.plugin.approved_pending', { id: record.pluginId });

    return NextResponse.json({
      ok: true,
      plugin: {
        id: refreshed.pluginId,
        trust: refreshed.trust,
        status: refreshed.activationStatus,
        approval_status: updated.status,
      },
      message,
    });
  } catch (error) {
    console.error(
      `[concierge/plugins] decision route failed: ${error instanceof Error ? error.stack || error.message : String(error)}`
    );
    return NextResponse.json({ ok: false, error: t('api.plugin.failed') }, { status: 500 });
  }
}
