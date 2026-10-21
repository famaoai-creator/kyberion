'use client';

import * as React from 'react';
import { Button, Callout, SettingRow, SettingsGroup, StatusPill } from '@agent/shared-ui';
import { useConciergeI18n } from '../../lib/use-concierge-i18n';
import { type Scope, type ManagementData } from './management-client';
import { useOrganizationParticipants } from './use-organization-participants';
import { ManagedAgentsPanel } from './ManagedAgentsPanel';
import type { ParticipantCandidate, ParticipantsCommand } from './participants-client';

export function OrganizationParticipantsPanel({
  scope,
  management,
  disabled,
}: {
  scope: Scope;
  management: ManagementData;
  disabled: boolean;
}) {
  const { t } = useConciergeI18n();
  const state = useOrganizationParticipants(scope, management);
  const [actor, setActor] = React.useState('');
  const [roles, setRoles] = React.useState<string[]>([]);
  const [pending, setPending] = React.useState<{
    command: ParticipantsCommand;
    summary: string;
  } | null>(null);
  const confirmation = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (pending) {
      confirmation.current?.focus();
      confirmation.current?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [pending]);
  const data = state.data;
  const mutationBusy = disabled || state.busy || state.loading;
  const busy = mutationBusy || Boolean(pending && data);
  const current = data?.participants.find((row) => row.actor === actor);
  const selected = data?.candidates.find((row) => row.actor === actor) ?? current;
  const roleName = (id: string) => data?.roles.find((role) => role.role_id === id)?.name ?? id;
  const kindName = (kind: ParticipantCandidate['kind']) =>
    t(kind === 'human' ? 'people.human' : kind === 'agent' ? 'people.agent' : 'people.service');
  function edit(row: ParticipantCandidate) {
    setPending(null);
    setActor(row.actor);
    setRoles(data?.participants.find((item) => item.actor === row.actor)?.role_ids ?? []);
  }
  function review(command: ParticipantsCommand, summary: string) {
    if (!busy && data) setPending({ command, summary });
  }
  async function confirm() {
    if (!pending || mutationBusy) return;
    if (await state.commit(pending.command)) {
      setPending(null);
      setActor('');
      setRoles([]);
    }
  }
  const active = data?.participants.filter((row) => row.status === 'active') ?? [];
  const displayActor = (row: ParticipantCandidate) =>
    `${row.display_name}${row.is_local_owner ? ' · ' + t('people.local_operator') : ''}${row.actor === management.actorId ? ' · ' + t('people.you') : ''}`;

  return (
    <section aria-label={t('people.title')} className="settings-section">
      <SettingsGroup
        id="management-participants"
        title={t('people.title')}
        description={t('people.description')}
      >
        <div className="settings-row-block">
          <p>
            {t('people.selected_scope', {
              tenant: scope.tenant,
              organization: management.organization?.name ?? scope.organizationId,
            })}
          </p>
          <p className="kb-text kb-text--muted">{t('people.roles_boundary')}</p>
          <Button
            label={t('people.member_access')}
            href={'/settings?tenant=' + encodeURIComponent(scope.tenant) + '#settings-members'}
          />
        </div>
        {state.loading ? <p role="status">{t('management.loading')}</p> : null}
        {state.notice ? (
          <div role={state.notice === 'saved' ? 'status' : 'alert'} aria-live="polite">
            <Callout
              tone={state.notice === 'saved' ? 'success' : 'warning'}
              title={t(
                state.notice === 'saved'
                  ? 'management.saved'
                  : state.notice === 'conflict'
                    ? 'management.conflict'
                    : state.notice === 'expired'
                      ? 'management.expired'
                      : state.notice === 'forbidden'
                        ? 'management.forbidden'
                        : state.notice === 'uncertain'
                          ? 'management.uncertain'
                          : 'management.failed'
              )}
            />
          </div>
        ) : null}
        {!state.loading && !data ? (
          <div className="settings-row-block">
            <Button
              disabled={busy}
              label={t('management.refresh')}
              onClick={() => {
                setPending(null);
                void state.reload();
              }}
            />
          </div>
        ) : null}
        {data ? (
          <>
            {!active.length ? <p className="settings-row-block">{t('people.empty')}</p> : null}
            {active.map((row) => (
              <SettingRow
                key={row.actor}
                label={displayActor(row)}
                description={`${kindName(row.kind)} · ${row.role_ids.map(roleName).join(' / ') || t('people.no_roles')}`}
              >
                <div className="settings-inline-actions">
                  <StatusPill
                    status={row.identity_status === 'active' ? 'active' : 'paused'}
                    label={
                      row.identity_status === 'active'
                        ? t('people.active')
                        : row.identity_status === 'provisioned'
                          ? t('people.provisioned')
                          : row.identity_status === 'retired'
                            ? t('people.retired')
                            : t('people.suspended')
                    }
                  />
                  <Button
                    label={t('people.edit_roles')}
                    disabled={busy}
                    onClick={() => edit(row)}
                  />
                  <Button
                    label={t('people.remove_assignment')}
                    disabled={busy}
                    variant="ghost"
                    onClick={() =>
                      review(
                        {
                          operation: 'participant.remove',
                          actor: row.actor,
                          expectedVersion: row.version,
                        },
                        `${t('people.remove_assignment')}: ${displayActor(row)}`
                      )
                    }
                  />
                </div>
              </SettingRow>
            ))}
            <div className="settings-row-block management-editor">
              <h3>{t('people.assign_title')}</h3>
              <label>
                {t('people.choose_identity')}
                <select
                  value={actor}
                  disabled={busy}
                  onChange={(event) => {
                    const row = data.candidates.find((item) => item.actor === event.target.value);
                    if (row) edit(row);
                    else {
                      setActor('');
                      setRoles([]);
                      setPending(null);
                    }
                  }}
                >
                  <option value="">{t('people.choose_identity')}</option>
                  {data.candidates.map((row) => (
                    <option key={row.actor} value={row.actor}>
                      {displayActor(row)} · {kindName(row.kind)}
                    </option>
                  ))}
                  {current && !data.candidates.some((row) => row.actor === current.actor) ? (
                    <option value={current.actor}>{displayActor(current)}</option>
                  ) : null}
                </select>
              </label>
              <fieldset disabled={busy || !selected} className="management-role-picker">
                <legend>{t('people.roles')}</legend>
                {data.roles.map((role) => (
                  <label key={role.role_id} className="management-role-option">
                    <input
                      type="checkbox"
                      checked={roles.includes(role.role_id)}
                      onChange={(event) =>
                        setRoles((values) =>
                          event.target.checked
                            ? [...values, role.role_id]
                            : values.filter((value) => value !== role.role_id)
                        )
                      }
                    />
                    {role.name}
                  </label>
                ))}
                {roles
                  .filter((id) => !data.roles.some((role) => role.role_id === id))
                  .map((id) => (
                    <label key={id} className="management-role-option">
                      <input
                        type="checkbox"
                        checked
                        onChange={() =>
                          setRoles((values) => values.filter((value) => value !== id))
                        }
                      />
                      {id}
                    </label>
                  ))}
              </fieldset>
              <div className="settings-inline-actions">
                <Button
                  label={t('management.review')}
                  disabled={busy || !selected}
                  onClick={() =>
                    selected &&
                    review(
                      {
                        operation: 'participant.assign',
                        actor: selected.actor,
                        roleIds: roles,
                        ...(current ? { expectedVersion: current.version } : {}),
                      },
                      `${displayActor(selected)}: ${roles.map(roleName).join(' / ') || t('people.no_roles')}`
                    )
                  }
                />
              </div>
            </div>
          </>
        ) : null}
      </SettingsGroup>
      {data ? (
        <ManagedAgentsPanel
          agents={data.agents}
          candidates={data.candidates}
          busy={busy}
          onReview={review}
        />
      ) : null}
      {pending && data ? (
        <div
          className="management-editor"
          role="region"
          aria-label={t('management.confirm')}
          ref={confirmation}
          tabIndex={-1}
        >
          <h3>{t('management.confirm')}</h3>
          <p>
            {t('people.selected_scope', {
              tenant: scope.tenant,
              organization: management.organization?.name ?? scope.organizationId,
            })}
          </p>
          <p className="management-description">{pending.summary}</p>
          <div className="settings-inline-actions">
            <Button
              variant="primary"
              label={t(state.busy ? 'management.saving' : 'management.confirm_save')}
              disabled={mutationBusy}
              onClick={() => void confirm()}
            />
            <Button
              label={t('management.cancel')}
              disabled={mutationBusy}
              onClick={() => setPending(null)}
            />
          </div>
        </div>
      ) : null}
    </section>
  );
}
