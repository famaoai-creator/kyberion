'use client';

import * as React from 'react';
import { Button, Callout, Select, SettingsGroup, TextField } from '@agent/shared-ui';
import { frontDeskText } from '../../../lib/i18n';
import type { ConciergeLocale } from '../../../lib/i18n';
import type {
  SettingsMember,
  SettingsMemberPatch,
  SettingsRole,
  SettingsTenantView,
} from '../../../lib/settings-types';
import { asText, FormScope, type SettingsTranslate } from './form-scope';

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
      <FormScope
        fields={{
          'member-admin.person': (value) => {
            const next = asText(value);
            const member = members.find((row) => row.member_id === next);
            setId(next);
            setName(member?.display_name ?? '');
            setTenant('');
            setRole('viewer');
            setPending(null);
          },
          'member-admin.name': (value) => {
            setName(asText(value));
            setPending(null);
          },
          'member-admin.tenant': (value) => {
            const next = asText(value);
            setTenant(next);
            setRole(
              selected?.memberships.find((row) => row.tenant_slug === next)?.role ?? 'viewer'
            );
            setPending(null);
          },
          'member-admin.role': (value) => {
            setRole(asText(value) as SettingsRole);
            setPending(null);
          },
        }}
      >
        <div className="settings-row-block settings-member-admin settings-section">
          {!contextId ? (
            <Callout tone="info" title={t('people.member_reload')}>
              {onRefresh ? (
                <Button label={t('management.refresh')} disabled={busy} onClick={onRefresh} />
              ) : null}
            </Callout>
          ) : null}
          <Select
            id="member-admin-person"
            name="member-admin.person"
            label={t('people.choose_human')}
            value={id}
            disabled={busy}
            options={[
              { value: '', label: t('people.choose_human') },
              ...members.map((member) => ({
                value: member.member_id,
                label:
                  member.display_name +
                  (member.member_id === 'owner' ? ' · ' + t('people.local_operator') : ''),
              })),
            ]}
          />
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
              <TextField
                id="member-admin-name"
                name="member-admin.name"
                label={t('people.human_name')}
                value={name}
                maxlength={160}
                disabled={busy}
              />
              <div className="settings-inline-actions">
                <Button
                  label={t('people.rename_human')}
                  disabled={cannotSave || !name.trim() || name.trim() === selected.display_name}
                  onClick={() =>
                    review(
                      { display_name: name.trim() },
                      `${selected.display_name} → ${name.trim()}`
                    )
                  }
                />
              </div>
              <Select
                id="member-admin-tenant"
                name="member-admin.tenant"
                label={t('management.tenant')}
                value={tenant}
                disabled={busy}
                options={[
                  { value: '', label: t('management.choose_tenant') },
                  ...owned.map((row) => ({ value: row.tenant_slug, label: row.display_name })),
                ]}
              />
              <Select
                id="member-admin-role"
                name="member-admin.role"
                label={t('people.access_role')}
                value={role}
                disabled={busy || !tenant}
                options={(['owner', 'approver', 'operator', 'viewer'] as const).map((value) => ({
                  value,
                  label: frontDeskText(
                    value === 'owner'
                      ? 'role_owner'
                      : value === 'approver'
                        ? 'role_approver'
                        : value === 'operator'
                          ? 'role_operator'
                          : 'role_viewer',
                    locale
                  ),
                }))}
              />
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
      </FormScope>
    </SettingsGroup>
  );
}
