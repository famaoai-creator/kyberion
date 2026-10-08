import { appendJsonLine, parseSafeJsonInput, readJsonLines } from '../foundation/json.js';
import * as path from 'node:path';
import { t } from '../t.js';
import { randomUUID } from 'node:crypto';
import { pathResolver, findMissionPath } from '../path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeStat,
  safeWriteFile,
} from '../secure-io.js';
import { logger } from '../core.js';
import { getReasoningBackend } from '../reasoning/reasoning-backend.js';
import { notifyOperator } from '../surface/operator-notifications.js';
import { deriveMissionOutcome, validateMissionHeuristics } from '../heuristic-feedback.js';
import { recordAgentRoleOutcomes } from '../agent/agent-performance-index.js';
import { recordModelRoleOutcomes } from '../reasoning/model-performance-index.js';
import { MetricsCollector, resolveCostRates } from '../metrics.js';
import { isRecord } from '../foundation/text.js';
import { nowIso } from '../foundation/time.js';
import { loadMissionNextTaskObjectsAtPath } from './mission-next-task-reader.js';
import { loadMissionStateAtPath } from './mission-state-reader.js';
import { loadMissionTicketDispatchManifestAtPath } from './mission-ticket-dispatch-manifest.js';
import { loadMissionWorkItemDispatchManifestAtPath } from './mission-workitem-dispatch-manifest.js';
import type { MissionState } from './mission-types.js';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { readSupervisorEvents } from '../agent/agent-runtime-events.js';

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

function regularProcessImprovementQueuePath(filePath: string): string {
  const safePath = safeRepositoryPath(filePath);
  if (safeExistsSync(safePath) && !safeLstat(safePath).isFile()) {
    throw new Error(`[process-improvement] queue must be a regular file: ${filePath}`);
  }
  return safePath;
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
  evidence_timing: {
    /** evidence_recorded ledger events seen. */
    events: number;
    first_at: string | null;
    last_at: string | null;
    /** first→last evidence record span; null when fewer than 2 events. */
    span_ms: number | null;
    /** mission history first→last event span; null when unavailable. */
    mission_active_ms: number | null;
    /** >=80% of evidence events inside some 10-min window while the mission
     *  ran >=1h — record-as-you-go degraded into closing-time bookkeeping. */
    closing_burst: boolean;
    /** share of evidence events inside the densest 10-min window (0..1). */
    densest_window_share: number | null;
    /** task_ids whose deliverable file was modified after its record-evidence
     *  call — the artifact was touched after the task closed. */
    edited_after_record: string[];
  };
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
  /** Tasks marked completed in NEXT_TASKS.json. */
  tasks_completed: number;
  /** True when tasks were completed but no usage entry of any kind exists —
   *  the zeros above mean "not recorded", never "free". */
  usage_unrecorded: boolean;
  item_outcomes: Array<{
    task_id: string;
    team_role: string;
    assignee: string;
    final_status: string;
    provider?: string;
    model_id?: string;
  }>;
}

/** Mirrors MISSION_TASK_COMPLETED_STATUSES (mission-lifecycle-completion.ts),
 *  kept local so the retrospective does not pull in the lifecycle module graph. */
const COMPLETED_TASK_STATUSES = new Set(['done', 'completed', 'accepted', 'reviewed']);

/**
 * The mission's own tier/tenant, from its state record: the resource-usage
 * ledger is partitioned by it. Unknown (no state) reads the system partition only.
 */
function missionUsageScope(
  missionPath: string | null
): { tier: MissionState['tier']; tenant_slug?: string } | undefined {
  if (!missionPath) return undefined;
  const state = loadMissionStateAtPath(safeMissionArtifactPath(missionPath, 'mission-state.json'));
  if (!state?.tier) return undefined;
  return { tier: state.tier, ...(state.tenant_slug ? { tenant_slug: state.tenant_slug } : {}) };
}

function collectMissionUsageStats(
  missionId: string,
  missionScope?: { tier: MissionState['tier']; tenant_slug?: string }
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

  // AC-10: the supervisor stream rotates daily now; read every partition
  // (legacy + dated) rather than the single unrotated file.
  for (const entry of readSupervisorEvents()) {
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

  // The mission's own partition plus the system one (a runtime scope that
  // resolved to public still carries this mission's id); never another tenant's.
  for (const entry of metricsCollector.loadResourceUsageHistory(
    missionScope ? { scope: missionScope, includeSystem: true } : undefined
  )) {
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
const PROPOSAL_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/process-improvement-proposal.schema.json'
);

export function processImprovementQueuePath(): string {
  return safeRepositoryPath(pathResolver.shared(IMPROVEMENT_QUEUE_PATH));
}

function processImprovementProposalCatalog(filePath: string) {
  return defineCatalog<ProcessImprovementProposal>({
    id: 'process-improvement-proposal',
    path: filePath,
    schema: PROPOSAL_SCHEMA_PATH,
  });
}

function readJsonl(filePath: string): JsonRecord[] {
  const safePath = regularProcessImprovementQueuePath(filePath);
  if (!safeExistsSync(safePath)) return [];
  try {
    return readJsonLines<unknown>(safePath, { onMalformed: 'skip' }).filter(isRecord);
  } catch {
    return [];
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
    evidence_timing: {
      events: 0,
      first_at: null,
      last_at: null,
      span_ms: null,
      mission_active_ms: null,
      closing_burst: false,
      densest_window_share: null,
      edited_after_record: [],
    },
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
    tasks_completed: 0,
    usage_unrecorded: false,
    item_outcomes: [],
  };
  Object.assign(stats, collectMissionUsageStats(missionId, missionUsageScope(missionPath)));
  if (!missionPath) return stats;

  const nextTasks = (() => {
    try {
      return (
        loadMissionNextTaskObjectsAtPath(
          safeMissionArtifactPath(missionPath, 'NEXT_TASKS.json'),
          missionId
        ) || []
      );
    } catch {
      return [];
    }
  })();
  stats.task_total = nextTasks.length;
  stats.tasks_completed = nextTasks.filter((task) =>
    COMPLETED_TASK_STATUSES.has(String(task.status || '').toLowerCase())
  ).length;
  stats.usage_unrecorded =
    stats.tasks_completed > 0 && stats.token_usage.entries + stats.resource_usage.entries === 0;
  for (const task of nextTasks) {
    const assignedTo = isRecord(task.assigned_to) ? task.assigned_to : undefined;
    const role = String(assignedTo?.role || 'unassigned');
    stats.tasks_by_role[role] = (stats.tasks_by_role[role] || 0) + 1;
  }

  const ticketManifest = (() => {
    try {
      return loadMissionTicketDispatchManifestAtPath(
        safeMissionArtifactPath(missionPath, 'coordination/tickets/dispatch-manifest.json')
      );
    } catch {
      return null;
    }
  })();
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

  const dispatchManifest = (() => {
    try {
      return loadMissionWorkItemDispatchManifestAtPath(
        safeMissionArtifactPath(missionPath, 'evidence/workitem-dispatch-manifest.json')
      );
    } catch {
      return null;
    }
  })();
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

  // Evidence freshness: ledger entries stamped with deliverable_mtime (added
  // alongside this stats block) let the retrospective flag bookkeeping that
  // was compressed into mission close or artifacts edited after the fact.
  const evidenceEvents = readMissionJsonl(missionPath, 'execution-ledger.jsonl').filter(
    (entry) => String(entry.event_type || '') === 'evidence_recorded'
  );
  const recordTimes = evidenceEvents
    .map((entry) => Date.parse(String(entry.ts || '')))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  stats.evidence_timing.events = evidenceEvents.length;
  stats.evidence_timing.first_at =
    recordTimes.length > 0 ? new Date(recordTimes[0]).toISOString() : null;
  stats.evidence_timing.last_at =
    recordTimes.length > 0 ? new Date(recordTimes[recordTimes.length - 1]).toISOString() : null;
  stats.evidence_timing.span_ms =
    recordTimes.length > 1 ? recordTimes[recordTimes.length - 1] - recordTimes[0] : null;
  const historyTimes = (Array.isArray(state?.history) ? state.history : [])
    .map((entry) => Date.parse(String(entry?.ts || '')))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  stats.evidence_timing.mission_active_ms =
    historyTimes.length > 1 ? historyTimes[historyTimes.length - 1] - historyTimes[0] : null;
  if (recordTimes.length > 0) {
    let densest = 0;
    for (let i = 0; i < recordTimes.length; i++) {
      let count = 0;
      for (const t0 of recordTimes) {
        if (t0 >= recordTimes[i] && t0 <= recordTimes[i] + 10 * 60 * 1000) count += 1;
      }
      densest = Math.max(densest, count);
    }
    stats.evidence_timing.densest_window_share = densest / recordTimes.length;
    stats.evidence_timing.closing_burst = Boolean(
      recordTimes.length >= 3 &&
      stats.evidence_timing.densest_window_share >= 0.8 &&
      stats.evidence_timing.mission_active_ms !== null &&
      stats.evidence_timing.mission_active_ms >= 60 * 60 * 1000
    );
  }
  // A deliverable edited after its record bumps the file's real mtime but not
  // the stamp frozen into the ledger entry — re-stat the recorded path now and
  // compare against the record ts to catch post-close edits.
  for (const entry of evidenceEvents) {
    const payload = isRecord(entry.payload) ? entry.payload : undefined;
    const deliverablePath = String(payload?.deliverable_path || '');
    const recordTs = Date.parse(String(entry.ts || ''));
    if (!deliverablePath || !Number.isFinite(recordTs)) continue;
    try {
      const candidate = safeMissionArtifactPath(missionPath, deliverablePath);
      if (!safeExistsSync(candidate)) continue;
      const currentMtime = safeStat(candidate).mtimeMs;
      if (currentMtime > recordTs + 1000) {
        stats.evidence_timing.edited_after_record.push(String(entry.task_id || 'unknown'));
      }
    } catch {
      // path escapes the mission root or the file vanished — not an edit signal
    }
  }

  return stats;
}

function enqueueProposal(proposal: ProcessImprovementProposal): void {
  const queuePath = regularProcessImprovementQueuePath(processImprovementQueuePath());
  safeMkdir(path.dirname(queuePath), { recursive: true });
  appendJsonLine(
    queuePath,
    processImprovementProposalCatalog(queuePath).validate(proposal, queuePath)
  );
}

export function listProcessImprovementProposals(): ProcessImprovementProposal[] {
  const queuePath = processImprovementQueuePath();
  return readJsonl(queuePath).flatMap((entry) => {
    try {
      const canonical = processImprovementProposalCatalog(queuePath).validate(entry, queuePath);
      const proposal = normalizeProcessImprovementProposal(canonical);
      return proposal ? [proposal] : [];
    } catch {
      return [];
    }
  });
}

function writeProcessImprovementQueue(
  queuePath: string,
  proposals: ProcessImprovementProposal[]
): void {
  const safeQueuePath = regularProcessImprovementQueuePath(queuePath);
  const catalog = processImprovementProposalCatalog(safeQueuePath);
  const canonical = proposals.map((proposal) => catalog.validate(proposal, safeQueuePath));
  safeMkdir(path.dirname(safeQueuePath), { recursive: true });
  safeWriteFile(safeQueuePath, canonical.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
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
  writeProcessImprovementQueue(queuePath, proposals);
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
      t('mission_ops:retro_wo_kind', { value: current.kind }),
      t('mission_ops:retro_wo_target', { value: current.target }),
      t('mission_ops:retro_wo_mission', { value: current.mission_id }),
      t('mission_ops:retro_wo_approved_at', { value: nowIso() }),
      '',
      t('mission_ops:retro_wo_changes_heading'),
      current.proposal,
      '',
      t('mission_ops:retro_wo_rationale_heading'),
      current.rationale,
      '',
      t('mission_ops:retro_wo_evidence_heading'),
      ...current.evidence.map((entry) => `- ${entry}`),
      '',
      t('mission_ops:retro_wo_footer'),
    ].join('\n')
  );
  const updated: ProcessImprovementProposal = { ...current, status: 'applied' };
  proposals[index] = updated;
  const queuePath = processImprovementQueuePath();
  writeProcessImprovementQueue(queuePath, proposals);
  void notifyOperator('deliverable_ready', {
    title: t('mission_ops:retro_wo_issued_title', { kind: current.kind, id: proposalId }),
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
    const recordedAt = nowIso();
    recordAgentRoleOutcomes(
      stats.item_outcomes.map((outcome) => ({
        mission_id: missionId,
        task_id: outcome.task_id,
        team_role: outcome.team_role,
        assignee: outcome.assignee,
        final_status: outcome.final_status,
        recorded_at: recordedAt,
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
          recorded_at: recordedAt,
        }))
    );
  } catch (err) {
    logger.warn(
      `[mission-retrospective] performance index update failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Close the heuristic learn loop: score the intuitions captured during this
  // mission against how it actually went (ratification still gates promotion).
  try {
    const outcome = deriveMissionOutcome({
      missionId,
      itemStatuses: stats.item_outcomes.map((item) => item.final_status),
      finishGateFailures: stats.finish_gate_failures.length,
    });
    if (outcome) {
      const validation = validateMissionHeuristics(outcome);
      for (const message of validation.errors) {
        logger.warn(`[mission-retrospective] heuristic validation skipped — ${message}`);
      }
    }
  } catch (err) {
    logger.warn(
      `[mission-retrospective] heuristic validation failed: ${err instanceof Error ? err.message : String(err)}`
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
          created_at: nowIso(),
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
    t('mission_ops:retro_stats_heading'),
    '```json',
    JSON.stringify(stats, null, 2),
    '```',
    '',
    ...(stats.usage_unrecorded
      ? [t('mission_ops:retro_usage_unrecorded', { count: stats.tasks_completed }), '']
      : []),
    ...(stats.evidence_timing.closing_burst || stats.evidence_timing.edited_after_record.length > 0
      ? [
          t('mission_ops:retro_evidence_freshness', {
            tasks:
              stats.evidence_timing.edited_after_record.length > 0
                ? stats.evidence_timing.edited_after_record.join(', ')
                : '-',
          }),
          '',
        ]
      : []),
    t('mission_ops:retro_proposals_heading'),
    ...(proposals.length > 0
      ? proposals.map(
          (proposal) =>
            `- **[${proposal.kind}] ${proposal.target}** — ${proposal.proposal}\n  - ${t('mission_ops:retro_rationale_label')}: ${proposal.rationale}`
        )
      : [`- ${t('mission_ops:retro_none')}${llmNote ? ` (${llmNote})` : ''}`]),
    '',
    t('mission_ops:retro_queue_footer', { path: IMPROVEMENT_QUEUE_PATH }),
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
      title: t('mission_ops:retro_question_title', { count: proposals.length, missionId }),
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
