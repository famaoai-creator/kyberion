'use client';

import * as React from 'react';
import { decideWithPasskey } from '../../../lib/passkey-client';
import { frontDeskFetch as fetch } from '../../../lib/front-desk-fetch';
import { conciergeText, type ConciergeLocale, type ConciergeMessageKey } from '../../../lib/i18n';

type Grant =
  | { operation_id: 'vcs:pr_create'; repository: string }
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
  charter: null | { id: string; expires_at: string; grants: Grant[]; stopped: boolean };
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
const validGrant = (value: unknown): value is Grant =>
  record(value) &&
  (value.operation_id === 'vcs:pr_create'
    ? typeof value.repository === 'string'
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
      !value.charter.grants.every(validGrant))
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
  const [expires, setExpires] = React.useState('');
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
    operation === 'vcs:pr_create'
      ? [{ operation_id: operation, repository: target }]
      : operation === 'browser:goto' || operation === 'browser:open_tab'
        ? [{ operation_id: operation, origin: target }]
        : [];
  const expiry =
    expires && Number.isFinite(Date.parse(expires)) ? new Date(expires).toISOString() : '';
  const draft = {
    ...scope,
    grants,
    expires_at: expiry,
    mode,
    ...(renewExisting ? { renew_existing: true } : {}),
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
  function revoke(grant: Grant) {
    setMode('revoke');
    setOperation(grant.operation_id);
    setTarget('repository' in grant ? grant.repository : grant.origin);
    const timestamp = Date.parse(overview?.charter?.expires_at || '');
    const date = new Date(timestamp);
    setExpires(
      Number.isFinite(timestamp)
        ? new Date(timestamp - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
        : ''
    );
    setPreview(null);
  }
  return (
    <section className="settings-row-block" aria-label={t('authority.title')} aria-busy={busy}>
      <h3>{t('authority.title')}</h3>
      <p>{t('authority.separate')}</p>
      <p>{t('authority.bounds')}</p>
      <p>{t('authority.proposal_explanation')}</p>
      <label>
        {t('authority.scope')}
        <select
          value={kind}
          disabled={busy}
          onChange={(event) =>
            setKind(event.target.value === 'organization' ? 'organization' : 'person')
          }
        >
          <option value="person">{t('authority.person')}</option>
          <option value="organization">{t('authority.organization')}</option>
        </select>
      </label>
      {kind === 'organization' ? (
        <label>
          {t('authority.tenant')}
          <select
            value={tenant}
            disabled={busy}
            onChange={(event) => setTenant(event.target.value)}
          >
            <option value="">{t('authority.choose')}</option>
            {tenants.map((item) => (
              <option key={item.tenant_slug} value={item.tenant_slug}>
                {item.display_name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <button type="button" disabled={busy} onClick={() => setReload((value) => value + 1)}>
        {t('authority.refresh')}
      </button>
      {busy ? <p role="status">{t('authority.pending')}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {!overview && !error && (kind === 'person' || tenant) ? (
        <p role="status">{t('authority.loading')}</p>
      ) : null}
      {ready ? (
        <>
          <p>
            {t('authority.accountable')}: {overview.accountable.display_name}
          </p>
          <p role="status">
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
              <p>
                {overview.charter.stopped ? t('authority.stopped') : t('authority.current')} ·{' '}
                {overview.charter.expires_at}
              </p>
              <ul>
                {overview.charter.grants.map((grant, index) => (
                  <li key={index}>
                    {grant.operation_id} · {'repository' in grant ? grant.repository : grant.origin}{' '}
                    <button type="button" disabled={busy} onClick={() => revoke(grant)}>
                      {t('authority.revoke')}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p>{t('authority.none')}</p>
          )}
          <fieldset disabled={busy}>
            <legend>{mode === 'revoke' ? t('authority.revoke') : t('authority.new')}</legend>
            {overview.renewal_required && overview.renewal ? (
              <div>
                <p>
                  {t('authority.renewal_limits')}: {overview.renewal.id}
                </p>
                <pre>
                  {JSON.stringify(
                    { envelope: overview.renewal.envelope, appetite: overview.renewal.appetite },
                    null,
                    2
                  )}
                </pre>
                <label>
                  <input
                    type="checkbox"
                    checked={renewExisting}
                    onChange={(event) => setRenewExisting(event.target.checked)}
                  />
                  {t('authority.renew_existing')}
                </label>
              </div>
            ) : null}
            <button
              type="button"
              onClick={() => {
                setMode('grant');
                setOperation('');
                setTarget('');
                setExpires('');
              }}
            >
              {t('authority.new')}
            </button>
            <label>
              {t('authority.operation')}
              <select
                value={operation}
                onChange={(event) => {
                  setOperation(event.target.value);
                  setMode('grant');
                }}
              >
                <option value="">{t('authority.choose')}</option>
                <option value="vcs:pr_create">{t('authority.pr')}</option>
                <option value="browser:goto">{t('authority.goto')}</option>
                <option value="browser:open_tab">{t('authority.tab')}</option>
              </select>
            </label>
            <label>
              {t('authority.target')}
              <input
                type="url"
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                placeholder="https://github.com/owner/repository"
              />
            </label>
            <label>
              {t('authority.expiry')}
              <input
                type="datetime-local"
                value={expires}
                onChange={(event) => setExpires(event.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={
                !grants.length ||
                !target ||
                !expiry ||
                Date.parse(expiry) <= Date.now() ||
                (overview.renewal_required && !renewExisting)
              }
              onClick={() => void command('preview')}
            >
              {t('authority.preview')}
            </button>
          </fieldset>
          {preview?.fingerprint === fingerprint ? (
            <div>
              <pre>{preview.statement}</pre>
              <button type="button" disabled={busy} onClick={() => void command('request')}>
                {t('authority.request')}
              </button>
            </div>
          ) : null}
          {requests.map((request) => (
            <div key={request.request_id}>
              <p>
                {request.request_id} · {request.status}
              </p>
              {approvalHref(request.approval_url) ? (
                <a href={approvalHref(request.approval_url)}>{t('authority.review')}</a>
              ) : null}
              {request.statement ? <pre>{request.statement}</pre> : null}
              {request.status === 'pending' &&
              request.statement &&
              request.presented_digest &&
              request.approval_channel === 'onboarding-authority' ? (
                <div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void decide(request, 'approved')}
                  >
                    {t('authority.approve')}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void decide(request, 'rejected')}
                  >
                    {t('authority.reject')}
                  </button>
                  <a href="#setup-profile">{t('authority.passkey_setup')}</a>
                </div>
              ) : null}
              <button
                type="button"
                disabled={busy}
                onClick={() => void command('status', request.request_id)}
              >
                {t('authority.status')}
              </button>
              {request.can_apply === true ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void command('apply', request.request_id)}
                >
                  {t('authority.apply')}
                </button>
              ) : null}
            </div>
          ))}
        </>
      ) : null}
    </section>
  );
}
