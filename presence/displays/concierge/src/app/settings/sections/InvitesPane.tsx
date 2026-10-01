'use client';

import * as React from 'react';
import { Button, Select, SettingRow, SettingsGroup, TextField } from '@agent/shared-ui';
import {
  inviteDisplayStatus,
  inviteJoinPath,
  parseInviteOverview,
  type InviteOverviewTenant,
  type InviteRole,
} from '../../../lib/invite-view';
import { useConciergeI18n } from '../../../lib/use-concierge-i18n';
import { FormScope, asText, type SettingsTranslate } from './form-scope';

type Message = { text: string; error?: boolean } | null;

const ROLE_KEYS = {
  approver: 'setup.invite_role_approver',
  operator: 'setup.invite_role_operator',
  viewer: 'setup.invite_role_viewer',
} as const;
const STATUS_KEYS = {
  pending: 'setup.invite_status_pending',
  accepted: 'setup.invite_status_accepted',
  revoked: 'setup.invite_status_revoked',
  expired: 'setup.invite_status_expired',
} as const;

/**
 * Settings › Organization and members › Invites. Owners and approvers create a one-time link; the
 * server decides which roles each may grant and shows the link exactly once.
 */
export function InvitesPane({ t }: { t: SettingsTranslate }) {
  const { locale } = useConciergeI18n();
  const [tenants, setTenants] = React.useState<InviteOverviewTenant[]>([]);
  const [tenant, setTenant] = React.useState('');
  const [role, setRole] = React.useState<InviteRole>('viewer');
  const [ttl, setTtl] = React.useState('72');
  const [link, setLink] = React.useState<string | null>(null);
  const [code, setCode] = React.useState<string | null>(null);
  const [email, setEmail] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<Message>(null);

  const current = tenants.find((entry) => entry.tenant_slug === tenant) ?? null;

  const load = React.useCallback(async () => {
    try {
      const response = await fetch('/api/invites', { cache: 'no-store' });
      const parsed = parseInviteOverview(await response.json().catch(() => null));
      if (!response.ok || !parsed) return;
      setTenants(parsed);
      setTenant((prev) =>
        parsed.some((e) => e.tenant_slug === prev) ? prev : (parsed[0]?.tenant_slug ?? '')
      );
    } catch {
      // The pane stays empty; the server is the authority either way.
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    // Keep the chosen role within what this tenant lets the viewer grant.
    if (current && !current.can_invite_roles.includes(role)) {
      setRole(current.can_invite_roles[current.can_invite_roles.length - 1] ?? 'viewer');
    }
    setLink(null);
    setCode(null);
  }, [tenant, current, role]);

  const post = async (body: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch('/api/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (!response.ok || !data || data.ok !== true) {
        setMessage({
          text: t('setup.invite_err', { detail: String(data?.error ?? response.status) }),
          error: true,
        });
        return null;
      }
      return data;
    } catch (error) {
      setMessage({
        text: t('setup.invite_err', {
          detail: error instanceof Error ? error.message : String(error),
        }),
        error: true,
      });
      return null;
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    if (!current) return;
    const data = await post({
      action: 'create',
      tenant_slug: current.tenant_slug,
      role,
      ttl_hours: Number(ttl),
    });
    if (data && typeof data.code === 'string') {
      setLink(`${window.location.origin}${inviteJoinPath(data.code)}`);
      setCode(data.code);
      await load();
    }
  };

  const makeDraft = async () => {
    if (!current || !code) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/invites/email-draft?locale=${locale}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenant_slug: current.tenant_slug, code, email: email.trim() }),
      });
      const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (!response.ok || !data || data.ok !== true) {
        setMessage({
          text:
            data?.error === 'invalid_email'
              ? t('setup.invite_email_invalid')
              : t('setup.invite_err', { detail: String(data?.error ?? response.status) }),
          error: true,
        });
        return;
      }
      setMessage({
        text:
          data.draft === 'created'
            ? t('setup.invite_email_created')
            : t('setup.invite_email_unavailable'),
      });
    } catch (error) {
      setMessage({
        text: t('setup.invite_err', {
          detail: error instanceof Error ? error.message : String(error),
        }),
        error: true,
      });
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (inviteId: string) => {
    if (!current) return;
    const data = await post({
      action: 'revoke',
      tenant_slug: current.tenant_slug,
      invite_id: inviteId,
    });
    if (data) await load();
  };

  if (tenants.length === 0) return null;

  return (
    <FormScope
      fields={{
        'invite.tenant': (v) => setTenant(asText(v)),
        'invite.role': (v) => setRole(asText(v) as InviteRole),
        'invite.ttl': (v) => setTtl(asText(v)),
        'invite.email': (v) => setEmail(asText(v)),
      }}
    >
      <SettingsGroup
        id="settings-invites"
        title={t('setup.invite_title')}
        description={t('setup.invite_description')}
      >
        {tenants.length > 1 ? (
          <SettingRow label={t('setup.invite_tenant')}>
            <Select
              id="invite-tenant"
              name="invite.tenant"
              label={t('setup.invite_tenant')}
              hide_label
              value={tenant}
              options={tenants.map((e) => ({ value: e.tenant_slug, label: e.tenant_slug }))}
            />
          </SettingRow>
        ) : null}
        {current ? (
          <>
            <SettingRow label={t('setup.invite_role')}>
              <Select
                id="invite-role"
                name="invite.role"
                label={t('setup.invite_role')}
                hide_label
                value={role}
                options={current.can_invite_roles.map((r) => ({
                  value: r,
                  label: t(ROLE_KEYS[r]),
                }))}
              />
            </SettingRow>
            <SettingRow label={t('setup.invite_ttl')}>
              <TextField
                id="invite-ttl"
                name="invite.ttl"
                label={t('setup.invite_ttl')}
                hide_label
                value={ttl}
              />
            </SettingRow>
            <div className="settings-row-actions">
              <Button
                label={t('setup.invite_create')}
                variant="primary"
                disabled={busy || !/^\d{1,3}$/.test(ttl) || Number(ttl) < 1}
                onClick={() => void create()}
              />
            </div>
            {link ? (
              <div className="settings-row-block">
                <p role="status">{t('setup.invite_link_once')}</p>
                <p style={{ wordBreak: 'break-all' }}>
                  <code>{link}</code>
                </p>
                <SettingRow label={t('setup.invite_email_label')}>
                  <TextField
                    id="invite-email"
                    name="invite.email"
                    label={t('setup.invite_email_label')}
                    hide_label
                    value={email}
                  />
                </SettingRow>
                <div className="settings-row-actions">
                  <Button
                    label={t('setup.invite_email_draft')}
                    variant="secondary"
                    disabled={busy || email.trim() === ''}
                    onClick={() => void makeDraft()}
                  />
                </div>
              </div>
            ) : null}
            <h4>{t('setup.invite_list_title')}</h4>
            {current.invites.length === 0 ? <p>{t('setup.invite_none')}</p> : null}
            {current.invites.map((invite) => {
              const status = inviteDisplayStatus(invite);
              return (
                <div key={invite.invite_id} className="settings-row-block">
                  <p>
                    {t('setup.invite_line', {
                      role: t(ROLE_KEYS[invite.role]),
                      status: t(STATUS_KEYS[status]),
                      date: invite.expires_at.slice(0, 10),
                    })}
                  </p>
                  {status === 'pending' ? (
                    <Button
                      label={t('setup.invite_revoke')}
                      variant="secondary"
                      disabled={busy}
                      onClick={() => void revoke(invite.invite_id)}
                    />
                  ) : null}
                </div>
              );
            })}
          </>
        ) : null}
        {message ? <p role={message.error ? 'alert' : 'status'}>{message.text}</p> : null}
      </SettingsGroup>
    </FormScope>
  );
}
