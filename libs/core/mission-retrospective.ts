import {
  appendJsonLine,
  parseSafeJsonInput,
  readJsonIfPresent as readFoundationJsonIfPresent,
} from './foundation/json.js';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathResolver, findMissionPath } from './path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
} from './secure-io.js';
import { logger } from './core.js';
import { getReasoningBackend } from './reasoning-backend.js';
import { notifyOperator } from './operator-notifications.js';
import { recordAgentRoleOutcomes } from './agent-performance-index.js';
import { recordModelRoleOutcomes } from './model-performance-index.js';
import { MetricsCollector, resolveCostRates } from './metrics.js';
import { isRecord } from './foundation/text.js';
import { loadMissionStateAtPath } from './mission-state-reader.js';
import type { MissionState } from './mission-types.js';

function safeMissionRoot(missionPath: string): string {
  return assertSafeRepositoryPath(missionPath, { allowMissingLeaf: true });
}

function safeMissionArtifactPath(missionPath: string, relativePath: string): string {
  return assertSafeRepositoryPath(path.join(safeMissionRoot(missionPath), relativePath), {
    allowMissingLeaf: true,
  });
}

function safeRepositoryPath(filePath: string, allowMissingLeaf = true): string {
  return assertSafeRepositoryPath(filePath, { allowMissingLeaf });
}

/**
 * Mission Retrospective Loop — the self-improvement back-edge for PROCESS and
 * TEAM (the goal-satisfaction loop closes the outcome; this closes the way of
 * working).
 *
 * Design contract:
 *  - Stats collection is DETERMINISTIC (task events, dispatch manifests,
 *    gate records, goal-loop rounds). No LLM in the measurement.
 *  - Improvement proposals come from the reasoning backend, grounded in the
 *    stats — but they are NEVER auto-applied. Each proposal lands in the
 *    governed process-improvement queue (proposed → operator approves →
 *    apply), mirroring the memory-promotion ratification pattern.
 */

export interface MissionExecutionStats {
  mission_id: string;
  task_total: number;
  tasks_by_role: Record<string, number>;
  ticket_failures: Array<{ task_id: string; notes: string[] }>;
  dispatch_rounds_observed: number;
  empty_response_blocks: number;
  rework_events: number;
  best_of_judgements: number;
  goal_reconciliation_rounds: number;
  finish_gate_failures: Array<{ gate_id: string; reason: string }>;
  unstaffed_role_fallbacks: string[];
  clarifications: number;
  token_usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cost_usd: number;
    estimated_entries: number;
    entries: number;
    by_model: Record<
      string,
      { prompt_tokens: number; completion_tokens: number; total_tokens: number; cost_usd: number }
    >;
  };
  resource_usage: {
    entries: number;
    cost_usd: number;
  };
  item_outcomes: Array<{
    task_id: string;
    team_role: string;
    assignee: string;
    final_status: string;
    provider?: string;
    model_id?: string;
  }>;
}

function collectMissionUsageStats(
  missionId: string
): Pick<MissionExecutionStats, 'token_usage' | 'resource_usage'> {
  const tokenUsage: MissionExecutionStats['token_usage'] = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    cost_usd: 0,
    estimated_entries: 0,
    entries: 0,
    by_model: {},
  };
  const resourceUsage = { entries: 0, cost_usd: 0 };
  const metricsCollector = new MetricsCollector({ persist: false });
  const metricCorrelationIds = new Set<string>();

  for (const entry of metricsCollector.loadHistory()) {
    if (String(entry.mission_id || '').toUpperCase() !== missionId.toUpperCase()) continue;
    if (entry.correlation_id) metricCorrelationIds.add(String(entry.correlation_id));
    const usage = entry.usage as Record<string, unknown> | undefined;
    if (!usage) continue;
    const promptTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
    const completionTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
    if (!Number.isFinite(promptTokens) || !Number.isFinite(completionTokens)) continue;
    const model = String(entry.model || 'default');
    const rates = resolveCostRates(model);
    const cost = Number(
      entry.cost_usd ?? promptTokens * rates.prompt + completionTokens * rates.completion
    );
    const modelStats = tokenUsage.by_model[model] || {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      cost_usd: 0,
    };
    modelStats.prompt_tokens += promptTokens;
    modelStats.completion_tokens += completionTokens;
    modelStats.total_tokens += promptTokens + completionTokens;
    modelStats.cost_usd += Number.isFinite(cost) ? cost : 0;
    tokenUsage.by_model[model] = modelStats;
    tokenUsage.prompt_tokens += promptTokens;
    tokenUsage.completion_tokens += completionTokens;
    tokenUsage.total_tokens += promptTokens + completionTokens;
    tokenUsage.cost_usd += Number.isFinite(cost) ? cost : 0;
    tokenUsage.entries += 1;
    if (entry.estimated === true) tokenUsage.estimated_entries += 1;
  }

  const supervisorEventsPath = safeRepositoryPath(
    pathResolver.shared('observability/mission-control/agent-runtime-supervisor-events.jsonl')
  );
  for (const entry of readJsonl(supervisorEventsPath)) {
    if (entry.decision !== 'agent_runtime_ask_completed') continue;
    if (String(entry.mission_id || '').toUpperCase() !== missionId.toUpperCase()) continue;
    if (entry.correlation_id && metricCorrelationIds.has(String(entry.correlation_id))) continue;
    if (entry.input_tokens === undefined && entry.output_tokens === undefined) continue;
    const promptTokens = Number(entry.input_tokens || 0);
    const completionTokens = Number(entry.output_tokens || 0);
    if (!Number.isFinite(promptTokens) || !Number.isFinite(completionTokens)) continue;
    const model = String(entry.model_id || 'default');
    const rates = resolveCostRates(model);
    const cost = promptTokens * rates.prompt + completionTokens * rates.completion;
    const modelStats = tokenUsage.by_model[model] || {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      cost_usd: 0,
    };
    modelStats.prompt_tokens += promptTokens;
    modelStats.completion_tokens += completionTokens;
    modelStats.total_tokens += promptTokens + completionTokens;
    modelStats.cost_usd += cost;
    tokenUsage.by_model[model] = modelStats;
    tokenUsage.prompt_tokens += promptTokens;
    tokenUsage.completion_tokens += completionTokens;
    tokenUsage.total_tokens += promptTokens + completionTokens;
    tokenUsage.cost_usd += cost;
    tokenUsage.entries += 1;
  }

  for (const entry of metricsCollector.loadResourceUsageHistory()) {
    if (String(entry.mission_id || '').toUpperCase() !== missionId.toUpperCase()) continue;
    resourceUsage.entries += 1;
    resourceUsage.cost_usd += Number(entry.cost_usd) || 0;
  }

  tokenUsage.cost_usd = Math.round(tokenUsage.cost_usd * 100000) / 100000;
  for (const modelStats of Object.values(tokenUsage.by_model)) {
    modelStats.cost_usd = Math.round(modelStats.cost_usd * 100000) / 100000;
  }
  resourceUsage.cost_usd = Math.round(resourceUsage.cost_usd * 100000) / 100000;
  return { token_usage: tokenUsage, resource_usage: resourceUsage };
}

export interface ProcessImprovementProposal {
  proposal_id: string;
  mission_id: string;
  kind: 'team_composition' | 'workflow_rule' | 'process_step' | 'tooling';
  target: string;
  proposal: string;
  rationale: string;
  evidence: string[];
  status: 'proposed' | 'approved' | 'rejected' | 'applied';
  created_at: string;
}

type JsonRecord = Record<string, unknown>;

const PROPOSAL_KINDS: readonly ProcessImprovementProposal['kind'][] = [
  'team_composition',
  'workflow_rule',
  'process_step',
  'tooling',
];
const PROPOSAL_STATUSES: readonly ProcessImprovementProposal['status'][] = [
  'proposed',
  'approved',
  'rejected',
  'applied',
];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Reject malformed durable proposals before lifecycle mutation or display. */
export function normalizeProcessImprovementProposal(
  value: unknown
): ProcessImprovementProposal | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !isNonEmptyString(value.proposal_id) ||
    !isNonEmptyString(value.mission_id) ||
    !isNonEmptyString(value.target) ||
    !isNonEmptyString(value.proposal) ||
    typeof value.rationale !== 'string' ||
    !isNonEmptyString(value.created_at) ||
    !PROPOSAL_KINDS.includes(value.kind as ProcessImprovementProposal['kind']) ||
    !PROPOSAL_STATUSES.includes(value.status as ProcessImprovementProposal['status']) ||
    !Array.isArray(value.evidence) ||
    !value.evidence.every((entry) => typeof entry === 'string')
  ) {
    return undefined;
  }
  return {
    proposal_id: value.proposal_id,
    mission_id: value.mission_id,
    kind: value.kind as ProcessImprovementProposal['kind'],
    target: value.target,
    proposal: value.proposal,
    rationale: value.rationale,
    evidence: value.evidence,
    status: value.status as ProcessImprovementProposal['status'],
    created_at: value.created_at,
  };
}

function normalizeProposalDraft(
  value: unknown
):
  | Pick<ProcessImprovementProposal, 'kind' | 'target' | 'proposal' | 'rationale' | 'evidence'>
  | undefined {
  if (!isRecord(value) || !isNonEmptyString(value.proposal)) return undefined;
  if (
    (value.kind !== undefined &&
      !PROPOSAL_KINDS.includes(value.kind as ProcessImprovementProposal['kind'])) ||
    (value.target !== undefined && typeof value.target !== 'string') ||
    (value.rationale !== undefined && typeof value.rationale !== 'string') ||
    (value.evidence !== undefined &&
      (!Array.isArray(value.evidence) ||
        !value.evidence.every((entry) => typeof entry === 'string')))
  ) {
    return undefined;
  }
  return {
    kind: (value.kind as ProcessImprovementProposal['kind'] | undefined) || 'process_step',
    target: (value.target as string | undefined) || 'unspecified',
    proposal: value.proposal,
    rationale: (value.rationale as string | undefined) || '',
    evidence: (value.evidence as string[] | undefined) || [],
  };
}

const IMPROVEMENT_QUEUE_PATH = 'coordination/process-improvements/queue.jsonl';

export function processImprovementQueuePath(): string {
  return safeRepositoryPath(pathResolver.shared(IMPROVEMENT_QUEUE_PATH));
}

function readJsonl(filePath: string): JsonRecord[] {
  try {
    const safePath = safeRepositoryPath(filePath);
    if (!safeExistsSync(safePath)) return [];
    return String(safeReadFile(safePath, { encoding: 'utf8' }))
      .split('\n')
      .filter((line) => line.trim())
      .flatMap((line) => {
        try {
          const parsed: unknown = parseSafeJsonInput(line, 'improvement queue entry');
          return isRecord(parsed) ? [parsed] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function readJsonIfPresent<T>(filePath: string): T | null {
  try {
    return readFoundationJsonIfPresent<T>(safeRepositoryPath(filePath));
  } catch {
    return null;
  }
}

function readMissionJsonIfPresent<T>(missionPath: string, relativePath: string): T | null {
  try {
    return readJsonIfPresent<T>(safeMissionArtifactPath(missionPath, relativePath));
  } catch {
    return null;
  }
}

function readMissionJsonl(
  missionPath: string,
  relativePath: string
): Array<Record<string, unknown>> {
  try {
    return readJsonl(safeMissionArtifactPath(missionPath, relativePath));
  } catch {
    return [];
  }
}

function missionArtifactExists(missionPath: string, relativePath: string): boolean {
  try {
    return safeExistsSync(safeMissionArtifactPath(missionPath, relativePath));
  } catch {
    return false;
  }
}

/**
 * Finished missions are archived; a stray same-named working dir must not
 * shadow the real records. Prefer whichever candidate actually holds the
 * coordination data the retrospective measures.
 */
function resolveRetrospectiveMissionPath(missionId: string): string | null {
  const candidates = [
    findMissionPath(missionId),
    pathResolver.rootResolve(path.join('active', 'archive', 'missions', missionId.toUpperCase())),
  ].flatMap((candidate) => {
    if (!candidate) return [];
    try {
      const safeCandidate = safeMissionRoot(candidate);
      return safeExistsSync(safeCandidate) ? [safeCandidate] : [];
    } catch {
      return [];
    }
  });
  if (candidates.length === 0) return null;
  const withRecords = candidates.find(
    (candidate) =>
      missionArtifactExists(candidate, 'coordination') ||
      missionArtifactExists(candidate, 'NEXT_TASKS.json')
  );
  return withRecords || candidates[0];
}

/** Deterministic execution telemetry from the mission's own records. */
export function collectMissionExecutionStats(missionId: string): MissionExecutionStats {
  const missionPath = resolveRetrospectiveMissionPath(missionId);
  const stats: MissionExecutionStats = {
    mission_id: missionId,
    task_total: 0,
    tasks_by_role: {},
    ticket_failures: [],
    dispatch_rounds_observed: 0,
    empty_response_blocks: 0,
    rework_events: 0,
    best_of_judgements: 0,
    goal_reconciliation_rounds: 0,
    finish_gate_failures: [],
    unstaffed_role_fallbacks: [],
    clarifications: 0,
    token_usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      cost_usd: 0,
      estimated_entries: 0,
      entries: 0,
      by_model: {},
    },
    resource_usage: { entries: 0, cost_usd: 0 },
    item_outcomes: [],
  };
  Object.assign(stats, collectMissionUsageStats(missionId));
  if (!missionPath) return stats;

  const nextTasks =
    readMissionJsonIfPresent<Array<{ assigned_to?: { role?: string } }>>(
      missionPath,
      'NEXT_TASKS.json'
    ) || [];
  stats.task_total = nextTasks.length;
  for (const task of nextTasks) {
    const role = String(task.assigned_to?.role || 'unassigned');
    stats.tasks_by_role[role] = (stats.tasks_by_role[role] || 0) + 1;
  }

  const ticketManifest = readMissionJsonIfPresent<{
    records?: Array<{ task_id?: string; status?: string; notes?: string[] }>;
  }>(missionPath, 'coordination/tickets/dispatch-manifest.json');
  for (const record of ticketManifest?.records || []) {
    const notes = Array.isArray(record.notes) ? record.notes.map(String) : [];
    if (record.status === 'failed') {
      stats.ticket_failures.push({ task_id: String(record.task_id || ''), notes });
    }
    for (const note of notes) {
      if (note.includes('unstaffed')) stats.unstaffed_role_fallbacks.push(note);
    }
  }

  const taskEvents = readMissionJsonl(missionPath, 'coordination/events/task-events.jsonl');
  for (const event of taskEvents) {
    const decision = String(event.decision || '');
    if (decision === 'best_of_judged') stats.best_of_judgements += 1;
    const payload = isRecord(event.payload) ? event.payload : {};
    if (payload.rework_requested === true) stats.rework_events += 1;
  }

  const dispatchEvents = readMissionJsonl(
    missionPath,
    'coordination/events/workitem-dispatch.jsonl'
  );
  stats.dispatch_rounds_observed = dispatchEvents.filter(
    (event) => String(event.event || '') === 'dispatch_started'
  ).length;

  const dispatchManifest = readMissionJsonIfPresent<{
    records?: Array<{
      item_id?: string;
      team_role?: string;
      assignee_peer_id?: string;
      provider?: string;
      model_id?: string;
      work_item_status_after?: string;
      notes?: string[];
      response_excerpt?: string;
    }>;
  }>(missionPath, 'evidence/workitem-dispatch-manifest.json');
  for (const record of dispatchManifest?.records || []) {
    const notes = Array.isArray(record.notes) ? record.notes.map(String) : [];
    if (record.team_role && record.assignee_peer_id) {
      stats.item_outcomes.push({
        task_id: String(record.item_id || ''),
        team_role: String(record.team_role),
        assignee: String(record.assignee_peer_id),
        final_status: String(record.work_item_status_after || 'unknown'),
        ...(record.provider ? { provider: String(record.provider) } : {}),
        ...(record.model_id ? { model_id: String(record.model_id) } : {}),
      });
    }
    if (notes.some((note) => note.includes('empty subagent response'))) {
      stats.empty_response_blocks += 1;
    }
    if (
      record.work_item_status_after === 'blocked' &&
      !String(record.response_excerpt || '').trim()
    ) {
      stats.empty_response_blocks += 1;
    }
  }

  const state = loadMissionStateAtPath(
    safeMissionArtifactPath(missionPath, 'mission-state.json')
  ) as
    | (MissionState & {
        context?: MissionState['context'] & Record<string, unknown>;
      })
    | null;
  stats.goal_reconciliation_rounds = Number(state?.context?.goal_reconciliation_round || 0);
  if (state?.context?.mission_finish_gate_last_reason) {
    stats.finish_gate_failures.push({
      gate_id: 'finish',
      reason: String(state.context.mission_finish_gate_last_reason),
    });
  }

  stats.clarifications = readMissionJsonl(
    missionPath,
    'coordination/events/task-events.jsonl'
  ).filter((event) => {
    const payload = isRecord(event.payload) ? event.payload : undefined;
    return String(payload?.clarification_packet_path || '');
  }).length;

  return stats;
}

function enqueueProposal(proposal: ProcessImprovementProposal): void {
  const queuePath = processImprovementQueuePath();
  safeMkdir(path.dirname(queuePath), { recursive: true });
  appendJsonLine(queuePath, proposal);
}

export function listProcessImprovementProposals(): ProcessImprovementProposal[] {
  return readJsonl(processImprovementQueuePath()).flatMap((entry) => {
    const proposal = normalizeProcessImprovementProposal(entry);
    return proposal ? [proposal] : [];
  });
}

/**
 * Governed lifecycle: proposed → approved/rejected → applied.
 * `apply` deliberately does NOT patch governed files automatically — it turns
 * the approved proposal into a concrete work order (markdown + operator inbox
 * entry) so 承認→着手物 is one step while structural changes stay reviewed.
 */
export function decideProcessImprovementProposal(
  proposalId: string,
  decision: 'approved' | 'rejected',
  decidedBy = 'operator'
): ProcessImprovementProposal {
  const proposals = listProcessImprovementProposals();
  const index = proposals.findIndex((entry) => entry.proposal_id === proposalId);
  if (index < 0) throw new Error(`process improvement proposal not found: ${proposalId}`);
  const current = proposals[index];
  if (current.status !== 'proposed') {
    throw new Error(`proposal ${proposalId} is ${current.status}; only proposed can be decided`);
  }
  const updated: ProcessImprovementProposal = {
    ...current,
    status: decision,
  };
  proposals[index] = updated;
  const queuePath = processImprovementQueuePath();
  safeMkdir(path.dirname(queuePath), { recursive: true });
  safeWriteFile(queuePath, proposals.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  logger.info(
    `[process-improvement] ${proposalId} ${decision} by ${decidedBy}: ${current.proposal.slice(0, 80)}`
  );
  return updated;
}

export function applyProcessImprovementProposal(proposalId: string): {
  proposal: ProcessImprovementProposal;
  work_order_path: string;
} {
  const proposals = listProcessImprovementProposals();
  const index = proposals.findIndex((entry) => entry.proposal_id === proposalId);
  if (index < 0) throw new Error(`process improvement proposal not found: ${proposalId}`);
  const current = proposals[index];
  if (current.status !== 'approved') {
    throw new Error(`proposal ${proposalId} is ${current.status}; approve it before applying`);
  }
  const workOrderDir = pathResolver.shared('coordination/process-improvements/applied');
  const safeWorkOrderDir = safeRepositoryPath(workOrderDir);
  safeMkdir(safeWorkOrderDir, { recursive: true });
  const workOrderPath = safeRepositoryPath(path.join(safeWorkOrderDir, `${proposalId}.md`));
  safeWriteFile(
    workOrderPath,
    [
      `# Process Improvement Work Order — ${proposalId}`,
      '',
      `- 種別: ${current.kind}`,
      `- 対象: ${current.target}`,
      `- 発生ミッション: ${current.mission_id}`,
      `- 承認日: ${new Date().toISOString()}`,
      '',
      '## 変更内容',
      current.proposal,
      '',
      '## 根拠',
      current.rationale,
      '',
      '## エビデンス',
      ...current.evidence.map((entry) => `- ${entry}`),
      '',
      '> 実装したら本ファイルに結果を追記し、関連する plan doc / ledger を更新すること。',
    ].join('\n')
  );
  const updated: ProcessImprovementProposal = { ...current, status: 'applied' };
  proposals[index] = updated;
  const queuePath = processImprovementQueuePath();
  safeWriteFile(queuePath, proposals.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  void notifyOperator('deliverable_ready', {
    title: `改善ワークオーダー発行: ${current.kind} (${proposalId})`,
    body: current.proposal.slice(0, 200),
    link_hint: workOrderPath,
    correlation_id: proposalId,
  });
  return { proposal: updated, work_order_path: workOrderPath };
}

function buildRetrospectivePrompt(stats: MissionExecutionStats): string {
  return [
    'You are the retrospective facilitator for an AI agent team.',
    'Given the deterministic execution stats of a finished mission, propose concrete improvements',
    'to (a) team composition/staffing, (b) workflow rules, (c) process steps, (d) tooling.',
    'Only propose changes justified by the stats. 0 proposals is a valid answer.',
    'Return STRICT JSON: {"proposals":[{"kind":"team_composition"|"workflow_rule"|"process_step"|"tooling",',
    '"target":"file or component the change applies to","proposal":"one concrete change",',
    '"rationale":"why, citing the stat","evidence":["stat refs"]}]}',
    '',
    '--- EXECUTION STATS ---',
    JSON.stringify(stats, null, 1),
  ].join('\n');
}

export interface MissionRetrospectiveResult {
  stats: MissionExecutionStats;
  proposals: ProcessImprovementProposal[];
  report_path: string;
}

/**
 * Run the retrospective for a finished mission: measure, propose, queue,
 * notify. Failure-tolerant by contract — callers may fire-and-forget.
 */
export async function runMissionRetrospective(
  missionId: string
): Promise<MissionRetrospectiveResult> {
  const stats = collectMissionExecutionStats(missionId);
  const missionPath = resolveRetrospectiveMissionPath(missionId);
  const proposals: ProcessImprovementProposal[] = [];

  // Cross-mission learning: feed measured agent×role outcomes into the
  // performance index that team-role selection consults for future staffing.
  try {
    recordAgentRoleOutcomes(
      stats.item_outcomes.map((outcome) => ({
        ...outcome,
        mission_id: missionId,
        recorded_at: new Date().toISOString(),
      }))
    );
    recordModelRoleOutcomes(
      stats.item_outcomes
        .filter((outcome): outcome is typeof outcome & { model_id: string } =>
          Boolean(outcome.model_id)
        )
        .map((outcome) => ({
          mission_id: missionId,
          task_id: outcome.task_id,
          team_role: outcome.team_role,
          ...(outcome.provider ? { provider: outcome.provider } : {}),
          model_id: outcome.model_id,
          final_status: outcome.final_status,
          recorded_at: new Date().toISOString(),
        }))
    );
  } catch (err) {
    logger.warn(
      `[mission-retrospective] performance index update failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  let llmNote = '';
  const backend = getReasoningBackend();
  if (backend.name !== 'stub') {
    try {
      const raw = await backend.prompt(buildRetrospectivePrompt(stats));
      const trimmed = raw.trim();
      const firstJsonToken = trimmed.search(/[\[{]/u);
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      const parsed: unknown =
        firstJsonToken >= 0 && trimmed[firstJsonToken] === '['
          ? { proposals: [] }
          : start >= 0 && end > start
            ? parseSafeJsonInput(raw.slice(start, end + 1), 'retrospective proposal response')
            : { proposals: [] };
      const proposalDrafts =
        isRecord(parsed) && Array.isArray(parsed.proposals)
          ? parsed.proposals.flatMap((entry) => {
              const draft = normalizeProposalDraft(entry);
              return draft ? [draft] : [];
            })
          : [];
      for (const entry of proposalDrafts) {
        proposals.push({
          proposal_id: `PIP-${randomUUID().slice(0, 8).toUpperCase()}`,
          mission_id: missionId,
          kind: entry.kind,
          target: entry.target,
          proposal: entry.proposal,
          rationale: entry.rationale,
          evidence: entry.evidence,
          status: 'proposed',
          created_at: new Date().toISOString(),
        });
      }
    } catch (err) {
      llmNote = `proposal generation failed: ${err instanceof Error ? err.message : String(err)}`;
      logger.warn(`[mission-retrospective] ${llmNote}`);
    }
  } else {
    llmNote = 'stub backend — stats collected, no proposals generated';
  }

  for (const proposal of proposals) {
    enqueueProposal(proposal);
  }

  // Human-readable report next to the mission evidence.
  const reportLines = [
    `# Mission Retrospective — ${missionId}`,
    '',
    '## 実行統計(決定論)',
    '```json',
    JSON.stringify(stats, null, 2),
    '```',
    '',
    '## 改善提案(承認待ち — process-improvement queue)',
    ...(proposals.length > 0
      ? proposals.map(
          (proposal) =>
            `- **[${proposal.kind}] ${proposal.target}** — ${proposal.proposal}\n  - 根拠: ${proposal.rationale}`
        )
      : [`- なし${llmNote ? `(${llmNote})` : ''}`]),
    '',
    `> 提案の承認/却下は queue (${IMPROVEMENT_QUEUE_PATH}) を更新し、承認済みのみ blueprint / workflow catalog へ反映すること。`,
  ];
  const reportPath = missionPath
    ? safeMissionArtifactPath(missionPath, 'evidence/retrospective.md')
    : safeRepositoryPath(pathResolver.shared(path.join('tmp', `retrospective-${missionId}.md`)));
  safeMkdir(path.dirname(reportPath), { recursive: true });
  safeWriteFile(reportPath, reportLines.join('\n'));
  if (missionPath) {
    safeWriteFile(
      safeMissionArtifactPath(missionPath, 'evidence/retrospective.json'),
      JSON.stringify({ stats, proposals }, null, 2)
    );
  }

  if (proposals.length > 0) {
    void notifyOperator('question', {
      title: `Retrospective: ${proposals.length} 件のプロセス改善提案 (${missionId})`,
      body: proposals
        .slice(0, 3)
        .map((proposal) => `- [${proposal.kind}] ${proposal.proposal}`)
        .join('\n'),
      link_hint: reportPath,
      correlation_id: `${missionId}:retrospective`,
    });
  }

  logger.info(
    `[mission-retrospective] ${missionId}: stats collected, ${proposals.length} proposal(s) queued → ${reportPath}`
  );
  return { stats, proposals, report_path: reportPath };
}
