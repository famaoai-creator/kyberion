import { NextRequest, NextResponse } from 'next/server';
import { withExecutionContextAsync } from '@agent/core/authority';
import { listApprovalRequests } from '@agent/core/governance/approval-store';
import { computeApprovalPresentedDigest } from '@agent/core/governance/approval-presentation';
import { loadApprovalPolicy } from '@agent/core/governance/approval-policy';
import { linkMemberExternalIdentity } from '@agent/core/organization/member-identity-link';
import { listMemberIds, readMemberProfile } from '@agent/core/organization/member-registry';
import { requireConciergeMutationAccess } from '../../../lib/api-guard';
import { readRequestObject } from '../../../lib/request-input';
import { resolveConciergeViewer } from '../../../lib/viewer-context';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };
const response = (value: unknown, status = 200) => NextResponse.json(value, { status, headers });

function currentOidcIdentity(viewer: {
  principal?: { source?: string; claims?: Record<string, unknown> };
}): { issuer: string; subject: string; email?: string } | null {
  const claims = viewer.principal?.claims;
  if (viewer.principal?.source !== 'oidc' || !claims) return null;
  const issuer = typeof claims.iss === 'string' ? claims.iss.trim() : '';
  const subject = typeof claims.sub === 'string' ? claims.sub.trim() : '';
  const email = typeof claims.email === 'string' ? claims.email.trim() : '';
  if (!issuer || !subject) return null;
  return { issuer, subject, ...(email ? { email } : {}) };
}

export async function GET(req: NextRequest) {
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  try {
    const value = await withExecutionContextAsync('sovereign_concierge', async () => {
      const pending = listApprovalRequests({ status: ['pending', 'approved'] }).map((record) => ({
        request_id: record.id,
        status: record.status,
        channel: record.storageChannel ?? '',
        kind: record.kind ?? '',
        scope: record.scope ?? null,
        expires_at: record.expiresAt,
        presented_digest: computeApprovalPresentedDigest(record),
      }));
      const rules = (loadApprovalPolicy().rules ?? []).map((rule) => ({
        id: rule.id,
        intent_ids: rule.intent_ids ?? [],
        decision_types: rule.when?.any_of ?? [],
        min_assurance: rule.min_assurance ?? 'A1',
      }));
      const members = listMemberIds()
        .map((id) => readMemberProfile(id))
        .filter((member): member is NonNullable<typeof member> => !!member)
        .map((member) => ({
          member_id: member.member_id,
          display_name: member.display_name ?? member.member_id,
          external_identities: (member.external_identities ?? []).map((identity) => ({
            issuer: identity.issuer,
            subject: identity.subject,
            ...(identity.email ? { email: identity.email } : {}),
          })),
        }));
      return {
        ok: true,
        pending_approvals: pending,
        approval_rules: rules,
        members,
        current_identity: currentOidcIdentity(resolved.context),
        viewer_member_id: resolved.context.memberId ?? null,
      };
    });
    return response(value);
  } catch (error) {
    return response(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      400
    );
  }
}

export async function POST(req: NextRequest) {
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  const parsed = await readRequestObject(req, 'request body', ['action', 'member_id']);
  if (!parsed.ok) return response({ ok: false, error: parsed.error }, 400);
  const body = parsed.body as Record<string, unknown>;
  const memberId = typeof body.member_id === 'string' ? body.member_id.trim() : '';
  if (body.action !== 'link_identity' || !memberId) {
    return response({ ok: false, error: "action must be 'link_identity' with member_id" }, 400);
  }
  const identity = currentOidcIdentity(resolved.context);
  if (!identity) {
    return response(
      { ok: false, error: 'no verified OIDC identity on this session — sign in via /login first' },
      403
    );
  }
  try {
    const result = await withExecutionContextAsync('sovereign_concierge', async () =>
      linkMemberExternalIdentity(memberId, identity)
    );
    return response({ ok: true, result });
  } catch (error) {
    return response(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      400
    );
  }
}
