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
  tone = 'text-white/80',
}: {
  label: string;
  value: number;
  tone?: string;
}) {
  return (
    <div className="rounded-lg border border-white/8 bg-white/[0.04] px-3 py-2">
      <div className="text-[9px] uppercase tracking-[0.16em] text-white/40">{label}</div>
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
    <section className="rounded-2xl border border-cyan-400/15 bg-cyan-500/[0.04] p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.2em] text-cyan-100/80">
            Agent Collaboration
          </div>
          <div className="mt-1 text-[11px] text-white/45">
            人間・親エージェント・子エージェントの因果関係を同じ時系列で表示
          </div>
        </div>
        {projection?.partial ? (
          <span className="rounded-full border border-amber-300/20 bg-amber-400/10 px-2 py-1 text-[10px] text-amber-100">
            状態に注意が必要です
          </span>
        ) : null}
        {projection?.status_flags.length ? (
          <div className="flex flex-wrap gap-1 text-[10px] text-amber-100/80">
            {projection.status_flags.map((flag) => (
              <span key={flag} className="rounded-full border border-amber-300/20 px-2 py-1">
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
            className="rounded border border-amber-300/20 bg-amber-400/10 px-2 py-1 text-[10px] text-amber-100 hover:bg-amber-400/20"
          >
            Runtime の鮮度を確認
          </button>
        ) : null}
        {error ? <span className="text-[11px] text-red-300">{error}</span> : null}
      </div>

      {overview ? (
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
          <Stat label="Mission" value={overview.missions} />
          <Stat label="Task" value={overview.tasks} />
          <Stat label="Agent" value={overview.agents} />
          <Stat label="進行" value={overview.active} tone="text-cyan-200" />
          <Stat label="ブロック" value={overview.blocked} tone="text-amber-200" />
          <Stat label="人間待ち" value={overview.waiting_human} tone="text-yellow-200" />
          <Stat label="レビュー" value={overview.review_pending} tone="text-violet-200" />
          <Stat label="失敗" value={overview.failures} tone="text-red-200" />
        </div>
      ) : (
        <div className="mt-4 text-[11px] text-white/40">協調イベントを読み込んでいます。</div>
      )}

      {projection && projection.attention.length > 0 ? (
        <div className="mt-4">
          <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-amber-100/70">
            Attention / 次の人間アクション
          </div>
          <div className="grid gap-2 lg:grid-cols-2">
            {projection.attention.slice(0, 6).map((item) => (
              <div
                key={item.event_id}
                className="rounded-xl border border-amber-300/15 bg-amber-400/[0.06] px-3 py-2 text-[11px]"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-amber-100">{item.title}</span>
                  <span className="rounded-full border border-white/10 px-2 text-[9px] text-white/50">
                    {KIND_LABEL[item.kind] || item.kind}
                  </span>
                  <span className="ml-auto text-[9px] text-white/40">
                    {item.mission_id || 'mission未指定'}
                  </span>
                </div>
                <div className="mt-1 text-white/65">理由: {item.reason}</div>
                <div className="mt-1 text-cyan-100/70">次: {item.next_action}</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {item.mission_id && onOpenMission ? (
                    <button
                      type="button"
                      onClick={() => onOpenMission(item.mission_id as string)}
                      className="rounded border border-cyan-300/20 bg-cyan-400/10 px-2 py-1 text-[10px] text-cyan-100 hover:bg-cyan-400/20"
                    >
                      ミッションを開く
                    </button>
                  ) : null}
                  {item.kind === 'approval' && onOpenView ? (
                    <button
                      type="button"
                      onClick={() => onOpenView('secret-approval-queue')}
                      className="rounded border border-yellow-300/20 bg-yellow-400/10 px-2 py-1 text-[10px] text-yellow-100 hover:bg-yellow-400/20"
                    >
                      承認キューを開く
                    </button>
                  ) : null}
                  {item.kind === 'failure' && onOpenView ? (
                    <button
                      type="button"
                      onClick={() => onOpenView('runtime-topology-map')}
                      className="rounded border border-red-300/20 bg-red-400/10 px-2 py-1 text-[10px] text-red-100 hover:bg-red-400/20"
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
            <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-white/50">
              Timeline
            </div>
            <div className="grid gap-1">
              {projection.events.slice(0, 8).map((event) => (
                <div
                  key={event.event_id}
                  className="flex gap-2 rounded-lg border border-white/6 bg-black/15 px-3 py-2 text-[10px]"
                >
                  <span className="w-14 shrink-0 text-white/35">{event.ts.slice(11, 19)}</span>
                  <span className="rounded-full border border-cyan-300/15 px-2 text-cyan-100/70">
                    {KIND_LABEL[event.kind] || event.kind}
                  </span>
                  <span className="min-w-0 truncate text-white/70">{event.summary}</span>
                  <span className="ml-auto shrink-0 text-white/35">
                    {event.agent_id || event.source}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-white/50">
              Handoff Graph
            </div>
            <div className="grid gap-1">
              {projection.edges.slice(-8).map((edge) => (
                <div
                  key={`${edge.event_id}:${edge.from}:${edge.to}`}
                  className="rounded-lg border border-white/6 bg-black/15 px-3 py-2 text-[10px] text-white/60"
                >
                  <span className="text-cyan-100/75">{edge.from}</span>
                  <span className="mx-2 text-white/30">→</span>
                  <span className="text-violet-100/75">{edge.to}</span>
                  <span className="ml-2 text-white/35">{KIND_LABEL[edge.kind] || edge.kind}</span>
                </div>
              ))}
              {projection.edges.length === 0 ? (
                <div className="text-[11px] text-white/35">関係グラフはまだありません。</div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
