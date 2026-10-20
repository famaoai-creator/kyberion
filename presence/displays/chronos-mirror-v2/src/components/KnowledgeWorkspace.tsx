'use client';

import * as React from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { KnowledgeLearningPanel, learningStateLabel } from './KnowledgeLearningPanel';
import { knowledgeSelectionAfterRefresh } from '../lib/knowledge-selection';
import {
  LEARNING_PENDING_PREFIX,
  parseLearningPending,
  curationRecoveryDigest,
  learningPendingResolved,
  parseLearningMutationReceipt,
  learningMutationConfirmed,
  learningScopeSupported,
  type LearningAction,
  type LearningPending,
} from '../lib/knowledge-learning-client';
import type { ClientKnowledgeCuration } from '../lib/knowledge-response';
import type { KbStatus } from '@agent/core/surface/a2ui-catalog';
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
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const requestedKey = searchParams.get('candidateKey');
  const requestedKeyRef = React.useRef(requestedKey);
  requestedKeyRef.current = requestedKey;
  const [selectedKey, setSelectedKey] = React.useState<string | null>(requestedKey);
  const [fresh, setFresh] = React.useState(false);
  const [pending, setPending] = React.useState<Record<string, LearningPending>>({});
  const [recoveryError, setRecoveryError] = React.useState(false);
  const requestVersion = React.useRef(0);
  const mutationInFlight = React.useRef(false);
  const view = React.useRef(tenant);
  view.current = tenant;
  const [promotedBody, setPromotedBody] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [accessRole, setAccessRole] = React.useState<'readonly' | 'localadmin'>('readonly');
  const [error, setError] = React.useState<string | null>(null);
  const [decisionNote, setDecisionNote] = React.useState('');
  const [feedback, setFeedback] = React.useState<string | null>(null);
  const selected = selectedKey
    ? items.find((item) => item.candidateKey === selectedKey) || null
    : items[0] || null;
  const selectionRef = React.useRef(selected?.candidateKey);
  selectionRef.current = selected?.candidateKey;
  React.useEffect(() => {
    setSelectedKey(requestedKey);
  }, [requestedKey]);
  const select = (key: string) => {
    setSelectedKey(key);
    const params = new URLSearchParams(searchParams.toString());
    params.set('section', 'knowledge');
    params.set('candidateKey', key);
    params.delete('request');
    params.delete('storageChannel');
    router.replace(pathname + '?' + params.toString(), { scroll: false });
  };

  const refresh = React.useCallback(async () => {
    const version = ++requestVersion.current;
    const originalTenant = tenant;
    setFresh(false);
    try {
      const query = tenant ? '?tenant=' + encodeURIComponent(tenant) : '';
      const response = await fetch('/api/knowledge' + query, { cache: 'no-store' });
      const payload = parseKnowledgeResponse(await response.json().catch(() => null));
      if (!response.ok || !payload) throw new Error(uxText('chronos_learning_load_failed', locale));
      if (version !== requestVersion.current || originalTenant !== view.current) return;
      const nextItems = payload.candidates;
      const markers: Record<string, LearningPending> = {};
      try {
        for (const item of nextItems) {
          const key = LEARNING_PENDING_PREFIX + item.candidateKey;
          const marker = parseLearningPending(window.sessionStorage.getItem(key));
          if (marker && (await learningPendingResolved(marker, item)))
            window.sessionStorage.removeItem(key);
          else if (marker) markers[item.candidateKey] = marker;
        }
        setRecoveryError(false);
      } catch {
        setRecoveryError(true);
      }
      if (version !== requestVersion.current || originalTenant !== view.current) return;
      setPending(markers);
      setAccessRole(payload.accessRole);
      setItems(nextItems);
      setSelectedKey((current) =>
        knowledgeSelectionAfterRefresh(
          nextItems.map((item) => item.candidateKey),
          current,
          requestedKeyRef.current,
          { tenant: originalTenant, version },
          { tenant: view.current, version: requestVersion.current }
        )
      );
      setFresh(true);
      setError(null);
    } catch (err) {
      if (version !== requestVersion.current || originalTenant !== view.current) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [tenant, locale]);

  React.useEffect(() => {
    setItems([]);
    setFresh(false);
    void refresh();
    return () => {
      requestVersion.current += 1;
    };
  }, [refresh]);
  React.useEffect(() => {
    setDecisionNote('');
    setFeedback(null);
  }, [selected?.candidateKey]);

  React.useEffect(() => {
    setPromotedBody(null);
    if (!selected?.promoted_ref || selected.learning) return;
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

  const runLearning = async (action: LearningAction, curation?: ClientKnowledgeCuration) => {
    const candidate = selected;
    if (
      !candidate?.learning?.payloadDigest ||
      !fresh ||
      recoveryError ||
      pending[candidate.candidateKey] ||
      accessRole !== 'localadmin' ||
      !learningScopeSupported(candidate) ||
      mutationInFlight.current
    )
      return;
    const originalTenant = tenant;
    mutationInFlight.current = true;
    setBusy(true);
    const marker: LearningPending = {
      action,
      expectedPayloadDigest: candidate.learning.payloadDigest,
    };
    const markerKey = LEARNING_PENDING_PREFIX + candidate.candidateKey;
    try {
      if (curation) marker.curationDigest = await curationRecoveryDigest(curation);
      if (originalTenant !== view.current) {
        mutationInFlight.current = false;
        setBusy(false);
        return;
      }
      window.sessionStorage.setItem(markerKey, JSON.stringify(marker));
      if (!parseLearningPending(window.sessionStorage.getItem(markerKey)))
        throw new Error('Recovery marker missing');
    } catch {
      setRecoveryError(true);
      mutationInFlight.current = false;
      setBusy(false);
      return;
    }
    setPending((current) => ({ ...current, [candidate.candidateKey]: marker }));
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/intelligence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          candidateId: candidate.candidate_id,
          candidateKey: candidate.candidateKey,
          expectedPayloadDigest: marker.expectedPayloadDigest,
          tenant,
          ...(curation ? { curation } : {}),
        }),
      });
      const body = await response.json().catch(() => null);
      const receipt = parseLearningMutationReceipt(body, candidate);
      const notApplied = !response.ok && body?.ok === false && body?.outcome === 'not_applied';
      if (
        notApplied ||
        (response.ok && receipt && learningMutationConfirmed(action, receipt, curation))
      ) {
        window.sessionStorage.removeItem(markerKey);
        if (originalTenant !== view.current) return;
        setPending((current) => {
          const next = { ...current };
          delete next[candidate.candidateKey];
          return next;
        });
        await refresh();
        if (notApplied)
          setError(
            typeof body.error === 'string'
              ? body.error
              : uxText('chronos_learning_action_rejected', locale)
          );
      } else {
        if (originalTenant !== view.current) return;
        setFresh(false);
        setError(uxText('chronos_learning_outcome_unknown', locale));
      }
    } catch {
      if (originalTenant === view.current) {
        setFresh(false);
        setError(uxText('chronos_learning_outcome_unknown', locale));
      }
    } finally {
      mutationInFlight.current = false;
      setBusy(false);
    }
  };

  const mutateLegacy = async (
    action: 'memory_promote_candidate' | 'memory_approve_candidate' | 'memory_reject_candidate'
  ) => {
    const candidate = selected;
    if (
      !candidate ||
      (candidate.learning && action !== 'memory_reject_candidate') ||
      !fresh ||
      accessRole !== 'localadmin' ||
      mutationInFlight.current
    )
      return;
    const originalTenant = tenant;
    mutationInFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/intelligence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          candidateId: candidate.candidate_id,
          candidateKey: candidate.candidateKey,
          tenant,
          ...(action === 'memory_reject_candidate' ? { note: decisionNote } : {}),
        }),
      });
      const payload = parseKnowledgeMutationResponse(await response.json().catch(() => null));
      if (!response.ok || !payload || payload.candidate.candidateKey !== candidate.candidateKey)
        throw new Error(uxText('chronos_learning_outcome_unknown', locale));
      if (originalTenant !== view.current) return;
      setDecisionNote('');
      await refresh();
    } catch (err) {
      if (originalTenant !== view.current) return;
      setFresh(false);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      mutationInFlight.current = false;
      setBusy(false);
    }
  };
  const promote = () => mutateLegacy('memory_promote_candidate');
  const approve = () => mutateLegacy('memory_approve_candidate');
  const reject = () => mutateLegacy('memory_reject_candidate');

  const recordFeedback = async (verdict: 'useful' | 'not_useful') => {
    if (!selected?.promoted_ref || !fresh || selected.learning) return;
    const originalKey = selected.candidateKey;
    const originalTenant = tenant;
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
      if (selectionRef.current !== originalKey || view.current !== originalTenant) return;
      setFeedback(verdict);
    } catch (err) {
      if (selectionRef.current !== originalKey || view.current !== originalTenant) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const localAdmin = accessRole === 'localadmin';
  const scopeLabel = `${tenant || uxText('chronos_ac_scope_all', locale)} · ${items.length}`;
  const canDecide = selected?.status === 'queued' || selected?.status === 'approved';
  const pendingSelected = selected ? pending[selected.candidateKey] : undefined;

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(18rem,0.9fr)_minmax(0,1.5fr)]">
      <Section
        title={uxText('chronos_knowledge_title', locale)}
        description={uxText('chronos_knowledge_description', locale)}
      >
        <div className="flex flex-wrap gap-2">
          <Badge label={scopeLabel} tone="accent" />
          <Button
            label={uxText('chronos_learning_refresh', locale)}
            variant="secondary"
            disabled={busy}
            onClick={() => void refresh()}
          />
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
          rowKey={(item) => item.candidateKey}
          selectedKey={selected?.candidateKey}
          onSelect={select}
          empty={uxText('chronos_knowledge_empty', locale)}
          renderCell={(item, key, select) =>
            key === 'kind' ? (
              <div className="flex flex-col gap-0.5">
                <WsTitleCell
                  title={item.proposed_memory_kind}
                  id={item.candidate_id}
                  onSelect={select}
                  selected={selected?.candidateKey === item.candidateKey}
                />
                <span className="kb-list__meta">
                  {item.tenantSlug || uxText('chronos_org_not_configured', locale)}
                </span>
              </div>
            ) : (
              <StatusPill
                status={knowledgeStatusPill(item.learning?.state || item.status)}
                label={
                  item.learning
                    ? learningStateLabel(item.learning.state, locale)
                    : knowledgeStatusLabel(item.status, locale)
                }
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
              status={knowledgeStatusPill(selected.learning?.state || selected.status)}
              label={
                selected.learning
                  ? learningStateLabel(selected.learning.state, locale)
                  : knowledgeStatusLabel(selected.status, locale)
              }
            />
            <span className="chronos-mission-cell__id">{selected.candidate_id}</span>
          </div>
          {!fresh ? (
            <Callout tone="warning" title={uxText('chronos_learning_stale', locale)} />
          ) : null}
          {recoveryError ? (
            <Callout
              tone="warning"
              title={uxText('chronos_learning_recovery_unavailable', locale)}
              body={uxText('chronos_learning_recovery_hint', locale)}
            />
          ) : null}
          {pendingSelected ? (
            <Callout
              tone="warning"
              title={uxText('chronos_learning_outcome_unknown', locale)}
              body={uxText('chronos_learning_check_only', locale)}
            />
          ) : null}
          {selected.learning ? (
            <KnowledgeLearningPanel
              key={selected.candidateKey + ':' + (selected.learning.payloadDigest || '')}
              candidate={selected}
              locale={locale}
              localAdmin={localAdmin}
              disabled={busy || !fresh || recoveryError || Boolean(pendingSelected)}
              onAction={(action, curation) => void runLearning(action, curation)}
              onReject={() => void reject()}
            />
          ) : null}
          <div className="chronos-feed">
            <h3 className="chronos-feed__title">
              {uxText(
                selected.learning
                  ? 'chronos_learning_source_summary'
                  : 'chronos_content_to_register',
                locale
              )}
            </h3>
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
          {selected.promoted_ref && !selected.learning ? (
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
                  disabled={!fresh || busy}
                  onClick={() => void recordFeedback('useful')}
                />
                <Button
                  label={uxText('chronos_knowledge_feedback_not_useful', locale)}
                  variant={feedback === 'not_useful' ? 'primary' : 'secondary'}
                  disabled={!fresh || busy}
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
          {!selected.learning ? (
            <div className="flex flex-wrap gap-2">
              {selected.ratification_required && selected.status === 'queued' ? (
                <Button
                  label={uxText('chronos_approve_candidate', locale)}
                  variant="primary"
                  disabled={busy || !fresh || !localAdmin}
                  onClick={() => void approve()}
                />
              ) : (
                <Button
                  label={uxText('chronos_register_knowledge', locale)}
                  variant="primary"
                  disabled={
                    busy ||
                    !fresh ||
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
                  disabled={busy || !fresh || !localAdmin}
                  onClick={() => void reject()}
                />
              ) : null}
            </div>
          ) : null}
          {!localAdmin ? (
            <p className="kb-text kb-text--muted">
              {uxText('chronos_localadmin_required', locale)}
            </p>
          ) : null}
        </Section>
      ) : (
        <Section>
          <EmptyState
            title={uxText(
              selectedKey ? 'chronos_learning_candidate_unavailable' : 'chronos_select_knowledge',
              locale
            )}
          />
        </Section>
      )}
    </div>
  );
}

function knowledgeStatusPill(status: string): KbStatus {
  if (status === 'queued' || status === 'pending' || status === 'draft') return 'pending';
  if (status === 'approved') return 'ready';
  if (status === 'rejected') return 'failed';
  if (status === 'promoted' || status === 'published') return 'completed';
  if (['error', 'expired', 'revoked', 'unsupported'].includes(status)) return 'blocked';
  return 'n/a';
}
