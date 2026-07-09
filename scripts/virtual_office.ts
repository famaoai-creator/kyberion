#!/usr/bin/env node
/**
 * `pnpm office` — the Virtual Office surface.
 *
 * Renders how the agent organization is ACTUALLY working right now as a
 * self-contained HTML dashboard with an office metaphor:
 *   rooms   = active missions (agent desks inside, task progress on the door)
 *   break room = staffed agents with no open assignment
 *   front desk = customer deals by stage
 *   mail room  = operator inbox / approval queue
 *   bulletin   = ops alerts + process-improvement proposals
 * plus a stats wing: agent×role success rates (retrospective performance
 * index), task-status distribution, and role staffing.
 *
 * Deterministic-first: every number on the wall is computed from files on
 * disk — no LLM involved. Output is a single self-contained HTML file
 * (data inlined at generation time; meta-refresh reloads it), regenerated
 * on demand or with `--watch <seconds>`.
 */
import * as path from 'node:path';
import {
  createStandardYargs,
  listApprovalRequests,
  listCustomerChannelBindings,
  listDeals,
  listInboxEntries,
  listProcessImprovementProposals,
  loadAgentProfileIndex,
  pathResolver,
  safeExistsSync,
  safeReaddir,
  safeReadFile,
  safeWriteFile,
} from '@agent/core';

// ---------- data collection ----------

interface OfficeTask {
  task_id: string;
  status: string;
  role: string;
  agent: string | null;
  description: string;
}

interface OfficeRoom {
  mission_id: string;
  mission_type: string;
  status: string;
  tier: string;
  tasks: OfficeTask[];
}

interface OfficeSnapshot {
  generated_at: string;
  rooms: OfficeRoom[];
  archived_recent: string[];
  agents: Array<{
    agent_id: string;
    roles: string[];
    open_tasks: number;
    state: 'working' | 'review' | 'blocked' | 'idle';
  }>;
  performance: Array<{ agent: string; role: string; samples: number; success_rate: number }>;
  deals: Array<{ deal_id: string; tenant: string; stage: string; summary: string }>;
  inbox_unread: number;
  approvals_pending: number;
  alerts: Array<{ title: string; severity: string }>;
  proposals: Array<{ id: string; status: string; kind: string }>;
  task_status_counts: Record<string, number>;
  role_counts: Record<string, number>;
}

function readJson<T>(filePath: string): T | null {
  try {
    if (!safeExistsSync(filePath)) return null;
    return JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as T;
  } catch {
    return null;
  }
}

function listMissionDirs(): Array<{ missionPath: string; tier: string }> {
  const roots: Array<{ dir: string; tier: string }> = [
    { dir: pathResolver.rootResolve('active/missions'), tier: 'legacy' },
    { dir: pathResolver.rootResolve('active/missions/public'), tier: 'public' },
    { dir: pathResolver.rootResolve('active/missions/confidential'), tier: 'confidential' },
    { dir: pathResolver.rootResolve('active/missions/personal'), tier: 'personal' },
  ];
  const found: Array<{ missionPath: string; tier: string }> = [];
  for (const root of roots) {
    if (!safeExistsSync(root.dir)) continue;
    let entries: string[] = [];
    try {
      entries = safeReaddir(root.dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (['public', 'confidential', 'personal', 'ephemeral'].includes(entry)) continue;
      const missionPath = path.join(root.dir, entry);
      if (safeExistsSync(path.join(missionPath, 'mission-state.json'))) {
        found.push({ missionPath, tier: root.tier });
      }
    }
  }
  return found;
}

const OPEN_STATUSES = new Set(['planned', 'requested', 'rework', 'blocked', 'reviewed']);
const WORKING_STATUSES = new Set(['in_progress', 'dispatched', 'ready']);

export function collectOfficeSnapshot(): OfficeSnapshot {
  const rooms: OfficeRoom[] = [];
  const archivedRecent: Array<{ id: string; mtime: number }> = [];

  for (const { missionPath, tier } of listMissionDirs()) {
    const state = readJson<{ mission_id?: string; status?: string; mission_type?: string }>(
      path.join(missionPath, 'mission-state.json')
    );
    if (!state?.mission_id) continue;
    const status = String(state.status || 'unknown');
    if (['archived', 'completed', 'closed'].includes(status)) {
      archivedRecent.push({ id: state.mission_id, mtime: 0 });
      continue;
    }
    const rawTasks =
      readJson<Array<Record<string, unknown>>>(path.join(missionPath, 'NEXT_TASKS.json')) || [];
    const tasks: OfficeTask[] = rawTasks.map((task) => ({
      task_id: String(task.task_id || '?'),
      status: String(task.status || 'planned'),
      role: String((task.assigned_to as Record<string, unknown>)?.role || '-'),
      agent: (task.assigned_to as Record<string, unknown>)?.agent_id
        ? String((task.assigned_to as Record<string, unknown>).agent_id)
        : null,
      description: String(task.description || '').slice(0, 80),
    }));
    rooms.push({
      mission_id: state.mission_id,
      mission_type: String(state.mission_type || '-'),
      status,
      tier,
      tasks,
    });
  }

  // agent states from open tasks across rooms. Roster is best-effort — a
  // fresh deployment has no profile index yet, and the office must still open.
  let roster: Record<string, unknown> = {};
  try {
    roster = loadAgentProfileIndex() as unknown as Record<string, unknown>;
  } catch {
    roster = {};
  }
  const openByAgent = new Map<string, { open: number; blocked: number; review: number }>();
  const taskStatusCounts: Record<string, number> = {};
  const roleCounts: Record<string, number> = {};
  for (const room of rooms) {
    for (const task of room.tasks) {
      taskStatusCounts[task.status] = (taskStatusCounts[task.status] || 0) + 1;
      if (task.role !== '-') roleCounts[task.role] = (roleCounts[task.role] || 0) + 1;
      if (!task.agent) continue;
      const bucket = openByAgent.get(task.agent) || { open: 0, blocked: 0, review: 0 };
      if (task.status === 'blocked') bucket.blocked += 1;
      else if (task.status === 'reviewed' || task.status === 'review') bucket.review += 1;
      else if (OPEN_STATUSES.has(task.status) || WORKING_STATUSES.has(task.status))
        bucket.open += 1;
      openByAgent.set(task.agent, bucket);
    }
  }
  // task-assigned agents missing from the profile index still get a desk
  const rosterEntries: Array<[string, unknown]> = Object.entries(roster);
  for (const agentId of openByAgent.keys()) {
    if (!(agentId in roster)) rosterEntries.push([agentId, {}]);
  }
  const agents = rosterEntries.map(([agentId, profile]) => {
    const activity = openByAgent.get(agentId) || { open: 0, blocked: 0, review: 0 };
    const state: 'working' | 'review' | 'blocked' | 'idle' =
      activity.blocked > 0
        ? 'blocked'
        : activity.review > 0
          ? 'review'
          : activity.open > 0
            ? 'working'
            : 'idle';
    const record = profile as unknown as Record<string, unknown>;
    const roles = Array.isArray(record.default_team_roles)
      ? (record.default_team_roles as string[])
      : [];
    return {
      agent_id: agentId,
      roles: roles.slice(0, 4),
      open_tasks: activity.open + activity.review + activity.blocked,
      state,
    };
  });

  // performance index (retrospective loop output)
  const performanceFile = readJson<{
    by_agent_role?: Record<
      string,
      { samples: number; success: number; review: number; blocked: number; success_rate: number }
    >;
  }>(pathResolver.shared('observability/retrospectives/agent-performance.json'));
  const performance = Object.entries(performanceFile?.by_agent_role || {})
    .map(([key, record]) => {
      const [agent, role] = key.split('|');
      return { agent, role, samples: record.samples, success_rate: record.success_rate };
    })
    .sort((a, b) => b.samples - a.samples)
    .slice(0, 10);

  // customer front desk
  const tenants = Array.from(new Set(listCustomerChannelBindings().map((b) => b.tenantSlug)));
  const deals = tenants
    .flatMap((tenant) =>
      listDeals(tenant).map((deal) => ({
        deal_id: deal.deal_id,
        tenant,
        stage: deal.stage,
        summary: String(deal.summary || '').slice(0, 60),
      }))
    )
    .slice(0, 12);

  // mail room
  const inboxUnread = listInboxEntries({ limit: 100 }).filter(
    (entry) => entry.status === 'unread'
  ).length;
  const approvalsPending = listApprovalRequests({ status: 'pending' }).length;

  // bulletin board
  const alertLines = safeExistsSync(pathResolver.shared('observability/ops-alerts.jsonl'))
    ? String(
        safeReadFile(pathResolver.shared('observability/ops-alerts.jsonl'), { encoding: 'utf8' })
      )
        .trim()
        .split('\n')
        .slice(-5)
    : [];
  const alerts = alertLines
    .map((line) => {
      try {
        const parsed = JSON.parse(line) as { title?: string; severity?: string };
        return {
          title: String(parsed.title || '').slice(0, 70),
          severity: String(parsed.severity || 'info'),
        };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { title: string; severity: string } => Boolean(entry))
    .reverse();
  let proposals: Array<{ id: string; status: string; kind: string }> = [];
  try {
    proposals = listProcessImprovementProposals()
      .slice(-6)
      .map((proposal) => ({
        id: proposal.proposal_id,
        status: proposal.status,
        kind: proposal.kind,
      }))
      .reverse();
  } catch {
    proposals = [];
  }

  return {
    generated_at: new Date().toISOString(),
    rooms: rooms.sort((a, b) => b.tasks.length - a.tasks.length),
    archived_recent: archivedRecent.slice(-6).map((entry) => entry.id),
    agents: agents.sort((a, b) => b.open_tasks - a.open_tasks),
    performance,
    deals,
    inbox_unread: inboxUnread,
    approvals_pending: approvalsPending,
    alerts,
    proposals,
    task_status_counts: taskStatusCounts,
    role_counts: roleCounts,
  };
}

// ---------- rendering ----------

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const STATE_COLOR: Record<string, string> = {
  working: '#00F2FF',
  review: '#f0abfc',
  blocked: '#f87171',
  idle: '#475569',
};
const STATE_LABEL: Record<string, string> = {
  working: '稼働中',
  review: 'レビュー',
  blocked: 'ブロック',
  idle: '待機',
};
const TASK_COLOR: Record<string, string> = {
  completed: '#4ade80',
  accepted: '#4ade80',
  reviewed: '#f0abfc',
  in_progress: '#00F2FF',
  dispatched: '#00F2FF',
  ready: '#7dd3fc',
  planned: '#64748b',
  requested: '#64748b',
  rework: '#fbbf24',
  blocked: '#f87171',
};

function chip(agent: string, role: string, status: string): string {
  const color = TASK_COLOR[status] || '#64748b';
  return `<span class="chip"><span class="dot" style="background:${color}"></span>${esc(agent)}<em>${esc(role)}</em></span>`;
}

function bar(fraction: number, color: string): string {
  const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  return `<div class="bar"><div class="fill" style="width:${pct}%;background:${color}"></div></div>`;
}

export function renderOfficeHtml(data: OfficeSnapshot, refreshSeconds?: number): string {
  const doneStates = new Set(['completed', 'accepted']);
  const roomsHtml = data.rooms
    .slice(0, 12)
    .map((room) => {
      const done = room.tasks.filter((t) => doneStates.has(t.status)).length;
      const total = room.tasks.length;
      const desks = room.tasks
        .filter((t) => t.agent && !doneStates.has(t.status))
        .slice(0, 8)
        .map((t) => chip(t.agent as string, t.role, t.status))
        .join('');
      return `<div class="room">
        <div class="door"><span class="room-name">${esc(room.mission_id)}</span><span class="badge">${esc(room.mission_type)}</span></div>
        ${total > 0 ? bar(done / total, '#4ade80') : ''}
        <div class="room-meta">${done}/${total} tasks · ${esc(room.status)}</div>
        <div class="desks">${desks || '<span class="empty">(無人 — 割当なし)</span>'}</div>
      </div>`;
    })
    .join('');

  const breakRoom = data.agents
    .filter((agent) => agent.state === 'idle')
    .slice(0, 14)
    .map(
      (agent) =>
        `<span class="chip"><span class="dot" style="background:${STATE_COLOR.idle}"></span>${esc(agent.agent_id)}<em>${esc(agent.roles[0] || '-')}</em></span>`
    )
    .join('');

  const activeAgents = data.agents
    .filter((agent) => agent.state !== 'idle')
    .map(
      (agent) =>
        `<div class="row"><span class="dot" style="background:${STATE_COLOR[agent.state]}"></span><strong>${esc(agent.agent_id)}</strong><span class="muted">${esc(agent.roles.join(', '))}</span><span class="pill" style="border-color:${STATE_COLOR[agent.state]}">${STATE_LABEL[agent.state]} × ${agent.open_tasks}</span></div>`
    )
    .join('');

  const perfHtml = data.performance.length
    ? data.performance
        .map(
          (entry) =>
            `<div class="stat-row"><span class="stat-label">${esc(entry.agent)}<em>${esc(entry.role)}</em></span>${bar(entry.success_rate, entry.success_rate >= 0.7 ? '#4ade80' : entry.success_rate >= 0.4 ? '#fbbf24' : '#f87171')}<span class="stat-val">${Math.round(entry.success_rate * 100)}% <i>(n=${entry.samples})</i></span></div>`
        )
        .join('')
    : '<div class="empty">まだ実績データなし — ミッション完了時の retrospective が蓄積します</div>';

  const statusTotal = Object.values(data.task_status_counts).reduce((a, b) => a + b, 0) || 1;
  const statusHtml = Object.entries(data.task_status_counts)
    .sort((a, b) => b[1] - a[1])
    .map(
      ([status, count]) =>
        `<div class="stat-row"><span class="stat-label">${esc(status)}</span>${bar(count / statusTotal, TASK_COLOR[status] || '#64748b')}<span class="stat-val">${count}</span></div>`
    )
    .join('');

  const rolesHtml = Object.entries(data.role_counts)
    .sort((a, b) => b[1] - a[1])
    .map(([role, count]) => `<span class="pill">${esc(role)} × ${count}</span>`)
    .join(' ');

  const dealsHtml = data.deals.length
    ? data.deals
        .map(
          (deal) =>
            `<div class="row"><span class="pill">${esc(deal.stage)}</span><strong>${esc(deal.deal_id)}</strong><span class="muted">${esc(deal.summary)}</span></div>`
        )
        .join('')
    : '<div class="empty">商談なし</div>';

  const alertsHtml = data.alerts.length
    ? data.alerts
        .map(
          (alert) =>
            `<div class="row"><span class="dot" style="background:${alert.severity === 'critical' ? '#f87171' : alert.severity === 'warning' ? '#fbbf24' : '#7dd3fc'}"></span><span class="muted">${esc(alert.title)}</span></div>`
        )
        .join('')
    : '<div class="empty">アラートなし</div>';

  const proposalsHtml = data.proposals.length
    ? data.proposals
        .map(
          (proposal) =>
            `<div class="row"><span class="pill">${esc(proposal.status)}</span><span class="muted">${esc(proposal.id)} (${esc(proposal.kind)})</span></div>`
        )
        .join('')
    : '<div class="empty">改善提案なし</div>';

  const workingCount = data.agents.filter((a) => a.state === 'working').length;
  const blockedCount = data.agents.filter((a) => a.state === 'blocked').length;

  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<title>Kyberion Virtual Office</title>
${refreshSeconds ? `<meta http-equiv="refresh" content="${refreshSeconds}">` : ''}
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#020617;--surface:#0f172a;--border:#1e293b;--text:#F8FAFC;--muted:#94a3b8;--accent:#00F2FF}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:Inter,'Hiragino Sans','Noto Sans JP',sans-serif;padding:24px}
h1{font-size:20px;letter-spacing:2px}
h2{font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:10px}
header{display:flex;align-items:baseline;gap:18px;margin-bottom:20px;flex-wrap:wrap}
.kpis{display:flex;gap:10px;flex-wrap:wrap}
.kpi{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:6px 14px;font-size:13px}
.kpi b{color:var(--accent);font-size:16px;margin-right:6px}
.stamp{color:var(--muted);font-size:12px;margin-left:auto}
main{display:grid;grid-template-columns:minmax(0,2fr) minmax(280px,1fr);gap:20px}
section{margin-bottom:22px}
.floor{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:14px}
.room{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:14px;box-shadow:0 0 24px rgba(0,242,255,.04)}
.door{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px}
.room-name{font-weight:700;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.badge{font-size:10px;border:1px solid var(--border);border-radius:999px;padding:2px 8px;color:var(--muted);flex-shrink:0}
.room-meta{font-size:11px;color:var(--muted);margin:6px 0}
.desks{display:flex;flex-wrap:wrap;gap:6px}
.chip{display:inline-flex;align-items:center;gap:6px;background:#020617;border:1px solid var(--border);border-radius:999px;padding:3px 10px;font-size:11.5px}
.chip em{color:var(--muted);font-style:normal;font-size:10px}
.dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.panel{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:14px;margin-bottom:16px}
.row{display:flex;align-items:center;gap:8px;padding:5px 0;font-size:12.5px;border-bottom:1px solid rgba(30,41,59,.6)}
.row:last-child{border-bottom:0}
.muted{color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pill{border:1px solid var(--border);border-radius:999px;padding:1px 9px;font-size:10.5px;color:var(--muted);flex-shrink:0}
.bar{height:7px;background:#1e293b;border-radius:4px;overflow:hidden;flex:1;min-width:60px}
.fill{height:100%;border-radius:4px}
.stat-row{display:flex;align-items:center;gap:10px;padding:4px 0;font-size:12px}
.stat-label{width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0}
.stat-label em{color:var(--muted);font-style:normal;margin-left:5px;font-size:10.5px}
.stat-val{width:80px;text-align:right;flex-shrink:0}
.stat-val i{color:var(--muted);font-style:normal;font-size:10px}
.empty{color:var(--muted);font-size:12px;padding:6px 0}
.archive{color:var(--muted);font-size:11px;line-height:1.9}
</style></head><body>
<header>
  <h1>🏢 KYBERION VIRTUAL OFFICE</h1>
  <div class="kpis">
    <span class="kpi"><b>${data.rooms.filter((r) => r.tasks.length > 0).length}</b>タスクありルーム<i style="color:var(--muted);font-style:normal"> / ${data.rooms.length} 未アーカイブ</i></span>
    <span class="kpi"><b>${workingCount}</b>稼働エージェント</span>
    <span class="kpi"><b>${blockedCount}</b>ブロック中</span>
    <span class="kpi"><b>${data.inbox_unread}</b>未読 inbox</span>
    <span class="kpi"><b>${data.approvals_pending}</b>承認待ち</span>
  </div>
  <span class="stamp">generated ${esc(data.generated_at)}${refreshSeconds ? ` · auto-refresh ${refreshSeconds}s` : ''}</span>
</header>
<main>
<div>
  <section><h2>Mission Floor — 稼働中の部屋(タスク数上位12)</h2>
    <div class="floor">${roomsHtml || '<div class="empty">稼働中のミッションはありません</div>'}</div>
  </section>
  <section><h2>Break Room — 待機中</h2>
    <div class="panel"><div class="desks">${breakRoom || '<span class="empty">全員稼働中</span>'}</div></div>
  </section>
  <section><h2>Front Desk — 商談</h2>
    <div class="panel">${dealsHtml}</div>
  </section>
</div>
<div>
  <section><h2>On Duty — 稼働状況</h2>
    <div class="panel">${activeAgents || '<div class="empty">稼働中のエージェントなし</div>'}</div>
  </section>
  <section><h2>成功率 — agent × role(retrospective 実績)</h2>
    <div class="panel">${perfHtml}</div>
  </section>
  <section><h2>タスク状態分布</h2>
    <div class="panel">${statusHtml || '<div class="empty">オープンタスクなし</div>'}</div>
  </section>
  <section><h2>ロール構成</h2>
    <div class="panel">${rolesHtml || '<div class="empty">-</div>'}</div>
  </section>
  <section><h2>Bulletin — アラート</h2>
    <div class="panel">${alertsHtml}</div>
  </section>
  <section><h2>Bulletin — 改善提案キュー</h2>
    <div class="panel">${proposalsHtml}</div>
  </section>
  <section><h2>Archive 書庫(直近)</h2>
    <div class="panel archive">${data.archived_recent.map(esc).join('<br>') || '-'}</div>
  </section>
</div>
</main>
</body></html>`;
}

// ---------- main ----------

const DEFAULT_OUT = 'active/shared/exports/virtual-office/office.html';

async function generateOnce(outPath: string, refreshSeconds?: number): Promise<string> {
  const snapshot = collectOfficeSnapshot();
  const html = renderOfficeHtml(snapshot, refreshSeconds);
  const resolved = pathResolver.rootResolve(outPath);
  safeWriteFile(resolved, html, { encoding: 'utf8', mkdir: true });
  return resolved;
}

async function main(): Promise<void> {
  const argv = await createStandardYargs()
    .option('out', { type: 'string', default: DEFAULT_OUT })
    .option('watch', {
      type: 'number',
      describe: 'regenerate every N seconds (page auto-refreshes)',
    })
    .parseSync();

  const watchSeconds = argv.watch && argv.watch > 0 ? Math.max(5, argv.watch) : undefined;
  const written = await generateOnce(String(argv.out), watchSeconds);
  console.log(`[virtual-office] ${written}`);
  console.log(`[virtual-office] open it: open "${written}"`);
  if (watchSeconds) {
    console.log(`[virtual-office] watching — regenerating every ${watchSeconds}s (Ctrl-C to stop)`);
    setInterval(() => {
      void generateOnce(String(argv.out), watchSeconds).catch((error) =>
        console.error(`[virtual-office] regeneration failed: ${error}`)
      );
    }, watchSeconds * 1000);
  }
}

const isDirectRun =
  process.argv[1]?.endsWith('virtual_office.ts') || process.argv[1]?.endsWith('virtual_office.js');
if (isDirectRun) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
