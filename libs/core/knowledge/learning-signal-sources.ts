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
import { isValidTenantSlug } from '../entity-scope.js';
import { listTaskSessions } from '../task/task-session.js';
import { delegatedTaskTracePath } from '../delegated-task-observability.js';
import {
  closedToken,
  daysInWindow,
  errorClass,
  errorCode,
  filesModifiedSince,
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
      const scope = closedToken(signal.intent_id || signal.surface || 'unknown');
      const locale = closedToken(signal.locale || 'any');
      return {
        key: `${signal.kind}:${scope}:${locale}`,
        title: `${signal.kind} on ${scope}${locale !== 'any' ? ` (${locale})` : ''}`,
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
        const reason = closedToken(
          stringField(event, 'reason_category') || annotated || 'uncategorized'
        );
        const kind = closedToken(String(record?.kind || 'unknown'));
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
      const scope = closedToken(
        stringField(metadata, 'pipelineId', 'actuator') ||
          stringField(asRecord(row.rootSpan), 'name') ||
          'run',
        'run'
      );
      const step = closedToken(deepest.name, 'step');
      const code = errorCode(deepest.error || 'failed');
      const tenantSlug = stringField(metadata, 'tenantSlug') || undefined;
      observations.push({
        key: `${scope}:${step}:${code}`,
        title: `${scope} step ${step} failed (${code})`,
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
        const intentId = closedToken(String(session.payload?.intent_id || '').trim(), 'no-intent');
        const taskType = closedToken(String(session.task_type || ''), 'task');
        const tenantSlug = session.project_context?.tenant_slug?.trim() || undefined;
        return {
          key: `${taskType}:${intentId}`,
          title: `${taskType} task session for ${intentId} failed`,
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
  // The repair agent completes (not fails) a trace whose output still did not validate.
  if (
    status === 'completed' &&
    /validation still failed/i.test(stringField(row, 'result_summary'))
  ) {
    return { failed: true, error: 'validation still failed' };
  }
  if (status === 'completed') return { failed: false, error: '' };
  return null;
}

/** Closed classification of the errors an ADF repair was asked to fix. */
export function adfErrorCategory(context: string): string {
  if (/JSON parse error|unexpected token|not valid JSON/i.test(context)) return 'json_parse';
  if (/^Execution failure/i.test(context)) return 'execution_failure';
  if (/required property|is required|missing/i.test(context)) return 'missing_required';
  if (/must be equal to one of|allowed values|enum/i.test(context)) return 'enum_violation';
  if (/additional propert/i.test(context)) return 'additional_property';
  if (/must be (string|number|integer|boolean|array|object|null)/i.test(context))
    return 'type_mismatch';
  if (/guardrail/i.test(context)) return 'guardrail';
  return 'other';
}

function readDelegationRows(window: LearningSignalWindow): Row[] {
  return readJsonlRecords(delegatedTaskTracePath()).filter((row) =>
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
        const category = adfErrorCategory(stringField(row, 'context'));
        const result = outcome.failed ? 'repair failed' : 'repaired';
        return [
          {
            key: `${outcome.failed ? 'failed' : 'repaired'}:${category}`,
            title: `ADF ${category.replace(/_/g, ' ')} (${result})`,
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
        const owner = closedToken(stringField(row, 'owner') || 'unknown');
        const backend = closedToken(stringField(row, 'backend_name') || 'any');
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
      const action = closedToken(stringField(row, 'action') || 'action');
      const operation = closedToken(
        stringField(row, 'operation').split(/\s+/)[0] || '',
        'operation'
      );
      const policy = stringField(asRecord(row.metadata), 'policy')
        ? closedToken(stringField(asRecord(row.metadata), 'policy'))
        : '';
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
    // The writer names a file after the day its process started and keeps
    // appending to it, so select by modification time rather than by name.
    const dir = pathResolver.shared('logs/worker-events');
    const files = filesModifiedSince(dir, window.since);
    const observations: LearningObservation[] = [];
    for (const file of files) {
      for (const event of readWorkerEventStreamJsonl(path.join(dir, file))) {
        if (!inWindow(event.ts, window)) continue;
        const payload = asRecord(event.payload);
        const ref = `worker-event:${file}#${event.seq}`;
        if (event.type === 'subagent_unavailable') {
          const who = closedToken(
            stringField(payload, 'provider', 'agent_id', 'backend'),
            'subagent'
          );
          observations.push({
            key: `subagent_unavailable:${who}`,
            title: `sub-agent ${who} unavailable`,
            ref,
            ts: event.ts,
          });
        } else if (event.type === 'step_end') {
          const status = stringField(payload, 'status');
          if (status !== 'failed' && status !== 'error') continue;
          const op = closedToken(stringField(payload, 'op', 'step_id'), 'step');
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
      const from = closedToken(stringField(row, 'provider_from', 'from_mode'), 'unknown');
      const to = closedToken(stringField(row, 'provider_to', 'to_mode'), 'unknown');
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
    const source = closedToken(String(record.source || ''), 'unknown');
    const bySource = daily.get(source) ?? new Map<string, number>();
    bySource.set(day, (bySource.get(day) || 0) + record.cost_usd);
    daily.set(source, bySource);
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
      const component = closedToken(stringField(row, 'component'), 'component');
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

const RUNTIME_TREND_LOOKBACK_MS = 86_400_000;

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
    // Trends need a full day of samples whatever the harvest cadence; one
    // observation per process, trend and day keeps an ongoing trend from being
    // counted again on every harvest (the adapter dedupes by ref).
    const samples = loadRuntimeHealthSamples(RUNTIME_TREND_LOOKBACK_MS, window.until.getTime());
    const lastSampleAt = new Map<string, string>();
    for (const sample of samples) {
      const current = lastSampleAt.get(sample.process_name);
      if (!current || sample.timestamp > current) {
        lastSampleAt.set(sample.process_name, sample.timestamp);
      }
    }
    return evaluateRuntimeHealthTrends(samples, RUNTIME_TREND_THRESHOLDS).map((finding) => {
      const rawName = finding.detail.split(':')[0] || 'process';
      const processName = closedToken(rawName, 'process');
      const ts = lastSampleAt.get(rawName) || window.until.toISOString();
      return {
        key: `${finding.kind}:${processName}`,
        title: `${processName} ${finding.kind.replace('_', ' ')} (${finding.severity})`,
        ref: `runtime-health:${processName}:${finding.kind}:${ts.slice(0, 10)}`,
        ts,
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
            key: `peer:${session.status}:${closedToken(session.remote_peer_id, 'peer')}`,
            title: `peer conversation with ${closedToken(session.remote_peer_id, 'peer')} ${session.status}`,
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
          key = `discussion:review_${closedToken(stringField(event, 'verdict'))}`;
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
        const provider = closedToken(stringField(event, 'actor_provider'), 'provider');
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
        const indicators =
          [...record.indicators]
            .map((indicator) => closedToken(indicator))
            .sort()
            .join('+') || 'unspecified';
        const origin = closedToken(record.source, 'external');
        const scope = record.scope?.trim() || '';
        return {
          key: `${origin}:${indicators}`,
          title: `${origin} content quarantined (${indicators})`,
          ref: `quarantine:${record.id}`,
          ts: record.recorded_at,
          ...(scope && isValidTenantSlug(scope) ? { tenantSlug: scope } : {}),
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
