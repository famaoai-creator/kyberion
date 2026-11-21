/**
 * Governed read loaders. Every function here is synchronous and may do
 * heavy file I/O or spawn `herdr` — they run inside the data worker, never
 * on the Ink render thread (NFR-RESP; lesson from MSN-TUI-SIMPLE-MOD).
 *
 * Each source degrades independently: a failing source records a health
 * entry and leaves its slice empty instead of failing the whole frame.
 */
import * as path from 'node:path';
import {
  buildMissionStatusView,
  listMissionSummaries,
  type MissionSummary,
} from '@agent/core/mission/mission-read-model';
import {
  collectOperatorHomeSummary,
  type OperatorHomeScopeFilter,
  type OperatorHomeSummary,
} from '@agent/core/surface/operator-home-summary';
import { currentScope, type ScopeContext } from '@agent/core/scope-context';
import {
  renderDecisionCardLines,
  viewDecisionCard,
} from '@agent/core/governance/approval-decision-card';
import type { ApprovalRequestRecord } from '@agent/core/governance/approval-store';
import { buildAgentCollaborationProjection } from '@agent/core/agent/agent-collaboration-projection';
import { composeCollaborationTree } from '@agent/core/agent/agent-collaboration-tree';
import { HerdrRuntimeClient } from '@agent/core/agent/agent-pane-runtime-herdr';
import { safeExistsSync } from '@agent/core/secure-io';
import { readJsonIfPresent } from '@agent/core/foundation';
import type { SupportedLocale } from '@agent/core/locale';
import { phaseForMission } from '../model/attention.js';
import type {
  AgentState,
  AgentTile,
  DeckSnapshot,
  DecisionItem,
  MissionDetail,
  DeckMissionRow,
  SourceHealth,
  TaskProgress,
} from '../model/types.js';
import { EMPTY_SNAPSHOT } from '../model/types.js';

export const AGENT_TAIL_LINES = 12;
/**
 * Link an agent to a mission by a known mission id appearing in its name or
 * working directory (worktrees are named after the mission). Matches whole
 * ids only (`MSN-A-1` does not match inside `MSN-A-10`); the longest wins.
 */
export function linkMission(
  text: string,
  knownMissionIds: ReadonlySet<string>
): string | undefined {
  const hay = text.toUpperCase();
  let best: string | undefined;
  for (const id of knownMissionIds) {
    const needle = id.toUpperCase();
    let from = 0;
    for (let at = hay.indexOf(needle, from); at >= 0; at = hay.indexOf(needle, from)) {
      const after = hay[at + needle.length] ?? '';
      const before = at > 0 ? hay[at - 1]! : '';
      if (!/[A-Z0-9]/u.test(after) && !/[A-Z0-9]/u.test(before)) {
        if (!best || id.length > best.length) best = id;
        break;
      }
      from = at + 1;
    }
  }
  return best;
}

export interface LoaderDeps {
  scope: () => ScopeContext;
  homeSummary: (scope: OperatorHomeScopeFilter) => OperatorHomeSummary;
  missions: (scope: ReturnType<typeof missionSummaryScope>) => MissionSummary[];
  herdr: () => Pick<HerdrRuntimeClient, 'listAgents' | 'readAgent' | 'listPanes'>;
  collaborationWaitingOnHuman: () => number;
}

export function missionSummaryScope(scope: ScopeContext) {
  return {
    tier: scope.tier,
    tenantSlug: scope.tenant_slug || (scope.tier === 'public' ? undefined : null),
    organizationId: scope.organization_id,
    projectId: scope.project_id,
  } as const;
}

/** Authoritative runtime scope → read filter. UI filters may only narrow this. */
export function homeScopeFilter(scope: ScopeContext): OperatorHomeScopeFilter {
  return {
    tiers: [scope.tier],
    ...(scope.tenant_slug
      ? { tenantSlugs: [scope.tenant_slug] }
      : scope.tier === 'public'
        ? { tenantSlugs: 'all' as const }
        : { tenantSlugs: [] }),
    ...(scope.organization_id ? { organizationIds: [scope.organization_id] } : {}),
    ...(scope.project_id ? { projectIds: [scope.project_id] } : {}),
  };
}

export const defaultLoaderDeps: LoaderDeps = {
  scope: () => currentScope(),
  homeSummary: (scope) => collectOperatorHomeSummary({ limit: 20, scope }),
  missions: (scope) => listMissionSummaries(undefined, scope),
  herdr: () => new HerdrRuntimeClient(),
  collaborationWaitingOnHuman: () => {
    const tree = composeCollaborationTree(
      buildAgentCollaborationProjection({ limit: 200, bounded: { recentDays: 7 } })
    );
    return tree.stats.humans_waited_on;
  },
};

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function attempt<T>(health: SourceHealth[], source: string, fallback: T, run: () => T): T {
  try {
    const value = run();
    health.push({ source, ok: true });
    return value;
  } catch (err) {
    health.push({ source, ok: false, detail: errorText(err).split('\n')[0] });
    return fallback;
  }
}

function scopeLabel(scope: ScopeContext): string {
  const parts: string[] = [scope.tier];
  if (scope.tenant_slug) parts.push(scope.tenant_slug);
  if (scope.organization_id) parts.push(scope.organization_id);
  if (scope.project_id) parts.push(scope.project_id);
  return parts.join(' / ');
}

function approvalMissionId(record: ApprovalRequestRecord): string | undefined {
  const loose = record as unknown as {
    source?: { missionId?: string };
    accountability?: { missionId?: string };
  };
  return loose.source?.missionId ?? loose.accountability?.missionId;
}

export function toDecision(record: ApprovalRequestRecord, locale?: SupportedLocale): DecisionItem {
  const view = viewDecisionCard(record, { locale });
  return {
    id: record.id,
    title: view.title || record.title,
    question: view.question,
    recommendation: view.recommendation,
    reasons: view.reasons ?? [],
    ifNoResponse: view.ifNoResponse,
    reversible: Boolean(view.reversible),
    level: view.level,
    requestedBy: record.requestedByDisplayName ?? record.requestedBy,
    requestedAt: record.requestedAt,
    missionId: approvalMissionId(record),
    cardLines: renderDecisionCardLines(view, locale),
  };
}

export function normalizeAgentState(raw: string | undefined): AgentState {
  const value = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (value === 'idle' || value === 'working' || value === 'blocked' || value === 'done') {
    return value;
  }
  if (['error', 'failed', 'dead', 'stopped', 'exited', 'terminated'].includes(value)) return 'done';
  return 'unknown';
}

/** Last non-empty lines of an agent's terminal, bounded. */
export function tailOf(text: string, lines = AGENT_TAIL_LINES): string[] {
  const all = text.replace(/\r/g, '').split('\n');
  while (all.length > 0 && all[all.length - 1]!.trim() === '') all.pop();
  return all.slice(-lines);
}

function loadAgents(
  deps: LoaderDeps,
  knownMissionIds: Set<string>,
  /** Under a tenant scope only agents linked to an in-scope mission are shown. */
  scopedToMissions = false
): { agents: AgentTile[]; available: boolean; reason?: string } {
  let client: ReturnType<LoaderDeps['herdr']>;
  let infos: ReturnType<HerdrRuntimeClient['listAgents']>;
  try {
    client = deps.herdr();
    infos = client.listAgents();
  } catch (err) {
    return { agents: [], available: false, reason: errorText(err).split('\n')[0] };
  }
  let cwdByPane = new Map<string, string>();
  try {
    cwdByPane = new Map(
      client
        .listPanes()
        .filter((pane) => pane.cwd)
        .map((pane) => [pane.pane_id, pane.cwd as string])
    );
  } catch {
    // cwd is only used to link an agent to a mission worktree
  }
  const agents = infos.map((info): AgentTile => {
    const target = info.name || info.pane_id;
    const cwd = cwdByPane.get(info.pane_id) ?? '';
    const missionId = linkMission(`${info.name ?? ''} ${cwd}`, knownMissionIds);
    let tail: string[] = [];
    try {
      tail = tailOf(client.readAgent(target, AGENT_TAIL_LINES * 2));
    } catch (err) {
      tail = [`(${errorText(err).split('\n')[0]})`];
    }
    return {
      target,
      name: info.name || (cwd ? path.basename(cwd) : info.pane_id),
      provider: info.agent,
      state: normalizeAgentState(info.agent_status),
      ...(missionId ? { missionId } : {}),
      tail,
    };
  });
  return {
    agents: scopedToMissions ? agents.filter((agent) => agent.missionId) : agents,
    available: true,
  };
}

export function loadSnapshot(
  options: { locale?: SupportedLocale; includeAgents?: boolean } = {},
  deps: LoaderDeps = defaultLoaderDeps
): DeckSnapshot {
  const health: SourceHealth[] = [];
  const scope = attempt<ScopeContext | undefined>(health, 'scope', undefined, () => deps.scope());
  if (!scope) {
    // Fail closed: without a resolved scope nothing is read or shown.
    return { ...EMPTY_SNAPSHOT, generatedAt: new Date().toISOString(), health };
  }
  const home = attempt<OperatorHomeSummary | undefined>(health, 'home', undefined, () =>
    deps.homeSummary(homeScopeFilter(scope))
  );
  const summaries = attempt<MissionSummary[]>(health, 'missions', [], () =>
    deps.missions(missionSummaryScope(scope))
  );

  const active = new Map((home?.activeMissions ?? []).map((m) => [m.missionId, m]));
  const missions: DeckMissionRow[] = summaries.map((summary) => {
    const extra = active.get(summary.id);
    return {
      id: summary.id,
      status: summary.status,
      tier: summary.tier,
      tenantSlug: summary.tenantSlug,
      goal: extra?.goalSummary,
      successCondition: extra?.successCondition,
      missionType: extra?.missionType,
      updatedAt: extra?.updatedAt,
      lastEvent: summary.lastEvent,
      checkpoints: summary.checkpoints,
      artifactCount: extra?.artifactCount ?? 0,
    };
  });

  const decisions = attempt<DecisionItem[]>(health, 'approvals', [], () =>
    (home?.pendingApprovals ?? []).map((record) =>
      toDecision(record as ApprovalRequestRecord, options.locale)
    )
  );

  const waitingOnHuman = attempt(health, 'collaboration', 0, () =>
    deps.collaborationWaitingOnHuman()
  );

  const agentResult =
    options.includeAgents === false
      ? { agents: [], available: false, reason: 'disabled' }
      : loadAgents(deps, new Set(missions.map((m) => m.id)), Boolean(scope.tenant_slug));
  health.push({
    source: 'agents',
    ok: agentResult.available,
    ...(agentResult.reason ? { detail: agentResult.reason } : {}),
  });

  const next = home?.nextAction as
    { title?: string; reason?: string; suggested_command?: string } | undefined;

  return {
    generatedAt: new Date().toISOString(),
    scopeLabel: scopeLabel(scope),
    statusLabel: home?.statusLabel ?? '',
    missions,
    decisions,
    agents: agentResult.agents,
    waitingOnHuman,
    agentsAvailable: agentResult.available,
    ...(agentResult.reason ? { agentsUnavailableReason: agentResult.reason } : {}),
    ...(next?.title
      ? { nextAction: { title: next.title, reason: next.reason, command: next.suggested_command } }
      : {}),
    health,
  };
}

interface RawTask {
  task_id?: string;
  description?: string;
  status?: string;
  deliverable?: string;
}

function readTasks(missionPath: string): TaskProgress[] {
  const file = path.join(missionPath, 'NEXT_TASKS.json');
  const parsed = readJsonIfPresent<unknown>(file);
  if (parsed === null) return [];
  const list = (
    Array.isArray(parsed) ? parsed : ((parsed as { tasks?: unknown[] }).tasks ?? [])
  ) as RawTask[];
  return list.map((task) => ({
    id: String(task.task_id ?? ''),
    title: String(task.description ?? task.task_id ?? '')
      .split(/[(（]/u)[0]!
      .trim(),
    status: String(task.status ?? 'planned'),
    ...(task.deliverable
      ? {
          deliverable: task.deliverable,
          deliverablePresent: safeExistsSync(path.join(missionPath, task.deliverable)),
        }
      : {}),
  }));
}

export function loadMissionDetail(id: string, row?: DeckMissionRow): MissionDetail | undefined {
  const view = buildMissionStatusView(id);
  if (!view) return undefined;
  const state = view.state as unknown as {
    status?: string;
    tier?: string;
    mission_type?: string;
    intent?: { goal_summary?: string; success_condition?: string };
    outcome_contract?: { requested_result?: string; success_criteria?: string[] };
    assigned_persona?: string;
    tenant_slug?: string;
    git?: { branch?: string };
  };
  const goal = row?.goal ?? state.intent?.goal_summary ?? state.outcome_contract?.requested_result;
  const successCondition =
    row?.successCondition ??
    state.intent?.success_condition ??
    state.outcome_contract?.success_criteria?.join(' / ');
  const tasks = view.missionPath ? readTasks(view.missionPath) : [];
  const evidence = tasks
    .filter((task) => task.deliverable && task.deliverablePresent)
    .map((task) => task.deliverable as string);
  const context: MissionDetail['context'] = [];
  const push = (label: MissionDetail['context'][number]['label'], value: string | undefined) => {
    if (value) context.push({ label, value });
  };
  push('tier', state.tier);
  push('tenant', state.tenant_slug);
  push('type', state.mission_type);
  push('owner', state.assigned_persona);
  return {
    id,
    phase: phaseForMission(String(state.status ?? row?.status ?? ''), Boolean(goal)),
    goal,
    successCondition,
    nextAction: view.nextAction,
    tasks,
    evidence,
    history: (view.recentHistory ?? []).slice(-6).map((entry) => {
      const loose = entry as { ts?: string; timestamp?: string; event?: string; note?: string };
      return {
        at: loose.ts ?? loose.timestamp,
        event: String(loose.event ?? ''),
        note: loose.note,
      };
    }),
    context,
  };
}
