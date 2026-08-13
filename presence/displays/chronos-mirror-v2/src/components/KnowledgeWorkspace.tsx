'use client';

import * as React from 'react';
import { BookOpen, CheckCircle2, FileSearch, UploadCloud, XCircle } from 'lucide-react';
import { useChronosLocale } from '../lib/hooks';
import { uxText } from '../lib/ux-vocabulary';

type Candidate = {
  candidate_id: string;
  status: string;
  proposed_memory_kind: string;
  summary: string;
  evidence_refs: string[];
  sensitivity_tier: string;
  source_ref: string;
  tenantSlug?: string;
  promoted_ref?: string;
  ratification_required: boolean;
};

function knowledgeStatusLabel(value: string, locale: string): string {
  const labels: Record<string, string> = {
    queued: 'chronos_knowledge_status_queued',
    approved: 'chronos_knowledge_status_approved',
    rejected: 'chronos_knowledge_status_rejected',
    promoted: 'chronos_knowledge_status_promoted',
  };
  return uxText(labels[value] || 'chronos_unknown', locale);
}

export function KnowledgeWorkspace({ tenant }: { tenant?: string }) {
  const locale = useChronosLocale();
  const [items, setItems] = React.useState<Candidate[]>([]);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [promotedBody, setPromotedBody] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [accessRole, setAccessRole] = React.useState<'readonly' | 'localadmin'>('readonly');
  const [error, setError] = React.useState<string | null>(null);
  const [decisionNote, setDecisionNote] = React.useState('');
  const selected = items.find((item) => item.candidate_id === selectedId) || items[0] || null;

  const refresh = React.useCallback(async () => {
    try {
      const query = tenant ? `?tenant=${encodeURIComponent(tenant)}` : '';
      const response = await fetch(`/api/knowledge${query}`, { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Failed to load knowledge candidates');
      const nextItems = Array.isArray(payload.candidates) ? payload.candidates : [];
      setAccessRole(payload.accessRole === 'localadmin' ? 'localadmin' : 'readonly');
      setItems(nextItems);
      setSelectedId((current) =>
        nextItems.some((item: Candidate) => item.candidate_id === current)
          ? current
          : nextItems[0]?.candidate_id || null
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [tenant]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  React.useEffect(() => {
    setPromotedBody(null);
    if (!selected?.promoted_ref) return;
    let cancelled = false;
    void fetch(
      `/api/knowledge-ref?path=${encodeURIComponent(selected.promoted_ref)}${tenant ? `&tenant=${encodeURIComponent(tenant)}` : ''}`,
      { cache: 'no-store' }
    )
      .then(async (response) => {
        if (!response.ok) throw new Error('Failed to load promoted knowledge');
        return response.text();
      })
      .then((body) => {
        if (!cancelled) setPromotedBody(body);
      })
      .catch((err) => {
        if (!cancelled)
          setPromotedBody(`Display error: ${err instanceof Error ? err.message : String(err)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, tenant]);

  const promote = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/intelligence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'memory_promote_candidate',
          candidateId: selected.candidate_id,
          tenant,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Failed to promote knowledge');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const approve = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/intelligence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'memory_approve_candidate',
          candidateId: selected.candidate_id,
          tenant,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Failed to approve the candidate');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const reject = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/intelligence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'memory_reject_candidate',
          candidateId: selected.candidate_id,
          tenant,
          note: decisionNote,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Failed to reject the candidate');
      setDecisionNote('');
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
          <div className="text-[10px] uppercase tracking-[0.28em] kb-text-accent">
            {uxText('chronos_knowledge_eyebrow', locale)}
          </div>
          <h2 className="mt-1 text-xl font-semibold kb-text-primary">
            {uxText('chronos_knowledge_title', locale)}
          </h2>
          <p className="mt-2 text-sm leading-6 kb-text-secondary">
            {uxText('chronos_knowledge_description', locale)}
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
        <div className="space-y-2">
          {items.length === 0 ? (
            <div className="rounded-xl border kb-border-subtle p-4 text-[11px] kb-text-muted">
              {uxText('chronos_knowledge_empty', locale)}
            </div>
          ) : (
            items.map((item) => (
              <button
                key={item.candidate_id}
                type="button"
                aria-pressed={selected?.candidate_id === item.candidate_id}
                onClick={() => setSelectedId(item.candidate_id)}
                className={`w-full rounded-xl border p-3 text-left ${selected?.candidate_id === item.candidate_id ? 'kb-border-accent kb-surface-accent' : 'kb-border-subtle kb-surface-sunken hover:kb-surface-raised'}`}
              >
                <div className="flex items-center gap-2">
                  <BookOpen size={13} className="kb-text-accent" />
                  <span className="truncate text-xs font-semibold kb-text-primary">
                    {item.proposed_memory_kind}
                  </span>
                </div>
                <div className="mt-2 text-[10px] kb-text-secondary">
                  {item.tenantSlug || uxText('chronos_org_not_configured', locale)} ·{' '}
                  {knowledgeStatusLabel(item.status, locale)}
                </div>
                <div className="mt-1 truncate text-[10px] kb-text-muted">{item.candidate_id}</div>
              </button>
            ))
          )}
        </div>
        {selected ? (
          <div className="rounded-2xl border kb-border-subtle kb-surface-sunken p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] kb-text-accent">
                  <FileSearch size={13} />
                  {uxText('chronos_candidate_content', locale)}
                </div>
                <h3 className="mt-1 text-lg font-semibold kb-text-primary">
                  {selected.proposed_memory_kind}
                </h3>
              </div>
              <span className="rounded-full border kb-border-subtle px-2 py-1 text-[10px] kb-text-secondary">
                {knowledgeStatusLabel(selected.status, locale)}
              </span>
            </div>
            <div className="mt-4 rounded-xl border kb-border-subtle kb-surface-raised p-4">
              <div className="text-[10px] uppercase tracking-[0.16em] kb-text-accent">
                {uxText('chronos_content_to_register', locale)}
              </div>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-6 kb-text-primary">
                {selected.summary}
              </p>
            </div>
            <details className="mt-3 rounded-xl border kb-border-subtle kb-surface-raised p-3">
              <summary className="cursor-pointer text-[10px] font-semibold kb-text-primary">
                {uxText('chronos_knowledge_evidence_details', locale)}
              </summary>
              <div className="mt-3 grid gap-3 md:grid-cols-2 text-[11px] kb-text-secondary">
                <div>
                  <div className="kb-text-accent">出典</div>
                  <div className="mt-1 break-all">{selected.source_ref}</div>
                  <div className="mt-2 kb-text-accent">
                    {uxText('chronos_tenant_data_level', locale)}
                  </div>
                  <div className="mt-1">
                    {selected.tenantSlug || '-'} / {selected.sensitivity_tier}
                  </div>
                </div>
                <div>
                  <div className="kb-text-accent">根拠</div>
                  {selected.evidence_refs.length ? (
                    <ul className="mt-1 list-disc break-all pl-4">
                      {selected.evidence_refs.map((ref) => (
                        <li key={ref}>{ref}</li>
                      ))}
                    </ul>
                  ) : (
                    <div className="mt-1">{uxText('chronos_no_evidence', locale)}</div>
                  )}
                </div>
              </div>
            </details>
            {selected.promoted_ref ? (
              <div className="mt-3 rounded-xl border kb-border-accent kb-surface-accent p-3">
                <div className="flex items-center gap-2 text-[10px] font-semibold kb-text-accent">
                  <CheckCircle2 size={13} />
                  {uxText('chronos_registered', locale)}: {selected.promoted_ref}
                </div>
                <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap text-[11px] kb-text-secondary">
                  {promotedBody || `${uxText('chronos_loading', locale)}…`}
                </pre>
              </div>
            ) : null}
            {selected.status === 'queued' || selected.status === 'approved' ? (
              <textarea
                aria-label="Knowledge decision note"
                value={decisionNote}
                onChange={(event) => setDecisionNote(event.target.value)}
                placeholder={uxText('chronos_decision_note', locale)}
                className="mt-4 min-h-16 w-full rounded-xl border kb-border-subtle kb-surface-raised p-3 text-xs kb-text-primary outline-none"
              />
            ) : null}
            <div className="mt-3 flex flex-wrap gap-2">
              {selected.ratification_required && selected.status === 'queued' ? (
                <button
                  type="button"
                  disabled={busy || accessRole !== 'localadmin'}
                  onClick={() => void approve()}
                  className="inline-flex items-center gap-1 rounded-lg kb-surface-positive px-3 py-2 text-[11px] kb-status-positive disabled:opacity-50"
                >
                  <CheckCircle2 size={14} />
                  {uxText('chronos_approve_candidate', locale)}
                </button>
              ) : (
                <button
                  type="button"
                  disabled={
                    busy ||
                    accessRole !== 'localadmin' ||
                    selected.status === 'rejected' ||
                    selected.status === 'promoted'
                  }
                  onClick={() => void promote()}
                  className="inline-flex items-center gap-1 rounded-lg kb-surface-accent px-3 py-2 text-[11px] kb-text-accent disabled:opacity-50"
                >
                  <UploadCloud size={14} />
                  {uxText('chronos_register_knowledge', locale)}
                </button>
              )}
              {(selected.status === 'queued' || selected.status === 'approved') && (
                <button
                  type="button"
                  disabled={busy || accessRole !== 'localadmin'}
                  onClick={() => void reject()}
                  className="inline-flex items-center gap-1 rounded-lg kb-surface-negative px-3 py-2 text-[11px] kb-status-negative disabled:opacity-50"
                >
                  <XCircle size={14} />
                  {uxText('chronos_reject_candidate', locale)}
                </button>
              )}
            </div>
            {accessRole !== 'localadmin' ? (
              <div className="mt-3 text-[10px] kb-text-muted">
                {uxText('chronos_localadmin_required', locale)}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="rounded-2xl border kb-border-subtle p-6 text-sm kb-text-muted">
            {uxText('chronos_select_knowledge', locale)}
          </div>
        )}
      </div>
    </section>
  );
}
