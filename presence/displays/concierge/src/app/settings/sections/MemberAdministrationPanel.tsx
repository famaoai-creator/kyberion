'use client';

import * as React from 'react';
import { Button, Callout, SettingsGroup } from '@agent/shared-ui';
import { frontDeskText } from '../../../lib/i18n';
import type { ConciergeLocale } from '../../../lib/i18n';
import type {
  SettingsMember,
  SettingsMemberPatch,
  SettingsRole,
  SettingsTenantView,
} from '../../../lib/settings-types';
import type { SettingsTranslate } from './form-scope';

/** Human sign-in access is managed independently from organization responsibilities. */
export function MemberAdministrationPanel({
  members,
  tenants,
  busy,
  locale,
  t,
  onPatch,
  contextId,
  onRefresh,
}: {
  members: SettingsMember[];
  tenants: SettingsTenantView[];
  busy: boolean;
  locale: ConciergeLocale;
  t: SettingsTranslate;
  onPatch: (id: string, patch: SettingsMemberPatch) => void;
  contextId?: string;
  onRefresh?: () => void;
}) {
  const [id, setId] = React.useState('');
  const [name, setName] = React.useState('');
  const [tenant, setTenant] = React.useState('');
  const [role, setRole] = React.useState<SettingsRole>('viewer');
  const [pending, setPending] = React.useState<{
    patch: SettingsMemberPatch;
    summary: string;
  } | null>(null);
  const selected = members.find((member) => member.member_id === id);
  const owned = tenants.filter((row) => row.role === 'owner' && row.status === 'active');
  const membership = selected?.memberships.find((row) => row.tenant_slug === tenant);
  const cannotSave = busy || !contextId || !selected?.version;
  function review(patch: SettingsMemberPatch, summary: string) {
    if (cannotSave || !selected) return;
    setPending({
      patch: { ...patch, expected_version: selected.version, expected_context_id: contextId },
      summary,
    });
  }
  const tenantName = (slug: string) =>
    tenants.find((row) => row.tenant_slug === slug)?.display_name ?? slug;
  React.useEffect(() => {
    setPending(null);
  }, [members, tenants, contextId]);
  return (
    <SettingsGroup
      id="settings-member-administration"
      title={t('people.member_admin_title')}
      description={t('people.member_access_hint')}
    >
      <div className="settings-row-block settings-member-admin settings-section">
        {!contextId ? (
          <Callout tone="info" title={t('people.member_reload')}>
            {onRefresh ? (
              <Button label={t('management.refresh')} disabled={busy} onClick={onRefresh} />
            ) : null}
          </Callout>
        ) : null}
        <label>
          {t('people.choose_human')}
          <select
            value={id}
            disabled={busy}
            onChange={(event) => {
              const member = members.find((row) => row.member_id === event.target.value);
              setId(event.target.value);
              setName(member?.display_name ?? '');
              setTenant('');
              setRole('viewer');
              setPending(null);
            }}
          >
            <option value="">{t('people.choose_human')}</option>
            {members.map((member) => (
              <option key={member.member_id} value={member.member_id}>
                {member.display_name}
                {member.member_id === 'owner' ? ' · ' + t('people.local_operator') : ''}
              </option>
            ))}
          </select>
        </label>
        {selected ? (
          <>
            <p>
              {selected.memberships
                .map(
                  (row) =>
                    `${tenantName(row.tenant_slug)}: ${frontDeskText(
                      row.role === 'owner'
                        ? 'role_owner'
                        : row.role === 'approver'
                          ? 'role_approver'
                          : row.role === 'operator'
                            ? 'role_operator'
                            : 'role_viewer',
                      locale
                    )}`
                )
                .join(' / ') || t('people.no_access_memberships')}
            </p>
            <label>
              {t('people.human_name')}
              <input
                value={name}
                maxLength={160}
                disabled={busy}
                onChange={(event) => {
                  setName(event.target.value);
                  setPending(null);
                }}
              />
            </label>
            <div className="settings-inline-actions">
              <Button
                label={t('people.rename_human')}
                disabled={cannotSave || !name.trim() || name.trim() === selected.display_name}
                onClick={() =>
                  review({ display_name: name.trim() }, `${selected.display_name} → ${name.trim()}`)
                }
              />
            </div>
            <label>
              {t('management.tenant')}
              <select
                value={tenant}
                disabled={busy}
                onChange={(event) => {
                  setTenant(event.target.value);
                  setRole(
                    selected.memberships.find((row) => row.tenant_slug === event.target.value)
                      ?.role ?? 'viewer'
                  );
                  setPending(null);
                }}
              >
                <option value="">{t('management.choose_tenant')}</option>
                {owned.map((row) => (
                  <option key={row.tenant_slug} value={row.tenant_slug}>
                    {row.display_name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t('people.access_role')}
              <select
                value={role}
                disabled={busy || !tenant}
                onChange={(event) => {
                  setRole(event.target.value as SettingsRole);
                  setPending(null);
                }}
              >
                {(['owner', 'approver', 'operator', 'viewer'] as const).map((value) => (
                  <option key={value} value={value}>
                    {frontDeskText(
                      value === 'owner'
                        ? 'role_owner'
                        : value === 'approver'
                          ? 'role_approver'
                          : value === 'operator'
                            ? 'role_operator'
                            : 'role_viewer',
                      locale
                    )}
                  </option>
                ))}
              </select>
            </label>
            <div className="settings-inline-actions">
              <Button
                label={t('people.set_access')}
                disabled={cannotSave || !tenant || membership?.role === role}
                onClick={() =>
                  review(
                    { tenant_slug: tenant, role },
                    `${selected.display_name} / ${tenantName(tenant)}: ${role}`
                  )
                }
              />
              <Button
                label={t('people.remove_access')}
                variant="ghost"
                disabled={cannotSave || !membership || selected.member_id === 'owner'}
                onClick={() =>
                  review(
                    { membership_remove: tenant },
                    `${t('people.remove_access')}: ${selected.display_name} / ${tenantName(tenant)}`
                  )
                }
              />
            </div>
          </>
        ) : null}
        {pending && selected ? (
          <div role="region" aria-label={t('management.confirm')}>
            <Callout tone="info" title={t('management.confirm')}>
              <p>{pending.summary}</p>
            </Callout>
            <div className="settings-inline-actions">
              <Button
                label={t('management.confirm_save')}
                variant="primary"
                disabled={busy}
                onClick={() => {
                  onPatch(id, pending.patch);
                  setPending(null);
                }}
              />
              <Button
                label={t('management.cancel')}
                disabled={busy}
                onClick={() => setPending(null)}
              />
            </div>
          </div>
        ) : null}
      </div>
    </SettingsGroup>
  );
}
