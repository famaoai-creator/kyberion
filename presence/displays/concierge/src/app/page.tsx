'use client';

import * as React from 'react';
import { useConciergeI18n } from '../lib/use-concierge-i18n';
import {
  parseConciergeSummaryEvent,
  parseConciergeSummaryResponse,
  type ConciergeSummary,
} from '../lib/summary-event';
import {
  parseConciergeHygieneResponse,
  parseConciergeMemoryQueueResponse,
  parseConciergeResponseStatusResponse,
  type ConciergeHygieneInquiry,
  type ConciergeMemoryQueueItem,
  type ConciergeResponseStatus,
} from '../lib/concierge-advisory-response';
import {
  parseConciergeOutcomePreviewResponse,
  type ConciergeOutcomePreview,
} from '../lib/outcome-preview-response';
import { parseConciergeMutationResponse } from '../lib/mutation-response';

type HygieneInquiry = ConciergeHygieneInquiry;
type MemoryQueueItem = ConciergeMemoryQueueItem;
type ResponseStatus = ConciergeResponseStatus;

type OutcomePreview = ConciergeOutcomePreview;

function formatWhen(value: string | undefined, locale: 'en' | 'ja'): string {
  if (!value) return '';
  try {
    return new Date(value).toLocaleString(locale === 'ja' ? 'ja-JP' : 'en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return value;
  }
}

export default function ConciergePage() {
  const { locale, setLocale, t } = useConciergeI18n();
  const [summary, setSummary] = React.useState<ConciergeSummary | null>(null);
  const [notice, setNotice] = React.useState<{ text: string; error?: boolean } | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [responseStatus, setResponseStatus] = React.useState<ResponseStatus | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      const response = await fetch('/api/summary', { cache: 'no-store' });
      const nextSummary = parseConciergeSummaryResponse(await response.json().catch(() => null));
      if (!response.ok || !nextSummary) throw new Error('Invalid summary response');
      setSummary(nextSummary);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const refreshResponseStatus = React.useCallback(async () => {
    try {
      const response = await fetch('/api/response-status', { cache: 'no-store' });
      const parsed = parseConciergeResponseStatusResponse(await response.json().catch(() => null));
      if (!response.ok || !parsed) throw new Error('Invalid response status response');
      setResponseStatus(parsed);
    } catch {
      // The response-status panel is advisory; the main concierge remains usable.
    }
  }, []);

  // CS-03: 停滞ミッション伺いカード — stalled requests waiting for a human
  // start/withdraw decision. The pane only appears when there is something to
  // decide, and nothing is ever decided without an explicit confirmed click.
  const [hygiene, setHygiene] = React.useState<HygieneInquiry[]>([]);
  const [hygieneBusyId, setHygieneBusyId] = React.useState<string | null>(null);
  const [hygieneConfirm, setHygieneConfirm] = React.useState<{
    missionId: string;
    decision: 'start' | 'cancel';
  } | null>(null);
  const [hygieneNote, setHygieneNote] = React.useState('');

  const refreshHygiene = React.useCallback(async () => {
    try {
      const response = await fetch('/api/hygiene', { cache: 'no-store' });
      const parsed = parseConciergeHygieneResponse(await response.json().catch(() => null));
      if (!response.ok || !parsed) throw new Error('Invalid hygiene response');
      setHygiene(parsed);
    } catch {
      // Advisory pane: a failed hygiene fetch never blocks the concierge.
    }
  }, []);

  // CS-03 記憶昇格キュー — proposed learnings awaiting the human's blessing.
  // The pane only appears when candidates exist, and nothing is approved or
  // rejected without an explicit confirmed click (§0: human gates stay human).
  const [memoryQueue, setMemoryQueue] = React.useState<MemoryQueueItem[]>([]);
  const [memoryBusyId, setMemoryBusyId] = React.useState<string | null>(null);
  const [memoryConfirm, setMemoryConfirm] = React.useState<{
    id: string;
    decision: 'approve' | 'reject';
  } | null>(null);

  const refreshMemoryQueue = React.useCallback(async () => {
    try {
      const response = await fetch('/api/memory-queue', { cache: 'no-store' });
      const parsed = parseConciergeMemoryQueueResponse(await response.json().catch(() => null));
      if (!response.ok || !parsed) throw new Error('Invalid memory queue response');
      setMemoryQueue(parsed);
    } catch {
      // Advisory pane: a failed queue fetch never blocks the concierge.
    }
  }, []);

  React.useEffect(() => {
    void refresh();
    void refreshResponseStatus();
    void refreshHygiene();
    void refreshMemoryQueue();
    // CS-01: live summary updates over SSE; degrade to the legacy 30 s
    // polling only when the event stream is unavailable.
    let source: EventSource | null = null;
    let fallbackTimer: ReturnType<typeof setInterval> | null = null;
    const startPollingFallback = () => {
      if (!fallbackTimer) fallbackTimer = setInterval(() => void refresh(), 30_000);
    };
    try {
      source = new EventSource('/api/events');
      source.addEventListener('summary', (event) => {
        try {
          const nextSummary = parseConciergeSummaryEvent((event as MessageEvent).data);
          if (!nextSummary) return;
          setSummary(nextSummary);
          setLoadError(null);
        } catch {
          // Keep the last good snapshot when one event fails to parse.
        }
      });
      source.onerror = () => {
        source?.close();
        source = null;
        startPollingFallback();
      };
    } catch {
      startPollingFallback();
    }
    const responseTimer = setInterval(() => void refreshResponseStatus(), 10_000);
    // The hygiene report scans mission directories; a relaxed cadence is
    // plenty for a list that changes on the order of days. The memory queue
    // moves at the same human pace.
    const hygieneTimer = setInterval(() => void refreshHygiene(), 60_000);
    const memoryTimer = setInterval(() => void refreshMemoryQueue(), 60_000);
    return () => {
      source?.close();
      if (fallbackTimer) clearInterval(fallbackTimer);
      clearInterval(responseTimer);
      clearInterval(hygieneTimer);
      clearInterval(memoryTimer);
    };
  }, [refresh, refreshResponseStatus, refreshHygiene, refreshMemoryQueue]);

  const decideApproval = React.useCallback(
    async (item: ConciergeSummary['approval_queue'][number], decision: 'approved' | 'rejected') => {
      setBusyId(item.id);
      try {
        const response = await fetch(`/api/approvals/${encodeURIComponent(item.id)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            decision,
            channel: item.channel,
            storageChannel: item.storage_channel,
          }),
        });
        if (!response.ok) throw new Error('Approval failed');
        setNotice({
          text: t(decision === 'approved' ? 'home.approved_notice' : 'home.rejected_notice', {
            title: item.title,
          }),
        });
        await refresh();
      } catch (error) {
        setNotice({ text: error instanceof Error ? error.message : String(error), error: true });
      } finally {
        setBusyId(null);
      }
    },
    [refresh, t]
  );

  const [changeFormId, setChangeFormId] = React.useState<string | null>(null);
  const [changeNote, setChangeNote] = React.useState('');

  const recordOutcomeVerdict = React.useCallback(
    async (
      item: ConciergeSummary['outcome_feed'][number],
      status: 'accepted' | 'changes_requested' | 'rejected',
      note = ''
    ) => {
      // CS-01: change requests arrive through the inline form below (the
      // blocking browser prompt is gone); an empty note never reaches the owner.
      if (status === 'changes_requested' && !note.trim()) return;
      setBusyId(item.entry_id);
      try {
        const response = await fetch(`/api/outcomes/${encodeURIComponent(item.entry_id)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status, note }),
        });
        if (!response.ok) throw new Error('Verdict failed');
        setNotice({
          text: t(
            status === 'accepted'
              ? 'home.accepted_notice'
              : status === 'rejected'
                ? 'home.rejected_notice'
                : 'home.changes_notice',
            { title: item.title }
          ),
        });
        setChangeFormId(null);
        setChangeNote('');
        await refresh();
      } catch (error) {
        setNotice({ text: error instanceof Error ? error.message : String(error), error: true });
      } finally {
        setBusyId(null);
      }
    },
    [refresh, t]
  );

  // CS-03: the decision only fires from the inline confirm step — there is no
  // auto-start, no auto-cancel, and no blocking browser dialog.
  const decideHygiene = React.useCallback(
    async (item: HygieneInquiry, decision: 'start' | 'cancel', note: string) => {
      setHygieneBusyId(item.mission_id);
      try {
        const response = await fetch(`/api/hygiene/${encodeURIComponent(item.mission_id)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision, ...(note.trim() ? { note: note.trim() } : {}) }),
        });
        const parsed = parseConciergeMutationResponse(await response.json().catch(() => null));
        if (!response.ok || !parsed?.result?.message) throw new Error('Hygiene action failed');
        setNotice({ text: parsed.result.message });
        setHygieneConfirm(null);
        setHygieneNote('');
        await refreshHygiene();
        await refresh();
      } catch (error) {
        setNotice({ text: error instanceof Error ? error.message : String(error), error: true });
      } finally {
        setHygieneBusyId(null);
      }
    },
    [refresh, refreshHygiene]
  );

  // CS-03: a memory decision only fires from the inline confirm step — no
  // auto-approval, no default, no blocking browser dialog.
  const decideMemory = React.useCallback(
    async (item: MemoryQueueItem, decision: 'approve' | 'reject') => {
      setMemoryBusyId(item.id);
      try {
        const response = await fetch(`/api/memory-queue/${encodeURIComponent(item.id)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision }),
        });
        const parsed = parseConciergeMutationResponse(await response.json().catch(() => null));
        if (!response.ok || !parsed?.result?.message) throw new Error('Memory decision failed');
        setNotice({ text: parsed.result.message });
        setMemoryConfirm(null);
        await refreshMemoryQueue();
      } catch (error) {
        setNotice({ text: error instanceof Error ? error.message : String(error), error: true });
      } finally {
        setMemoryBusyId(null);
      }
    },
    [refreshMemoryQueue]
  );

  // CS-03 受領プレビュー: one preview open at a time, fetched on demand.
  const [previewId, setPreviewId] = React.useState<string | null>(null);
  const [previewData, setPreviewData] = React.useState<OutcomePreview | null>(null);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  const [previewBusyId, setPreviewBusyId] = React.useState<string | null>(null);

  const togglePreview = React.useCallback(
    async (item: ConciergeSummary['outcome_feed'][number]) => {
      if (previewId === item.entry_id) {
        setPreviewId(null);
        setPreviewData(null);
        setPreviewError(null);
        return;
      }
      setPreviewBusyId(item.entry_id);
      try {
        const response = await fetch(`/api/outcomes/${encodeURIComponent(item.entry_id)}/preview`, {
          cache: 'no-store',
        });
        const parsed = parseConciergeOutcomePreviewResponse(
          await response.json().catch(() => null)
        );
        if (!response.ok || !parsed) throw new Error('Invalid outcome preview response');
        setPreviewData(parsed);
        setPreviewError(null);
      } catch (error) {
        setPreviewData(null);
        setPreviewError(error instanceof Error ? error.message : String(error));
      } finally {
        setPreviewId(item.entry_id);
        setPreviewBusyId(null);
      }
    },
    [previewId]
  );

  if (loadError) {
    return <div className="notice error">{t('home.load_error', { error: loadError })}</div>;
  }
  if (!summary) {
    return <div className="pane-empty">{t('home.loading')}</div>;
  }

  const briefing = summary.briefing;

  // CS-04 「今日の伺い」— every item awaiting the human's decision is rendered
  // by one card helper per type; the unified queue and the panes below share
  // these helpers, so the two views can never drift apart.
  const renderApprovalCard = (item: ConciergeSummary['approval_queue'][number]) => (
    <div key={item.id} className="item-card">
      <p className="item-title">{item.title}</p>
      {item.reason ? <p className="item-body">{item.reason}</p> : null}
      <div className="item-meta">
        {item.mission_id ? `${item.mission_id} · ` : ''}
        {formatWhen(item.requested_at, locale)}
        {item.expires_at
          ? ` · ${locale === 'ja' ? '期限' : 'expires'} ${formatWhen(item.expires_at, locale)}`
          : ''}
      </div>
      <div className="button-row">
        <button
          type="button"
          className="action-button"
          disabled={busyId === item.id}
          onClick={() => void decideApproval(item, 'approved')}
        >
          {t('home.approve')}
        </button>
        <button
          type="button"
          className="action-button danger"
          disabled={busyId === item.id}
          onClick={() => void decideApproval(item, 'rejected')}
        >
          {t('home.reject')}
        </button>
      </div>
    </div>
  );

  const renderHygieneCard = (item: HygieneInquiry) => (
    <div key={item.mission_id} className="item-card">
      <p className="item-title">{item.title}</p>
      <p className="item-body">{t(`hygiene.reason.${item.reason}` as Parameters<typeof t>[0])}</p>
      <div className="item-meta">
        {item.mission_id}
        {typeof item.age_days === 'number'
          ? ` · ${t('hygiene.waiting_days', { count: item.age_days })}`
          : ''}
        {item.waiting_since
          ? ` · ${t('hygiene.waiting_since', { value: formatWhen(item.waiting_since, locale) })}`
          : ''}
      </div>
      {hygieneConfirm?.missionId === item.mission_id ? (
        <div className="hygiene-confirm">
          <p className="item-body">
            {t(
              hygieneConfirm.decision === 'start'
                ? 'hygiene.confirm_start'
                : 'hygiene.confirm_cancel'
            )}
          </p>
          {hygieneConfirm.decision === 'cancel' ? (
            <label className="field-label">
              {t('hygiene.note_label')}
              <textarea
                value={hygieneNote}
                rows={2}
                onChange={(event) => setHygieneNote(event.target.value)}
              />
            </label>
          ) : null}
          <div className="button-row">
            <button
              type="button"
              className="action-button"
              disabled={hygieneBusyId === item.mission_id}
              onClick={() => void decideHygiene(item, hygieneConfirm.decision, hygieneNote)}
            >
              {t('hygiene.confirm_yes')}
            </button>
            <button
              type="button"
              className="action-button secondary"
              disabled={hygieneBusyId === item.mission_id}
              onClick={() => {
                setHygieneConfirm(null);
                setHygieneNote('');
              }}
            >
              {t('hygiene.confirm_back')}
            </button>
          </div>
        </div>
      ) : (
        <div className="button-row">
          <button
            type="button"
            className="action-button"
            disabled={hygieneBusyId !== null}
            onClick={() => {
              setHygieneConfirm({ missionId: item.mission_id, decision: 'start' });
              setHygieneNote('');
            }}
          >
            {t('hygiene.start')}
          </button>
          <button
            type="button"
            className="action-button danger"
            disabled={hygieneBusyId !== null}
            onClick={() => {
              setHygieneConfirm({ missionId: item.mission_id, decision: 'cancel' });
              setHygieneNote('');
            }}
          >
            {t('hygiene.cancel')}
          </button>
        </div>
      )}
    </div>
  );

  const renderMemoryCard = (item: MemoryQueueItem) => (
    <div key={item.id} className="item-card">
      <p className="item-title">
        {t(`memory.kind.${item.kind}` as Parameters<typeof t>[0])}
        <span className="status-chip">
          {t(`memory.tier.${item.sensitivity_tier}` as Parameters<typeof t>[0])}
        </span>
      </p>
      <p className="item-body">{item.summary}</p>
      <div className="item-meta">
        {item.source ? `${t('memory.source', { value: item.source })} · ` : ''}
        {formatWhen(item.queued_at, locale)}
        {item.occurrences > 1 ? ` · ${t('memory.seen_times', { count: item.occurrences })}` : ''}
      </div>
      {memoryConfirm?.id === item.id ? (
        <div className="memory-confirm">
          <p className="item-body">
            {t(
              memoryConfirm.decision === 'approve'
                ? 'memory.confirm_approve'
                : 'memory.confirm_reject'
            )}
          </p>
          <div className="button-row">
            <button
              type="button"
              className="action-button"
              disabled={memoryBusyId === item.id}
              onClick={() => void decideMemory(item, memoryConfirm.decision)}
            >
              {t('memory.confirm_yes')}
            </button>
            <button
              type="button"
              className="action-button secondary"
              disabled={memoryBusyId === item.id}
              onClick={() => setMemoryConfirm(null)}
            >
              {t('memory.confirm_back')}
            </button>
          </div>
        </div>
      ) : (
        <div className="button-row">
          <button
            type="button"
            className="action-button"
            disabled={memoryBusyId !== null}
            onClick={() => setMemoryConfirm({ id: item.id, decision: 'approve' })}
          >
            {t('memory.approve')}
          </button>
          <button
            type="button"
            className="action-button danger"
            disabled={memoryBusyId !== null}
            onClick={() => setMemoryConfirm({ id: item.id, decision: 'reject' })}
          >
            {t('memory.reject')}
          </button>
        </div>
      )}
    </div>
  );

  const renderExceptionCard = (item: ConciergeSummary['exception_feed'][number]) => (
    <div key={item.id} className="item-card">
      <p className="item-title">{item.title}</p>
      {item.text ? <p className="item-body">{item.text}</p> : null}
      <div className="item-meta">
        {item.surface} · {formatWhen(item.created_at, locale)}
      </div>
    </div>
  );

  const renderOutcomeCard = (item: ConciergeSummary['outcome_feed'][number]) => (
    <div key={item.entry_id} className="item-card">
      <p className="item-title">
        {item.title}
        <span className="status-chip">
          {t(`home.status.${item.status}` as Parameters<typeof t>[0]) || item.status}
        </span>
      </p>
      {item.summary ? <p className="item-body">{item.summary}</p> : null}
      <div className="item-meta">
        {item.mission_id ? `${item.mission_id} · ` : ''}
        {formatWhen(item.updated_at, locale)}
        {item.artifact_paths.length > 0
          ? ` · ${t('home.artifacts', { count: item.artifact_paths.length })}`
          : ''}
      </div>
      <div className="button-row">
        {item.artifact_paths.length > 0 ? (
          <button
            type="button"
            className="action-button secondary"
            disabled={previewBusyId === item.entry_id}
            onClick={() => void togglePreview(item)}
          >
            {previewId === item.entry_id ? t('home.preview_hide') : t('home.preview')}
          </button>
        ) : null}
        <button
          type="button"
          className="action-button"
          disabled={busyId === item.entry_id || item.status === 'accepted'}
          onClick={() => void recordOutcomeVerdict(item, 'accepted')}
        >
          {t('home.accept')}
        </button>
        <button
          type="button"
          className="action-button secondary"
          disabled={busyId === item.entry_id}
          onClick={() => {
            setChangeFormId(changeFormId === item.entry_id ? null : item.entry_id);
            setChangeNote('');
          }}
        >
          {t('home.request_changes')}
        </button>
        <button
          type="button"
          className="action-button danger"
          disabled={busyId === item.entry_id}
          onClick={() => void recordOutcomeVerdict(item, 'rejected')}
        >
          {t('home.reject')}
        </button>
      </div>
      {previewId === item.entry_id ? (
        <div className="outcome-preview">
          {previewError ? (
            <p className="item-body">{t('home.preview_error', { error: previewError })}</p>
          ) : null}
          {previewData && previewData.files.length === 0 ? (
            <p className="item-meta">{t('home.preview_empty')}</p>
          ) : null}
          {previewData?.files.map((file, index) => (
            <div className="preview-file" key={`${file.name}-${index}`}>
              <p className="preview-name">{file.name}</p>
              {file.kind === 'image' && file.data_uri ? (
                <img className="preview-image" src={file.data_uri} alt={file.name} />
              ) : (file.kind === 'markdown' || file.kind === 'text') &&
                typeof file.content === 'string' ? (
                <pre className="preview-content">{file.content}</pre>
              ) : (
                <p className="item-meta">
                  {t(
                    file.missing
                      ? 'home.preview_missing'
                      : file.too_large
                        ? 'home.preview_too_large'
                        : 'home.preview_unsupported'
                  )}
                </p>
              )}
              {file.truncated ? <p className="item-meta">{t('home.preview_truncated')}</p> : null}
            </div>
          ))}
          {previewData && previewData.total > previewData.shown ? (
            <p className="item-meta">
              {t('home.preview_more', { count: previewData.total - previewData.shown })}
            </p>
          ) : null}
        </div>
      ) : null}
      {changeFormId === item.entry_id ? (
        <form
          className="change-request-form"
          onSubmit={(event) => {
            event.preventDefault();
            void recordOutcomeVerdict(item, 'changes_requested', changeNote);
          }}
        >
          <label className="field-label">
            {t('home.change_prompt')}
            <textarea
              value={changeNote}
              rows={3}
              required
              onChange={(event) => setChangeNote(event.target.value)}
            />
          </label>
          <div className="button-row">
            <button
              type="submit"
              className="action-button"
              disabled={busyId === item.entry_id || !changeNote.trim()}
            >
              {t('home.change_send')}
            </button>
            <button
              type="button"
              className="action-button secondary"
              onClick={() => {
                setChangeFormId(null);
                setChangeNote('');
              }}
            >
              {t('home.change_cancel')}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );

  // Queue order = decision urgency: approvals block others' work, stalled
  // missions and learnings wait on the human alone, deliverables and
  // exceptions can breathe a little longer.
  const queueItems: Array<{
    id: string;
    type: 'approval' | 'hygiene' | 'memory' | 'outcome' | 'exception';
    card: React.ReactNode;
  }> = [
    ...summary.approval_queue.map((item) => ({
      id: `approval-${item.id}`,
      type: 'approval' as const,
      card: renderApprovalCard(item),
    })),
    ...hygiene.map((item) => ({
      id: `hygiene-${item.mission_id}`,
      type: 'hygiene' as const,
      card: renderHygieneCard(item),
    })),
    ...memoryQueue.map((item) => ({
      id: `memory-${item.id}`,
      type: 'memory' as const,
      card: renderMemoryCard(item),
    })),
    ...summary.outcome_feed.map((item) => ({
      id: `outcome-${item.entry_id}`,
      type: 'outcome' as const,
      card: renderOutcomeCard(item),
    })),
    ...summary.exception_feed.map((item) => ({
      id: `exception-${item.id}`,
      type: 'exception' as const,
      card: renderExceptionCard(item),
    })),
  ];

  return (
    <>
      <section className="briefing-card" aria-label={t('home.briefing_label')}>
        <div className="locale-switcher">
          <label>
            {t('locale.label')}
            <select
              value={locale}
              onChange={(event) => setLocale(event.target.value as 'en' | 'ja')}
            >
              <option value="ja">{t('locale.japanese')}</option>
              <option value="en">{t('locale.english')}</option>
            </select>
          </label>
        </div>
        <p className="briefing-sentence">
          {locale === 'ja' ? briefing.sentence_ja : t('home.briefing_fallback')}
        </p>
        <div className="briefing-counts">
          <span>
            <strong>{briefing.counts.pending_approvals}</strong>
            {t('home.approvals_count')}
          </span>
          <span>
            <strong>{briefing.counts.active_missions}</strong>
            {t('home.missions_count')}
          </span>
          <span>
            <strong>{briefing.counts.unread_outcomes}</strong>
            {t('home.outcomes_count')}
          </span>
          <span>
            <strong>{briefing.counts.exceptions}</strong>
            {t('home.exceptions_count')}
          </span>
        </div>
        {briefing.next_action_ja ? (
          <div className="item-meta" style={{ marginTop: 8 }}>
            {t('home.next_action', { value: briefing.next_action_ja })}
          </div>
        ) : null}
      </section>

      {notice ? <div className={`notice${notice.error ? ' error' : ''}`}>{notice.text}</div> : null}

      <section className="pane inquiry-queue" aria-label={t('queue.title')}>
        <h2>{t('queue.title')}</h2>
        <p className="pane-subtitle">{t('queue.description')}</p>
        {queueItems.length === 0 ? (
          <div className="pane-empty">{t('queue.empty')}</div>
        ) : (
          queueItems.map((entry) => (
            <div key={entry.id} className="queue-item">
              <span className={`queue-chip ${entry.type}`}>
                {t(`queue.type.${entry.type}` as Parameters<typeof t>[0])}
              </span>
              {entry.card}
            </div>
          ))
        )}
      </section>

      {responseStatus ? (
        <section className="pane response-status" aria-label={t('home.response_title')}>
          <h2>{t('home.response_title')}</h2>
          <p className="pane-subtitle">{t('home.response_description')}</p>
          <p className={`status-chip${responseStatus.state === 'ready' ? '' : ' attention'}`}>
            {responseStatus.label}
          </p>
          <p className="item-body">{responseStatus.next_action}</p>
          {responseStatus.stale_child_count > 0 ? (
            <p className="item-meta">
              {t('home.response_stale', { count: responseStatus.stale_child_count })}
            </p>
          ) : null}
          {responseStatus.active_tasks.map((task) => (
            <div className="item-meta" key={task.delegation_id}>
              {t('home.response_task', { value: task.task_id || task.delegation_id })}
              {task.backend_name
                ? ` · ${t('home.response_backend', { value: task.backend_name })}`
                : ''}
              {` · ${t('home.response_elapsed', { value: task.elapsed_seconds })}`}
            </div>
          ))}
        </section>
      ) : null}

      <div className="pane-grid">
        <section className="pane" aria-label={t('home.approval_title')}>
          <h2>{t('home.approval_title')}</h2>
          <p className="pane-subtitle">{t('home.approval_description')}</p>
          {summary.approval_queue.length === 0 ? (
            <div className="pane-empty">{t('home.approval_empty')}</div>
          ) : (
            <p className="pane-subtitle">
              {t('home.see_queue', { count: summary.approval_queue.length })}
            </p>
          )}
        </section>

        <section className="pane" aria-label={t('home.request_title')}>
          <h2>{t('home.request_title')}</h2>
          <p className="pane-subtitle">{t('home.request_description')}</p>
          {summary.intent_inbox.length === 0 ? (
            <div className="pane-empty">{t('home.request_empty')}</div>
          ) : (
            summary.intent_inbox.map((item) => (
              <div key={item.mission_id} className="item-card">
                <p className="item-title">
                  {item.title}
                  <span className={`status-chip${item.attention_needed ? ' attention' : ''}`}>
                    {locale === 'ja'
                      ? item.status_ja
                      : t(item.attention_needed ? 'home.needs_attention' : 'home.in_progress')}
                  </span>
                </p>
                {item.success_condition ? (
                  <p className="item-body">
                    {t('home.completed_condition', { value: item.success_condition })}
                  </p>
                ) : null}
                <div className="item-meta">
                  {item.mission_id}
                  {item.updated_at
                    ? ` · ${t('home.last_updated', { value: formatWhen(item.updated_at, locale) })}`
                    : ''}
                </div>
              </div>
            ))
          )}
        </section>

        <section className="pane" aria-label={t('home.outcome_title')}>
          <h2>{t('home.outcome_title')}</h2>
          <p className="pane-subtitle">{t('home.outcome_description')}</p>
          {summary.outcome_feed.length === 0 ? (
            <div className="pane-empty">{t('home.outcome_empty')}</div>
          ) : (
            <p className="pane-subtitle">
              {t('home.see_queue', { count: summary.outcome_feed.length })}
            </p>
          )}
        </section>

        <section className="pane" aria-label={t('home.exception_title')}>
          <h2>{t('home.exception_title')}</h2>
          <p className="pane-subtitle">{t('home.exception_description')}</p>
          {summary.exception_feed.length === 0 ? (
            <div className="pane-empty">{t('home.exception_empty')}</div>
          ) : (
            <p className="pane-subtitle">
              {t('home.see_queue', { count: summary.exception_feed.length })}
            </p>
          )}
        </section>
      </div>
    </>
  );
}
