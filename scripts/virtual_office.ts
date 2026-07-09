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
  listAgentRuntimeSnapshots,
  listTaskSessions,
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
    display_name: string;
    roles: string[];
    open_tasks: number;
    state: 'working' | 'review' | 'blocked' | 'idle';
    current_story: string;
    current_goal: string;
    current_next_step: string;
    current_signal: string;
    runtime_status: string;
    provider?: string;
    model_id?: string;
  }>;
  live_sessions: Array<{
    surface: string;
    agentIds: string[];
    status: string;
    task_type: string;
    goal: string;
    headline: string;
    note: string;
    next_step: string;
    updated_at: string;
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
const SESSION_ACTIVE_STATUSES = new Set([
  'awaiting_instruction',
  'collecting_requirements',
  'planning',
  'awaiting_confirmation',
  'executing',
  'verifying',
  'blocked',
  'paused',
]);

function humanizeId(value: string): string {
  return value
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (ch) => ch.toUpperCase())
    .replace(/\bId\b/g, 'ID');
}

function trimText(value: string, max = 72): string {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function summarizeSession(session: {
  surface: string;
  status: string;
  task_type: string;
  goal: { summary: string };
  payload?: Record<string, unknown>;
  history: Array<{ type: string; text: string }>;
  completion_summary?: { next_step?: string };
  work_loop?: { workflow_design?: { stage?: string }; intent?: { label?: string } };
  updated_at: string;
}): {
  surface: string;
  agentIds: string[];
  status: string;
  task_type: string;
  goal: string;
  headline: string;
  note: string;
  next_step: string;
  updated_at: string;
} {
  const goal = trimText(session.goal?.summary || '対応中', 64);
  const latestHistory = [...session.history].reverse().find((entry) => entry.text)?.text || '';
  const nextStep = trimText(session.completion_summary?.next_step || '', 64);
  const taskLabel = humanizeId(session.work_loop?.intent?.label || session.task_type || 'task');
  const statusHeadline: Record<string, string> = {
    awaiting_instruction: '次の指示待ち',
    collecting_requirements: '要件を集めています',
    planning: '段取りを組んでいます',
    awaiting_confirmation: '確認待ちです',
    executing: '手を動かしています',
    verifying: '仕上がりを確かめています',
    blocked: '詰まりをほどいています',
    paused: 'いったん止めています',
  };
  const headline = statusHeadline[session.status] || `${taskLabel} を進行中`;
  const noteParts = [trimText(latestHistory, 72), nextStep && `次: ${nextStep}`].filter(
    Boolean
  ) as string[];
  const note = noteParts.length ? noteParts.join(' · ') : trimText(goal, 72);
  return {
    surface: session.surface,
    agentIds: extractSessionAgentIds(session),
    status: session.status,
    task_type: session.task_type,
    goal,
    headline,
    note,
    next_step: nextStep,
    updated_at: session.updated_at,
  };
}

function extractSessionAgentIds(session: {
  surface: string;
  payload?: Record<string, unknown>;
}): string[] {
  const candidates = [
    session.surface,
    session.payload?.agent_id,
    session.payload?.agentId,
    session.payload?.assigned_agent_id,
    session.payload?.owner_agent_id,
  ];
  return candidates.map((value) => (typeof value === 'string' ? value.trim() : '')).filter(Boolean);
}

function summarizeRuntimePrompt(snapshot: {
  logs?: Array<{ content: string; type: string }>;
}): string {
  const latest =
    snapshot.logs
      ?.slice()
      .reverse()
      .find((entry) => entry.content)?.content || '';
  return trimText(latest, 72);
}

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
  const taskSessions = listTaskSessions();
  const activeSessions = taskSessions
    .filter((session) => SESSION_ACTIVE_STATUSES.has(session.status))
    .slice(0, 24)
    .map((session) => summarizeSession(session));
  const sessionByAgent = new Map<string, ReturnType<typeof summarizeSession>>();
  for (const session of activeSessions) {
    for (const agentId of session.agentIds) {
      if (!sessionByAgent.has(agentId)) sessionByAgent.set(agentId, session);
    }
  }
  const runtimeSnapshots = listAgentRuntimeSnapshots();
  const runtimeByAgent = new Map(
    runtimeSnapshots.map((snapshot) => [snapshot.agent.agentId, snapshot])
  );
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
    const runtime = runtimeByAgent.get(agentId);
    const surfaceSession = sessionByAgent.get(agentId);
    const runtimeStatus = runtime?.agent?.status || 'unknown';
    const currentGoal = trimText(surfaceSession?.goal || '', 64);
    const currentNextStep = trimText(surfaceSession?.next_step || '', 64);
    const currentSignal = surfaceSession?.note || summarizeRuntimePrompt(runtime || { logs: [] });
    const currentStory =
      surfaceSession?.headline ||
      (runtimeStatus === 'busy'
        ? 'いま手を動かしています'
        : activity.blocked > 0
          ? '詰まりをほどいています'
          : activity.review > 0
            ? '仕上げを見ています'
            : activity.open > 0
              ? '作業を進めています'
              : '席を空けています');
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
      display_name: humanizeId(agentId),
      roles: roles.slice(0, 4),
      open_tasks: activity.open + activity.review + activity.blocked,
      state,
      current_story: currentStory,
      current_goal: currentGoal || '現在は割当を待っています',
      current_next_step: currentNextStep || '次の一手はまだ記録されていません',
      current_signal: currentSignal || 'システム上の信号はまだありません',
      runtime_status: runtimeStatus,
      provider: runtime?.agent?.provider,
      model_id: runtime?.agent?.modelId,
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
    live_sessions: activeSessions
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, 10),
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

/** Stable, distinct body color per agent (hash → curated palette). */
const BODY_PALETTE = [
  '#38bdf8',
  '#a78bfa',
  '#fb923c',
  '#34d399',
  '#f472b6',
  '#facc15',
  '#f87171',
  '#7dd3fc',
  '#c084fc',
  '#4ade80',
  '#fbbf24',
  '#e879f9',
];
function bodyColor(agentId: string): string {
  let hash = 0;
  for (const ch of agentId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return BODY_PALETTE[hash % BODY_PALETTE.length];
}

function roleAccessory(role: string): string {
  const r = role.toLowerCase();
  if (r.includes('implement') || r.includes('developer'))
    return '<path d="M25 26 Q45 8 65 26 L65 30 L25 30 Z" fill="#facc15" stroke="#a16207" stroke-width="1.5"/><rect x="40" y="10" width="10" height="6" rx="2" fill="#facc15" stroke="#a16207" stroke-width="1"/>';
  if (r.includes('review'))
    return '<g stroke="#0f172a" stroke-width="2" fill="rgba(148,163,184,.25)"><circle cx="37" cy="38" r="7"/><circle cx="55" cy="38" r="7"/><line x1="44" y1="38" x2="48" y2="38"/></g>';
  if (r.includes('qa') || r.includes('test'))
    return '<g transform="translate(66 44) rotate(30)"><circle cx="0" cy="0" r="7" fill="rgba(125,211,252,.3)" stroke="#0f172a" stroke-width="2"/><line x1="5" y1="5" x2="13" y2="13" stroke="#0f172a" stroke-width="3" stroke-linecap="round"/></g>';
  if (r.includes('plan') || r.includes('strateg'))
    return '<g transform="translate(64 50) rotate(-25)"><rect x="-2" y="-9" width="4" height="16" rx="1" fill="#fbbf24" stroke="#a16207" stroke-width="1"/><path d="M-2 7 L0 12 L2 7 Z" fill="#0f172a"/></g>';
  if (r.includes('owner'))
    return '<path d="M32 22 L38 12 L45 20 L52 12 L58 22 Z" fill="#facc15" stroke="#a16207" stroke-width="1.5"/>';
  if (r.includes('liaison') || r.includes('surface'))
    return '<path d="M28 36 Q28 20 45 20 Q62 20 62 36" fill="none" stroke="#0f172a" stroke-width="3"/><rect x="24" y="34" width="7" height="10" rx="3" fill="#0f172a"/><rect x="59" y="34" width="7" height="10" rx="3" fill="#0f172a"/>';
  return '';
}

/**
 * A little round character. state drives the face + animation class + prop:
 * working = at a laptop, typing bounce; review = scanning a document;
 * blocked = trembling with a red "!" ; idle = coffee + steam.
 */
function characterSvg(agentId: string, role: string, state: string): string {
  const color = bodyColor(agentId);
  const mouth =
    state === 'blocked'
      ? '<path d="M39 52 Q45 47 51 52" fill="none" stroke="#0f172a" stroke-width="2" stroke-linecap="round"/>'
      : state === 'idle'
        ? '<path d="M39 50 Q45 56 51 50" fill="none" stroke="#0f172a" stroke-width="2" stroke-linecap="round"/>'
        : '<path d="M40 51 Q45 54 50 51" fill="none" stroke="#0f172a" stroke-width="2" stroke-linecap="round"/>';
  const eyes =
    state === 'review'
      ? '<g class="scan"><circle cx="37" cy="40" r="3" fill="#0f172a"/><circle cx="53" cy="40" r="3" fill="#0f172a"/></g>'
      : '<g><circle cx="37" cy="40" r="3" fill="#0f172a"/><circle cx="53" cy="40" r="3" fill="#0f172a"/><rect class="blink" x="32" y="36" width="26" height="8" rx="4" fill="' +
        color +
        '"/></g>';
  const prop =
    state === 'working'
      ? '<g><rect x="22" y="76" width="46" height="5" rx="2" fill="#334155"/><path d="M30 76 L34 64 L56 64 L60 76 Z" fill="#64748b"/><rect x="36" y="66" width="18" height="9" rx="1.5" fill="#0ea5e9" opacity=".85"/></g>'
      : state === 'review'
        ? '<g class="doc"><rect x="30" y="62" width="30" height="20" rx="2" fill="#f1f5f9"/><line x1="34" y1="67" x2="56" y2="67" stroke="#94a3b8" stroke-width="1.6"/><line x1="34" y1="71" x2="56" y2="71" stroke="#94a3b8" stroke-width="1.6"/><line x1="34" y1="75" x2="50" y2="75" stroke="#94a3b8" stroke-width="1.6"/></g>'
        : state === 'idle'
          ? '<g><rect x="56" y="66" width="12" height="10" rx="2" fill="#f8fafc"/><rect x="68" y="68" width="4" height="5" rx="2" fill="none" stroke="#f8fafc" stroke-width="1.6"/><path class="steam" d="M60 62 Q62 58 60 54" fill="none" stroke="#94a3b8" stroke-width="1.6" stroke-linecap="round"/><path class="steam s2" d="M65 62 Q63 58 65 54" fill="none" stroke="#94a3b8" stroke-width="1.6" stroke-linecap="round"/></g>'
          : '';
  const bubble =
    state === 'blocked'
      ? '<g class="alarm"><circle cx="72" cy="18" r="11" fill="#f87171"/><text x="72" y="24" text-anchor="middle" font-size="16" font-weight="900" fill="#0f172a">!</text></g>'
      : state === 'working'
        ? '<g><rect x="60" y="8" width="26" height="14" rx="7" fill="#0f172a" stroke="#1e293b"/><circle class="d1" cx="68" cy="15" r="2" fill="#00F2FF"/><circle class="d2" cx="73" cy="15" r="2" fill="#00F2FF"/><circle class="d3" cx="78" cy="15" r="2" fill="#00F2FF"/></g>'
        : state === 'idle'
          ? '<text class="zzz" x="70" y="18" font-size="12" fill="#64748b" font-weight="700">zzz</text>'
          : '';
  return `<svg class="char ${state}" viewBox="0 0 90 90" width="86" height="86" aria-hidden="true">
    <g class="body-wrap">
      <ellipse cx="45" cy="50" rx="24" ry="26" fill="${color}"/>
      <ellipse cx="45" cy="44" rx="20" ry="16" fill="rgba(255,255,255,.35)"/>
      ${eyes}${mouth}${roleAccessory(role)}
    </g>
    ${prop}${bubble}
  </svg>`;
}

const STATE_LABEL: Record<string, string> = {
  working: '作業中',
  review: 'レビュー中',
  blocked: '困っています',
  idle: '休憩中',
};
const TASK_STATE: Record<string, string> = {
  completed: 'done',
  accepted: 'done',
  reviewed: 'review',
  in_progress: 'working',
  dispatched: 'working',
  ready: 'working',
  planned: 'waiting',
  requested: 'waiting',
  rework: 'working',
  blocked: 'blocked',
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

function bar(fraction: number, color: string): string {
  const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  return `<div class="bar"><div class="fill" style="width:${pct}%;background:${color}"></div></div>`;
}

function desk(agent: string, role: string, taskStatus: string, saying: string): string {
  const state =
    TASK_STATE[taskStatus] === 'blocked'
      ? 'blocked'
      : TASK_STATE[taskStatus] === 'review'
        ? 'review'
        : 'working';
  return `<div class="desk-seat">
    ${characterSvg(agent, role, state)}
    <div class="who">${esc(agent)}</div>
    <div class="role-tag">${esc(role)}</div>
    ${saying ? `<div class="saying">「${esc(saying)}」</div>` : ''}
  </div>`;
}

export function renderOfficeHtml(data: OfficeSnapshot, refreshSeconds?: number): string {
  const doneStates = new Set(['completed', 'accepted']);
  const roomsHtml = data.rooms
    .slice(0, 9)
    .map((room) => {
      const done = room.tasks.filter((t) => doneStates.has(t.status)).length;
      const total = room.tasks.length;
      const seats = room.tasks
        .filter((t) => t.agent && !doneStates.has(t.status))
        .slice(0, 4)
        .map((t) => desk(t.agent as string, t.role, t.status, t.description.slice(0, 34)))
        .join('');
      return `<div class="room">
        <div class="door"><span class="room-name">${esc(room.mission_id)}</span><span class="badge">${esc(room.mission_type)}</span></div>
        ${total > 0 ? bar(done / total, '#4ade80') : ''}
        <div class="room-meta">進捗 ${done}/${total}</div>
        <div class="desks">${seats || '<span class="empty">(無人)</span>'}</div>
      </div>`;
    })
    .join('');

  const breakRoom = data.agents
    .filter((agent) => agent.state === 'idle')
    .slice(0, 10)
    .map(
      (agent) => `<div class="desk-seat">
        ${characterSvg(agent.agent_id, agent.roles[0] || '', 'idle')}
        <div class="who">${esc(agent.agent_id)}</div>
        <div class="role-tag">${esc(agent.roles[0] || '-')}</div>
      </div>`
    )
    .join('');

  const legend = `<div class="legend">
    <span>${characterSvg('legend-a', 'implementer', 'working')}<b>作業中</b><i>手を動かしています</i></span>
    <span>${characterSvg('legend-b', 'reviewer', 'review')}<b>レビュー中</b><i>成果物を確認中</i></span>
    <span>${characterSvg('legend-c', 'qa', 'blocked')}<b>困っています</b><i>人の判断待ち</i></span>
    <span>${characterSvg('legend-d', 'planner', 'idle')}<b>休憩中</b><i>次の仕事待ち</i></span>
  </div>`;

  const perfHtml = data.performance.length
    ? data.performance
        .map(
          (entry) =>
            `<div class="stat-row"><span class="stat-label">${esc(entry.agent)}<em>${esc(entry.role)}</em></span>${bar(entry.success_rate, entry.success_rate >= 0.7 ? '#4ade80' : entry.success_rate >= 0.4 ? '#fbbf24' : '#f87171')}<span class="stat-val">${Math.round(entry.success_rate * 100)}% <i>(n=${entry.samples})</i></span></div>`
        )
        .join('')
    : '<div class="empty">まだ実績データなし — ミッション完了ごとに蓄積されます</div>';

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

  // Now Working — plain-language answer to 「いま誰が何をしているの?」
  const nowWorkingRows = data.agents
    .filter((agent) => agent.state !== 'idle')
    .map(
      (agent) => `<div class="now-row">
        <div class="now-char">${characterSvg(agent.agent_id, agent.roles[0] || '', agent.state)}</div>
        <div class="now-body">
          <div class="now-head"><strong>${esc(agent.display_name)}</strong>
            <span class="pill">${STATE_LABEL[agent.state]}</span>
            ${agent.provider ? `<span class="pill">${esc(agent.provider)}${agent.model_id ? ` · ${esc(agent.model_id)}` : ''}</span>` : ''}
          </div>
          <div class="now-story">${esc(agent.current_story)}</div>
          <div class="now-detail">🎯 ${esc(agent.current_goal)}<br>👉 ${esc(agent.current_next_step)}</div>
        </div>
      </div>`
    )
    .join('');
  const sessionRows = data.live_sessions
    .map(
      (session) => `<div class="row"><span class="pill">${esc(session.surface)}</span>
        <span class="muted">${esc(session.headline || session.goal)} — ${esc(session.agentIds.join(', '))}</span></div>`
    )
    .join('');
  const nowWorkingHtml = `<section><h2>Now Working — いま何をしている?</h2>
    <div class="panel">${nowWorkingRows || '<div class="empty">全員休憩中です</div>'}
    ${sessionRows ? `<div class="sessions">${sessionRows}</div>` : ''}</div>
  </section>`;

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
header{display:flex;align-items:baseline;gap:18px;margin-bottom:14px;flex-wrap:wrap}
.kpis{display:flex;gap:10px;flex-wrap:wrap}
.kpi{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:6px 14px;font-size:13px}
.kpi b{color:var(--accent);font-size:16px;margin-right:6px}
.stamp{color:var(--muted);font-size:12px;margin-left:auto}
main{display:grid;grid-template-columns:minmax(0,2.2fr) minmax(280px,1fr);gap:20px}
section{margin-bottom:22px}
.floor{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:14px}
.room{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:14px;box-shadow:0 0 24px rgba(0,242,255,.04)}
.door{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px}
.room-name{font-weight:700;font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.badge{font-size:10px;border:1px solid var(--border);border-radius:999px;padding:2px 8px;color:var(--muted);flex-shrink:0}
.room-meta{font-size:11px;color:var(--muted);margin:6px 0}
.desks{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end}
.desk-seat{width:110px;text-align:center}
.who{font-size:10.5px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.role-tag{font-size:9.5px;color:var(--muted)}
.saying{font-size:9.5px;color:var(--muted);margin-top:3px;line-height:1.4;min-height:2.6em}
.legend{display:flex;gap:14px;flex-wrap:wrap;background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:8px 14px;margin-bottom:16px}
.legend span{display:flex;align-items:center;gap:6px;font-size:11.5px}
.legend svg{width:44px;height:44px}
.legend b{white-space:nowrap}
.now-row{display:flex;gap:12px;align-items:flex-start;padding:8px 0;border-bottom:1px solid rgba(30,41,59,.6)}
.now-row:last-child{border-bottom:0}
.now-char svg{width:56px;height:56px}
.now-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:13px}
.now-story{font-size:12.5px;margin:3px 0;color:var(--text)}
.now-detail{font-size:11px;color:var(--muted);line-height:1.7}
.sessions{margin-top:8px;border-top:1px dashed var(--border);padding-top:6px}
.legend i{color:var(--muted);font-style:normal;font-size:10.5px;white-space:nowrap}
.panel{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:14px;margin-bottom:16px}
.row{display:flex;align-items:center;gap:8px;padding:5px 0;font-size:12.5px;border-bottom:1px solid rgba(30,41,59,.6)}
.row:last-child{border-bottom:0}
.muted{color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pill{border:1px solid var(--border);border-radius:999px;padding:1px 9px;font-size:10.5px;color:var(--muted);flex-shrink:0}
.dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.bar{height:7px;background:#1e293b;border-radius:4px;overflow:hidden;flex:1;min-width:60px}
.fill{height:100%;border-radius:4px}
.stat-row{display:flex;align-items:center;gap:10px;padding:4px 0;font-size:12px}
.stat-label{width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0}
.stat-label em{color:var(--muted);font-style:normal;margin-left:5px;font-size:10.5px}
.stat-val{width:80px;text-align:right;flex-shrink:0}
.stat-val i{color:var(--muted);font-style:normal;font-size:10px}
.empty{color:var(--muted);font-size:12px;padding:6px 0}
.archive{color:var(--muted);font-size:11px;line-height:1.9}
/* ---- character life ---- */
.char.working .body-wrap{animation:type .5s ease-in-out infinite}
.char.review .body-wrap{animation:nod 2.4s ease-in-out infinite}
.char.blocked{animation:tremble .18s linear infinite}
.char.idle .body-wrap{animation:sway 3.5s ease-in-out infinite}
@keyframes type{0%,100%{transform:translateY(0)}50%{transform:translateY(1.6px)}}
@keyframes nod{0%,100%{transform:rotate(0)}50%{transform:rotate(2.5deg)}}
@keyframes tremble{0%{transform:translateX(0)}25%{transform:translateX(-1.2px)}75%{transform:translateX(1.2px)}100%{transform:translateX(0)}}
@keyframes sway{0%,100%{transform:rotate(-1.5deg)}50%{transform:rotate(1.5deg)}}
.blink{opacity:0;animation:blink 4s infinite}
@keyframes blink{0%,94%,100%{opacity:0}96%,98%{opacity:1}}
.scan{animation:scan 2s ease-in-out infinite}
@keyframes scan{0%,100%{transform:translateX(-2px)}50%{transform:translateX(2px)}}
.d1{animation:dots 1.2s infinite}
.d2{animation:dots 1.2s .2s infinite}
.d3{animation:dots 1.2s .4s infinite}
@keyframes dots{0%,100%{opacity:.2}40%{opacity:1}}
.steam{animation:steam 2.2s ease-in-out infinite;opacity:.7}
.steam.s2{animation-delay:.7s}
@keyframes steam{0%{transform:translateY(0);opacity:.7}100%{transform:translateY(-5px);opacity:0}}
.zzz{animation:zzz 2.8s ease-in-out infinite}
@keyframes zzz{0%,100%{opacity:.3;transform:translateY(0)}50%{opacity:1;transform:translateY(-3px)}}
.alarm{animation:alarm 1s ease-in-out infinite}
@keyframes alarm{0%,100%{opacity:1}50%{opacity:.55}}
</style></head><body>
<header>
  <h1>🏢 KYBERION VIRTUAL OFFICE</h1>
  <div class="kpis">
    <span class="kpi"><b>${data.rooms.filter((r) => r.tasks.length > 0).length}</b>タスクありルーム<i style="color:var(--muted);font-style:normal"> / ${data.rooms.length} 未アーカイブ</i></span>
    <span class="kpi"><b>${workingCount}</b>作業中</span>
    <span class="kpi"><b>${blockedCount}</b>困っている</span>
    <span class="kpi"><b>${data.inbox_unread}</b>未読 inbox</span>
    <span class="kpi"><b>${data.approvals_pending}</b>承認待ち</span>
  </div>
  <span class="stamp">generated ${esc(data.generated_at)}${refreshSeconds ? ` · auto-refresh ${refreshSeconds}s` : ''}</span>
</header>
${legend}
<main>
<div>
  ${nowWorkingHtml}
  <section><h2>Mission Floor — 稼働中の部屋(タスク数上位)</h2>
    <div class="floor">${roomsHtml || '<div class="empty">稼働中のミッションはありません</div>'}</div>
  </section>
  <section><h2>Break Room — 休憩室</h2>
    <div class="panel"><div class="desks">${breakRoom || '<span class="empty">全員稼働中</span>'}</div></div>
  </section>
  <section><h2>Front Desk — 商談</h2>
    <div class="panel">${dealsHtml}</div>
  </section>
</div>
<div>
  <section><h2>成功率 — agent × role(実績)</h2>
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
      void generateOnce(String(argv.out), watchSeconds)
        .then((writtenPath) => {
          console.log(`[virtual-office] refreshed ${writtenPath} @ ${new Date().toISOString()}`);
        })
        .catch((error) => console.error(`[virtual-office] regeneration failed: ${error}`));
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
