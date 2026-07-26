'use client';

import * as React from 'react';

type Attention = {
  event_id: string;
  mission_id?: string;
  task_id?: string;
  agent_id?: string;
  kind: string;
  title: string;
  reason: string;
  next_action: string;
};

type CollaborationProjection = {
  generated_at: string;
  partial: boolean;
  status_flags: Array<'sequence_gap' | 'unknown_event' | 'stale_runtime'>;
  sequence_gaps: Array<{
    source: string;
    previous_seq: number;
    expected_seq: number;
    actual_seq: number;
  }>;
  overview: {
    events: number;
    missions: number;
    tasks: number;
    agents: number;
    active: number;
    blocked: number;
    waiting_human: number;
    review_pending: number;
    failures: number;
  };
  events: Array<{
    event_id: string;
    ts: string;
    mission_id?: string;
    task_id?: string;
    agent_id?: string;
    kind: string;
    summary: string;
    source: string;
  }>;
  edges: Array<{ from: string; to: string; kind: string; event_id: string }>;
  attention: Attention[];
};

const KIND_LABEL: Record<string, string> = {
  dispatch: '発行',
  claim: '担当',
  spawn: '起動',
  progress: '進行',
  waiting: '待機',
  blocked: 'ブロック',
  handoff: '引き継ぎ',
  approval: '承認待ち',
  review: 'レビュー待ち',
  artifact: '成果物',
  retry: '再試行',
  failure: '失敗',
  completion: '完了',
  unknown: '不明',
};

function Stat({
  label,
  value,
  tone = 'kb-text-primary',
}: {
  label: string;
  value: number;
  tone?: string;
}) {
  return (
    <div className="rounded-lg border kb-border-subtle kb-surface-raised px-3 py-2">
      <div className="text-[9px] uppercase tracking-[0.16em] kb-text-muted">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${tone}`}>{value}</div>
    </div>
  );
}

/** Read-only projection of human/agent collaboration state. */
export function AgentCollaborationBoard({
  tenant = '',
  onOpenMission,
  onOpenView,
}: {
  tenant?: string;
  onOpenMission?: (missionId: string) => void;
  onOpenView?: (
    viewId: 'secret-approval-queue' | 'runtime-topology-map' | 'mission-control-plane'
  ) => void;
}) {
  const [projection, setProjection] = React.useState<CollaborationProjection | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      const query = tenant ? `?tenant=${encodeURIComponent(tenant)}` : '';
      const response = await fetch(`/api/collaboration${query}`, { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok || !payload.ok)
        throw new Error(payload.error || '協調状態の取得に失敗しました');
      setProjection(payload.projection);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [tenant]);

  React.useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const overview = projection?.overview;
  return (
    <section className="rounded-2xl border kb-border-accent kb-surface-accent p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.2em] kb-text-accent">
            Agent Collaboration
          </div>
          <div className="mt-1 text-[11px] kb-text-muted">
            人間・親エージェント・子エージェントの因果関係を同じ時系列で表示
          </div>
        </div>
        {projection?.partial ? (
          <span className="rounded-full border kb-status-warning-border kb-status-warning-surface px-2 py-1 text-[10px] kb-status-warning">
            状態に注意が必要です
          </span>
        ) : null}
        {projection?.status_flags.length ? (
          <div className="flex flex-wrap gap-1 text-[10px] kb-status-warning">
            {projection.status_flags.map((flag) => (
              <span key={flag} className="rounded-full border kb-status-warning-border px-2 py-1">
                {flag === 'sequence_gap'
                  ? '欠番検知'
                  : flag === 'stale_runtime'
                    ? 'runtime stale'
                    : '未知イベント'}
              </span>
            ))}
          </div>
        ) : null}
        {projection?.status_flags.includes('stale_runtime') && onOpenView ? (
          <button
            type="button"
            onClick={() => onOpenView('runtime-topology-map')}
            className="rounded border kb-status-warning-border kb-status-warning-surface px-2 py-1 text-[10px] kb-status-warning hover:kb-status-warning-surface"
          >
            Runtime の鮮度を確認
          </button>
        ) : null}
        {error ? <span className="text-[11px] kb-status-negative">{error}</span> : null}
      </div>

      {overview ? (
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
          <Stat label="Mission" value={overview.missions} />
          <Stat label="Task" value={overview.tasks} />
          <Stat label="Agent" value={overview.agents} />
          <Stat label="進行" value={overview.active} tone="kb-text-accent" />
          <Stat label="ブロック" value={overview.blocked} tone="kb-status-warning" />
          <Stat label="人間待ち" value={overview.waiting_human} tone="kb-status-warning" />
          <Stat label="レビュー" value={overview.review_pending} tone="kb-status-info" />
          <Stat label="失敗" value={overview.failures} tone="kb-status-negative" />
        </div>
      ) : (
        <div className="mt-4 text-[11px] kb-text-muted">協調イベントを読み込んでいます。</div>
      )}

      {projection && projection.attention.length > 0 ? (
        <div className="mt-4">
          <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em] kb-status-warning">
            Attention / 次の人間アクション
          </div>
          <div className="grid gap-2 lg:grid-cols-2">
            {projection.attention.slice(0, 6).map((item) => (
              <div
                key={item.event_id}
                className="rounded-xl border kb-status-warning-border kb-status-warning-surface px-3 py-2 text-[11px]"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold kb-status-warning">{item.title}</span>
                  <span className="rounded-full border kb-border-subtle px-2 text-[9px] kb-text-muted">
                    {KIND_LABEL[item.kind] || item.kind}
                  </span>
                  <span className="ml-auto text-[9px] kb-text-muted">
                    {item.mission_id || 'mission未指定'}
                  </span>
                </div>
                <div className="mt-1 kb-text-secondary">理由: {item.reason}</div>
                <div className="mt-1 kb-text-accent">次: {item.next_action}</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {item.mission_id && onOpenMission ? (
                    <button
                      type="button"
                      onClick={() => onOpenMission(item.mission_id as string)}
                      className="rounded border kb-border-accent kb-surface-accent px-2 py-1 text-[10px] kb-text-accent hover:kb-surface-accent"
                    >
                      ミッションを開く
                    </button>
                  ) : null}
                  {item.kind === 'approval' && onOpenView ? (
                    <button
                      type="button"
                      onClick={() => onOpenView('secret-approval-queue')}
                      className="rounded border kb-status-warning-border kb-status-warning-surface px-2 py-1 text-[10px] kb-status-warning hover:kb-status-warning-surface"
                    >
                      承認キューを開く
                    </button>
                  ) : null}
                  {item.kind === 'failure' && onOpenView ? (
                    <button
                      type="button"
                      onClick={() => onOpenView('runtime-topology-map')}
                      className="rounded border kb-status-negative-border kb-status-negative-surface px-2 py-1 text-[10px] kb-status-negative hover:kb-status-negative-surface"
                    >
                      Runtime を確認
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {projection && projection.events.length > 0 ? (
        <div className="mt-4 grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
          <div>
            <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em] kb-text-muted">
              Timeline
            </div>
            <div className="grid gap-1">
              {projection.events.slice(0, 8).map((event) => (
                <div
                  key={event.event_id}
                  className="flex gap-2 rounded-lg border kb-border-subtle kb-surface-sunken px-3 py-2 text-[10px]"
                >
                  <span className="w-14 shrink-0 kb-text-muted">{event.ts.slice(11, 19)}</span>
                  <span className="rounded-full border kb-border-accent px-2 kb-text-accent">
                    {KIND_LABEL[event.kind] || event.kind}
                  </span>
                  <span className="min-w-0 truncate kb-text-secondary">{event.summary}</span>
                  <span className="ml-auto shrink-0 kb-text-muted">
                    {event.agent_id || event.source}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em] kb-text-muted">
              Handoff Graph
            </div>
            <div className="grid gap-1">
              {projection.edges.slice(-8).map((edge) => (
                <div
                  key={`${edge.event_id}:${edge.from}:${edge.to}`}
                  className="rounded-lg border kb-border-subtle kb-surface-sunken px-3 py-2 text-[10px] kb-text-secondary"
                >
                  <span className="kb-text-accent">{edge.from}</span>
                  <span className="mx-2 kb-text-muted">→</span>
                  <span className="kb-status-info">{edge.to}</span>
                  <span className="ml-2 kb-text-muted">{KIND_LABEL[edge.kind] || edge.kind}</span>
                </div>
              ))}
              {projection.edges.length === 0 ? (
                <div className="text-[11px] kb-text-muted">関係グラフはまだありません。</div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
