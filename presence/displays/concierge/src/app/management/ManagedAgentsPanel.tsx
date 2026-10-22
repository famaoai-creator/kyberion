'use client';

import * as React from 'react';
import { Button, SettingsGroup, SettingRow, StatusPill } from '@agent/shared-ui';
import { useConciergeI18n } from '../../lib/use-concierge-i18n';
import type {
  ManagedAgent,
  ParticipantCandidate,
  ParticipantsCommand,
} from './participants-client';

export function ManagedAgentsPanel({
  agents,
  candidates,
  busy,
  onReview,
}: {
  agents: ManagedAgent[];
  candidates: ParticipantCandidate[];
  busy: boolean;
  onReview: (command: ParticipantsCommand, summary: string) => void;
}) {
  const { t } = useConciergeI18n();
  const [slug, setSlug] = React.useState('');
  const [name, setName] = React.useState('');
  const [owner, setOwner] = React.useState('');
  const [edits, setEdits] = React.useState<Record<string, { reason: string; owner: string }>>({});
  const humans = candidates.filter(
    (row) => row.kind === 'human' && row.identity_status === 'active'
  );
  const displayOwner = (id: string) => humans.find((row) => row.actor === id)?.display_name ?? id;
  const ownerOptions = (value: string, onChange: (value: string) => void, label: string) => (
    <label>
      {label}
      <select value={value} disabled={busy} onChange={(event) => onChange(event.target.value)}>
        <option value="">{t('people.choose_accountable')}</option>
        {humans.map((row) => (
          <option key={row.actor} value={row.actor}>
            {row.display_name}
            {row.is_local_owner ? ' · ' + t('people.local_operator') : ''}
          </option>
        ))}
      </select>
    </label>
  );
  function update(agent: ManagedAgent, field: 'reason' | 'owner', value: string) {
    setEdits((current) => ({
      ...current,
      [agent.nhi_id]: {
        reason: current[agent.nhi_id]?.reason ?? '',
        owner: current[agent.nhi_id]?.owner ?? agent.accountable_human_id,
        [field]: value,
      },
    }));
  }
  return (
    <SettingsGroup
      id="management-agents"
      title={t('people.agents_title')}
      description={t('people.agent_scope')}
    >
      {!agents.length ? <p className="settings-row-block">{t('people.agents_empty')}</p> : null}
      {agents.map((agent) => {
        const form = edits[agent.nhi_id] ?? { reason: '', owner: agent.accountable_human_id };
        const lifecycle = (action: 'activate' | 'suspend' | 'retire', label: string) => (
          <Button
            label={label}
            disabled={busy || !form.reason.trim()}
            variant={action === 'retire' ? 'ghost' : 'secondary'}
            onClick={() =>
              onReview(
                {
                  operation: 'agent.lifecycle',
                  nhiId: agent.nhi_id,
                  action,
                  reason: form.reason.trim(),
                  expectedVersion: agent.version,
                },
                `${label}: ${agent.display_name}\n${t('people.change_reason')}: ${form.reason.trim()}`
              )
            }
          />
        );
        return (
          <SettingRow
            key={agent.nhi_id}
            label={agent.display_name}
            description={t('people.accountable_summary', {
              name: displayOwner(agent.accountable_human_id),
            })}
          >
            <div className="settings-section">
              <StatusPill
                status={agent.lifecycle_status === 'active' ? 'active' : 'paused'}
                label={t(
                  agent.lifecycle_status === 'active'
                    ? 'people.active'
                    : agent.lifecycle_status === 'provisioned'
                      ? 'people.provisioned'
                      : agent.lifecycle_status === 'suspended'
                        ? 'people.suspended'
                        : 'people.retired'
                )}
              />
              {agent.lifecycle_status !== 'retired' ? (
                <>
                  <label>
                    {t('people.change_reason')}
                    <input
                      value={form.reason}
                      maxLength={1000}
                      disabled={busy}
                      onChange={(event) => update(agent, 'reason', event.target.value)}
                    />
                  </label>
                  {ownerOptions(
                    form.owner,
                    (value) => update(agent, 'owner', value),
                    t('people.accountable')
                  )}
                  <div className="settings-inline-actions">
                    {agent.lifecycle_status === 'provisioned' ||
                    agent.lifecycle_status === 'suspended'
                      ? lifecycle('activate', t('people.activate_agent'))
                      : null}
                    {agent.lifecycle_status === 'active'
                      ? lifecycle('suspend', t('people.suspend_agent'))
                      : null}
                    {lifecycle('retire', t('people.retire_agent'))}
                    <Button
                      label={t('people.change_accountable')}
                      disabled={
                        busy ||
                        !form.owner ||
                        !form.reason.trim() ||
                        form.owner === agent.accountable_human_id
                      }
                      onClick={() =>
                        onReview(
                          {
                            operation: 'agent.accountable',
                            nhiId: agent.nhi_id,
                            accountableHumanId: form.owner,
                            reason: form.reason.trim(),
                            expectedVersion: agent.version,
                          },
                          `${t('people.change_accountable')}: ${agent.display_name} → ${displayOwner(form.owner)}\n${t('people.change_reason')}: ${form.reason.trim()}`
                        )
                      }
                    />
                  </div>
                </>
              ) : null}
            </div>
          </SettingRow>
        );
      })}
      <div className="settings-row-block management-editor">
        <h3>{t('people.issue_agent')}</h3>
        <p className="kb-text kb-text--muted">{t('people.provisioned_hint')}</p>
        <form
          className="settings-section"
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy && slug.trim() && name.trim() && owner)
              onReview(
                {
                  operation: 'agent.issue',
                  slug: slug.trim(),
                  displayName: name.trim(),
                  accountableHumanId: owner,
                },
                `${t('people.issue_agent')}: ${name.trim()} (${slug.trim()})\n${t('people.accountable')}: ${displayOwner(owner)}`
              );
          }}
        >
          <label>
            {t('people.agent_name')}
            <input
              required
              value={name}
              maxLength={160}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            {t('people.agent_slug')}
            <input
              required
              value={slug}
              pattern="[a-z][a-z0-9-]*"
              maxLength={64}
              disabled={busy}
              onChange={(event) => setSlug(event.target.value)}
            />
          </label>
          {ownerOptions(owner, setOwner, t('people.accountable'))}
          <div className="settings-inline-actions">
            <Button
              type="submit"
              label={t('management.review')}
              disabled={busy || !name.trim() || !slug.trim() || !owner}
            />
          </div>
        </form>
      </div>
    </SettingsGroup>
  );
}
