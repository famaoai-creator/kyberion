'use client';

import * as React from 'react';
import { frontDeskText } from '../../../lib/i18n';
import type { ConciergeLocale, ConciergeMessageKey, FrontDeskMessageKey } from '../../../lib/i18n';
import type {
  Setup,
  SettingsMember,
  SettingsRole,
  SettingsTenantView,
  TrainingAssignments,
  TrainingProgressSummary,
  TrainingTrack,
} from '../../../lib/settings-types';

/** FD-06/FD-07/HT-05 組織とメンバー pane (`#settings-members`) — tenants list,
 * member list, add-member form, the accountable-agents list, and the
 * training-track assignment UI. Extracted from settings/page.tsx; all
 * state, refresh, and mutation handlers stay owned by the page (or its
 * use-training-assignments hook). */

const ROLE_LABEL_KEYS: Record<SettingsRole, FrontDeskMessageKey> = {
  owner: 'role_owner',
  approver: 'role_approver',
  operator: 'role_operator',
  viewer: 'role_viewer',
};

// HT-06 (i18n gate): training status labels resolve through the shared
// `front_desk:training_status_*` vocabulary keys (same ones `static/help.js`
// renders) instead of an inline stand-in map.
const TRAINING_STATUS_LABEL_KEYS: Record<
  'not_started' | 'in_progress' | 'complete',
  FrontDeskMessageKey
> = {
  not_started: 'training_status_not_started',
  in_progress: 'training_status_in_progress',
  complete: 'training_status_complete',
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
  setup: Setup;
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
  trainingTracks: TrainingTrack[];
  trainingAssignments: TrainingAssignments[];
  trainingProgress: TrainingProgressSummary[];
  trainingTrackId: string;
  setTrainingTrackId: (value: string) => void;
  onAssignTraining: (memberId: string) => void;
  sectionRef: (element: HTMLElement | null) => void;
};

export function MembersSection({
  locale,
  t,
  setup,
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
  trainingTracks,
  trainingAssignments,
  trainingProgress,
  trainingTrackId,
  setTrainingTrackId,
  onAssignTraining,
  sectionRef,
}: MembersSectionProps) {
  const activeTenantSlug = meViewing?.tenant_slug ?? meTenants[0]?.tenant_slug;
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
            const membership = member.memberships.find((m) => m.tenant_slug === activeTenantSlug);
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
                      if (!activeTenantSlug) return;
                      onPatchMember(member.member_id, {
                        tenant_slug: activeTenantSlug,
                        role: event.target.value as SettingsRole,
                      });
                    }}
                  >
                    {(['owner', 'approver', 'operator', 'viewer'] as SettingsRole[]).map((role) => (
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

      {/* HT-05/HT-06: track catalog comes from /api/training/catalog (never
          hardcoded here), so track titles stay a single source of truth with
          knowledge/product/orchestration/training-catalog.json; the fixed
          chrome (heading, field label, statuses, button) is vocabulary. */}
      <h3 className="pane-subheading">{frontDeskText('settings_training_title', locale)}</h3>
      <p className="pane-subtitle">{frontDeskText('settings_training_lead', locale)}</p>
      {trainingTracks.length > 0 ? (
        <div className="item-card settings-member-form">
          <label className="field-label">
            {frontDeskText('settings_training_track', locale)}
            <select
              value={trainingTrackId}
              onChange={(event) => setTrainingTrackId(event.target.value)}
            >
              {trainingTracks.map((track) => (
                <option key={track.id} value={track.id}>
                  {track.title}
                </option>
              ))}
            </select>
          </label>
          {members.map((member) => {
            const assignment = trainingAssignments
              .find((item) => item.tenant_slug === activeTenantSlug)
              ?.assignments.find(
                (item) => item.member_id === member.member_id && item.track_id === trainingTrackId
              );
            const progress = trainingProgress.find((item) => item.member_id === member.member_id);
            return (
              <div className="button-row" key={`training-${member.member_id}`}>
                <span>
                  {member.display_name} ·{' '}
                  {frontDeskText(
                    TRAINING_STATUS_LABEL_KEYS[assignment?.status ?? 'not_started'],
                    locale
                  )}
                </span>
                {/* HT-05 second pass: per-member progress, reusing the
                    `training_lessons_done` key `static/help.js` shares —
                    never a section-local count string. */}
                <span className="item-meta">
                  {frontDeskText('settings_training_progress', locale)}:{' '}
                  {progress
                    ? frontDeskText('training_lessons_done', locale, {
                        done: progress.lessons_done,
                        total: progress.lessons_total,
                      })
                    : frontDeskText('training_no_progress', locale)}
                </span>
                <button
                  className="action-button"
                  disabled={memberBusy}
                  onClick={() => onAssignTraining(member.member_id)}
                >
                  {frontDeskText('settings_training_assign', locale)}
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="pane-empty">{t('setup.loading')}</p>
      )}

      {/* FD-10: accountable agents (display name + accountable member only —
          never the nhi_id, per plan §2.5 principle 6). */}
      <h3 className="pane-subheading">{t('setup.agent_display_name')}</h3>
      <p className="pane-subtitle">
        {t('setup.agent_registry_count', {
          count: setup.agent_management.durable_identities.length,
        })}
      </p>
      {setup.agent_management.durable_identities.length > 0 ? (
        <ul className="settings-tenant-list">
          {setup.agent_management.durable_identities.map((agent) => {
            const ownerId = agent.accountable_human_id?.replace(/^user:/, '');
            const owner = members.find((member) => member.member_id === ownerId);
            return (
              <li className="item-card settings-tenant-item" key={agent.nhi_id}>
                <p className="item-title">{agent.display_name}</p>
                <p className="item-meta">
                  {owner?.display_name || frontDeskText('settings_members_title', locale)}
                </p>
              </li>
            );
          })}
        </ul>
      ) : null}

      <h3 className="pane-subheading">{frontDeskText('settings_member_add', locale)}</h3>
      <div className="item-card settings-member-form">
        <div className="field-row">
          <label className="field-label">
            {frontDeskText('settings_member_add_display_name', locale)}
            <input
              type="text"
              value={memberForm.display_name}
              onChange={(event) =>
                setMemberForm({ ...memberForm, display_name: event.target.value })
              }
            />
          </label>
          <label className="field-label">
            {frontDeskText('settings_member_add_id', locale)}
            <input
              type="text"
              value={memberForm.member_id}
              onChange={(event) => setMemberForm({ ...memberForm, member_id: event.target.value })}
            />
          </label>
        </div>
        <div className="field-row">
          <label className="field-label">
            {frontDeskText('settings_member_add_tenant', locale)}
            <select
              value={memberForm.tenant_slug}
              onChange={(event) =>
                setMemberForm({ ...memberForm, tenant_slug: event.target.value })
              }
            >
              {meTenants.map((tenant) => (
                <option key={tenant.tenant_slug} value={tenant.tenant_slug}>
                  {tenant.display_name}
                </option>
              ))}
            </select>
          </label>
          <label className="field-label">
            {frontDeskText('settings_member_add_role', locale)}
            <select
              value={memberForm.role}
              onChange={(event) =>
                setMemberForm({ ...memberForm, role: event.target.value as SettingsRole })
              }
            >
              {(['owner', 'approver', 'operator', 'viewer'] as SettingsRole[]).map((role) => (
                <option key={role} value={role}>
                  {frontDeskText(ROLE_LABEL_KEYS[role], locale)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={memberForm.issue_token}
            onChange={(event) =>
              setMemberForm({ ...memberForm, issue_token: event.target.checked })
            }
          />
          {frontDeskText('settings_member_add_issue_token', locale)}
        </label>
        <div className="button-row">
          <button
            className="action-button"
            disabled={
              memberBusy ||
              !memberForm.display_name.trim() ||
              !memberForm.member_id.trim() ||
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
      </div>
    </section>
  );
}
