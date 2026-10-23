'use client';

import * as React from 'react';
import { decideWithPasskey } from '../../../lib/passkey-client';
import { frontDeskFetch as fetch } from '../../../lib/front-desk-fetch';
import type { ConciergeLocale } from '../../../lib/i18n';
import type { SettingsTranslate } from './form-scope';
import { Button, SettingsGroup } from '@agent/shared-ui';

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

  return (
    <SettingsGroup title="Provider attestation">
      <div className="settings-row-block">
        <p className="kb-text kb-text--muted">
          Attest how each provider is contracted for this tenant (training_use). 'none' opens
          confidential egress and requires a human approval.
        </p>
        <label>
          Tenant
          <select value={tenant} onChange={(e) => setTenant(e.target.value)} disabled={busy}>
            {(tenants ?? []).map((entry) => (
              <option key={entry.tenant_slug} value={entry.tenant_slug}>
                {entry.display_name || entry.tenant_slug}
              </option>
            ))}
            {tenant && !(tenants ?? []).some((e) => e.tenant_slug === tenant) && (
              <option value={tenant}>{tenant}</option>
            )}
          </select>
        </label>
        {overview && (
          <table className="kb-table">
            <thead>
              <tr>
                <th>provider</th>
                <th>training_use</th>
                <th>expires</th>
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
        )}
        {overview?.pending_requests.map((request) => (
          <div key={request.request_id} className="settings-row-block">
            <p className="kb-text">
              {request.request_id} — {request.status}
            </p>
            <Button
              label={busy ? '…' : 'Approve with passkey'}
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
              label={busy ? '…' : 'Record attestation'}
              disabled={busy || request.status !== 'approved'}
              onClick={() =>
                void run(async () => {
                  await post({
                    action: 'record',
                    ...attestationInput(),
                    approval_request_id: request.request_id,
                  });
                  setMessage('attestation recorded');
                  await load(tenant);
                })
              }
            />
          </div>
        ))}
        <fieldset disabled={busy}>
          <label>
            Provider
            <select value={provider} onChange={(e) => setProvider(e.target.value)}>
              <option value="">—</option>
              {(overview?.providers ?? []).map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>
          <label>
            training_use
            <select
              value={trainingUse}
              onChange={(e) => setTrainingUse(e.target.value as 'none' | 'used' | 'unknown')}
            >
              <option value="none">none</option>
              <option value="used">used</option>
              <option value="unknown">unknown</option>
            </select>
          </label>
          <label>
            plan
            <input value={plan} onChange={(e) => setPlan(e.target.value)} />
          </label>
          <label>
            basis
            <input value={basis} onChange={(e) => setBasis(e.target.value)} />
          </label>
          <label>
            attested_by
            <input value={attestedBy} onChange={(e) => setAttestedBy(e.target.value)} />
          </label>
          <label>
            valid_for_days
            <input value={validDays} onChange={(e) => setValidDays(e.target.value)} />
          </label>
        </fieldset>
        <Button
          label={busy ? '…' : trainingUse === 'none' ? 'Request approval' : 'Record attestation'}
          disabled={busy || !tenant || !provider}
          onClick={() =>
            void run(async () => {
              if (trainingUse === 'none') {
                const result = await post({ action: 'request', ...attestationInput() });
                setMessage(`approval request ${String(result.request_id ?? '')} created`);
              } else {
                await post({ action: 'record', ...attestationInput() });
                setMessage('attestation recorded');
              }
              await load(tenant);
            })
          }
        />
        {error && <p role="alert">{error}</p>}
        {message && <p aria-live="polite">{message}</p>}
      </div>
    </SettingsGroup>
  );
}
