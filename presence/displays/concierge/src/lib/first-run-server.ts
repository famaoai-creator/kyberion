/**
 * Server-side logic behind first-run setup (`/setup/first-run`) and the SSO
 * settings it leads to.
 *
 *  - Claiming is unauthenticated by design (no owner can sign in yet): the
 *    one-time setup code issued on the host is the only proof, checked and
 *    rate-limited in `@agent/core/surface/first-run-setup`.
 *  - SSO settings are instance-wide, so only an instance owner (owner of every
 *    registered tenant) may read or change them. The member is resolved from
 *    the authenticated viewer, never from the request body.
 */

import { withExecutionContext, withExecutionContextAsync } from '@agent/core/authority';
import {
  FirstRunError,
  claimFirstRun,
  isInstanceOwner,
  readFirstRunStatus,
  type FirstRunErrorCode,
} from '@agent/core/surface/first-run-setup';
import {
  OidcSettingsInputError,
  saveOidcLoginSettings,
  summarizeOidcLoginSettings,
  type OidcLoginSettingsSummary,
  type SessionKeyState,
} from '@agent/core/surface/oidc-login-settings';
import {
  resolveOidcLoginConfig,
  resolveOidcRedirectOrigin,
} from '@agent/core/surface/oidc-browser-login';
import { startSurfaceIdentityLink } from '@agent/core/surface/surface-auth-routes';
import { resolveMemberByPrincipal } from '@agent/core/organization/member-registry';
import {
  conciergeFrontDeskRoleForTenant,
  resolveConciergeFrontDeskRole,
} from './front-desk-member';
import { auditChain } from '@agent/core/governance/audit-chain';
import type { ConciergeViewerContext } from './viewer-context';

export const FIRST_RUN_SETUP_HREF = '/setup/first-run';

/** Surfaces that serve the shared `/login` flow, with their default local ports. */
export const LOGIN_SURFACES: ReadonlyArray<{ id: string; port: number }> = [
  { id: 'concierge', port: 3050 },
  { id: 'chronos-mirror-v2', port: 3000 },
  { id: 'presence-studio', port: 3031 },
  { id: 'computer-surface', port: 3040 },
  { id: 'operator-surface', port: 3331 },
];

type Viewer = Pick<
  ConciergeViewerContext,
  'principalId' | 'source' | 'registrationLabel' | 'memberId' | 'role'
>;

export type FirstRunFailure = {
  ok: false;
  status: 400 | 403 | 409 | 500;
  error: string;
  field?: string;
};

const CLAIM_STATUS: Record<FirstRunErrorCode, FirstRunFailure['status']> = {
  claimed: 409,
  invalid_input: 400,
  tenant_unavailable: 409,
  member_unavailable: 409,
  code_not_issued: 403,
  code_expired: 403,
  code_invalid: 403,
  code_locked: 403,
};

/** Whether the setup page is still open. Fails closed to "claimed". */
export function firstRunOpen(): boolean {
  try {
    return (
      withExecutionContext('sovereign_concierge', () => readFirstRunStatus()).state === 'unclaimed'
    );
  } catch {
    return false;
  }
}

export function claimFirstRunForRequest(
  body: Record<string, unknown>
):
  | { ok: true; token: string; member_id: string; tenant_slug: string; tenant_slugs: string[] }
  | FirstRunFailure {
  try {
    const result = withExecutionContext('sovereign_concierge', () =>
      claimFirstRun({
        code: body.code,
        tenant_slug: body.tenant_slug,
        tenant_display_name: body.tenant_display_name,
        display_name: body.display_name,
      })
    );
    return {
      ok: true,
      token: result.token,
      member_id: result.member_id,
      tenant_slug: result.tenant_slug,
      tenant_slugs: result.tenant_slugs,
    };
  } catch (error) {
    if (error instanceof FirstRunError) {
      return {
        ok: false,
        status: CLAIM_STATUS[error.code],
        error: error.code,
        ...(error.field ? { field: error.field } : {}),
      };
    }
    return { ok: false, status: 500, error: 'first_run_failed' };
  }
}

/** True when the viewer is an active member that owns every registered tenant. */
export function viewerIsInstanceOwner(viewer: Viewer): boolean {
  if (viewer.role !== 'localadmin') return false;
  try {
    return withExecutionContext('sovereign_concierge', () =>
      isInstanceOwner(
        resolveMemberByPrincipal({
          principalId: viewer.principalId,
          source: viewer.source,
          registrationLabel: viewer.registrationLabel,
          memberId: viewer.memberId,
        })
      )
    );
  } catch {
    return false;
  }
}

export type IdentityLinkStart =
  | { ok: true; location: string; setCookies: string[] }
  | { ok: false; status: 403 | 409 | 503; error: string };

/**
 * Start "link my IdP account" for the authenticated viewer. The member is the
 * one the viewer resolves to server-side; nothing in the request selects it.
 *
 * A bound IdP identity carries the member's ENTIRE scope and outlives the
 * credential that created it, so — exactly like `PATCH /api/members`
 * identity binding — the viewer must be owner on every tenant the member
 * belongs to, within the viewer's own (possibly narrowed) scope. A loopback
 * viewer without a credential is refused: local-only authority must not mint
 * a persistent remote sign-in.
 */
export async function startIdentityLinkForViewer(
  viewer: ConciergeViewerContext,
  request: { requestOrigin: string; loopback: boolean; next?: string | null }
): Promise<IdentityLinkStart> {
  if (viewer.source === 'loopback') return { ok: false, status: 403, error: 'credential_required' };
  let decision: { memberId?: string; error?: 'member_required' | 'owner_required' };
  try {
    decision = withExecutionContext('sovereign_concierge', () => {
      const member = resolveMemberByPrincipal({
        principalId: viewer.principalId,
        source: viewer.source,
        registrationLabel: viewer.registrationLabel,
        memberId: viewer.memberId,
      });
      if (member?.status !== 'active') return { error: 'member_required' as const };
      const ownerEverywhere =
        member.memberships.length > 0
          ? member.memberships.every(
              (m) => conciergeFrontDeskRoleForTenant(viewer, m.tenant_slug) === 'owner'
            )
          : resolveConciergeFrontDeskRole(viewer) === 'owner';
      return ownerEverywhere
        ? { memberId: member.member_id }
        : { error: 'owner_required' as const };
    });
  } catch {
    decision = { error: 'member_required' };
  }
  if (!decision.memberId) {
    return { ok: false, status: 403, error: decision.error ?? 'member_required' };
  }
  const memberId = decision.memberId;
  const linkMemberId = memberId;
  const started = await withExecutionContextAsync('sovereign_concierge', () =>
    startSurfaceIdentityLink({
      surfaceId: 'concierge',
      requestOrigin: request.requestOrigin,
      loopback: request.loopback,
      linkMemberId,
      next: request.next,
    })
  );
  if (started.ok === false) {
    return started.view.kind === 'unconfigured'
      ? { ok: false, status: 409, error: 'sso_not_configured' }
      : { ok: false, status: 503, error: 'link_unavailable' };
  }
  return started;
}

/** Redirect URIs to register at the IdP, one per login surface (deduplicated). */
export function oidcRedirectUris(): string[] {
  let config = null;
  try {
    config = withExecutionContext('sovereign_concierge', () => resolveOidcLoginConfig().config);
  } catch {
    config = null;
  }
  const uris = LOGIN_SURFACES.map(({ id, port }) => {
    const local = `http://localhost:${port}`;
    const origin = config
      ? resolveOidcRedirectOrigin(config, { surfaceId: id, requestOrigin: local, loopback: true })
      : local;
    return `${origin ?? local}/auth/callback`;
  });
  return [...new Set(uris)];
}

export interface SsoSettingsView {
  settings: OidcLoginSettingsSummary;
  redirect_uris: string[];
}

export function readSsoSettings(): SsoSettingsView {
  return {
    settings: withExecutionContext('sovereign_concierge', () => summarizeOidcLoginSettings()),
    redirect_uris: oidcRedirectUris(),
  };
}

function auditSsoSave(viewer: Viewer, result: string, metadata: Record<string, unknown>): void {
  try {
    auditChain.record({
      agentId: viewer.principalId || 'concierge-viewer',
      action: 'surface_sso_settings',
      operation: 'save',
      result: result === 'completed' ? 'completed' : 'error',
      ...(result === 'completed' ? {} : { reason: result }),
      metadata,
    });
  } catch {
    // The secret-guard write is also ledgered as CONFIG_CHANGE.
  }
}

export function saveSsoSettings(
  viewer: Viewer,
  body: Record<string, unknown>
):
  | ({ ok: true; session_key: SessionKeyState; env_overrides: boolean } & SsoSettingsView)
  | FirstRunFailure {
  try {
    const saved = withExecutionContext('sovereign_concierge', () =>
      saveOidcLoginSettings(
        {
          issuer: body.issuer,
          client_id: body.client_id,
          client_secret: body.client_secret,
          provider_label: body.provider_label,
          scopes: body.scopes,
          public_base_url: body.public_base_url,
        },
        { actor: 'concierge_sso_settings' }
      )
    );
    auditSsoSave(viewer, 'completed', {
      issuer: saved.summary.issuer,
      client_id: saved.summary.client_id,
      session_key: saved.session_key,
      env_overrides: saved.env_overrides,
    });
    return {
      ok: true,
      settings: saved.summary,
      session_key: saved.session_key,
      env_overrides: saved.env_overrides,
      redirect_uris: oidcRedirectUris(),
    };
  } catch (error) {
    if (error instanceof OidcSettingsInputError) {
      return { ok: false, status: 400, error: 'invalid_input', field: error.field };
    }
    auditSsoSave(viewer, 'sso_save_failed', {});
    return { ok: false, status: 500, error: 'sso_save_failed' };
  }
}
