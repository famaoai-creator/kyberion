'use client';

import * as React from 'react';

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

function formatWhen(value?: string): string {
  if (!value) return '';
  try {
    return new Date(value).toLocaleString('ja-JP', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return value;
  }
}

const OUTCOME_STATUS_JA: Record<string, string> = {
  unread: '未確認',
  read: '確認済み',
  accepted: '受領済み',
  rejected: '差し戻し済み',
  changes_requested: '修正依頼中',
};

export default function ConciergePage() {
  const [summary, setSummary] = React.useState<Summary | null>(null);
  const [notice, setNotice] = React.useState<{ text: string; error?: boolean } | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);

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

  React.useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

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
          text:
            decision === 'approved'
              ? `「${item.title}」を承認いたしました。担当へお伝えします。`
              : `「${item.title}」を差し戻しました。理由の補足が必要な場合はお知らせください。`,
        });
        await refresh();
      } catch (error) {
        setNotice({ text: error instanceof Error ? error.message : String(error), error: true });
      } finally {
        setBusyId(null);
      }
    },
    [refresh]
  );

  const recordOutcomeVerdict = React.useCallback(
    async (
      item: Summary['outcome_feed'][number],
      status: 'accepted' | 'changes_requested' | 'rejected'
    ) => {
      setBusyId(item.entry_id);
      try {
        const note =
          status === 'changes_requested'
            ? window.prompt('修正のご要望をお聞かせください（担当へそのまま伝わります）') || ''
            : '';
        if (status === 'changes_requested' && !note) {
          setBusyId(null);
          return;
        }
        const response = await fetch(`/api/outcomes/${encodeURIComponent(item.entry_id)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status, note }),
        });
        const payload = await response.json();
        if (!response.ok || !payload.ok) throw new Error(payload.error || 'verdict failed');
        setNotice({
          text:
            status === 'accepted'
              ? `「${item.title}」を受領いたしました。`
              : status === 'rejected'
                ? `「${item.title}」を差し戻しました。`
                : `「${item.title}」の修正依頼を担当へ送りました。`,
        });
        await refresh();
      } catch (error) {
        setNotice({ text: error instanceof Error ? error.message : String(error), error: true });
      } finally {
        setBusyId(null);
      }
    },
    [refresh]
  );

  if (loadError) {
    return (
      <div className="notice error">
        申し訳ございません。データの取得に失敗しました: {loadError}
      </div>
    );
  }
  if (!summary) {
    return <div className="pane-empty">本日の状況を確認しております…</div>;
  }

  const briefing = summary.briefing;

  return (
    <>
      <section className="briefing-card" aria-label="本日のご報告">
        <p className="briefing-sentence">{briefing.sentence_ja}</p>
        <div className="briefing-counts">
          <span>
            <strong>{briefing.counts.pending_approvals}</strong>ご承認待ち
          </span>
          <span>
            <strong>{briefing.counts.active_missions}</strong>進行中のご依頼
          </span>
          <span>
            <strong>{briefing.counts.unread_outcomes}</strong>未確認の成果物
          </span>
          <span>
            <strong>{briefing.counts.exceptions}</strong>要確認の例外
          </span>
        </div>
        {briefing.next_action_ja ? (
          <div className="item-meta" style={{ marginTop: 8 }}>
            おすすめの次の一手: {briefing.next_action_ja}
          </div>
        ) : null}
      </section>

      {notice ? <div className={`notice${notice.error ? ' error' : ''}`}>{notice.text}</div> : null}

      <div className="pane-grid">
        <section className="pane" aria-label="ご承認待ち">
          <h2>ご承認待ち</h2>
          <p className="pane-subtitle">
            ご判断が必要な案件です。承認または差し戻しをお選びください。
          </p>
          {summary.approval_queue.length === 0 ? (
            <div className="pane-empty">現在、ご承認待ちの案件はございません。</div>
          ) : (
            summary.approval_queue.map((item) => (
              <div key={item.id} className="item-card">
                <p className="item-title">{item.title}</p>
                {item.reason ? <p className="item-body">{item.reason}</p> : null}
                <div className="item-meta">
                  {item.mission_id ? `${item.mission_id} · ` : ''}
                  {formatWhen(item.requested_at)}
                  {item.expires_at ? ` · 期限 ${formatWhen(item.expires_at)}` : ''}
                </div>
                <div className="button-row">
                  <button
                    type="button"
                    className="action-button"
                    disabled={busyId === item.id}
                    onClick={() => void decideApproval(item, 'approved')}
                  >
                    承認する
                  </button>
                  <button
                    type="button"
                    className="action-button danger"
                    disabled={busyId === item.id}
                    onClick={() => void decideApproval(item, 'rejected')}
                  >
                    差し戻す
                  </button>
                </div>
              </div>
            ))
          )}
        </section>

        <section className="pane" aria-label="ご依頼の状況">
          <h2>ご依頼の状況</h2>
          <p className="pane-subtitle">現在お預かりしているご依頼の進捗です。</p>
          {summary.intent_inbox.length === 0 ? (
            <div className="pane-empty">現在、進行中のご依頼はございません。</div>
          ) : (
            summary.intent_inbox.map((item) => (
              <div key={item.mission_id} className="item-card">
                <p className="item-title">
                  {item.title}
                  <span className={`status-chip${item.attention_needed ? ' attention' : ''}`}>
                    {item.status_ja}
                  </span>
                </p>
                {item.success_condition ? (
                  <p className="item-body">完了条件: {item.success_condition}</p>
                ) : null}
                <div className="item-meta">
                  {item.mission_id}
                  {item.updated_at ? ` · 最終更新 ${formatWhen(item.updated_at)}` : ''}
                </div>
              </div>
            ))
          )}
        </section>

        <section className="pane" aria-label="お届けした成果">
          <h2>お届けした成果</h2>
          <p className="pane-subtitle">
            完成した成果物です。ご確認のうえ、受領・修正依頼をお選びください。
          </p>
          {summary.outcome_feed.length === 0 ? (
            <div className="pane-empty">新しくお届けした成果物はございません。</div>
          ) : (
            summary.outcome_feed.map((item) => (
              <div key={item.entry_id} className="item-card">
                <p className="item-title">
                  {item.title}
                  <span className="status-chip">
                    {OUTCOME_STATUS_JA[item.status] || item.status}
                  </span>
                </p>
                {item.summary ? <p className="item-body">{item.summary}</p> : null}
                <div className="item-meta">
                  {item.mission_id ? `${item.mission_id} · ` : ''}
                  {formatWhen(item.updated_at)}
                  {item.artifact_paths.length > 0
                    ? ` · 成果物 ${item.artifact_paths.length}点`
                    : ''}
                </div>
                <div className="button-row">
                  <button
                    type="button"
                    className="action-button"
                    disabled={busyId === item.entry_id || item.status === 'accepted'}
                    onClick={() => void recordOutcomeVerdict(item, 'accepted')}
                  >
                    受領する
                  </button>
                  <button
                    type="button"
                    className="action-button secondary"
                    disabled={busyId === item.entry_id}
                    onClick={() => void recordOutcomeVerdict(item, 'changes_requested')}
                  >
                    修正を依頼する
                  </button>
                  <button
                    type="button"
                    className="action-button danger"
                    disabled={busyId === item.entry_id}
                    onClick={() => void recordOutcomeVerdict(item, 'rejected')}
                  >
                    差し戻す
                  </button>
                </div>
              </div>
            ))
          )}
        </section>

        <section className="pane" aria-label="ご確認いただきたい例外">
          <h2>ご確認いただきたい例外</h2>
          <p className="pane-subtitle">通常の流れから外れた事象のみをお知らせします。</p>
          {summary.exception_feed.length === 0 ? (
            <div className="pane-empty">現在、例外はございません。順調に進んでおります。</div>
          ) : (
            summary.exception_feed.map((item) => (
              <div key={item.id} className="item-card">
                <p className="item-title">{item.title}</p>
                {item.text ? <p className="item-body">{item.text}</p> : null}
                <div className="item-meta">
                  {item.surface} · {formatWhen(item.created_at)}
                </div>
              </div>
            ))
          )}
        </section>
      </div>
    </>
  );
}
