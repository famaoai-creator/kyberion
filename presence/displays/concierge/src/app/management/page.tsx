'use client';

import * as React from 'react';
import { Button, Callout } from '@agent/shared-ui';
import { useConciergeI18n } from '../../lib/use-concierge-i18n';
import { TENANT_CHANGED_EVENT, tenantFromChangeEvent } from '../../lib/tenant-context';
import { parseSettingsMe } from '../../lib/settings-types';
import { frontDeskFetch } from '../../lib/front-desk-fetch';
import {
  managementDescription,
  ManagementFence,
  ManagementError,
  loadManagement,
  submitManagement,
  scopeQuery,
  missionLink,
  type Scope,
  type ManagementData,
  type Mutation,
  type Operation,
} from './management-client';
import { ManagementOverview } from './ManagementOverview';
import { ManagementEditor } from './ManagementEditor';
import '../settings/settings.css';
import './management.css';

const EMPTY: Scope = { tenant: '', organizationId: '', projectId: '' };
type Notice =
  | 'expired'
  | 'forbidden'
  | 'conflict'
  | 'failed'
  | 'uncertain'
  | 'saved'
  | 'audit_pending'
  | 'changed';
type Draft = { operation: Operation; name: string; description: string };
export default function ManagementPage() {
  const { t } = useConciergeI18n();
  const fence = React.useRef<ManagementFence | null>(null);
  if (!fence.current) fence.current = new ManagementFence();
  const [tenants, setTenants] = React.useState<{ slug: string; name: string }[]>([]);
  const [scope, setScope] = React.useState<Scope>(EMPTY);
  const scopeRef = React.useRef(scope);
  scopeRef.current = scope;
  const [data, setData] = React.useState<ManagementData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [receipt, setReceipt] = React.useState<'saved' | 'audit_pending' | null>(null);
  const [notice, setNotice] = React.useState<Notice | null>(null);
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [pending, setPending] = React.useState<Mutation | null>(null);
  const [auditRetry, setAuditRetry] = React.useState<{ command: Mutation; scope: Scope } | null>(
    null
  );
  const [busy, setBusy] = React.useState(false);
  const [identityChecking, setIdentityChecking] = React.useState(false);
  const identityRead = React.useRef(0);
  const [links, setLinks] = React.useState<unknown>(null);
  const lock = React.useRef(false);
  const expired = React.useRef(false);

  const invalidate = React.useCallback(() => {
    if (expired.current) return;
    expired.current = true;
    fence.current!.reset();
    setReceipt(null);
    setAuditRetry(null);
    setData(null);
    setDraft(null);
    setPending(null);
    setScope(EMPTY);
    setLinks(null);
    setTenants([]);
    setBusy(false);
    setLoading(false);
    setIdentityChecking(false);
    setNotice('changed');
  }, []);

  const load = React.useCallback(
    async (next: Scope, preserveNotice = false) => {
      fence.current!.reset();
      const ticket = fence.current!.begin();
      setLoading(true);
      setIdentityChecking(false);
      setData(null);
      if (!next.tenant) {
        setLoading(false);
        return;
      }
      if (!preserveNotice) setNotice(null);
      try {
        const value = await loadManagement(next, ticket.signal);
        if (!ticket.current()) return;
        const identityMatches = await fence.current!.verifyIdentity(ticket.signal);
        if (!ticket.current()) return;
        if (!identityMatches || !fence.current!.acceptsSnapshot(value)) {
          invalidate();
          return;
        }
        if (!ticket.current()) return;
        setData(value);
        setScope(value.selected);
        scopeRef.current = value.selected;
        window.history?.replaceState(
          window.history.state,
          '',
          '/management?' + scopeQuery(value.selected)
        );
      } catch (error) {
        if (!ticket.current()) return;
        const kind = error instanceof ManagementError ? error.kind : 'failed';
        setNotice(kind);
        if (kind === 'expired' || kind === 'forbidden') {
          invalidate();
          setNotice(kind);
        }
      } finally {
        if (ticket.current()) setLoading(false);
      }
    },
    [invalidate]
  );
  React.useEffect(() => {
    expired.current = false;
    const params = new URLSearchParams(window.location.search);
    const initial = {
      tenant: params.get('tenant') || '',
      organizationId: params.get('organization_id') || params.get('organizationId') || '',
      projectId: params.get('project_id') || params.get('projectId') || '',
    };
    const ticket = fence.current!.begin();
    void frontDeskFetch('/api/me', { signal: ticket.signal })
      .then(async (response) => {
        const identity: unknown = await response.json();
        const me = parseSettingsMe(identity);
        if (!ticket.current()) return;
        if (response.status === 401 || response.status === 403) {
          setNotice(response.status === 401 ? 'expired' : 'forbidden');
          setLoading(false);
          return;
        }
        if (!response.ok || !me || !fence.current!.bindIdentity(identity)) {
          setNotice('failed');
          setLoading(false);
          return;
        }
        const options = me.tenants
          .filter((row) => row.role === 'owner' && row.status === 'active')
          .map((row) => ({ slug: row.tenant_slug, name: row.display_name }));
        setTenants(options);
        if (!options.length) {
          setNotice('forbidden');
          setLoading(false);
          return;
        }
        const tenant = options.some((row) => row.slug === initial.tenant)
          ? initial.tenant
          : options.some((row) => row.slug === me.viewing?.tenant_slug)
            ? me.viewing!.tenant_slug
            : options.length === 1
              ? options[0].slug
              : '';
        const next =
          tenant === initial.tenant ? initial : { tenant, organizationId: '', projectId: '' };
        setScope(next);
        void load(next);
      })
      .catch(() => {
        if (ticket.current()) {
          setNotice('failed');
          setLoading(false);
        }
      });
    const guard = () => {
      if (fence.current!.authChanged()) invalidate();
    };
    const verifyOnFocus = () => {
      guard();
      if (expired.current || !fence.current!.hasIdentity()) return;
      const ticket = fence.current!.begin();
      const identitySequence = ++identityRead.current;
      setIdentityChecking(true);
      void fence
        .current!.verifyIdentity(ticket.signal)
        .then((matches) => {
          if (ticket.current() && identitySequence === identityRead.current && !matches)
            invalidate();
        })
        .catch((error) => {
          if (!ticket.current()) return;
          invalidate();
          setNotice(error instanceof ManagementError ? error.kind : 'failed');
        })
        .finally(() => {
          if (ticket.current() && identitySequence === identityRead.current)
            setIdentityChecking(false);
        });
    };
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) invalidate();
      else verifyOnFocus();
    };
    const scopeChanged = (event: Event) => {
      if (fence.current!.authChanged()) {
        invalidate();
        return;
      }
      const params = new URLSearchParams(window.location.search);
      const tenant = tenantFromChangeEvent(event) || params.get('tenant') || '';
      if (event.type === TENANT_CHANGED_EVENT && tenant === scopeRef.current.tenant) return;
      const next = {
        tenant,
        organizationId:
          event.type === TENANT_CHANGED_EVENT
            ? ''
            : params.get('organization_id') || params.get('organizationId') || '',
        projectId:
          event.type === TENANT_CHANGED_EVENT
            ? ''
            : params.get('project_id') || params.get('projectId') || '',
      };
      setReceipt(null);
      setAuditRetry(null);
      setDraft(null);
      setPending(null);
      setLinks(null);
      setScope(next);
      setBusy(false);
      void load(next);
    };
    window.addEventListener(TENANT_CHANGED_EVENT, scopeChanged);
    window.addEventListener('popstate', scopeChanged);
    window.addEventListener('focus', verifyOnFocus);
    window.addEventListener('storage', guard);
    window.addEventListener('pageshow', restored);
    const timer = window.setInterval(guard, 1000);
    return () => {
      fence.current!.reset();
      window.clearInterval(timer);
      window.removeEventListener(TENANT_CHANGED_EVENT, scopeChanged);
      window.removeEventListener('popstate', scopeChanged);
      window.removeEventListener('focus', verifyOnFocus);
      window.removeEventListener('storage', guard);
      window.removeEventListener('pageshow', restored);
    };
  }, [load, invalidate]);
  React.useEffect(() => {
    if (!data) return;
    const ticket = fence.current!.begin();
    void frontDeskFetch('/api/front-desk/links', { signal: ticket.signal })
      .then(async (response) => {
        const value: unknown = await response.json();
        if (response.ok && ticket.current()) setLinks(value);
      })
      .catch(() => {
        if (ticket.current()) setLinks(null);
      });
  }, [data]);

  function changeScope(next: Scope) {
    if (fence.current!.authChanged()) {
      invalidate();
      return;
    }
    setReceipt(null);
    setAuditRetry(null);
    setDraft(null);
    setPending(null);
    setLinks(null);
    setScope(next);
    scopeRef.current = next;
    window.history?.replaceState(window.history.state, '', '/management?' + scopeQuery(next));
    setBusy(false);
    void load(next);
  }
  function start(operation: Operation) {
    if (identityChecking || auditRetry) return;
    if (fence.current!.authChanged()) {
      invalidate();
      return;
    }
    const organization = operation.startsWith('organization');
    const editing = operation.endsWith('update');
    setReceipt(null);
    setPending(null);
    setNotice(null);
    setDraft({
      operation,
      name: editing ? (organization ? data?.organization?.name : data?.project?.name) || '' : '',
      description: editing
        ? (organization ? data?.organization?.purpose : data?.project?.summary) || ''
        : '',
    });
  }
  function review(event: React.FormEvent) {
    event.preventDefault();
    if (
      !draft ||
      !data ||
      busy ||
      identityChecking ||
      !draft.name.trim() ||
      !managementDescription(draft.operation, draft.description, data).valid ||
      fence.current!.authChanged()
    ) {
      if (fence.current!.authChanged()) invalidate();
      return;
    }
    const organization = draft.operation.startsWith('organization');
    const entity = organization ? data.organization : data.project;
    if (draft.operation.endsWith('update') && !entity) return;
    setPending({
      ...scope,
      operation: draft.operation,
      requestId: crypto.randomUUID(),
      contextId: data.contextId,
      name: draft.name.trim(),
      ...managementDescription(draft.operation, draft.description, data).fields,
      ...(draft.operation.endsWith('update') ? { expectedVersion: entity!.version } : {}),
    });
  }
  async function commit(command: Mutation | null = pending, completionOnly = false) {
    if (!command || lock.current || expired.current || identityChecking) return;
    if (fence.current!.authChanged()) {
      invalidate();
      return;
    }
    if (
      completionOnly &&
      (!auditRetry || scopeQuery(auditRetry.scope) !== scopeQuery(scopeRef.current))
    )
      return;
    lock.current = true;
    setBusy(true);
    setNotice(null);
    const ticket = fence.current!.begin();
    try {
      const beforeMatches = await fence.current!.verifyIdentity(ticket.signal);
      if (!ticket.current()) return;
      if (!beforeMatches) {
        invalidate();
        return;
      }
      if (!ticket.current()) return;
      const result = await submitManagement(command, ticket.signal);
      const afterMatches = await fence.current!.verifyIdentity(ticket.signal);
      if (!ticket.current()) return;
      if (!afterMatches) {
        invalidate();
        return;
      }
      if (!ticket.current()) return;
      setPending(null);
      setDraft(null);
      setReceipt(result.auditPending ? 'audit_pending' : 'saved');
      const committedScope: Scope = {
        tenant: command.tenant,
        organizationId: result.organizationId,
        projectId:
          result.projectId ||
          (command.operation === 'organization.create' ? '' : command.projectId),
      };
      setAuditRetry(result.auditPending ? { command, scope: committedScope } : null);
      if (completionOnly) return;
      setScope(committedScope);
      scopeRef.current = committedScope;
      window.history?.replaceState(
        window.history.state,
        '',
        '/management?' + scopeQuery(committedScope)
      );
      await load(committedScope, true);
    } catch (error) {
      if (!ticket.current()) return;
      const kind = error instanceof ManagementError ? error.kind : 'uncertain';
      setNotice(kind);
      if (kind === 'expired' || kind === 'forbidden') {
        invalidate();
        setNotice(kind);
      }
      if (kind === 'conflict') {
        setPending(null);
        setDraft(null);
        setData(null);
      }
    } finally {
      lock.current = false;
      if (!expired.current) setBusy(false);
    }
  }
  const missions = missionLink(links, scope);
  const denied =
    expired.current ||
    notice === 'expired' ||
    notice === 'forbidden' ||
    (data !== null && !data.canManage);
  return (
    <main className="settings-page management-page">
      <header>
        <h1 className="kb-text kb-text--title">{t('management.title')}</h1>
        <p className="kb-text kb-text--muted">{t('management.description')}</p>
      </header>
      <nav className="settings-inline-actions" aria-label={t('management.navigation')}>
        <Button label={t('management.settings')} href={'/settings?' + scopeQuery(scope)} />
        {missions ? <Button label={t('management.missions')} href={missions} /> : null}
      </nav>
      {receipt ? (
        <div role="status" aria-live="polite">
          <Callout
            tone="success"
            title={t(receipt === 'audit_pending' ? 'management.audit_pending' : 'management.saved')}
          />
        </div>
      ) : null}
      {auditRetry ? (
        <Button
          label={t('management.retry_audit')}
          disabled={busy || identityChecking}
          onClick={() => void commit(auditRetry.command, true)}
        />
      ) : null}
      {notice ? (
        <div
          role={['saved', 'audit_pending'].includes(notice) ? 'status' : 'alert'}
          aria-live="polite"
        >
          <Callout
            tone={['saved', 'audit_pending'].includes(notice) ? 'success' : 'warning'}
            title={t(('management.' + notice) as Parameters<typeof t>[0])}
          />
        </div>
      ) : null}
      {loading ? <p role="status">{t('management.loading')}</p> : null}
      {denied ? (
        <Callout tone="warning" title={t('management.owner_only')}>
          <Button label={t('management.sign_in')} href="/login?next=%2Fmanagement" />
        </Callout>
      ) : null}
      {!loading && !data && !denied && !!scope.tenant ? (
        <Button label={t('management.refresh')} onClick={() => void load(scope)} />
      ) : null}
      <ManagementOverview
        scope={scope}
        data={data}
        busy={busy || identityChecking}
        writeBlocked={auditRetry !== null}
        expired={expired.current}
        denied={denied}
        tenants={tenants}
        missions={missions}
        changeScope={changeScope}
        start={start}
      />
      {draft && data && !denied ? (
        <ManagementEditor
          verifying={identityChecking}
          draft={draft}
          data={data}
          pending={pending}
          busy={busy}
          notice={notice}
          scope={scope}
          setDraft={setDraft}
          review={review}
          commit={commit}
          cancel={() => {
            setPending(null);
            setDraft(null);
            setNotice(null);
          }}
        />
      ) : null}
    </main>
  );
}
