'use client';

import * as React from 'react';
import { AlertTriangle, CheckCircle2, FileCheck2, ShieldAlert, XCircle } from 'lucide-react';
import { useChronosLocale } from '../lib/hooks';
import { formatChronosDateTime, uxText } from '../lib/ux-vocabulary';
import { parseApprovalsResponse, type ClientApproval } from '../lib/approvals-response';

type Approval = ClientApproval;

function approvalRiskLabel(value: string | undefined, locale: string): string {
  const labels: Record<string, string> = {
    low: 'chronos_risk_low',
    medium: 'chronos_risk_medium',
    high: 'chronos_risk_high',
    critical: 'chronos_risk_critical',
  };
  return uxText(labels[value || ''] || 'chronos_unknown', locale);
}

function approvalMutationLabel(value: string | undefined, locale: string): string {
  const labels: Record<string, string> = {
    create: 'chronos_change_create',
    update: 'chronos_change_update',
    delete: 'chronos_change_delete',
    rotate: 'chronos_change_rotate',
  };
  return uxText(labels[value || ''] || 'chronos_change_other', locale);
}

export function ApprovalsWorkspace({ tenant }: { tenant?: string }) {
  const locale = useChronosLocale();
  const [items, setItems] = React.useState<Approval[]>([]);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [accessRole, setAccessRole] = React.useState<'readonly' | 'localadmin'>('readonly');
  const [note, setNote] = React.useState('');
  const selected = items.find((item) => item.id === selectedId) || items[0] || null;

  const refresh = React.useCallback(async () => {
    try {
      const query = new URLSearchParams({ status: 'pending', limit: '50' });
      if (tenant) query.set('tenant', tenant);
      const response = await fetch(`/api/approvals?${query.toString()}`, { cache: 'no-store' });
      const payload = parseApprovalsResponse(await response.json().catch(() => null));
      if (!response.ok || !payload) throw new Error('Invalid approval queue response');
      setAccessRole(payload.accessRole);
      setItems(payload.approvals);
      setSelectedId((current) =>
        payload.approvals.some((item) => item.id === current)
          ? current
          : payload.approvals[0]?.id || null
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [tenant]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const decide = async (decision: 'approved' | 'rejected') => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/intelligence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'approval_decision',
          requestId: selected.id,
          channel: selected.channel,
          storageChannel: selected.storageChannel,
          decision,
          note,
          tenant,
        }),
      });
      if (!response.ok) throw new Error('Failed to record the approval decision');
      setNote('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="kyberion-glass rounded-[30px] border kb-border-subtle p-5 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.28em] kb-text-accent">承認</div>
          <h2 className="mt-1 text-xl font-semibold kb-text-primary">
            {uxText('chronos_approvals_title', locale)}
          </h2>
          <p className="mt-2 text-sm leading-6 kb-text-secondary">
            {uxText('chronos_approvals_description', locale)}
          </p>
        </div>
        <span className="rounded-full border kb-border-accent kb-surface-accent px-3 py-1 text-[10px] kb-text-accent">
          {tenant || uxText('chronos_ac_scope_all', locale)} · {items.length}
        </span>
      </div>
      {error ? (
        <div className="mt-4 rounded-xl border kb-status-negative-border kb-status-negative-surface p-3 text-[11px] kb-status-negative">
          {error}
        </div>
      ) : null}
      <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(15rem,0.8fr)_minmax(0,1.5fr)]">
        <div className="chronos-scroll max-h-[calc(100vh-18rem)] space-y-2 overflow-y-auto pr-1">
          {items.length === 0 ? (
            <div className="rounded-xl border kb-border-subtle p-4 text-[11px] kb-text-muted">
              {uxText('chronos_approvals_empty', locale)}
            </div>
          ) : (
            items.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={selected?.id === item.id}
                onClick={() => setSelectedId(item.id)}
                className={`w-full rounded-xl border p-3 text-left ${selected?.id === item.id ? 'kb-border-accent kb-surface-accent' : 'kb-border-subtle kb-surface-sunken hover:kb-surface-raised'}`}
              >
                <div className="flex items-center gap-2">
                  <ShieldAlert size={13} className="kb-text-accent" />
                  <span className="truncate text-xs font-semibold kb-text-primary">
                    {item.title}
                  </span>
                </div>
                <div className="mt-2 text-[10px] kb-text-secondary">
                  {item.tenantSlug || uxText('chronos_org_not_configured', locale)} /{' '}
                  {item.kind || '承認'}
                </div>
                <div className="mt-1 text-[10px] kb-text-muted">
                  {item.requestedBy} · {formatChronosDateTime(item.requestedAt, locale)}
                </div>
              </button>
            ))
          )}
        </div>
        {selected ? (
          <div className="rounded-2xl border kb-border-subtle kb-surface-sunken p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] kb-text-accent">
                  <FileCheck2 size={13} />
                  承認内容
                </div>
                <h3 className="mt-1 text-lg font-semibold kb-text-primary">{selected.title}</h3>
              </div>
              <span className="rounded-full border kb-border-subtle px-2 py-1 text-[10px] uppercase kb-text-secondary">
                {approvalRiskLabel(selected.risk?.level, locale)} / {uxText('chronos_risk', locale)}
              </span>
            </div>
            <p className="mt-4 whitespace-pre-wrap text-sm leading-6 kb-text-primary">
              {selected.summary}
            </p>
            {selected.details ? (
              <section className="mt-4 rounded-xl border kb-border-subtle kb-surface-raised p-3">
                <h4 className="text-[10px] uppercase tracking-[0.16em] kb-text-accent">詳細</h4>
                <p className="mt-2 whitespace-pre-wrap text-[11px] leading-5 kb-text-secondary">
                  {selected.details}
                </p>
              </section>
            ) : null}
            {selected.sourceText ? (
              <details className="mt-3 rounded-xl border kb-border-subtle kb-surface-raised p-3">
                <summary className="cursor-pointer text-[10px] font-semibold kb-text-primary">
                  {uxText('chronos_request_source', locale)}
                </summary>
                <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap text-[11px] kb-text-secondary">
                  {selected.sourceText}
                </pre>
              </details>
            ) : null}
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <div className="rounded-xl border kb-border-subtle p-3">
                <h4 className="text-[10px] uppercase tracking-[0.16em] kb-text-accent">
                  {uxText('chronos_approval_change_details', locale)}
                </h4>
                <dl className="mt-2 space-y-1 text-[11px] kb-text-secondary">
                  <div>
                    {uxText('chronos_approval_service', locale)}:{' '}
                    {selected.target?.serviceId || '-'}
                  </div>
                  <div>
                    {uxText('chronos_approval_operation', locale)}:{' '}
                    {approvalMutationLabel(selected.target?.mutation, locale)}
                  </div>
                  <div>
                    {uxText('chronos_approval_key', locale)}: {selected.target?.secretKey || '-'}
                  </div>
                  <div>
                    {uxText('chronos_approval_current_value', locale)}:{' '}
                    {selected.target?.existingValuePresent
                      ? uxText('chronos_approval_value_present', locale)
                      : uxText('chronos_approval_value_missing', locale)}
                  </div>
                </dl>
              </div>
              <div className="rounded-xl border kb-border-subtle p-3">
                <h4 className="text-[10px] uppercase tracking-[0.16em] kb-text-accent">注意点</h4>
                <dl className="mt-2 space-y-1 text-[11px] kb-text-secondary">
                  <div>
                    {uxText('chronos_approval_restart', locale)}:{' '}
                    {selected.risk?.restartScope || uxText('chronos_approval_not_needed', locale)}
                  </div>
                  <div>
                    {uxText('chronos_approval_strong_auth', locale)}:{' '}
                    {selected.risk?.requiresStrongAuth
                      ? uxText('chronos_required', locale)
                      : uxText('chronos_not_required', locale)}
                  </div>
                  <div>
                    {uxText('chronos_approval_policy', locale)}:{' '}
                    {selected.risk?.policyId || uxText('chronos_approval_default_policy', locale)}
                  </div>
                </dl>
              </div>
            </div>
            {selected.justification ? (
              <section className="mt-3 rounded-xl border kb-border-subtle p-3">
                <h4 className="text-[10px] uppercase tracking-[0.16em] kb-text-accent">
                  {uxText('chronos_reason_impact', locale)}
                </h4>
                <p className="mt-2 text-[11px] kb-text-secondary">
                  {selected.justification.reason}
                </p>
                {selected.justification.impactSummary ? (
                  <p className="mt-2 text-[11px] kb-text-secondary">
                    影響: {selected.justification.impactSummary}
                  </p>
                ) : null}
                {selected.justification.requestedEffects?.length ? (
                  <ul className="mt-2 list-disc pl-4 text-[11px] kb-text-secondary">
                    {selected.justification.requestedEffects.map((effect) => (
                      <li key={effect}>{effect}</li>
                    ))}
                  </ul>
                ) : null}
              </section>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-2 text-[10px] kb-text-muted">
              <span>
                {uxText('chronos_tenant', locale)}: {selected.tenantSlug || '-'}
              </span>
              <span>
                {uxText('chronos_project', locale)}: {selected.workLoop?.project_id || '-'}
              </span>
              <span>
                {uxText('chronos_mission', locale)}: {selected.missionId || '-'}
              </span>
            </div>
            <textarea
              aria-label="Decision note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder={uxText('chronos_decision_note', locale)}
              className="mt-4 min-h-20 w-full rounded-xl border kb-border-subtle kb-surface-raised p-3 text-xs kb-text-primary outline-none"
            />
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                disabled={busy || accessRole !== 'localadmin'}
                onClick={() => void decide('approved')}
                className="inline-flex items-center gap-1 rounded-lg kb-surface-positive px-3 py-2 text-[11px] kb-status-positive disabled:opacity-50"
              >
                <CheckCircle2 size={14} />
                承認
              </button>
              <button
                type="button"
                disabled={busy || accessRole !== 'localadmin'}
                onClick={() => void decide('rejected')}
                className="inline-flex items-center gap-1 rounded-lg kb-surface-negative px-3 py-2 text-[11px] kb-status-negative disabled:opacity-50"
              >
                <XCircle size={14} />
                却下
              </button>
            </div>
            {accessRole !== 'localadmin' ? (
              <div className="mt-3 text-[10px] kb-text-muted">
                {uxText('chronos_admin_action_hint', locale)}
              </div>
            ) : null}
            {selected.risk?.level === 'critical' ? (
              <div className="mt-3 flex items-center gap-2 text-[10px] kb-status-negative">
                <AlertTriangle size={13} />
                {uxText('chronos_additional_confirmation_hint', locale)}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="rounded-2xl border kb-border-subtle p-6 text-sm kb-text-muted">
            {uxText('chronos_select_approval', locale)}
          </div>
        )}
      </div>
    </section>
  );
}
