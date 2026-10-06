import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeReaddir } from '../secure-io.js';
import { listConversationSignals } from '../intent/conversation-signals.js';
import { loadApprovalRequest } from '../governance/approval-store.js';
import { readWorkerEventStreamJsonl } from '../workforce/worker-event-stream.js';
import { reasoningFailoverEventsPath } from '../reasoning/reasoning-failover.js';
import { metrics, type ResourceUsageRecord } from '../metrics.js';
import { parseDefectTransitionEvent } from '../software-quality-operations.js';
import {
  evaluateRuntimeHealthTrends,
  loadRuntimeHealthSamples,
} from '../tool/runtime-health-history.js';
import {
  listPeerConversationPeers,
  listPeerConversationSessions,
  listPeerConversationTenants,
} from '../mesh/peer-conversation.js';
import {
  listDiscussionRooms,
  readDiscussionEvents,
  readDiscussionRoom,
} from '../discussion/discussion-store.js';
import { listQuarantineRecords } from '../security-screen.js';
import { listTaskSessions } from '../task/task-session.js';
import {
  daysInWindow,
  errorClass,
  readJsonlFilesMatching,
  readJsonlRecords,
  stringField,
  type LearningCluster,
  type LearningObservation,
  type LearningSignalSource,
  type LearningSignalWindow,
} from './learning-signal-adapter.js';

/**
 * LS-02: the built-in learning-signal sources — one per runtime log that used
 * to dead-end outside the improvement loop. Each reader keeps to structural
 * fields (kinds, categories, ops, error classes) so no user text leaves its
 * store. See learning-signal-adapter.ts for how observations are clustered.
 */

type Row = Record<string, unknown>;

function asRecord(value: unknown): Row {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
}

function inWindow(ts: string, window: LearningSignalWindow): boolean {
  const ms = Date.parse(ts);
  return Number.isFinite(ms) && ms > window.since.getTime() && ms <= window.until.getTime();
}

/** Day tokens for date-partitioned files, padded one day back for late-rotating writers. */
function dayTokens(window: LearningSignalWindow): string[] {
  const padded = { since: new Date(window.since.getTime() - 86_400_000), until: window.until };
  return daysInWindow(padded);
}

function listSubdirs(dir: string): string[] {
  if (!safeExistsSync(dir)) return [];
  return safeReaddir(dir).filter((name) => !name.startsWith('.'));
}

// 1. Conversation signal ledger ------------------------------------------------

const CONVERSATION_MISS_KINDS = [
  'route_unrecognized',
  'route_unrouted',
  'feedback_dissatisfied',
  'turn_failed',
] as const;

export const conversationSignalSource: LearningSignalSource = {
  id: 'conversation',
  description:
    'The conversation signal ledger records turns that were not understood, not routed, failed or left the user dissatisfied.',
  minOccurrences: 3,
  hintCategory: 'conversation-signal',
  hintText: (cluster) =>
    `${cluster.title} happened ${cluster.total} times. Review these turns with ` +
    '`pnpm kyberion conversation report` and add the phrasing to the intent eval corpus ' +
    'or fix the route before relying on this intent.',
  read(window) {
    return listConversationSignals({
      sinceMs: window.since.getTime(),
      kinds: CONVERSATION_MISS_KINDS,
    }).map((signal) => {
      const scope = signal.intent_id || signal.surface || 'unknown';
      return {
        key: `${signal.kind}:${scope}:${signal.locale || 'any'}`,
        title: `${signal.kind} on ${scope}${signal.locale ? ` (${signal.locale})` : ''}`,
        ref: `conversation-signal:${signal.signal_id}`,
        ts: signal.ts,
      };
    });
  },
};

// 2. Approval rejections (every channel, not only deliverable review) --------

export const approvalRejectionSource: LearningSignalSource = {
  id: 'approval-rejection',
  description:
    'Approval requests rejected by a human on any channel (Slack, surfaces, approval actuator).',
  minOccurrences: 1,
  hintCategory: 'human-rejection',
  hintText: (cluster) =>
    `${cluster.title}: a human rejected this kind of request ${cluster.total} times. ` +
    'Re-check the request against the rejection reason before asking again.',
  read(window) {
    const root = pathResolver.shared('observability/channels');
    const observations: LearningObservation[] = [];
    for (const channel of listSubdirs(root)) {
      const events = readJsonlRecords(path.join(root, channel, 'approvals.jsonl'));
      for (const event of events) {
        if (event.event !== 'rejected') continue;
        const ts = stringField(event, 'ts');
        if (!inWindow(ts, window)) continue;
        const requestId = stringField(event, 'request_id');
        let record = null;
        try {
          record = requestId ? loadApprovalRequest(channel, requestId) : null;
        } catch {
          record = null;
        }
        const annotated = record?.workflow?.approvals.find(
          (approval) => approval.status === 'rejected' && approval.reasonCategory
        )?.reasonCategory;
        const reason = stringField(event, 'reason_category') || annotated || 'uncategorized';
        const kind = record?.kind || 'unknown';
        const tenantSlug = record?.scope?.tenant_slug?.trim() || undefined;
        observations.push({
          key: `${kind}:${reason}`,
          title: `${kind} approval rejected (${reason})`,
          ref: `approval:${channel}/${requestId}`,
          ts,
          ...(tenantSlug ? { tenantSlug } : {}),
        });
      }
    }
    return observations;
  },
};

// 3. Non-mission runs: failed trace spans and failed task sessions -----------

function collectErrorSpans(span: Row, out: Array<{ name: string; error: string }>): void {
  if (span.status === 'error') {
    out.push({ name: stringField(span, 'name') || 'span', error: stringField(span, 'error') });
  }
  const children = Array.isArray(span.children) ? span.children : [];
  for (const child of children) collectErrorSpans(asRecord(child), out);
}

export const traceFailureSource: LearningSignalSource = {
  id: 'trace-failure',
  description:
    'Execution traces of runs outside a mission (direct replies, task sessions, pipelines) that ended in a failed step.',
  minOccurrences: 3,
  hintCategory: 'trace-failure',
  read(window) {
    const rows = readJsonlFilesMatching(pathResolver.shared('logs/traces'), dayTokens(window));
    const observations: LearningObservation[] = [];
    for (const row of rows) {
      const metadata = asRecord(row.metadata);
      if (stringField(metadata, 'missionId')) continue;
      const origin = stringField(metadata, 'origin');
      if (origin === 'test' || origin === 'ci') continue;
      const ts =
        stringField(metadata, 'completedAt', 'startedAt') || stringField(row, '_persistedAt');
      if (!inWindow(ts, window)) continue;
      const failures: Array<{ name: string; error: string }> = [];
      collectErrorSpans(asRecord(row.rootSpan), failures);
      const deepest = failures[failures.length - 1];
      if (!deepest) continue;
      const scope =
        stringField(metadata, 'pipelineId', 'actuator') ||
        stringField(asRecord(row.rootSpan), 'name') ||
        'run';
      const cls = errorClass(deepest.error || 'failed');
      const tenantSlug = stringField(metadata, 'tenantSlug') || undefined;
      observations.push({
        key: `${scope}:${deepest.name}:${cls}`,
        title: `${scope} step ${deepest.name} failed (${cls})`,
        ref: `trace:${stringField(row, 'traceId')}`,
        ts,
        ...(tenantSlug ? { tenantSlug } : {}),
      });
    }
    return observations;
  },
};

export const taskSessionFailureSource: LearningSignalSource = {
  id: 'task-session',
  description: 'Task sessions (work below the mission threshold) that ended as failed.',
  minOccurrences: 2,
  hintCategory: 'task-session-failure',
  read(window) {
    return listTaskSessions()
      .filter((session) => session.status === 'failed' && inWindow(session.updated_at, window))
      .map((session) => {
        const intentId = String(session.payload?.intent_id || '').trim() || 'no-intent';
        const tenantSlug = session.project_context?.tenant_slug?.trim() || undefined;
        return {
          key: `${session.task_type}:${intentId}`,
          title: `${session.task_type} task session for ${intentId} failed`,
          ref: `task-session:${session.session_id}`,
          ts: session.updated_at,
          ...(tenantSlug ? { tenantSlug } : {}),
        };
      });
  },
};

// 4. Delegated tasks, with ADF repair as its own lesson stream ----------------

const ADF_REPAIR_OWNER = 'adf-repair-agent';

function delegationOutcome(row: Row): { failed: boolean; error: string } | null {
  const status = stringField(row, 'status');
  const activationFailure = asRecord(row.activation_failure);
  const childReport = asRecord(row.child_report);
  const settlement = asRecord(row.settlement);
  const error =
    stringField(row, 'error') ||
    stringField(activationFailure, 'error') ||
    stringField(childReport, 'error');
  if (status === 'failed' || status === 'cancelled' || error) {
    return { failed: true, error: error || status };
  }
  const settled = stringField(settlement, 'status');
  if (settled === 'failed' || settled === 'cancelled') return { failed: true, error: settled };
  if (status === 'completed') return { failed: false, error: '' };
  return null;
}

function readDelegationRows(window: LearningSignalWindow): Row[] {
  const tracePath =
    process.env.KYBERION_DELEGATION_TRACE_PATH?.trim() ||
    pathResolver.shared('observability/delegations.jsonl');
  return readJsonlRecords(tracePath).filter((row) =>
    inWindow(stringField(row, 'completed_at', 'created_at'), window)
  );
}

export const adfRepairSource: LearningSignalSource = {
  id: 'adf-repair',
  description:
    'ADF repair sub-agent runs, grouped by the class of validation error they were asked to fix and whether the repair held.',
  minOccurrences: 2,
  hintCategory: 'adf-repair',
  hintText: (cluster) =>
    `ADF repair for "${cluster.title}" was needed ${cluster.total} times. ` +
    'Fix the generator or template that emits this shape instead of repairing it after the fact.',
  read(window) {
    return readDelegationRows(window)
      .filter((row) => stringField(row, 'owner') === ADF_REPAIR_OWNER)
      .flatMap((row) => {
        const outcome = delegationOutcome(row);
        if (!outcome) return [];
        const cls = errorClass(stringField(row, 'context') || 'unknown');
        const result = outcome.failed ? 'repair failed' : 'repaired';
        return [
          {
            key: `${outcome.failed ? 'failed' : 'repaired'}:${cls}`,
            title: `${cls} (${result})`,
            ref: `delegation:${stringField(row, 'trace_id')}`,
            ts: stringField(row, 'completed_at', 'created_at'),
          },
        ];
      });
  },
};

export const delegationFailureSource: LearningSignalSource = {
  id: 'delegation',
  description: 'Delegated sub-agent tasks that failed, were cancelled or could not be activated.',
  minOccurrences: 3,
  read(window) {
    return readDelegationRows(window)
      .filter((row) => stringField(row, 'owner') !== ADF_REPAIR_OWNER)
      .flatMap((row) => {
        const outcome = delegationOutcome(row);
        if (!outcome?.failed) return [];
        const owner = stringField(row, 'owner') || 'unknown';
        const backend = stringField(row, 'backend_name') || 'any';
        const cls = errorClass(outcome.error);
        return [
          {
            key: `${owner}:${backend}:${cls}`,
            title: `${owner} delegation on ${backend} failed (${cls})`,
            ref: `delegation:${stringField(row, 'trace_id')}`,
            ts: stringField(row, 'completed_at', 'created_at'),
          },
        ];
      });
  },
};

// 5. Audit chain denials ------------------------------------------------------

export const auditDenialSource: LearningSignalSource = {
  id: 'audit-denial',
  description: 'Audit chain entries that were denied by policy or ended in error.',
  minOccurrences: 3,
  hintCategory: 'policy-denial',
  hintText: (cluster) =>
    `${cluster.title} was denied ${cluster.total} times. Use the governed path for this ` +
    'operation instead of retrying it.',
  read(window) {
    const rows = readJsonlFilesMatching(
      pathResolver.shared('logs/audit'),
      dayTokens(window).map((day) => `audit-${day}`)
    );
    return rows.flatMap((row) => {
      const result = stringField(row, 'result');
      if (result !== 'denied' && result !== 'error' && result !== 'failed') return [];
      const ts = stringField(row, 'timestamp');
      if (!inWindow(ts, window)) return [];
      const action = stringField(row, 'action') || 'action';
      const operation = errorClass(stringField(row, 'operation') || 'operation', 50);
      const policy = stringField(asRecord(row.metadata), 'policy');
      const tenantSlug = stringField(row, 'tenantSlug') || undefined;
      return [
        {
          key: `${action}:${operation}:${result}${policy ? `:${policy}` : ''}`,
          title: `${action} ${operation} ${result}${policy ? ` by ${policy}` : ''}`,
          ref: `audit:${stringField(row, 'id')}`,
          ts,
          ...(tenantSlug ? { tenantSlug } : {}),
        },
      ];
    });
  },
};

// 6. Worker events and reasoning failover -------------------------------------

export const workerEventSource: LearningSignalSource = {
  id: 'worker-event',
  description: 'Worker event stream steps that failed and sub-agents that were unavailable.',
  minOccurrences: 3,
  read(window) {
    const dir = pathResolver.shared('logs/worker-events');
    if (!safeExistsSync(dir)) return [];
    const tokens = dayTokens(window);
    const files = safeReaddir(dir).filter(
      (name) => name.endsWith('.jsonl') && tokens.some((token) => name.includes(token))
    );
    const observations: LearningObservation[] = [];
    for (const file of files) {
      for (const event of readWorkerEventStreamJsonl(path.join(dir, file))) {
        if (!inWindow(event.ts, window)) continue;
        const payload = asRecord(event.payload);
        const ref = `worker-event:${file}#${event.seq}`;
        if (event.type === 'subagent_unavailable') {
          const who = stringField(payload, 'provider', 'agent_id', 'backend') || 'subagent';
          observations.push({
            key: `subagent_unavailable:${who}`,
            title: `sub-agent ${who} unavailable`,
            ref,
            ts: event.ts,
          });
        } else if (event.type === 'step_end') {
          const status = stringField(payload, 'status');
          if (status !== 'failed' && status !== 'error') continue;
          const op = stringField(payload, 'op', 'step_id') || 'step';
          const cls = errorClass(stringField(payload, 'error') || status);
          observations.push({
            key: `step_failed:${op}:${cls}`,
            title: `step ${op} failed (${cls})`,
            ref,
            ts: event.ts,
          });
        }
      }
    }
    return observations;
  },
};

export const reasoningFailoverSource: LearningSignalSource = {
  id: 'reasoning-failover',
  description: 'Reasoning backend failovers from one mode or provider to the next.',
  minOccurrences: 2,
  read(window) {
    return readJsonlRecords(reasoningFailoverEventsPath()).flatMap((row) => {
      const ts = stringField(row, 'ts');
      if (!inWindow(ts, window)) return [];
      const from = stringField(row, 'provider_from', 'from_mode') || 'unknown';
      const to = stringField(row, 'provider_to', 'to_mode') || 'unknown';
      const cls = errorClass(stringField(row, 'error_summary') || 'failover');
      return [
        {
          key: `${from}->${to}:${cls}`,
          title: `failover ${from} -> ${to} (${cls})`,
          ref: `reasoning-failover:${ts}`,
          ts,
        },
      ];
    });
  },
};

// 7. Execution metrics: errors, latency outliers and cost spikes --------------

const LATENCY_OUTLIER_FACTOR = 5;
const LATENCY_OUTLIER_FLOOR_MS = 30_000;
const COST_SPIKE_FACTOR = 3;
const COST_SPIKE_FLOOR_USD = 1;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function detectCostSpikes(
  records: ResourceUsageRecord[],
  window: LearningSignalWindow
): LearningObservation[] {
  const daily = new Map<string, Map<string, number>>();
  for (const record of records) {
    const day = String(record.timestamp || '').slice(0, 10);
    if (!day || !Number.isFinite(record.cost_usd)) continue;
    const bySource = daily.get(record.source) ?? new Map<string, number>();
    bySource.set(day, (bySource.get(day) || 0) + record.cost_usd);
    daily.set(record.source, bySource);
  }
  const windowDays = new Set(daysInWindow(window));
  const observations: LearningObservation[] = [];
  for (const [source, byDay] of daily) {
    const days = [...byDay.keys()].sort();
    for (const day of days) {
      if (!windowDays.has(day)) continue;
      const baseline = median(days.filter((d) => d < day).map((d) => byDay.get(d) || 0));
      const total = byDay.get(day) || 0;
      if (baseline <= 0 || total < COST_SPIKE_FLOOR_USD) continue;
      if (total < baseline * COST_SPIKE_FACTOR) continue;
      observations.push({
        key: `cost_spike:${source}`,
        title: `daily cost of ${source} spiked above ${COST_SPIKE_FACTOR}x its median`,
        ref: `resource-usage:${source}:${day}`,
        ts: `${day}T23:59:59.000Z`,
      });
    }
  }
  return observations.filter(
    (obs) => inWindow(obs.ts, window) || windowDays.has(obs.ts.slice(0, 10))
  );
}

export const executionMetricSource: LearningSignalSource = {
  id: 'execution-metric',
  description:
    'Execution metrics outside missions: component errors, latency far above the component median, and daily cost spikes.',
  minOccurrences: 3,
  read(window) {
    const history = metrics.loadHistory() as Row[];
    const durations = new Map<string, number[]>();
    for (const row of history) {
      const component = stringField(row, 'component');
      const duration = Number(row.duration_ms);
      if (component && Number.isFinite(duration)) {
        durations.set(component, [...(durations.get(component) || []), duration]);
      }
    }
    const medians = new Map([...durations].map(([key, values]) => [key, median(values)]));
    const observations: LearningObservation[] = [];
    for (const row of history) {
      if (row.type === 'intervention') continue;
      if (stringField(row, 'mission_id')) continue;
      const ts = stringField(row, 'timestamp');
      if (!inWindow(ts, window)) continue;
      const component = stringField(row, 'component') || 'component';
      const ref = `execution-metric:${component}:${ts}`;
      if (row.status === 'error') {
        const cls = errorClass(stringField(row, 'error', 'message') || 'error');
        observations.push({
          key: `error:${component}:${cls}`,
          title: `${component} error (${cls})`,
          ref,
          ts,
        });
        continue;
      }
      const duration = Number(row.duration_ms);
      const typical = medians.get(component) || 0;
      if (
        typical > 0 &&
        duration >= LATENCY_OUTLIER_FLOOR_MS &&
        duration >= typical * LATENCY_OUTLIER_FACTOR
      ) {
        observations.push({
          key: `slow:${component}`,
          title: `${component} ran over ${LATENCY_OUTLIER_FACTOR}x its median duration`,
          ref,
          ts,
        });
      }
    }
    return [...observations, ...detectCostSpikes(metrics.loadResourceUsageHistory(), window)];
  },
};

// 8. Defects and runtime health -----------------------------------------------

export const defectSource: LearningSignalSource = {
  id: 'defect',
  description: 'QA defect transitions back to open or reopened.',
  minOccurrences: 2,
  read(window) {
    return readJsonlRecords(pathResolver.shared('runtime/qa/defect-events.jsonl')).flatMap(
      (row) => {
        const event = parseDefectTransitionEvent(row);
        if (!event || !inWindow(event.occurred_at, window)) return [];
        if (event.to !== 'reopened' && event.to !== 'open') return [];
        return [
          {
            key: `${event.to}:${event.actor_type}`,
            title: `defect moved to ${event.to} by ${event.actor_type}`,
            ref: `defect:${event.defect_id}`,
            ts: event.occurred_at,
          },
        ];
      }
    );
  },
};

const RUNTIME_TREND_THRESHOLDS = {
  rss_growth_warning_ratio: 1.5,
  rss_growth_red_ratio: 2.5,
  restart_warning_count: 3,
  restart_red_count: 10,
};

export const runtimeHealthSource: LearningSignalSource = {
  id: 'runtime-health',
  description: 'Resident processes whose memory kept growing or whose agents kept restarting.',
  minOccurrences: 2,
  read(window) {
    const windowMs = window.until.getTime() - window.since.getTime();
    const samples = loadRuntimeHealthSamples(windowMs, window.until.getTime());
    return evaluateRuntimeHealthTrends(samples, RUNTIME_TREND_THRESHOLDS).map((finding) => {
      const processName = finding.detail.split(':')[0] || 'process';
      return {
        key: `${finding.kind}:${processName}`,
        title: `${processName} ${finding.kind.replace('_', ' ')} (${finding.severity})`,
        ref: `runtime-health:${processName}:${window.until.toISOString().slice(0, 10)}`,
        ts: window.until.toISOString(),
      };
    });
  },
};

// 9. Collaboration logs: peer conversations, discussions, co-sessions ---------

export const collaborationSource: LearningSignalSource = {
  id: 'collaboration',
  description:
    'Peer conversations that failed or were blocked, discussion rooms that errored or whose output was rejected, and co-session leases that expired.',
  minOccurrences: 3,
  read(window) {
    const observations: LearningObservation[] = [];

    for (const tenant of listPeerConversationTenants()) {
      for (const peer of listPeerConversationPeers(tenant)) {
        for (const session of listPeerConversationSessions(tenant, peer)) {
          if (session.status !== 'failed' && session.status !== 'blocked') continue;
          if (!inWindow(session.updated_at, window)) continue;
          observations.push({
            key: `peer:${session.status}:${session.remote_peer_id}`,
            title: `peer conversation with ${session.remote_peer_id} ${session.status}`,
            ref: `peer-conversation:${tenant}/${peer}/${session.session_id}`,
            ts: session.updated_at,
            tenantSlug: tenant,
          });
        }
      }
    }

    for (const room of listDiscussionRooms()) {
      const state = readDiscussionRoom(room.id);
      const tenantSlug = state?.scope?.tenant_slug?.trim() || undefined;
      for (const event of readDiscussionEvents(room.id).map(asRecord)) {
        const ts = stringField(event, 'ts');
        if (!inWindow(ts, window)) continue;
        const type = stringField(event, 'type');
        let key = '';
        if (type === 'error') key = 'discussion:error';
        if (
          type === 'status_changed' &&
          ['failed', 'stopped'].includes(stringField(event, 'status'))
        ) {
          key = `discussion:${stringField(event, 'status')}`;
        }
        if (type === 'review_recorded' && stringField(event, 'verdict') !== 'accept') {
          key = `discussion:review_${stringField(event, 'verdict')}`;
        }
        if (!key) continue;
        observations.push({
          key,
          title: key.replace(':', ' ').replace('_', ' '),
          ref: `discussion:${room.id}#${String(event.seq ?? '')}`,
          ts,
          ...(tenantSlug ? { tenantSlug } : {}),
        });
      }
    }

    const coRoot = pathResolver.shared('observability/co-sessions');
    for (const sessionId of listSubdirs(coRoot)) {
      for (const event of readJsonlRecords(path.join(coRoot, sessionId, 'events.jsonl'))) {
        if (stringField(event, 'type') !== 'lease_expired') continue;
        const ts = stringField(event, 'at');
        if (!inWindow(ts, window)) continue;
        const provider = stringField(event, 'actor_provider') || 'provider';
        observations.push({
          key: `co-session:lease_expired:${provider}`,
          title: `co-session lease held by ${provider} expired`,
          ref: `co-session:${sessionId}/${stringField(event, 'event_id')}`,
          ts,
        });
      }
    }
    return observations;
  },
};

// 10. Security quarantine -----------------------------------------------------

export const quarantineSource: LearningSignalSource = {
  id: 'quarantine',
  description:
    'Inbound content quarantined by the security screen, grouped by source and indicators.',
  minOccurrences: 2,
  read(window) {
    return listQuarantineRecords(500)
      .filter((record) => inWindow(record.recorded_at, window))
      .map((record) => {
        const indicators = [...record.indicators].sort().join('+') || 'unspecified';
        return {
          key: `${record.source}:${indicators}`,
          title: `${record.source} content quarantined (${indicators})`,
          ref: `quarantine:${record.id}`,
          ts: record.recorded_at,
        };
      });
  },
};

/** Every built-in source, in the order the harvest report lists them. */
export function builtinLearningSignalSources(): LearningSignalSource[] {
  return [
    conversationSignalSource,
    approvalRejectionSource,
    traceFailureSource,
    taskSessionFailureSource,
    adfRepairSource,
    delegationFailureSource,
    auditDenialSource,
    workerEventSource,
    reasoningFailoverSource,
    executionMetricSource,
    defectSource,
    runtimeHealthSource,
    collaborationSource,
    quarantineSource,
  ];
}

export type { LearningCluster };
