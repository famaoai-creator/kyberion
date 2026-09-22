import { NextRequest, NextResponse } from 'next/server';
import { withExecutionContext } from '@agent/core/authority';
import {
  CONSENTABLE_OBSERVATION_KINDS,
  MAX_CONSENT_WINDOW_DAYS,
  WORK_INVENTORY_CONSENT_SOURCES,
  grantWorkInventoryConsent,
  listWorkInventoryConsents,
  revokeWorkInventoryConsent,
  type WorkInventoryConsentSource,
  type WorkInventoryObservationKind,
} from '@agent/core/work-inventory-consent';
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

/**
 * WI-15: member-facing "PC 操作の記録" consent. Every read and write below
 * acts only on the viewer's own member record (`requireWorkInventoryMember`)
 * — a client-supplied member id is never accepted anywhere on this route.
 */
export function GET(req: NextRequest) {
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  const member = requireWorkInventoryMember(req, resolved.context);
  if (member.response) return member.response;
  try {
    const consents = withExecutionContext('sovereign_concierge', () =>
      listWorkInventoryConsents(member.member.member_id)
    );
    return NextResponse.json(
      {
        ok: true,
        consents,
        sources: WORK_INVENTORY_CONSENT_SOURCES,
        observation_kinds: CONSENTABLE_OBSERVATION_KINDS,
        max_days: MAX_CONSENT_WINDOW_DAYS,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    return conciergeErrorResponse(error, 500);
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
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
    'sources',
    'observation_kinds',
    'purpose',
    'days',
    'consent_id',
  ]);
  if (!parsedBody.ok) {
    return NextResponse.json({ ok: false, error: parsedBody.error }, { status: 400 });
  }
  const { body } = parsedBody;
  const action = body.action;

  try {
    if (action === 'grant') {
      if (!isStringArray(body.sources) || !isStringArray(body.observation_kinds)) {
        return NextResponse.json(
          { ok: false, error: frontDeskText('settings_recording_grant_invalid', locale) },
          { status: 400 }
        );
      }
      const purpose = typeof body.purpose === 'string' ? body.purpose : '';
      // Validate here, not in core: a huge value would overflow the Date
      // math below into an Invalid Date and surface as a 500.
      const days = body.days;
      if (
        typeof days !== 'number' ||
        !Number.isInteger(days) ||
        days < 1 ||
        days > MAX_CONSENT_WINDOW_DAYS
      ) {
        return NextResponse.json(
          { ok: false, error: frontDeskText('settings_recording_grant_invalid', locale) },
          { status: 400 }
        );
      }
      const now = new Date();
      const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
      const scope = resolveWorkInventoryScopeForViewer(resolved.context);
      const consent = withExecutionContext('sovereign_concierge', () =>
        grantWorkInventoryConsent(
          {
            member_id: member.member.member_id,
            ...(scope?.tenant_slug ? { tenant_slug: scope.tenant_slug } : {}),
            sources: body.sources as WorkInventoryConsentSource[],
            observation_kinds: body.observation_kinds as WorkInventoryObservationKind[],
            purpose,
            expires_at: expiresAt,
            granted_by: { kind: 'human', id: member.member.member_id },
          },
          { now }
        )
      );
      return NextResponse.json({ ok: true, consent });
    }

    if (action === 'revoke') {
      const consentId = typeof body.consent_id === 'string' ? body.consent_id : '';
      if (!consentId) {
        return NextResponse.json(
          { ok: false, error: frontDeskText('settings_recording_grant_invalid', locale) },
          { status: 400 }
        );
      }
      const consent = withExecutionContext('sovereign_concierge', () =>
        revokeWorkInventoryConsent(member.member.member_id, consentId, {
          by: { kind: 'human', id: member.member.member_id },
        })
      );
      return NextResponse.json({ ok: true, consent });
    }

    return NextResponse.json(
      { ok: false, error: frontDeskText('settings_recording_grant_invalid', locale) },
      { status: 400 }
    );
  } catch (error) {
    return workInventoryErrorResponse(error);
  }
}
