'use client';

import * as React from 'react';
import { useConciergeI18n } from '../lib/use-concierge-i18n';

type Summary = {
  generated_at: string;
  briefing: {
    sentence_ja: string;
    counts: {
      active_missions: number;
      pending_approvals: number;
      unread_outcomes: number;
      exceptions: number;
    };
    next_action_ja?: string;
  };
  intent_inbox: Array<{
    mission_id: string;
    title: string;
    status_ja: string;
    attention_needed: boolean;
    updated_at?: string;
    success_condition?: string;
  }>;
  approval_queue: Array<{
    id: string;
    channel: string;
    storage_channel: string;
    title: string;
    reason: string;
    requested_at: string;
    expires_at?: string;
    mission_id?: string;
  }>;
  outcome_feed: Array<{
    entry_id: string;
    title: string;
    summary: string;
    artifact_paths: string[];
    mission_id?: string;
    status: string;
    updated_at: string;
  }>;
  exception_feed: Array<{
    id: string;
    title: string;
    text: string;
    surface: string;
    created_at: string;
  }>;
};

type ResponseStatus = {
  state: 'ready' | 'waiting' | 'queued';
  label: string;
  next_action: string;
  active_count: number;
  queued_count: number;
  stale_child_count: number;
  active_tasks: Array<{
    delegation_id: string;
    mission_id?: string;
    task_id?: string;
    backend_name?: string;
    elapsed_seconds: number;
  }>;
};

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
  const [summary, setSummary] = React.useState<Summary | null>(null);
  const [notice, setNotice] = React.useState<{ text: string; error?: boolean } | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [responseStatus, setResponseStatus] = React.useState<ResponseStatus | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      const response = await fetch('/api/summary', { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || 'summary failed');
      setSummary(payload.summary);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const refreshResponseStatus = React.useCallback(async () => {
    try {
      const response = await fetch('/api/response-status', { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || 'response status failed');
      setResponseStatus(payload.response_status);
    } catch {
      // The response-status panel is advisory; the main concierge remains usable.
    }
  }, []);

  React.useEffect(() => {
    void refresh();
    void refreshResponseStatus();
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
          setSummary(JSON.parse((event as MessageEvent).data) as Summary);
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
    return () => {
      source?.close();
      if (fallbackTimer) clearInterval(fallbackTimer);
      clearInterval(responseTimer);
    };
  }, [refresh, refreshResponseStatus]);

  const decideApproval = React.useCallback(
    async (item: Summary['approval_queue'][number], decision: 'approved' | 'rejected') => {
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
        const payload = await response.json();
        if (!response.ok || !payload.ok) throw new Error(payload.error || 'approval failed');
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
      item: Summary['outcome_feed'][number],
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
        const payload = await response.json();
        if (!response.ok || !payload.ok) throw new Error(payload.error || 'verdict failed');
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

  if (loadError) {
    return <div className="notice error">{t('home.load_error', { error: loadError })}</div>;
  }
  if (!summary) {
    return <div className="pane-empty">{t('home.loading')}</div>;
  }

  const briefing = summary.briefing;

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
            summary.approval_queue.map((item) => (
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
            ))
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
            summary.outcome_feed.map((item) => (
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
            ))
          )}
        </section>

        <section className="pane" aria-label={t('home.exception_title')}>
          <h2>{t('home.exception_title')}</h2>
          <p className="pane-subtitle">{t('home.exception_description')}</p>
          {summary.exception_feed.length === 0 ? (
            <div className="pane-empty">{t('home.exception_empty')}</div>
          ) : (
            summary.exception_feed.map((item) => (
              <div key={item.id} className="item-card">
                <p className="item-title">{item.title}</p>
                {item.text ? <p className="item-body">{item.text}</p> : null}
                <div className="item-meta">
                  {item.surface} · {formatWhen(item.created_at, locale)}
                </div>
              </div>
            ))
          )}
        </section>
      </div>
    </>
  );
}
