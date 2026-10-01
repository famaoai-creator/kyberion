'use client';

import * as React from 'react';
import { useConciergeI18n } from '../../lib/use-concierge-i18n';
import { frontDeskText, type FrontDeskMessageKey } from '../../lib/i18n';
import { codeFromSearch, inviteErrorKind, type InviteErrorKind } from '../../lib/invite-view';

/**
 * 参加オンボーディング: the page behind an invite link. It shows what the code
 * grants (organization, role, what that role can see), then joins — as the
 * identity the server verified, never one typed here. A brand-new person gives
 * only a display name. Everything else (who may invite, single use, expiry)
 * is enforced server-side (`/api/invites/join`).
 */

type Preview = {
  tenant_slug: string;
  role: 'approver' | 'operator' | 'viewer';
  joining_as: 'member' | 'new_member' | null;
};

const ROLE_KEY: Record<Preview['role'], FrontDeskMessageKey> = {
  approver: 'role_approver',
  operator: 'role_operator',
  viewer: 'role_viewer',
};
const ROLE_SCOPE_KEY: Record<Preview['role'], FrontDeskMessageKey> = {
  approver: 'join_role_approver',
  operator: 'join_role_operator',
  viewer: 'join_role_viewer',
};
const ERROR_KEY: Record<InviteErrorKind, FrontDeskMessageKey> = {
  not_found: 'join_err_not_found',
  expired: 'join_err_expired',
  used: 'join_err_used',
  revoked: 'join_err_used',
  already_member: 'join_err_already_member',
  forbidden: 'join_err_forbidden',
  sign_in: 'join_sign_in_required',
  generic: 'join_err_generic',
};

export default function JoinPage() {
  const { locale } = useConciergeI18n();
  const [code, setCode] = React.useState('');
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [error, setError] = React.useState<{ kind: InviteErrorKind; detail: string } | null>(null);
  const [displayName, setDisplayName] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [joined, setJoined] = React.useState<string | null>(null);

  const fail = React.useCallback((status: number, errorCode: unknown) => {
    const detail = typeof errorCode === 'string' ? errorCode : String(status);
    setError({ kind: inviteErrorKind(detail, status), detail });
  }, []);

  React.useEffect(() => {
    const fromUrl = codeFromSearch(window.location.search);
    setCode(fromUrl);
    if (!fromUrl) return;
    // The code leaves the address bar right away so it is not kept in history or sent as a referrer.
    window.history.replaceState(null, '', '/join');
    void (async () => {
      try {
        const response = await fetch(`/api/invites/join?code=${encodeURIComponent(fromUrl)}`, {
          cache: 'no-store',
        });
        const data = await response.json().catch(() => null);
        if (!response.ok || !data?.ok) return fail(response.status, data?.error);
        setPreview(data as Preview);
      } catch {
        fail(0, 'network');
      }
    })();
  }, [fail]);

  const join = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/invites/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          ...(displayName.trim() ? { display_name: displayName } : {}),
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) return fail(response.status, data?.error);
      setJoined(String(data.tenant_slug));
    } catch {
      fail(0, 'network');
    } finally {
      setBusy(false);
    }
  };

  const errorText = error
    ? frontDeskText(ERROR_KEY[error.kind], locale, { detail: error.detail })
    : null;

  return (
    <section className="pane" aria-label={frontDeskText('join_title', locale)}>
      <h2>{frontDeskText('join_title', locale)}</h2>
      {!code && !joined ? (
        <p className="notice error">{frontDeskText('join_missing_code', locale)}</p>
      ) : null}
      {errorText ? <p className="notice error">{errorText}</p> : null}
      {joined ? (
        <>
          <p className="notice">{frontDeskText('join_done', locale, { tenant: joined })}</p>
          <p className="pane-subtitle">{frontDeskText('join_next', locale)}</p>
          <div className="button-row">
            <a className="action-button" href="/settings">
              {frontDeskText('nav_settings', locale)}
            </a>
          </div>
        </>
      ) : preview ? (
        <>
          <p className="pane-subtitle">{frontDeskText('join_lead', locale)}</p>
          <p>{frontDeskText('join_org', locale, { tenant: preview.tenant_slug })}</p>
          <p>
            {frontDeskText('join_role', locale, {
              role: frontDeskText(ROLE_KEY[preview.role], locale),
            })}
          </p>
          <p>{frontDeskText(ROLE_SCOPE_KEY[preview.role], locale)}</p>
          <p className="pane-subtitle">{frontDeskText('join_separation', locale)}</p>
          {preview.joining_as === 'new_member' ? (
            <label>
              {frontDeskText('join_display_name', locale)}
              <input
                value={displayName}
                maxLength={80}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </label>
          ) : null}
          <div className="button-row">
            <button
              className="action-button"
              disabled={busy || (preview.joining_as === 'new_member' && !displayName.trim())}
              onClick={() => void join()}
            >
              {frontDeskText('join_submit', locale)}
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}
