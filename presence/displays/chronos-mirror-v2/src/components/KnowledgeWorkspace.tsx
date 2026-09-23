'use client';

import * as React from 'react';
import type { KbStatus } from '@agent/core/a2ui-catalog';
import {
  Badge,
  Button,
  Callout,
  Disclosure,
  EmptyState,
  KeyValue,
  List,
  Section,
  Skeleton,
  StatusPill,
} from '@agent/shared-ui';
import { WsPreformatted, WsSelectTable, WsTextareaField, WsTitleCell } from './ChronosWsParts';
import { useChronosLocale } from '../lib/hooks';
import { uxText, uxTextOr, type SupportedLocale } from '../lib/ux-vocabulary';
import { parseKnowledgeResponse, type ClientKnowledgeCandidate } from '../lib/knowledge-response';
import {
  parseKnowledgeFeedbackResponse,
  parseKnowledgeMutationResponse,
} from '../lib/knowledge-mutation-response';

type Candidate = ClientKnowledgeCandidate;

function knowledgeStatusLabel(value: string, locale: SupportedLocale): string {
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
  const [feedback, setFeedback] = React.useState<string | null>(null);
  const selected = items.find((item) => item.candidate_id === selectedId) || items[0] || null;

  const refresh = React.useCallback(async () => {
    try {
      const query = tenant ? `?tenant=${encodeURIComponent(tenant)}` : '';
      const response = await fetch(`/api/knowledge${query}`, { cache: 'no-store' });
      const payload = parseKnowledgeResponse(await response.json().catch(() => null));
      if (!response.ok || !payload) throw new Error('Invalid knowledge response');
      const nextItems = payload.candidates;
      setAccessRole(payload.accessRole);
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
          setPromotedBody(
            `${uxTextOr('chronos_ws_display_error', 'Display error', locale)}: ${err instanceof Error ? err.message : String(err)}`
          );
      });
    return () => {
      cancelled = true;
    };
  }, [selected, tenant, locale]);

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
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error('Failed to promote knowledge');
      if (!parseKnowledgeMutationResponse(payload)) {
        throw new Error('Invalid knowledge promotion response');
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const recordFeedback = async (verdict: 'useful' | 'not_useful') => {
    if (!selected?.promoted_ref) return;
    try {
      const response = await fetch('/api/knowledge-feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ document_path: selected.promoted_ref, verdict, tenant }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error('Failed to record feedback');
      if (!parseKnowledgeFeedbackResponse(payload)) {
        throw new Error('Invalid knowledge feedback response');
      }
      setFeedback(verdict);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error('Failed to approve the candidate');
      if (!parseKnowledgeMutationResponse(payload)) {
        throw new Error('Invalid knowledge approval response');
      }
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
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error('Failed to reject the candidate');
      if (!parseKnowledgeMutationResponse(payload)) {
        throw new Error('Invalid knowledge rejection response');
      }
      setDecisionNote('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const localAdmin = accessRole === 'localadmin';
  const scopeLabel = `${tenant || uxText('chronos_ac_scope_all', locale)} · ${items.length}`;
  const canDecide = selected?.status === 'queued' || selected?.status === 'approved';

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(18rem,0.9fr)_minmax(0,1.5fr)]">
      <Section
        title={uxText('chronos_knowledge_title', locale)}
        description={uxText('chronos_knowledge_description', locale)}
      >
        <div className="flex flex-wrap gap-2">
          <Badge label={scopeLabel} tone="accent" />
        </div>
        {error ? (
          <Callout
            tone="danger"
            title={uxTextOr('chronos_ws_load_failed', 'Could not load this view', locale)}
            body={error}
          />
        ) : null}
        <WsSelectTable
          columns={[
            { key: 'kind', label: uxTextOr('chronos_ws_col_candidate', 'Candidate', locale) },
            { key: 'status', label: uxText('chronos_col_status', locale), width: '8rem' },
          ]}
          rows={items}
          rowKey={(item) => item.candidate_id}
          selectedKey={selected?.candidate_id}
          onSelect={setSelectedId}
          empty={uxText('chronos_knowledge_empty', locale)}
          renderCell={(item, key, select) =>
            key === 'kind' ? (
              <div className="flex flex-col gap-0.5">
                <WsTitleCell
                  title={item.proposed_memory_kind}
                  id={item.candidate_id}
                  onSelect={select}
                  selected={selected?.candidate_id === item.candidate_id}
                />
                <span className="kb-list__meta">
                  {item.tenantSlug || uxText('chronos_org_not_configured', locale)}
                </span>
              </div>
            ) : (
              <StatusPill
                status={knowledgeStatusPill(item.status)}
                label={knowledgeStatusLabel(item.status, locale)}
              />
            )
          }
        />
      </Section>

      {selected ? (
        <Section
          title={selected.proposed_memory_kind}
          description={uxText('chronos_candidate_content', locale)}
        >
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill
              status={knowledgeStatusPill(selected.status)}
              label={knowledgeStatusLabel(selected.status, locale)}
            />
            <span className="chronos-mission-cell__id">{selected.candidate_id}</span>
          </div>
          <div className="chronos-feed">
            <h3 className="chronos-feed__title">{uxText('chronos_content_to_register', locale)}</h3>
            <p className="kb-text kb-text--body" style={{ whiteSpace: 'pre-wrap' }}>
              {selected.summary}
            </p>
          </div>
          <Disclosure summary={uxText('chronos_knowledge_evidence_details', locale)}>
            <KeyValue
              items={[
                {
                  label: uxTextOr('chronos_ws_source', 'Source', locale),
                  value: selected.source_ref || '-',
                  mono: true,
                },
                {
                  label: uxText('chronos_tenant_data_level', locale),
                  value: `${selected.tenantSlug || '-'} / ${selected.sensitivity_tier}`,
                },
              ]}
            />
            <h4 className="chronos-feed__title">
              {uxTextOr('chronos_ws_evidence', 'Evidence', locale)}
            </h4>
            {selected.evidence_refs.length ? (
              <List items={selected.evidence_refs.map((ref) => ({ title: ref }))} />
            ) : (
              <p className="kb-text kb-text--muted">{uxText('chronos_no_evidence', locale)}</p>
            )}
          </Disclosure>
          {selected.promoted_ref ? (
            <div className="chronos-feed">
              <StatusPill
                status="completed"
                label={`${uxText('chronos_registered', locale)}: ${selected.promoted_ref}`}
              />
              {promotedBody === null ? (
                <Skeleton shape="text" lines={4} label={uxText('chronos_loading', locale)} />
              ) : (
                <WsPreformatted text={promotedBody} />
              )}
              <div className="flex flex-wrap items-center gap-2">
                <span className="kb-text kb-text--caption">
                  {uxText('chronos_knowledge_feedback_prompt', locale)}
                </span>
                <Button
                  label={uxText('chronos_knowledge_feedback_useful', locale)}
                  variant={feedback === 'useful' ? 'primary' : 'secondary'}
                  onClick={() => void recordFeedback('useful')}
                />
                <Button
                  label={uxText('chronos_knowledge_feedback_not_useful', locale)}
                  variant={feedback === 'not_useful' ? 'primary' : 'secondary'}
                  onClick={() => void recordFeedback('not_useful')}
                />
              </div>
            </div>
          ) : null}
          {canDecide ? (
            <WsTextareaField
              id="chronos-knowledge-note"
              label={uxTextOr('chronos_ws_decision_note_label', 'Decision note', locale)}
              value={decisionNote}
              onChange={setDecisionNote}
              placeholder={uxText('chronos_decision_note', locale)}
              rows={2}
            />
          ) : null}
          <div className="flex flex-wrap gap-2">
            {selected.ratification_required && selected.status === 'queued' ? (
              <Button
                label={uxText('chronos_approve_candidate', locale)}
                variant="primary"
                disabled={busy || !localAdmin}
                onClick={() => void approve()}
              />
            ) : (
              <Button
                label={uxText('chronos_register_knowledge', locale)}
                variant="primary"
                disabled={
                  busy ||
                  !localAdmin ||
                  selected.status === 'rejected' ||
                  selected.status === 'promoted'
                }
                onClick={() => void promote()}
              />
            )}
            {canDecide ? (
              <Button
                label={uxText('chronos_reject_candidate', locale)}
                variant="danger"
                disabled={busy || !localAdmin}
                onClick={() => void reject()}
              />
            ) : null}
          </div>
          {!localAdmin ? (
            <p className="kb-text kb-text--muted">
              {uxText('chronos_localadmin_required', locale)}
            </p>
          ) : null}
        </Section>
      ) : (
        <Section>
          <EmptyState title={uxText('chronos_select_knowledge', locale)} />
        </Section>
      )}
    </div>
  );
}

function knowledgeStatusPill(status: string): KbStatus {
  if (status === 'queued') return 'pending';
  if (status === 'approved') return 'ready';
  if (status === 'rejected') return 'failed';
  if (status === 'promoted') return 'completed';
  return 'n/a';
}
