'use client';

import * as React from 'react';
import {
  Button,
  Callout,
  Select,
  SettingRow,
  SettingsGroup,
  StatusPill,
  Switch,
  TextField,
} from '@agent/shared-ui';
import { frontDeskText } from '../../../lib/i18n';
import type { ConciergeLocale, FrontDeskMessageKey } from '../../../lib/i18n';
import type {
  Setup,
  SettingsMember,
  SettingsRole,
  SettingsTenantView,
  TrainingAssignments,
  TrainingProgressSummary,
  TrainingTrack,
} from '../../../lib/settings-types';
import { FormScope, asText, type SettingsTranslate } from './form-scope';

/** FD-06/FD-07/HT-05 組織とメンバー pane (`#settings-members`) — tenants list,
 * member list, add-member form, the accountable-agents list, and the
 * training-track assignment UI. Extracted from settings/page.tsx; all
 * state, refresh, and mutation handlers stay owned by the page (or its
 * use-training-assignments hook). UI-06: shared settings groups / rows. */

const ROLE_LABEL_KEYS: Record<SettingsRole, FrontDeskMessageKey> = {
  owner: 'role_owner',
  approver: 'role_approver',
  operator: 'role_operator',
  viewer: 'role_viewer',
};

const ROLES: SettingsRole[] = ['owner', 'approver', 'operator', 'viewer'];

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
  t: SettingsTranslate;
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

function Loading({ text }: { text: string }) {
  return (
    <div className="settings-row-block">
      <p className="kb-text kb-text--muted">{text}</p>
    </div>
  );
}

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
  const roleOptions = ROLES.map((role) => ({
    value: role,
    label: frontDeskText(ROLE_LABEL_KEYS[role], locale),
  }));
  const roleFields = Object.fromEntries(
    members.map((member) => [
      `member.role.${member.member_id}`,
      (value: unknown) => {
        if (!activeTenantSlug) return;
        onPatchMember(member.member_id, {
          tenant_slug: activeTenantSlug,
          role: asText(value) as SettingsRole,
        });
      },
    ])
  );
  return (
    <div
      className="settings-section"
      id="settings-members"
      ref={sectionRef}
      aria-label={frontDeskText('settings_nav_members', locale)}
    >
      <FormScope
        fields={{
          ...roleFields,
          'training.track': (value) => setTrainingTrackId(asText(value)),
          'member.display_name': (value) =>
            setMemberForm((current) => ({ ...current, display_name: asText(value) })),
          'member.member_id': (value) =>
            setMemberForm((current) => ({ ...current, member_id: asText(value) })),
          'member.tenant_slug': (value) =>
            setMemberForm((current) => ({ ...current, tenant_slug: asText(value) })),
          'member.role': (value) =>
            setMemberForm((current) => ({ ...current, role: asText(value) as SettingsRole })),
          'member.issue_token': (value) =>
            setMemberForm((current) => ({ ...current, issue_token: value === true })),
        }}
      >
        <SettingsGroup
          id="settings-tenants"
          title={frontDeskText('settings_nav_members', locale)}
          description={`${frontDeskText('settings_tenants_title', locale)} — ${frontDeskText(
            'settings_tenants_lead',
            locale
          )}`}
        >
          {meTenants.length === 0 ? (
            <Loading text={t('setup.loading')} />
          ) : (
            meTenants.map((tenant) => (
              <SettingRow
                key={tenant.tenant_slug}
                label={`${tenant.display_name} (${tenant.tenant_slug})`}
                description={`${frontDeskText(ROLE_LABEL_KEYS[tenant.role], locale)} · ${tenant.status}`}
              >
                {meViewing?.tenant_slug === tenant.tenant_slug ? (
                  <StatusPill
                    status="active"
                    label={frontDeskText('settings_tenant_current', locale)}
                  />
                ) : null}
              </SettingRow>
            ))
          )}
        </SettingsGroup>

        <SettingsGroup
          id="settings-member-list"
          title={frontDeskText('settings_members_title', locale)}
        >
          {members.length === 0 ? (
            <Loading text={t('setup.loading')} />
          ) : (
            members.map((member) => {
              const membership = member.memberships.find((m) => m.tenant_slug === activeTenantSlug);
              const signIn = frontDeskText(
                member.sign_in === 'token'
                  ? 'settings_member_signin_token'
                  : 'settings_member_signin_local',
                locale
              );
              const status = frontDeskText(
                member.status === 'suspended'
                  ? 'settings_member_status_suspended'
                  : 'settings_member_status_active',
                locale
              );
              return (
                <SettingRow
                  key={member.member_id}
                  label={`${member.display_name} (${member.member_id})`}
                  description={`${signIn} · ${status}`}
                >
                  <div className="settings-inline-actions">
                    <Select
                      id={`member-role-${member.member_id}`}
                      name={`member.role.${member.member_id}`}
                      label={frontDeskText('settings_member_role_change', locale)}
                      hide_label
                      value={membership?.role ?? 'viewer'}
                      disabled={memberBusy}
                      options={roleOptions}
                    />
                    <Button
                      label={frontDeskText(
                        member.status === 'suspended'
                          ? 'settings_member_reactivate'
                          : 'settings_member_suspend',
                        locale
                      )}
                      variant={member.status === 'suspended' ? 'secondary' : 'ghost'}
                      disabled={memberBusy}
                      onClick={() =>
                        onPatchMember(member.member_id, {
                          status: member.status === 'suspended' ? 'active' : 'suspended',
                        })
                      }
                    />
                  </div>
                </SettingRow>
              );
            })
          )}
        </SettingsGroup>

        {/* HT-05/HT-06: track catalog comes from /api/training/catalog (never
            hardcoded here), so track titles stay a single source of truth with
            knowledge/product/orchestration/training-catalog.json; the fixed
            chrome (heading, field label, statuses, button) is vocabulary. */}
        <SettingsGroup
          id="settings-training"
          title={frontDeskText('settings_training_title', locale)}
          description={frontDeskText('settings_training_lead', locale)}
        >
          {trainingTracks.length > 0 ? (
            <>
              <SettingRow label={frontDeskText('settings_training_track', locale)}>
                <Select
                  id="training-track"
                  name="training.track"
                  label={frontDeskText('settings_training_track', locale)}
                  hide_label
                  value={trainingTrackId}
                  options={trainingTracks.map((track) => ({ value: track.id, label: track.title }))}
                />
              </SettingRow>
              {members.map((member) => {
                const assignment = trainingAssignments
                  .find((item) => item.tenant_slug === activeTenantSlug)
                  ?.assignments.find(
                    (item) =>
                      item.member_id === member.member_id && item.track_id === trainingTrackId
                  );
                const progress = trainingProgress.find(
                  (item) => item.member_id === member.member_id
                );
                // HT-05 second pass: per-member progress, reusing the
                // `training_lessons_done` key `static/help.js` shares —
                // never a section-local count string.
                const progressText = progress
                  ? frontDeskText('training_lessons_done', locale, {
                      done: progress.lessons_done,
                      total: progress.lessons_total,
                    })
                  : frontDeskText('training_no_progress', locale);
                return (
                  <SettingRow
                    key={`training-${member.member_id}`}
                    label={`${member.display_name} · ${frontDeskText(
                      TRAINING_STATUS_LABEL_KEYS[assignment?.status ?? 'not_started'],
                      locale
                    )}`}
                    description={`${frontDeskText('settings_training_progress', locale)}: ${progressText}`}
                  >
                    <Button
                      label={frontDeskText('settings_training_assign', locale)}
                      variant="secondary"
                      disabled={memberBusy}
                      onClick={() => onAssignTraining(member.member_id)}
                    />
                  </SettingRow>
                );
              })}
            </>
          ) : (
            <Loading text={t('setup.loading')} />
          )}
        </SettingsGroup>

        {/* FD-10: accountable agents (display name + accountable member only —
            never the nhi_id, per plan §2.5 principle 6). */}
        <SettingsGroup
          id="settings-agents"
          title={t('setup.agent_display_name')}
          description={t('setup.agent_registry_count', {
            count: setup.agent_management.durable_identities.length,
          })}
        >
          {setup.agent_management.durable_identities.length === 0 ? (
            <Loading text={t('settings.agents_empty')} />
          ) : null}
          {setup.agent_management.durable_identities.map((agent) => {
            const ownerId = agent.accountable_human_id?.replace(/^user:/, '');
            const owner = members.find((member) => member.member_id === ownerId);
            return (
              <SettingRow
                key={agent.nhi_id}
                label={agent.display_name}
                description={owner?.display_name || frontDeskText('settings_members_title', locale)}
              />
            );
          })}
        </SettingsGroup>

        <SettingsGroup
          id="settings-member-add"
          title={frontDeskText('settings_member_add', locale)}
        >
          <SettingRow label={frontDeskText('settings_member_add_display_name', locale)}>
            <TextField
              id="member-add-name"
              name="member.display_name"
              label={frontDeskText('settings_member_add_display_name', locale)}
              hide_label
              value={memberForm.display_name}
            />
          </SettingRow>
          <SettingRow label={frontDeskText('settings_member_add_id', locale)}>
            <TextField
              id="member-add-id"
              name="member.member_id"
              label={frontDeskText('settings_member_add_id', locale)}
              hide_label
              value={memberForm.member_id}
            />
          </SettingRow>
          <SettingRow label={frontDeskText('settings_member_add_tenant', locale)}>
            <Select
              id="member-add-tenant"
              name="member.tenant_slug"
              label={frontDeskText('settings_member_add_tenant', locale)}
              hide_label
              value={memberForm.tenant_slug}
              options={meTenants.map((tenant) => ({
                value: tenant.tenant_slug,
                label: tenant.display_name,
              }))}
            />
          </SettingRow>
          <SettingRow label={frontDeskText('settings_member_add_role', locale)}>
            <Select
              id="member-add-role"
              name="member.role"
              label={frontDeskText('settings_member_add_role', locale)}
              hide_label
              value={memberForm.role}
              options={roleOptions}
            />
          </SettingRow>
          <SettingRow label={frontDeskText('settings_member_add_issue_token', locale)}>
            <Switch
              id="member-add-token"
              name="member.issue_token"
              label={frontDeskText('settings_member_add_issue_token', locale)}
              hide_label
              value={memberForm.issue_token}
            />
          </SettingRow>
          <div className="settings-row-actions">
            <Button
              label={frontDeskText('settings_member_add_submit', locale)}
              variant="primary"
              disabled={
                memberBusy ||
                !memberForm.display_name.trim() ||
                !memberForm.member_id.trim() ||
                !memberForm.tenant_slug
              }
              onClick={onAddMember}
            />
          </div>
          {issuedToken ? (
            // The new access token is shown exactly once and never re-fetchable.
            <div className="settings-row-block" role="alert">
              <Callout tone="warning" title={frontDeskText('settings_token_once', locale)}>
                <code className="kb-text--mono settings-token">{issuedToken}</code>
                <div className="settings-inline-actions">
                  <Button
                    label={frontDeskText('settings_token_once_dismiss', locale)}
                    variant="secondary"
                    onClick={() => setIssuedToken(null)}
                  />
                </div>
              </Callout>
            </div>
          ) : null}
        </SettingsGroup>
      </FormScope>
    </div>
  );
}
