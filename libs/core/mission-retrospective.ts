import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathResolver, findMissionPath } from './path-resolver.js';
import {
  safeAppendFileSync,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
} from './secure-io.js';
import { logger } from './core.js';
import { getReasoningBackend } from './reasoning-backend.js';
import { notifyOperator } from './operator-notifications.js';
import { recordAgentRoleOutcomes } from './agent-performance-index.js';

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
  item_outcomes: Array<{
    task_id: string;
    team_role: string;
    assignee: string;
    final_status: string;
  }>;
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

const IMPROVEMENT_QUEUE_PATH = 'coordination/process-improvements/queue.jsonl';

export function processImprovementQueuePath(): string {
  return pathResolver.shared(IMPROVEMENT_QUEUE_PATH);
}

function readJsonl(filePath: string): Array<Record<string, unknown>> {
  try {
    if (!safeExistsSync(filePath)) return [];
    return String(safeReadFile(filePath, { encoding: 'utf8' }))
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is Record<string, unknown> => Boolean(entry));
  } catch {
    return [];
  }
}

function readJsonIfPresent<T>(filePath: string): T | null {
  try {
    if (!safeExistsSync(filePath)) return null;
    return JSON.parse(String(safeReadFile(filePath, { encoding: 'utf8' }))) as T;
  } catch {
    return null;
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
  ].filter((candidate): candidate is string => Boolean(candidate && safeExistsSync(candidate)));
  if (candidates.length === 0) return null;
  const withRecords = candidates.find(
    (candidate) =>
      safeExistsSync(path.join(candidate, 'coordination')) ||
      safeExistsSync(path.join(candidate, 'NEXT_TASKS.json'))
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
    item_outcomes: [],
  };
  if (!missionPath) return stats;

  const nextTasks =
    readJsonIfPresent<Array<{ assigned_to?: { role?: string } }>>(
      path.join(missionPath, 'NEXT_TASKS.json')
    ) || [];
  stats.task_total = nextTasks.length;
  for (const task of nextTasks) {
    const role = String(task.assigned_to?.role || 'unassigned');
    stats.tasks_by_role[role] = (stats.tasks_by_role[role] || 0) + 1;
  }

  const ticketManifest = readJsonIfPresent<{
    records?: Array<{ task_id?: string; status?: string; notes?: string[] }>;
  }>(path.join(missionPath, 'coordination', 'tickets', 'dispatch-manifest.json'));
  for (const record of ticketManifest?.records || []) {
    const notes = Array.isArray(record.notes) ? record.notes.map(String) : [];
    if (record.status === 'failed') {
      stats.ticket_failures.push({ task_id: String(record.task_id || ''), notes });
    }
    for (const note of notes) {
      if (note.includes('unstaffed')) stats.unstaffed_role_fallbacks.push(note);
    }
  }

  const taskEvents = readJsonl(
    path.join(missionPath, 'coordination', 'events', 'task-events.jsonl')
  );
  for (const event of taskEvents) {
    const decision = String(event.decision || '');
    if (decision === 'best_of_judged') stats.best_of_judgements += 1;
    const payload = (event.payload || {}) as Record<string, unknown>;
    if (payload.rework_requested === true) stats.rework_events += 1;
  }

  const dispatchEvents = readJsonl(
    path.join(missionPath, 'coordination', 'events', 'workitem-dispatch.jsonl')
  );
  stats.dispatch_rounds_observed = dispatchEvents.filter(
    (event) => String(event.event || '') === 'dispatch_started'
  ).length;

  const dispatchManifest = readJsonIfPresent<{
    records?: Array<{
      item_id?: string;
      team_role?: string;
      assignee_peer_id?: string;
      work_item_status_after?: string;
      notes?: string[];
      response_excerpt?: string;
    }>;
  }>(path.join(missionPath, 'evidence', 'workitem-dispatch-manifest.json'));
  for (const record of dispatchManifest?.records || []) {
    const notes = Array.isArray(record.notes) ? record.notes.map(String) : [];
    if (record.team_role && record.assignee_peer_id) {
      stats.item_outcomes.push({
        task_id: String(record.item_id || ''),
        team_role: String(record.team_role),
        assignee: String(record.assignee_peer_id),
        final_status: String(record.work_item_status_after || 'unknown'),
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

  const state = readJsonIfPresent<{
    context?: {
      goal_reconciliation_round?: number;
      mission_finish_gate_last_reason?: string;
      mission_finish_gate_failure_count?: number;
    };
  }>(path.join(missionPath, 'mission-state.json'));
  stats.goal_reconciliation_rounds = Number(state?.context?.goal_reconciliation_round || 0);
  if (state?.context?.mission_finish_gate_last_reason) {
    stats.finish_gate_failures.push({
      gate_id: 'finish',
      reason: String(state.context.mission_finish_gate_last_reason),
    });
  }

  stats.clarifications = readJsonl(
    path.join(missionPath, 'coordination', 'events', 'task-events.jsonl')
  ).filter((event) =>
    String((event.payload as Record<string, unknown> | undefined)?.clarification_packet_path || '')
  ).length;

  return stats;
}

function enqueueProposal(proposal: ProcessImprovementProposal): void {
  const queuePath = processImprovementQueuePath();
  safeMkdir(path.dirname(queuePath), { recursive: true });
  safeAppendFileSync(queuePath, `${JSON.stringify(proposal)}\n`);
}

export function listProcessImprovementProposals(): ProcessImprovementProposal[] {
  return readJsonl(processImprovementQueuePath()) as unknown as ProcessImprovementProposal[];
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
  safeMkdir(workOrderDir, { recursive: true });
  const workOrderPath = path.join(workOrderDir, `${proposalId}.md`);
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
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      const parsed =
        start >= 0 && end > start
          ? (JSON.parse(raw.slice(start, end + 1)) as {
              proposals?: Array<Partial<ProcessImprovementProposal>>;
            })
          : { proposals: [] };
      for (const entry of parsed.proposals || []) {
        if (!entry?.proposal) continue;
        proposals.push({
          proposal_id: `PIP-${randomUUID().slice(0, 8).toUpperCase()}`,
          mission_id: missionId,
          kind: (entry.kind as ProcessImprovementProposal['kind']) || 'process_step',
          target: String(entry.target || 'unspecified'),
          proposal: String(entry.proposal),
          rationale: String(entry.rationale || ''),
          evidence: Array.isArray(entry.evidence) ? entry.evidence.map(String) : [],
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
    ? path.join(missionPath, 'evidence', 'retrospective.md')
    : pathResolver.shared(path.join('tmp', `retrospective-${missionId}.md`));
  safeMkdir(path.dirname(reportPath), { recursive: true });
  safeWriteFile(reportPath, reportLines.join('\n'));
  if (missionPath) {
    safeWriteFile(
      path.join(missionPath, 'evidence', 'retrospective.json'),
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
