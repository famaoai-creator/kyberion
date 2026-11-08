'use client';

import * as React from 'react';
import { decideWithPasskey } from '../../../lib/passkey-client';
import { frontDeskFetch as fetch } from '../../../lib/front-desk-fetch';
import type { ConciergeLocale } from '../../../lib/i18n';
import { FormScope, asText, type SettingsTranslate } from './form-scope';
import {
  Button,
  Callout,
  Segmented,
  Select,
  SettingRow,
  SettingsGroup,
  TextField,
} from '@agent/shared-ui';

type PendingRequest = {
  request_id: string;
  status: string;
  approval_channel?: string;
  presented_digest?: string;
  expires_at?: string;
};
type Attestation = {
  training_use?: string;
  plan?: string;
  basis?: string;
  attested_by?: string;
  expires_at?: string;
};
type Overview = {
  providers: string[];
  attestations: Record<string, Attestation>;
  pending_requests: PendingRequest[];
};
type MemberOption = { member_id: string; display_name: string };

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function readOverview(value: unknown): Overview | null {
  if (!record(value) || value.ok !== true) return null;
  if (!Array.isArray(value.providers) || !value.providers.every((p) => typeof p === 'string'))
    return null;
  const attestations: Record<string, Attestation> = {};
  if (record(value.attestations))
    for (const [key, entry] of Object.entries(value.attestations))
      if (record(entry)) attestations[key] = entry as Attestation;
  const pending: PendingRequest[] = Array.isArray(value.pending_requests)
    ? value.pending_requests.filter(
        (item): item is PendingRequest =>
          record(item) && typeof item.request_id === 'string' && typeof item.status === 'string'
      )
    : [];
  return { providers: value.providers as string[], attestations, pending_requests: pending };
}

function readMembers(value: unknown): MemberOption[] {
  if (!record(value) || value.ok !== true || !Array.isArray(value.members)) return [];
  return value.members
    .filter((item): item is MemberOption => record(item) && typeof item.member_id === 'string')
    .map((item) => ({
      member_id: item.member_id,
      display_name: typeof item.display_name === 'string' ? item.display_name : item.member_id,
    }));
}

const VALID_DAY_OPTIONS = [
  { value: '90', label: '90' },
  { value: '180', label: '180' },
  { value: '365', label: '365' },
];

/**
 * Provider attestation (`#settings-provider-attestation`): every enumerable
 * field is a governed Select/Segmented — tenant and provider come from the
 * server overview, `attested_by` from the member registry, validity from
 * fixed day presets. `plan`/`basis` stay text only because the backend has
 * no catalog for them.
 */
export function ProviderAttestationSection({
  t,
  tenants,
  selectedTenant,
}: {
  t: SettingsTranslate;
  locale?: ConciergeLocale;
  tenants?: { tenant_slug: string; display_name: string }[];
  selectedTenant?: string;
}) {
  const [tenant, setTenant] = React.useState(selectedTenant || tenants?.[0]?.tenant_slug || '');
  const [provider, setProvider] = React.useState('');
  const [trainingUse, setTrainingUse] = React.useState<'none' | 'used' | 'unknown'>('none');
  const [plan, setPlan] = React.useState('');
  const [basis, setBasis] = React.useState('');
  const [attestedBy, setAttestedBy] = React.useState('');
  const [validDays, setValidDays] = React.useState('180');
  const [members, setMembers] = React.useState<MemberOption[]>([]);
  const [overview, setOverview] = React.useState<Overview | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async (slug: string) => {
    if (!slug) return setOverview(null);
    const res = await fetch(`/api/tenant-attestation?tenant=${encodeURIComponent(slug)}`);
    const data: unknown = await res.json().catch(() => null);
    setOverview(readOverview(data));
  }, []);

  React.useEffect(() => {
    void load(tenant);
  }, [tenant, load]);

  React.useEffect(() => {
    void fetch('/api/members')
      .then((res) => res.json().catch(() => null))
      .then((data) => setMembers(readMembers(data)))
      .catch(() => setMembers([]));
  }, []);

  const post = async (body: Record<string, unknown>) => {
    const res = await fetch('/api/tenant-attestation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data: unknown = await res.json().catch(() => null);
    if (!res.ok || !record(data) || data.ok !== true)
      throw new Error(
        record(data) && typeof data.error === 'string' ? data.error : `http_${res.status}`
      );
    return data;
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const attestationInput = () => ({
    tenant,
    provider,
    training_use: trainingUse,
    ...(plan.trim() ? { plan: plan.trim() } : {}),
    ...(basis.trim() ? { basis: basis.trim() } : {}),
    ...(attestedBy.trim() ? { attested_by: attestedBy.trim() } : {}),
    ...(Number.isInteger(Number(validDays)) ? { valid_for_days: Number(validDays) } : {}),
  });

  const memberOptions = members.map((member) => ({
    value: member.member_id,
    label: member.display_name,
  }));

  return (
    <FormScope
      fields={{
        'attestation.tenant': (value) => setTenant(asText(value)),
        'attestation.provider': (value) => setProvider(asText(value)),
        'attestation.training_use': (value) => {
          const next = asText(value);
          if (next === 'none' || next === 'used' || next === 'unknown') setTrainingUse(next);
        },
        'attestation.plan': (value) => setPlan(asText(value)),
        'attestation.basis': (value) => setBasis(asText(value)),
        'attestation.attested_by': (value) => setAttestedBy(asText(value)),
        'attestation.valid_days': (value) => setValidDays(asText(value) || '180'),
      }}
    >
      <SettingsGroup id="settings-provider-attestation" title={t('attestation.title')}>
        <div className="settings-row-block">
          <p className="kb-text kb-text--muted">{t('attestation.description')}</p>
        </div>
        <SettingRow label={t('attestation.tenant')} control_id="attestation-tenant">
          <Select
            id="attestation-tenant"
            name="attestation.tenant"
            label={t('attestation.tenant')}
            hide_label
            value={tenant}
            disabled={busy}
            options={(tenants ?? []).map((entry) => ({
              value: entry.tenant_slug,
              label: entry.display_name || entry.tenant_slug,
            }))}
          />
        </SettingRow>
        {overview && (
          <div className="settings-row-block">
            <table className="kb-table">
              <thead>
                <tr>
                  <th>{t('attestation.provider')}</th>
                  <th>{t('attestation.training_use')}</th>
                  <th>{t('attestation.expires')}</th>
                </tr>
              </thead>
              <tbody>
                {overview.providers.map((id) => {
                  const att = overview.attestations[id];
                  return (
                    <tr key={id}>
                      <td>{id}</td>
                      <td>{att?.training_use ?? '—'}</td>
                      <td>{att?.expires_at ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {overview?.pending_requests.map((request) => (
          <SettingRow key={request.request_id} label={`${request.request_id} — ${request.status}`}>
            <Button
              label={busy ? '…' : t('governance.approve_passkey')}
              variant="secondary"
              disabled={busy || request.status !== 'pending'}
              onClick={() =>
                void run(async () => {
                  await decideWithPasskey({
                    requestId: request.request_id,
                    decision: 'approved',
                    channel: request.approval_channel,
                    storageChannel: request.approval_channel,
                    presentedDigest: request.presented_digest,
                  });
                  setMessage(`approved ${request.request_id}`);
                  await load(tenant);
                })
              }
            />
            <Button
              label={busy ? '…' : t('attestation.record')}
              variant="secondary"
              disabled={busy || request.status !== 'approved'}
              onClick={() =>
                void run(async () => {
                  await post({
                    action: 'record',
                    ...attestationInput(),
                    approval_request_id: request.request_id,
                  });
                  setMessage(t('attestation.recorded_msg'));
                  await load(tenant);
                })
              }
            />
          </SettingRow>
        ))}
        <SettingRow label={t('attestation.provider')} control_id="attestation-provider">
          <Select
            id="attestation-provider"
            name="attestation.provider"
            label={t('attestation.provider')}
            hide_label
            value={provider}
            disabled={busy}
            placeholder="—"
            options={(overview?.providers ?? []).map((id) => ({ value: id, label: id }))}
          />
        </SettingRow>
        <SettingRow label={t('attestation.training_use')} control_id="attestation-training">
          <Select
            id="attestation-training"
            name="attestation.training_use"
            label={t('attestation.training_use')}
            hide_label
            value={trainingUse}
            disabled={busy}
            options={[
              { value: 'none', label: 'none' },
              { value: 'used', label: 'used' },
              { value: 'unknown', label: 'unknown' },
            ]}
          />
        </SettingRow>
        <SettingRow label={t('attestation.plan')} control_id="attestation-plan">
          <TextField
            id="attestation-plan"
            name="attestation.plan"
            label={t('attestation.plan')}
            hide_label
            value={plan}
            disabled={busy}
          />
        </SettingRow>
        <SettingRow label={t('attestation.basis')} control_id="attestation-basis">
          <TextField
            id="attestation-basis"
            name="attestation.basis"
            label={t('attestation.basis')}
            hide_label
            value={basis}
            disabled={busy}
          />
        </SettingRow>
        <SettingRow label={t('attestation.attested_by')} control_id="attestation-attested-by">
          {memberOptions.length > 0 ? (
            <Select
              id="attestation-attested-by"
              name="attestation.attested_by"
              label={t('attestation.attested_by')}
              hide_label
              value={attestedBy}
              disabled={busy}
              placeholder="—"
              options={memberOptions}
            />
          ) : (
            <TextField
              id="attestation-attested-by"
              name="attestation.attested_by"
              label={t('attestation.attested_by')}
              hide_label
              value={attestedBy}
              disabled={busy}
            />
          )}
        </SettingRow>
        <SettingRow label={t('attestation.valid_days')} control_id="attestation-valid-days">
          <Segmented
            id="attestation-valid-days"
            name="attestation.valid_days"
            label={t('attestation.valid_days')}
            hide_label
            value={validDays}
            disabled={busy}
            options={VALID_DAY_OPTIONS}
          />
        </SettingRow>
        <div className="settings-row-actions">
          <Button
            label={
              busy
                ? '…'
                : trainingUse === 'none'
                  ? t('attestation.request_approval')
                  : t('attestation.record')
            }
            variant="primary"
            disabled={busy || !tenant || !provider}
            onClick={() =>
              void run(async () => {
                if (trainingUse === 'none') {
                  const result = await post({ action: 'request', ...attestationInput() });
                  setMessage(
                    t('attestation.requested_msg', { id: String(result.request_id ?? '') })
                  );
                } else {
                  await post({ action: 'record', ...attestationInput() });
                  setMessage(t('attestation.recorded_msg'));
                }
                await load(tenant);
              })
            }
          />
        </div>
        {error && (
          <div className="settings-row-block">
            <Callout tone="danger" title={error} />
          </div>
        )}
        {message && (
          <div className="settings-row-block">
            <p role="status" className="kb-text kb-text--body">
              {message}
            </p>
          </div>
        )}
      </SettingsGroup>
    </FormScope>
  );
}
