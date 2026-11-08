'use client';

import * as React from 'react';
import { decideWithPasskey } from '../../../lib/passkey-client';
import { frontDeskFetch as fetch } from '../../../lib/front-desk-fetch';
import { conciergeText, type ConciergeLocale, type ConciergeMessageKey } from '../../../lib/i18n';
import { InstallationAccessNotice } from './InstallationAccessNotice';
import { isInstallationAccessCode } from '../../../lib/installation-access-client';
import { FormScope, asText } from './form-scope';
import {
  Button,
  Callout,
  Checkbox,
  Segmented,
  Select,
  SettingRow,
  TextField,
} from '@agent/shared-ui';

type Grant =
  | { operation_id: 'vcs:pr_create'; repository: string; visibility?: 'private' }
  | {
      operation_id: 'vcs:pr_merge' | 'vcs:push';
      repository: string;
      branch: string;
      visibility?: 'private';
    }
  | { operation_id: 'browser:goto' | 'browser:open_tab'; origin: string };
type Pending = {
  request_id: string;
  status: string;
  can_apply?: boolean;
  approval_url?: string;
  statement?: string;
  presented_digest?: string;
  approval_channel?: string;
  min_assurance?: string;
};
type Overview = {
  accountable: { id: string; display_name: string };
  charter: null | {
    id: string;
    expires_at: string;
    grants: Grant[];
    delegated_decisions: Record<string, string>;
    stopped: boolean;
    data_tier?: { read: string[]; write: string[] };
  };
  delegable_decisions: { decision_type: string; label: Record<string, string> }[];
  pending_requests: Pending[];
  runtime: { ready: boolean; agent_id?: string; reason?: string };
  renewal_required: boolean;
  renewal: null | {
    id: string;
    envelope: Record<string, unknown>;
    appetite: Record<string, unknown>;
  };
};
type Preview = { statement: string; digest: string; base_hash: string; fingerprint: string };
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const validDataTiers = (value: unknown): value is { read: string[]; write: string[] } =>
  record(value) &&
  ['read', 'write'].every(
    (key) =>
      Array.isArray(value[key]) && value[key].every((token: unknown) => typeof token === 'string')
  );
const validGrant = (value: unknown): value is Grant =>
  record(value) &&
  (value.visibility === undefined || value.visibility === 'private') &&
  (value.operation_id === 'vcs:pr_create'
    ? typeof value.repository === 'string'
    : ['vcs:pr_merge', 'vcs:push'].includes(String(value.operation_id))
      ? typeof value.repository === 'string' && typeof value.branch === 'string'
      : ['browser:goto', 'browser:open_tab'].includes(String(value.operation_id)) &&
        typeof value.origin === 'string');
function readOverview(value: unknown): Overview | null {
  if (
    !record(value) ||
    value.ok !== true ||
    !record(value.accountable) ||
    typeof value.accountable.id !== 'string' ||
    typeof value.accountable.display_name !== 'string' ||
    !record(value.runtime) ||
    typeof value.runtime.ready !== 'boolean' ||
    (value.runtime.agent_id !== undefined && typeof value.runtime.agent_id !== 'string') ||
    (value.runtime.reason !== undefined && typeof value.runtime.reason !== 'string') ||
    typeof value.renewal_required !== 'boolean' ||
    (value.renewal !== null &&
      (!record(value.renewal) ||
        typeof value.renewal.id !== 'string' ||
        !record(value.renewal.envelope) ||
        !record(value.renewal.appetite))) ||
    (value.renewal_required && value.renewal === null) ||
    !Array.isArray(value.pending_requests) ||
    !value.pending_requests.every(
      (item) =>
        record(item) &&
        typeof item.request_id === 'string' &&
        typeof item.status === 'string' &&
        (item.approval_url === undefined || typeof item.approval_url === 'string') &&
        (item.can_apply === undefined || typeof item.can_apply === 'boolean') &&
        ['statement', 'presented_digest', 'approval_channel', 'min_assurance'].every(
          (key) => item[key] === undefined || typeof item[key] === 'string'
        )
    )
  )
    return null;
  if (
    value.charter !== null &&
    (!record(value.charter) ||
      typeof value.charter.id !== 'string' ||
      typeof value.charter.expires_at !== 'string' ||
      typeof value.charter.stopped !== 'boolean' ||
      !Array.isArray(value.charter.grants) ||
      !value.charter.grants.every(validGrant) ||
      !record(value.charter.delegated_decisions) ||
      (value.charter.data_tier !== undefined && !validDataTiers(value.charter.data_tier)))
  )
    return null;
  return value as unknown as Overview;
}
/** Approval URLs are same-origin server-owned queue links, never arbitrary navigation. */
function approvalHref(value?: string): string | undefined {
  if (!value || !value.startsWith('/') || value.startsWith('//') || /[\\\x00-\x20]/.test(value))
    return undefined;
  const url = new URL(value, 'https://concierge.invalid');
  return url.origin === 'https://concierge.invalid'
    ? url.pathname + url.search + url.hash
    : undefined;
}

export function OnboardingAuthorityPanel({
  locale,
  tenants,
  selectedTenant,
}: {
  locale: ConciergeLocale;
  tenants: { tenant_slug: string; display_name: string }[];
  selectedTenant?: string;
}) {
  const t = (key: ConciergeMessageKey) => conciergeText(key, locale);
  const [kind, setKind] = React.useState<'person' | 'organization'>('person');
  const [tenant, setTenant] = React.useState(selectedTenant || '');
  const [operation, setOperation] = React.useState('');
  const [target, setTarget] = React.useState('');
  const [branch, setBranch] = React.useState('');
  const [mergeBase, setMergeBase] = React.useState('');
  const [privateRepository, setPrivateRepository] = React.useState(false);
  const [editTiers, setEditTiers] = React.useState(false);
  const [readTiers, setReadTiers] = React.useState<string[]>([]);
  const [writeTiers, setWriteTiers] = React.useState<string[]>([]);
  const [decisions, setDecisions] = React.useState<Record<string, string>>({});
  const [expires, setExpires] = React.useState('');
  const [expiryChoice, setExpiryChoice] = React.useState('');
  const [mode, setMode] = React.useState<'grant' | 'revoke'>('grant');
  const [renewExisting, setRenewExisting] = React.useState(false);
  const [overview, setOverview] = React.useState<Overview | null>(null);
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [requests, setRequests] = React.useState<Pending[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [reload, setReload] = React.useState(0);
  const [loadedScope, setLoadedScope] = React.useState('');
  const scope = { scope_kind: kind, ...(kind === 'organization' ? { tenant_slug: tenant } : {}) };
  const scopeKey = JSON.stringify(scope);
  const active = React.useRef(scopeKey);
  active.current = scopeKey;
  const inFlight = React.useRef(false);
  const grants: Grant[] =
    operation === 'vcs:development'
      ? [
          {
            operation_id: 'vcs:pr_create',
            repository: target,
            ...(privateRepository ? { visibility: 'private' as const } : {}),
          },
          {
            operation_id: 'vcs:push',
            repository: target,
            branch,
            ...(privateRepository ? { visibility: 'private' as const } : {}),
          },
          {
            operation_id: 'vcs:pr_merge',
            repository: target,
            branch: mergeBase,
            ...(privateRepository ? { visibility: 'private' as const } : {}),
          },
        ]
      : operation === 'vcs:pr_create'
        ? [
            {
              operation_id: operation,
              repository: target,
              ...(privateRepository ? { visibility: 'private' as const } : {}),
            },
          ]
        : operation === 'vcs:pr_merge' || operation === 'vcs:push'
          ? [
              {
                operation_id: operation,
                repository: target,
                branch,
                ...(privateRepository ? { visibility: 'private' as const } : {}),
              },
            ]
          : operation === 'browser:goto' || operation === 'browser:open_tab'
            ? [{ operation_id: operation, origin: target }]
            : [];
  const expiry =
    expires && Number.isFinite(Date.parse(expires)) ? new Date(expires).toISOString() : '';
  const chosenDecisions = Object.fromEntries(
    Object.entries(decisions)
      .filter(([, policy]) => policy)
      .map(([type, policy]) => [type, policy === '__revoke__' ? 'forbid' : policy])
  );
  const draft = {
    ...scope,
    grants,
    ...(Object.keys(chosenDecisions).length ? { delegated_decisions: chosenDecisions } : {}),
    expires_at: expiry,
    mode,
    ...(renewExisting ? { renew_existing: true } : {}),
    ...(editTiers ? { data_tier: { read: readTiers, write: writeTiers } } : {}),
  };
  const fingerprint = JSON.stringify(draft);
  const currentDraft = React.useRef(fingerprint);
  currentDraft.current = fingerprint;
  const ready = loadedScope === scopeKey && !!overview && (kind === 'person' || !!tenant);
  React.useEffect(() => {
    setPreview(null);
  }, [fingerprint]);
  React.useEffect(() => {
    if (kind === 'organization') setTenant(selectedTenant || '');
  }, [kind, selectedTenant]);
  React.useEffect(() => {
    let cancelled = false;
    setOverview(null);
    setPreview(null);
    setRequests([]);
    setLoadedScope('');
    setError(null);
    setOperation('');
    setTarget('');
    setBranch('');
    setMergeBase('');
    setPrivateRepository(false);
    setEditTiers(false);
    setReadTiers([]);
    setWriteTiers([]);
    setExpires('');
    setMode('grant');
    setRenewExisting(false);
    if (kind === 'organization' && !tenant) return;
    const query = new URLSearchParams(scope);
    void fetch('/api/onboarding-authority?' + query, { cache: 'no-store' })
      .then(async (response) => {
        const value = await response.json().catch(() => null);
        const parsed = readOverview(value);
        if (!response.ok || !parsed)
          throw new Error(
            record(value) && typeof value.error === 'string'
              ? value.error
              : t('authority.unavailable')
          );
        if (!cancelled && active.current === scopeKey) {
          setOverview(parsed);
          setRequests(parsed.pending_requests);
          setLoadedScope(scopeKey);
        }
      })
      .catch((reason) => {
        if (!cancelled && active.current === scopeKey)
          setError(reason instanceof Error ? reason.message : t('authority.unavailable'));
      });
    return () => {
      cancelled = true;
    };
  }, [scopeKey, reload, locale]);
  async function command(action: 'preview' | 'request' | 'status' | 'apply', requestId?: string) {
    if (
      !ready ||
      inFlight.current ||
      (action === 'request' && (!preview || preview.fingerprint !== fingerprint))
    )
      return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const submittedScope = scopeKey;
    const submittedDraft = fingerprint;
    try {
      const body =
        action === 'preview' || action === 'request'
          ? {
              ...draft,
              action,
              ...(action === 'request'
                ? { digest: preview!.digest, base_hash: preview!.base_hash }
                : {}),
            }
          : { ...scope, action, request_id: requestId };
      const response = await fetch('/api/onboarding-authority', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const value: unknown = await response.json().catch(() => null);
      if (!response.ok || !record(value) || value.ok !== true)
        throw new Error(
          record(value) && typeof value.error === 'string'
            ? value.error
            : t('authority.unconfirmed')
        );
      if (active.current !== submittedScope) return;
      if (action === 'preview') {
        if (
          typeof value.statement !== 'string' ||
          typeof value.digest !== 'string' ||
          typeof value.base_hash !== 'string'
        )
          throw new Error(t('authority.unconfirmed'));
        if (currentDraft.current === submittedDraft)
          setPreview({
            statement: value.statement,
            digest: value.digest,
            base_hash: value.base_hash,
            fingerprint: submittedDraft,
          });
      } else if (action === 'request') {
        if (typeof value.request_id !== 'string' || value.status !== 'pending')
          throw new Error(t('authority.unconfirmed'));
        setRequests((previous) => [
          ...previous.filter((item) => item.request_id !== value.request_id),
          {
            request_id: value.request_id as string,
            status: 'pending',
            approval_url: typeof value.approval_url === 'string' ? value.approval_url : undefined,
          },
        ]);
        setPreview(null);
      } else if (action === 'status') {
        if (typeof value.status !== 'string' || typeof value.can_apply !== 'boolean')
          throw new Error(t('authority.unconfirmed'));
        setRequests((previous) =>
          previous.map((item) =>
            item.request_id === requestId
              ? {
                  ...item,
                  status: value.status as string,
                  can_apply: value.can_apply as boolean,
                  statement: typeof value.statement === 'string' ? value.statement : undefined,
                  presented_digest:
                    typeof value.presented_digest === 'string' ? value.presented_digest : undefined,
                  approval_channel:
                    typeof value.approval_channel === 'string' ? value.approval_channel : undefined,
                  min_assurance:
                    typeof value.min_assurance === 'string' ? value.min_assurance : undefined,
                }
              : item
          )
        );
        if (typeof value.error === 'string') setError(value.error);
      } else {
        setPreview(null);
        setReload((value) => value + 1);
      }
    } catch (reason) {
      if (active.current === submittedScope) {
        setError(reason instanceof Error ? reason.message : t('authority.unconfirmed'));
        setPreview(null);
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function decide(request: Pending, decision: 'approved' | 'rejected') {
    if (
      !ready ||
      inFlight.current ||
      request.status !== 'pending' ||
      !request.statement ||
      !request.presented_digest ||
      request.approval_channel !== 'onboarding-authority'
    )
      return;
    const reviewedScope = scopeKey;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const binding = {
        requestId: request.request_id,
        decision,
        channel: request.approval_channel,
        storageChannel: request.approval_channel,
        presentedDigest: request.presented_digest,
      };
      if (request.min_assurance === 'A2') {
        const { requestId, ...body } = binding;
        const response = await fetch(`/api/approvals/${encodeURIComponent(requestId)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const value: unknown = await response.json().catch(() => null);
        if (!response.ok || !record(value) || value.ok !== true)
          throw new Error(
            record(value) && typeof value.error === 'string'
              ? value.error
              : t('authority.unconfirmed')
          );
      } else await decideWithPasskey(binding);
      if (active.current === reviewedScope)
        setRequests((previous) =>
          previous.map((item) =>
            item.request_id === request.request_id
              ? { ...item, status: decision, can_apply: false }
              : item
          )
        );
    } catch (reason) {
      if (active.current === reviewedScope)
        setError(reason instanceof Error ? reason.message : t('authority.unconfirmed'));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  function revokeDecision(type: string) {
    setMode('revoke');
    setOperation('');
    setTarget('');
    setBranch('');
    setPrivateRepository(false);
    setEditTiers(false);
    setDecisions({ [type]: '__revoke__' });
    const timestamp = Date.parse(overview?.charter?.expires_at || '');
    const date = new Date(timestamp);
    setExpires(
      Number.isFinite(timestamp)
        ? new Date(timestamp - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
        : ''
    );
    setExpiryChoice('custom');
    setPreview(null);
  }
  function revoke(grant: Grant) {
    setMode('revoke');
    setDecisions({});
    setOperation(grant.operation_id);
    setTarget('repository' in grant ? grant.repository : grant.origin);
    setBranch('branch' in grant ? grant.branch : '');
    setPrivateRepository('visibility' in grant && grant.visibility === 'private');
    setEditTiers(false);
    const timestamp = Date.parse(overview?.charter?.expires_at || '');
    const date = new Date(timestamp);
    setExpires(
      Number.isFinite(timestamp)
        ? new Date(timestamp - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
        : ''
    );
    setExpiryChoice('custom');
    setPreview(null);
  }
  const toggleTier = (access: 'read' | 'write', token: string, checked: boolean) => {
    const update = access === 'read' ? setReadTiers : setWriteTiers;
    update((previous) =>
      checked ? [...new Set([...previous, token])] : previous.filter((value) => value !== token)
    );
  };
  const tierTokens = ['public', kind === 'person' ? 'personal' : `confidential:${tenant}`];
  const tierFields = Object.fromEntries(
    (['read', 'write'] as const).flatMap((access) =>
      tierTokens.map((token) => [
        `authority.tier.${access}.${token}`,
        (value: unknown) => toggleTier(access, token, value === true),
      ])
    )
  );
  const applyExpiryChoice = (choice: string) => {
    setExpiryChoice(choice);
    if (choice === 'custom' || !choice) return;
    const days = Number(choice);
    if (!Number.isFinite(days)) return;
    const derived = new Date(Date.now() + days * 86_400_000);
    setExpires(
      new Date(derived.getTime() - derived.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
    );
  };
  return (
    <FormScope
      fields={{
        'authority.scope': (value) =>
          setKind(asText(value) === 'organization' ? 'organization' : 'person'),
        'authority.tenant': (value) => setTenant(asText(value)),
        'authority.operation': (value) => {
          const next = asText(value);
          setOperation(next);
          setMode('grant');
          if (next === 'vcs:development') {
            setBranch('agent/kyberion-development');
            setMergeBase('main');
          }
        },
        'authority.private_repo': (value) => setPrivateRepository(value === true),
        'authority.target': (value) => setTarget(asText(value)),
        'authority.branch': (value) => setBranch(asText(value)),
        'authority.merge_base': (value) => setMergeBase(asText(value)),
        'authority.tier_edit': (value) => {
          const checked = value === true;
          setEditTiers(checked);
          if (checked) {
            setReadTiers(overview?.charter?.data_tier?.read ?? ['public']);
            setWriteTiers(overview?.charter?.data_tier?.write ?? []);
          }
        },
        'authority.renew': (value) => setRenewExisting(value === true),
        'authority.expiry_choice': (value) => applyExpiryChoice(asText(value)),
        'authority.expiry_custom': (value) => setExpires(asText(value)),
        ...tierFields,
      }}
    >
      <section className="settings-row-block" aria-label={t('authority.title')} aria-busy={busy}>
        <h3>{t('authority.title')}</h3>
        <p className="kb-text kb-text--muted">{t('authority.separate')}</p>
        <p className="kb-text kb-text--muted">{t('authority.bounds')}</p>
        <p className="kb-text kb-text--muted">{t('authority.proposal_explanation')}</p>
        <SettingRow label={t('authority.scope')}>
          <Segmented
            id="authority-scope"
            name="authority.scope"
            label={t('authority.scope')}
            hide_label
            value={kind}
            disabled={busy}
            options={[
              { value: 'person', label: t('authority.person') },
              { value: 'organization', label: t('authority.organization') },
            ]}
          />
        </SettingRow>
        {kind === 'organization' ? (
          <SettingRow label={t('authority.tenant')} control_id="authority-tenant">
            <Select
              id="authority-tenant"
              name="authority.tenant"
              label={t('authority.tenant')}
              hide_label
              value={tenant}
              disabled={busy}
              placeholder={t('authority.choose')}
              options={tenants.map((item) => ({
                value: item.tenant_slug,
                label: item.display_name,
              }))}
            />
          </SettingRow>
        ) : null}
        <div className="settings-row-actions">
          <Button
            label={t('authority.refresh')}
            variant="secondary"
            disabled={busy}
            onClick={() => setReload((value) => value + 1)}
          />
        </div>
        {busy ? (
          <p role="status" className="kb-text kb-text--muted">
            {t('authority.pending')}
          </p>
        ) : null}
        {error && isInstallationAccessCode(error) ? (
          <InstallationAccessNotice code={error} t={t} onConfirmed={() => setError(null)} />
        ) : error ? (
          <Callout tone="danger" title={error} />
        ) : null}
        {!overview && !error && (kind === 'person' || tenant) ? (
          <p role="status" className="kb-text kb-text--muted">
            {t('authority.loading')}
          </p>
        ) : null}
        {ready ? (
          <>
            <p className="kb-text kb-text--body">
              {t('authority.accountable')}: {overview.accountable.display_name}
            </p>
            <p role="status" className="kb-text kb-text--body">
              {overview.runtime.ready
                ? t('authority.runtime_ready')
                : t('authority.runtime_unavailable')}{' '}
              {[
                overview.runtime.agent_id,
                !overview.runtime.ready ? overview.runtime.reason : undefined,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
            {overview.charter ? (
              <>
                <p className="kb-text kb-text--body">
                  {overview.charter.stopped ? t('authority.stopped') : t('authority.current')} ·{' '}
                  {overview.charter.expires_at}
                </p>
                <ul className="settings-plain-list">
                  {overview.charter.grants.map((grant, index) => (
                    <li key={index}>
                      {grant.operation_id} ·{' '}
                      {'repository' in grant ? grant.repository : grant.origin}
                      {'branch' in grant ? ` · ${grant.branch}` : ''}{' '}
                      {'visibility' in grant && grant.visibility === 'private'
                        ? t('authority.private_repository')
                        : null}{' '}
                      <Button
                        label={t('authority.revoke')}
                        variant="ghost"
                        disabled={busy}
                        onClick={() => revoke(grant)}
                      />
                    </li>
                  ))}
                  {Object.entries(overview.charter.delegated_decisions ?? {}).map(
                    ([type, policy]) => (
                      <li key={type}>
                        {type} · {policy}{' '}
                        <Button
                          label={t('authority.revoke')}
                          variant="ghost"
                          disabled={busy}
                          onClick={() => revokeDecision(type)}
                        />
                      </li>
                    )
                  )}
                </ul>
                {overview.charter.data_tier ? (
                  <p className="kb-text kb-text--muted">
                    {t('authority.tier_read')}:{' '}
                    {overview.charter.data_tier.read.join(', ') || t('authority.tier_none')} ·{' '}
                    {t('authority.tier_write')}:{' '}
                    {overview.charter.data_tier.write.join(', ') || t('authority.tier_none')}
                  </p>
                ) : null}
              </>
            ) : (
              <p className="kb-text kb-text--muted">{t('authority.none')}</p>
            )}
            <h4 className="kb-text kb-text--body">
              {mode === 'revoke' ? t('authority.revoke') : t('authority.new')}
            </h4>
            {overview.renewal_required && overview.renewal ? (
              <div className="settings-row-block">
                <p className="kb-text kb-text--body">
                  {t('authority.renewal_limits')}: {overview.renewal.id}
                </p>
                <pre className="kb-code">
                  {JSON.stringify(
                    { envelope: overview.renewal.envelope, appetite: overview.renewal.appetite },
                    null,
                    2
                  )}
                </pre>
                <Checkbox
                  id="authority-renew"
                  name="authority.renew"
                  label={t('authority.renew_existing')}
                  value={renewExisting}
                  disabled={busy}
                />
              </div>
            ) : null}
            <div className="settings-row-actions">
              <Button
                label={t('authority.new')}
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setMode('grant');
                  setDecisions({});
                  setOperation('');
                  setTarget('');
                  setBranch('');
                  setMergeBase('');
                  setPrivateRepository(false);
                  setEditTiers(false);
                  setExpires('');
                  setExpiryChoice('');
                }}
              />
            </div>
            <SettingRow label={t('authority.operation')} control_id="authority-operation">
              <Select
                id="authority-operation"
                name="authority.operation"
                label={t('authority.operation')}
                hide_label
                value={operation}
                disabled={busy}
                placeholder={t('authority.choose')}
                options={[
                  { value: 'vcs:development', label: t('authority.development') },
                  { value: 'vcs:pr_create', label: t('authority.pr') },
                  { value: 'vcs:pr_merge', label: t('authority.merge') },
                  { value: 'vcs:push', label: t('authority.push') },
                  { value: 'browser:goto', label: t('authority.goto') },
                  { value: 'browser:open_tab', label: t('authority.tab') },
                ]}
              />
            </SettingRow>
            {operation.startsWith('vcs:') ? (
              <Checkbox
                id="authority-private-repo"
                name="authority.private_repo"
                label={t('authority.private_repository')}
                value={privateRepository}
                disabled={busy}
              />
            ) : null}
            <SettingRow label={t('authority.target')} control_id="authority-target">
              <TextField
                id="authority-target"
                name="authority.target"
                label={t('authority.target')}
                hide_label
                type="url"
                value={target}
                disabled={busy}
                placeholder="https://github.com/owner/repository"
              />
            </SettingRow>
            {operation === 'vcs:development' ? (
              <p className="kb-text kb-text--muted">{t('authority.development_bounds')}</p>
            ) : null}
            {operation === 'vcs:pr_merge' ||
            operation === 'vcs:push' ||
            operation === 'vcs:development' ? (
              <SettingRow
                label={t(
                  operation === 'vcs:development'
                    ? 'authority.candidate_branch'
                    : 'authority.branch'
                )}
                control_id="authority-branch"
              >
                <TextField
                  id="authority-branch"
                  name="authority.branch"
                  label={t('authority.branch')}
                  hide_label
                  value={branch}
                  readonly={operation === 'vcs:development'}
                  disabled={busy}
                  placeholder="main"
                />
              </SettingRow>
            ) : null}
            {operation === 'vcs:development' ? (
              <SettingRow label={t('authority.merge_base')} control_id="authority-merge-base">
                <TextField
                  id="authority-merge-base"
                  name="authority.merge_base"
                  label={t('authority.merge_base')}
                  hide_label
                  value={mergeBase}
                  readonly
                  disabled={busy}
                />
              </SettingRow>
            ) : null}
            <Checkbox
              id="authority-tier-edit"
              name="authority.tier_edit"
              label={t('authority.tier_edit')}
              value={editTiers}
              disabled={busy}
            />
            {editTiers ? (
              <div className="settings-row-block">
                <p className="kb-text kb-text--body">{t('authority.tier_scope')}</p>
                <p className="kb-text kb-text--muted">{t('authority.tier_bounds')}</p>
                {(['read', 'write'] as const).map((access) => (
                  <div key={access} className="settings-row-block">
                    <p className="kb-text kb-text--body">
                      {t(access === 'read' ? 'authority.tier_read' : 'authority.tier_write')}
                    </p>
                    {[
                      { token: 'public', label: t('authority.tier_public') },
                      {
                        token: kind === 'person' ? 'personal' : `confidential:${tenant}`,
                        label: t(
                          kind === 'person'
                            ? 'authority.tier_personal'
                            : 'authority.tier_confidential'
                        ),
                      },
                    ].map((choice) => {
                      const values = access === 'read' ? readTiers : writeTiers;
                      return (
                        <Checkbox
                          key={choice.token}
                          id={`authority-tier-${access}-${choice.token === 'public' ? 'public' : 'scoped'}`}
                          name={`authority.tier.${access}.${choice.token}`}
                          label={choice.label}
                          value={values.includes(choice.token)}
                          disabled={busy}
                        />
                      );
                    })}
                  </div>
                ))}
              </div>
            ) : null}
            {(overview.delegable_decisions ?? []).length ? (
              <div className="settings-row-block">
                <p className="kb-text kb-text--body">{t('authority.decisions')}</p>
                <p className="kb-text kb-text--muted">{t('authority.decisions_hint')}</p>
                {overview.delegable_decisions.map((entry) => {
                  const current =
                    overview.charter?.delegated_decisions?.[entry.decision_type] ?? '';
                  const value = decisions[entry.decision_type] ?? '';
                  const rowLabel = entry.label?.[locale] ?? entry.label?.en ?? entry.decision_type;
                  return (
                    <SettingRow
                      key={entry.decision_type}
                      label={`${rowLabel}${current ? ` (${current})` : ''}`}
                    >
                      <FormScope
                        fields={{
                          [`authority.decision.${entry.decision_type}`]: (val) =>
                            setDecisions((previous) => ({
                              ...previous,
                              [entry.decision_type]: asText(val),
                            })),
                        }}
                      >
                        <Select
                          id={`authority-decision-${entry.decision_type}`}
                          name={`authority.decision.${entry.decision_type}`}
                          label={rowLabel}
                          hide_label
                          value={value}
                          disabled={busy}
                          options={[
                            {
                              value: '',
                              label:
                                mode === 'revoke'
                                  ? t('authority.decision_keep')
                                  : t('authority.decision_unchanged'),
                            },
                            ...(mode === 'revoke'
                              ? [{ value: '__revoke__', label: t('authority.decision_revoke') }]
                              : [
                                  {
                                    value: 'allow_with_review',
                                    label: t('authority.policy_allow_with_review'),
                                  },
                                  { value: 'allow', label: t('authority.policy_allow') },
                                  { value: 'forbid', label: t('authority.policy_forbid') },
                                ]),
                          ]}
                        />
                      </FormScope>
                    </SettingRow>
                  );
                })}
              </div>
            ) : null}
            <SettingRow label={t('authority.expiry')}>
              <Segmented
                id="authority-expiry-choice"
                name="authority.expiry_choice"
                label={t('authority.expiry')}
                hide_label
                value={expiryChoice}
                disabled={busy}
                options={[
                  { value: '7', label: '7d' },
                  { value: '30', label: '30d' },
                  { value: '90', label: '90d' },
                  { value: 'custom', label: t('authority.expiry_custom') },
                ]}
              />
            </SettingRow>
            {expiryChoice === 'custom' ? (
              <SettingRow label={t('authority.expiry')} control_id="authority-expiry-custom">
                <TextField
                  id="authority-expiry-custom"
                  name="authority.expiry_custom"
                  label={t('authority.expiry')}
                  hide_label
                  value={expires}
                  disabled={busy}
                  placeholder="2027-01-31T23:59"
                />
              </SettingRow>
            ) : null}
            <div className="settings-row-actions">
              <Button
                label={t('authority.preview')}
                variant="primary"
                disabled={
                  busy ||
                  (!grants.length && !Object.keys(chosenDecisions).length && !editTiers) ||
                  (grants.length && !target) ||
                  (['vcs:push', 'vcs:pr_merge', 'vcs:development'].includes(operation) &&
                    !branch) ||
                  (operation === 'vcs:development' && (!mergeBase || mergeBase === branch)) ||
                  !expiry ||
                  Date.parse(expiry) <= Date.now() ||
                  (overview.renewal_required && !renewExisting)
                }
                onClick={() => void command('preview')}
              />
            </div>
            {preview?.fingerprint === fingerprint ? (
              <div className="settings-row-block">
                <pre className="kb-code">{preview.statement}</pre>
                <div className="settings-row-actions">
                  <Button
                    label={t('authority.request')}
                    variant="primary"
                    disabled={busy}
                    onClick={() => void command('request')}
                  />
                </div>
              </div>
            ) : null}
            {requests.map((request) => (
              <div key={request.request_id} className="settings-row-block">
                <p className="kb-text kb-text--body">
                  {request.request_id} · {request.status}
                </p>
                {approvalHref(request.approval_url) ? (
                  <a href={approvalHref(request.approval_url)}>{t('authority.review')}</a>
                ) : null}
                {request.statement ? <pre className="kb-code">{request.statement}</pre> : null}
                {request.status === 'pending' &&
                request.statement &&
                request.presented_digest &&
                request.approval_channel === 'onboarding-authority' ? (
                  <div className="settings-row-actions">
                    <Button
                      label={t('authority.approve')}
                      variant="primary"
                      disabled={busy}
                      onClick={() => void decide(request, 'approved')}
                    />
                    <Button
                      label={t('authority.reject')}
                      variant="secondary"
                      disabled={busy}
                      onClick={() => void decide(request, 'rejected')}
                    />
                    <a href="#setup-profile">{t('authority.passkey_setup')}</a>
                  </div>
                ) : null}
                <div className="settings-row-actions">
                  <Button
                    label={t('authority.status')}
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void command('status', request.request_id)}
                  />
                  {request.can_apply === true ? (
                    <Button
                      label={t('authority.apply')}
                      variant="primary"
                      disabled={busy}
                      onClick={() => void command('apply', request.request_id)}
                    />
                  ) : null}
                </div>
              </div>
            ))}
          </>
        ) : null}
      </section>
    </FormScope>
  );
}
