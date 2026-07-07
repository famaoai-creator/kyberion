'use client';

import * as React from 'react';

type Blocker = { kind: string; reason: string };
type Entry = {
  agent_id: string;
  team_role?: string;
  mission_id?: string;
  tenant_slug?: string;
  item_id: string;
  title: string;
  status: string;
  phase?: string;
  blockers: Blocker[];
};
type Board = {
  generated_at: string;
  entries: Entry[];
  agents: Array<{ agent_id: string; active: number; blocked: number; in_review: number }>;
};
type WorkItem = {
  item_id: string;
  title: string;
  status: string;
  assignee_peer_id?: string;
  labels: string[];
  metadata?: Record<string, unknown>;
};

const STATUS_LABEL: Record<string, string> = {
  backlog: 'Backlog',
  ready: 'Ready',
  in_progress: '進行中',
  review: 'レビュー',
  done: '完了',
};

/** どのエージェントが今何をしていて、どこがブロッカーか(V2)。 */
export function AgentOpsBoards() {
  const [board, setBoard] = React.useState<Board | null>(null);
  const [items, setItems] = React.useState<WorkItem[]>([]);
  const [statuses, setStatuses] = React.useState<string[]>([]);
  const [tenant, setTenant] = React.useState('');
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      const [activityResponse, itemsResponse] = await Promise.all([
        fetch(`/api/agent-activity${tenant ? `?tenant=${encodeURIComponent(tenant)}` : ''}`, {
          cache: 'no-store',
        }),
        fetch('/api/workitems', { cache: 'no-store' }),
      ]);
      const activity = await activityResponse.json();
      const workitems = await itemsResponse.json();
      if (activity.ok) setBoard(activity.board);
      if (workitems.ok) {
        setItems(workitems.items);
        setStatuses(workitems.statuses);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [tenant]);

  React.useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const moveItem = React.useCallback(
    async (itemId: string, status: string) => {
      setBusyId(itemId);
      try {
        const response = await fetch('/api/workitems', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ itemId, status }),
        });
        const payload = await response.json();
        if (!response.ok || !payload.ok) throw new Error(payload.error || 'move failed');
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId(null);
      }
    },
    [refresh]
  );

  const tenants = React.useMemo(
    () => [...new Set((board?.entries || []).map((entry) => entry.tenant_slug).filter(Boolean))],
    [board]
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <div className="text-xs font-bold uppercase tracking-[0.2em] text-white/60">
          Agent Activity
        </div>
        <select
          value={tenant}
          onChange={(event) => setTenant(event.target.value)}
          className="rounded border border-white/10 bg-black/30 px-2 py-1 text-[11px] text-white/80"
        >
          <option value="">全テナント</option>
          {tenants.map((slug) => (
            <option key={slug} value={slug as string}>
              {slug}
            </option>
          ))}
        </select>
        {error ? <span className="text-[11px] text-red-300">{error}</span> : null}
      </div>

      {/* エージェント別サマリ */}
      <div className="flex flex-wrap gap-2">
        {(board?.agents || []).map((agent) => (
          <div
            key={agent.agent_id}
            className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-[11px]"
          >
            <span className="font-bold text-white/90">{agent.agent_id}</span>
            <span className="ml-2 text-cyan-300">稼働 {agent.active}</span>
            <span className="ml-2 text-amber-300">ブロック {agent.blocked}</span>
            <span className="ml-2 text-white/50">レビュー待ち {agent.in_review}</span>
          </div>
        ))}
        {(board?.agents || []).length === 0 ? (
          <div className="text-[11px] text-white/40">アクティブなエージェント作業はありません。</div>
        ) : null}
      </div>

      {/* 現在のタスクとブロッカー */}
      <div className="grid gap-2">
        {(board?.entries || []).map((entry) => (
          <div
            key={entry.item_id}
            className="rounded-xl border border-white/8 bg-black/20 px-4 py-3 text-[12px]"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-bold text-white/90">{entry.agent_id}</span>
              {entry.team_role ? (
                <span className="rounded-full border border-white/10 px-2 text-[10px] text-white/50">
                  {entry.team_role}
                </span>
              ) : null}
              <span className="text-white/60">{entry.title}</span>
              <span className="ml-auto rounded-full border border-cyan-400/20 px-2 text-[10px] text-cyan-200/80">
                {STATUS_LABEL[entry.status] || entry.status}
              </span>
            </div>
            <div className="mt-1 text-[10px] text-white/40">
              {entry.mission_id}
              {entry.phase ? ` · phase: ${entry.phase}` : ''}
              {entry.tenant_slug ? ` · tenant: ${entry.tenant_slug}` : ''}
            </div>
            {entry.blockers.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {entry.blockers.map((blocker, index) => (
                  <span
                    key={index}
                    className={`rounded-lg px-2 py-1 text-[10px] ${
                      blocker.kind === 'review_wait'
                        ? 'bg-white/10 text-white/60'
                        : 'bg-amber-500/15 text-amber-200'
                    }`}
                  >
                    🚧 {blocker.reason}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>

      {/* 看板ボード */}
      <div className="text-xs font-bold uppercase tracking-[0.2em] text-white/60">
        Work Items 看板
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {statuses.map((column) => (
          <div key={column} className="rounded-xl border border-white/8 bg-black/20 p-2">
            <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-white/50">
              {STATUS_LABEL[column] || column} (
              {items.filter((item) => item.status === column).length})
            </div>
            <div className="flex flex-col gap-2">
              {items
                .filter((item) => item.status === column)
                .map((item) => {
                  const columnIndex = statuses.indexOf(column);
                  return (
                    <div
                      key={item.item_id}
                      className="rounded-lg border border-white/10 bg-white/[0.04] p-2 text-[11px]"
                    >
                      <div className="text-white/85">{item.title}</div>
                      <div className="mt-1 text-[9px] text-white/40">
                        {item.assignee_peer_id || '未割当'}
                        {item.metadata?.phase ? ` · ${String(item.metadata.phase)}` : ''}
                      </div>
                      <div className="mt-1 flex gap-1">
                        {columnIndex > 0 ? (
                          <button
                            type="button"
                            disabled={busyId === item.item_id}
                            onClick={() => void moveItem(item.item_id, statuses[columnIndex - 1])}
                            className="rounded bg-white/10 px-2 text-[10px] text-white/70 hover:bg-white/20"
                          >
                            ←
                          </button>
                        ) : null}
                        {columnIndex < statuses.length - 1 ? (
                          <button
                            type="button"
                            disabled={busyId === item.item_id}
                            onClick={() => void moveItem(item.item_id, statuses[columnIndex + 1])}
                            className="rounded bg-cyan-500/20 px-2 text-[10px] text-cyan-100 hover:bg-cyan-500/30"
                          >
                            →
                          </button>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
