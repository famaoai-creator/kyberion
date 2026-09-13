'use client';

import * as React from 'react';
import { frontDeskText } from '../../../lib/i18n';
import type { ConciergeLocale, ConciergeMessageKey, FrontDeskMessageKey } from '../../../lib/i18n';
import type { SettingsMember, SettingsRole, SettingsTenantView } from '../../../lib/settings-types';

/** FD-06/FD-07 組織とメンバー pane (`#settings-members`) — tenants list,
 * member list, and the add-member form. Extracted from settings/page.tsx;
 * all state, refresh, and mutation handlers stay owned by the page. */

const ROLE_LABEL_KEYS: Record<SettingsRole, FrontDeskMessageKey> = {
  owner: 'role_owner',
  approver: 'role_approver',
  viewer: 'role_viewer',
};

export type MemberFormState = {
  display_name: string;
  member_id: string;
  tenant_slug: string;
  role: SettingsRole;
  issue_token: boolean;
};

export type MembersSectionProps = {
  locale: ConciergeLocale;
  t: (key: ConciergeMessageKey, params?: Record<string, string | number>) => string;
  meTenants: SettingsTenantView[];
  meViewing: SettingsTenantView | null;
  members: SettingsMember[];
  memberForm: MemberFormState;
  setMemberForm: React.Dispatch<React.SetStateAction<MemberFormState>>;
  memberBusy: boolean;
  issuedToken: string | null;
  setIssuedToken: (token: string | null) => void;
  onAddMember: () => void;
  onPatchMember: (
    memberId: string,
    patch: { tenant_slug: string; role: SettingsRole } | { status: 'active' | 'suspended' }
  ) => void;
  sectionRef: (element: HTMLElement | null) => void;
};

export function MembersSection({
  locale,
  t,
  meTenants,
  meViewing,
  members,
  memberForm,
  setMemberForm,
  memberBusy,
  issuedToken,
  setIssuedToken,
  onAddMember,
  onPatchMember,
  sectionRef,
}: MembersSectionProps) {
  return (
    <section
      className="pane"
      id="settings-members"
      ref={sectionRef}
      aria-label={frontDeskText('settings_nav_members', locale)}
    >
      <h2>{frontDeskText('settings_nav_members', locale)}</h2>
      <h3 className="pane-subheading">{frontDeskText('settings_tenants_title', locale)}</h3>
      <p className="pane-subtitle">{frontDeskText('settings_tenants_lead', locale)}</p>
      {meTenants.length === 0 ? (
        <p className="pane-empty">{t('setup.loading')}</p>
      ) : (
        <ul className="settings-tenant-list">
          {meTenants.map((tenant) => (
            <li className="item-card settings-tenant-item" key={tenant.tenant_slug}>
              <p className="item-title">
                {tenant.display_name} ({tenant.tenant_slug})
                {meViewing?.tenant_slug === tenant.tenant_slug ? (
                  <span className="status-chip ok">
                    {frontDeskText('settings_tenant_current', locale)}
                  </span>
                ) : null}
              </p>
              <p className="item-meta">
                {frontDeskText(ROLE_LABEL_KEYS[tenant.role], locale)} · {tenant.status}
              </p>
            </li>
          ))}
        </ul>
      )}
      <h3 className="pane-subheading">{frontDeskText('settings_members_title', locale)}</h3>
      {members.length === 0 ? (
        <p className="pane-empty">{t('setup.loading')}</p>
      ) : (
        <ul className="settings-tenant-list">
          {members.map((member) => {
            const membership = member.memberships.find(
              (m) => m.tenant_slug === (meViewing?.tenant_slug ?? meTenants[0]?.tenant_slug)
            );
            return (
              <li className="item-card settings-tenant-item" key={member.member_id}>
                <p className="item-title">
                  {member.display_name} ({member.member_id})
                  <span className="status-chip">
                    {frontDeskText(
                      member.sign_in === 'token'
                        ? 'settings_member_signin_token'
                        : 'settings_member_signin_local',
                      locale
                    )}
                  </span>
                  {membership ? (
                    <span className="status-chip ok">
                      {frontDeskText(ROLE_LABEL_KEYS[membership.role], locale)}
                    </span>
                  ) : null}
                  <span className="status-chip">
                    {frontDeskText(
                      member.status === 'suspended'
                        ? 'settings_member_status_suspended'
                        : 'settings_member_status_active',
                      locale
                    )}
                  </span>
                </p>
                <div className="button-row">
                  <select
                    aria-label={frontDeskText('settings_member_role_change', locale)}
                    defaultValue={membership?.role ?? 'viewer'}
                    disabled={memberBusy}
                    onChange={(event) => {
                      const tenantSlug = meViewing?.tenant_slug ?? meTenants[0]?.tenant_slug;
                      if (!tenantSlug) return;
                      onPatchMember(member.member_id, {
                        tenant_slug: tenantSlug,
                        role: event.target.value as SettingsRole,
                      });
                    }}
                  >
                    {(['owner', 'approver', 'viewer'] as SettingsRole[]).map((role) => (
                      <option key={role} value={role}>
                        {frontDeskText(ROLE_LABEL_KEYS[role], locale)}
                      </option>
                    ))}
                  </select>
                  <button
                    className="action-button"
                    disabled={memberBusy}
                    onClick={() =>
                      onPatchMember(member.member_id, {
                        status: member.status === 'suspended' ? 'active' : 'suspended',
                      })
                    }
                  >
                    {frontDeskText(
                      member.status === 'suspended'
                        ? 'settings_member_reactivate'
                        : 'settings_member_suspend',
                      locale
                    )}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <h3 className="pane-subheading">{frontDeskText('settings_member_add', locale)}</h3>
      <label>
        {frontDeskText('settings_member_add_display_name', locale)}
        <input
          type="text"
          value={memberForm.display_name}
          onChange={(event) => setMemberForm({ ...memberForm, display_name: event.target.value })}
        />
      </label>
      <label>
        {frontDeskText('settings_member_add_id', locale)}
        <input
          type="text"
          value={memberForm.member_id}
          onChange={(event) => setMemberForm({ ...memberForm, member_id: event.target.value })}
        />
      </label>
      <label>
        {frontDeskText('settings_member_add_tenant', locale)}
        <select
          value={memberForm.tenant_slug}
          onChange={(event) => setMemberForm({ ...memberForm, tenant_slug: event.target.value })}
        >
          {meTenants.map((tenant) => (
            <option key={tenant.tenant_slug} value={tenant.tenant_slug}>
              {tenant.display_name}
            </option>
          ))}
        </select>
      </label>
      <label>
        {frontDeskText('settings_member_add_role', locale)}
        <select
          value={memberForm.role}
          onChange={(event) =>
            setMemberForm({ ...memberForm, role: event.target.value as SettingsRole })
          }
        >
          {(['owner', 'approver', 'viewer'] as SettingsRole[]).map((role) => (
            <option key={role} value={role}>
              {frontDeskText(ROLE_LABEL_KEYS[role], locale)}
            </option>
          ))}
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          checked={memberForm.issue_token}
          onChange={(event) => setMemberForm({ ...memberForm, issue_token: event.target.checked })}
        />
        {frontDeskText('settings_member_add_issue_token', locale)}
      </label>
      <div className="button-row">
        <button
          className="action-button"
          disabled={
            memberBusy ||
            !memberForm.display_name ||
            !memberForm.member_id ||
            !memberForm.tenant_slug
          }
          onClick={onAddMember}
        >
          {frontDeskText('settings_member_add_submit', locale)}
        </button>
      </div>
      {issuedToken ? (
        <div className="notice" role="alert">
          <p>{frontDeskText('settings_token_once', locale)}</p>
          <code>{issuedToken}</code>
          <div className="button-row">
            <button className="action-button" onClick={() => setIssuedToken(null)}>
              {frontDeskText('settings_token_once_dismiss', locale)}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
