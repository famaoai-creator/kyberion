/**
 * Weekly Kyberion usage report — aggregation over the daily audit chain files
 * (`active/shared/logs/audit/audit-YYYY-MM-DD.jsonl`, UTC-dated).
 *
 * Weeks run Monday 00:00 → next Monday 00:00 Asia/Tokyo (JST has no DST, so a
 * fixed +09:00 offset is exact). The report carries counts and categories
 * only: prompt text, commands and file paths are read to classify activity
 * (tenant touched, mission touched) and are never copied into the output —
 * prompts can carry confidential tenant content.
 *
 * The execution-origin section (`aggregateExecutionOrigins`) additionally
 * reads the execution-metrics ledger (LLM calls, tokens, per-wake accounting)
 * and the agent-runtime supervisor events — counts and token totals only.
 *
 * Pure aggregation (`aggregateUsageWeek`, `aggregateExecutionOrigins`,
 * `buildUsageWeeklyReport`, `renderUsageWeeklyMarkdown`) is separated from the
 * file reads (`readAuditRecordsForWindow`, `readExecutionMetricsForWindow`,
 * `readSupervisorEventsForWindow`) so tests feed fixture lines directly.
 */

import * as path from 'node:path';
import { isReservedScopeName, isValidTenantSlug } from '@agent/core/entity-scope';
import { tenantOfPath } from '@agent/core/path-tenant-attribution';
import { streamJsonLines } from '@agent/core/jsonl-read';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeReaddir } from '@agent/core/secure-io';

const DAY_MS = 24 * 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** A session at or above this many recorded events is flagged as a context-cost risk. */
export const LONG_SESSION_EVENT_THRESHOLD = 1000;
const TOP_ROWS = 5;
const TRIGGER_CLUSTER_MIN = 5;
const DOT_DENIAL_CLUSTER_MIN = 3;
const OUTSIDE_MISSION_RATIO = 0.5;
const OUTSIDE_MISSION_MIN_PROMPTS = 20;
const HOST_SUSPENDED_NOTE_MIN = 3;
const VOLUME_SWING_RATIO = 0.5;

export const HOST_SUSPENDED_REASON = 'host_suspended';

export interface UsageAuditRecord {
  timestamp?: string;
  agentId?: string;
  action?: string;
  operation?: string;
  result?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface UsageWeekWindow {
  /** Monday (JST) that opens the week, `YYYY-MM-DD`. */
  week: string;
  start_ms: number;
  end_ms: number;
}

export interface UsageSessionRow {
  /** First 8 characters of the host session id — enough to correlate, not a full identifier. */
  session: string;
  host: string;
  events: number;
  prompts: number;
  tool_events: number;
  touched_mission: boolean;
  first_at: string;
  last_at: string;
}

export interface UsageCount {
  key: string;
  count: number;
}

export interface UsageDayRow {
  day: string;
  events: number;
  prompts: number;
  tool_events: number;
  sessions: number;
}

export interface UsageWeekSummary {
  week: string;
  total_events: number;
  prompts: number;
  tool_events: number;
  by_action: UsageCount[];
  by_day: UsageDayRow[];
  peak_prompt_hours_jst: UsageCount[];
  sessions: {
    count: number;
    long_session_threshold: number;
    long_sessions: number;
    top: UsageSessionRow[];
  };
  tool_mix: UsageCount[];
  tenants_touched: UsageCount[];
  missions: {
    by_verb: UsageCount[];
    created: number;
    started: number;
    created_families: UsageCount[];
  };
  prompts_outside_mission: {
    prompts: number;
    sessions: number;
    ratio: number | null;
    /** Prompts recorded without a host session id (older hook builds) — not classifiable. */
    unattributed_prompts: number;
  };
  trigger: {
    delivered: number;
    failed: number;
    failed_excluding_host_suspended: number;
    host_suspended: number;
    by_reason: UsageCount[];
    by_source: UsageCount[];
  };
  dot_denials: {
    total: number;
    by_reason: UsageCount[];
    by_dot: UsageCount[];
  };
  tenant_scope_violations: number;
}

export interface UsageImprovementCandidate {
  id: string;
  severity: 'high' | 'medium' | 'info';
  text: string;
}

/** Where a unit of work was started from (実行元). */
export type ExecutionOrigin =
  'interactive_cli' | 'dot' | 'trigger_daemon' | 'agent_runtime' | 'other';

export const EXECUTION_ORIGINS: readonly ExecutionOrigin[] = [
  'interactive_cli',
  'dot',
  'trigger_daemon',
  'agent_runtime',
  'other',
];

/** One execution-metrics ledger row (`work/metrics/execution-metrics.jsonl` + tier partitions). */
export interface ExecutionMetricRecord {
  timestamp?: string;
  component?: string;
  status?: string;
  actor_id?: string;
  accounting_id?: string;
  operation?: string;
  usage?: Record<string, unknown>;
  /** Stop-hook (`claude-code-cli`) rows keep cache counters beside `usage`. */
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
}

/** One agent-runtime supervisor event (`agent-runtime-supervisor-events-YYYY-MM-DD.jsonl`). */
export type SupervisorEventRecord = Record<string, unknown>;

export interface ExecutionTokenTotals {
  /** Uncached input + cache read + cache writes (the counters are disjoint). */
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  /** cache_read / input incl. cache; null when no row carried cache counters. */
  cache_hit_ratio: number | null;
}

export interface ExecutionOriginRow {
  origin: ExecutionOrigin;
  audit_events: number;
  /** Audit records with result error/failed. */
  audit_failures: number;
  llm_calls: number;
  llm_failures: number;
  /** null when no metered row exists for the origin. */
  tokens: ExecutionTokenTotals | null;
  /** Caveat for the token column (e.g. interactive CLI metering source). */
  token_note?: string;
}

export interface ExecutionDotRow {
  dot: string;
  audit_events: number;
  llm_calls: number;
  llm_failures: number;
  /** Distinct accounting_id values — one per wake. */
  wakes: number;
  calls_per_wake: number | null;
  tokens: ExecutionTokenTotals | null;
}

export interface ExecutionOriginSummary {
  sources: { audit_records: number; execution_metrics_records: number; supervisor_events: number };
  by_origin: ExecutionOriginRow[];
  /** Top audit agentIds inside the trigger/daemon and other buckets. */
  trigger_daemon_agents: UsageCount[];
  other_agents: UsageCount[];
  dots: ExecutionDotRow[];
  /** reasoning:* route events — no actor id, so not attributed to an origin. */
  reasoning_routes: UsageCount[];
  supervisor: {
    asks_completed: number;
    asks_failed: number;
    ask_input_tokens: number;
    ask_output_tokens: number;
    asks_usage_estimated: number;
    daemon_started: number;
    daemon_stops_by_reason: UsageCount[];
  };
}

export interface UsageWeeklyReport {
  generated_at: string;
  window: { week: string; start: string; end: string; timezone: 'Asia/Tokyo' };
  current: UsageWeekSummary;
  previous: UsageWeekSummary;
  delta: Record<'total_events' | 'prompts' | 'tool_events' | 'sessions' | 'trigger_failed', number>;
  /** Current week only. */
  execution_origin: ExecutionOriginSummary;
  improvement_candidates: UsageImprovementCandidate[];
}

// ---------------------------------------------------------------------------
// Week arithmetic (JST)
// ---------------------------------------------------------------------------

function jstDayString(ms: number): string {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10);
}

function jstHour(ms: number): number {
  return new Date(ms + JST_OFFSET_MS).getUTCHours();
}

/** Start (ms) of the JST calendar day `YYYY-MM-DD`. */
function jstDayStartMs(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`) - JST_OFFSET_MS;
}

/**
 * Resolve the reporting week. `week` must be a Monday (JST calendar date);
 * omitted → the previous full week relative to `now`.
 */
export function resolveUsageWeek(week?: string, now: Date = new Date()): UsageWeekWindow {
  if (week !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(week) || Number.isNaN(Date.parse(`${week}T00:00:00Z`))) {
      throw new Error(`--week must be a date in YYYY-MM-DD form, got: ${week}`);
    }
    if (new Date(`${week}T00:00:00Z`).getUTCDay() !== 1) {
      throw new Error(`--week must be a Monday (JST), got: ${week}`);
    }
    const start = jstDayStartMs(week);
    return { week, start_ms: start, end_ms: start + 7 * DAY_MS };
  }
  const today = jstDayString(now.getTime());
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  const sinceMonday = (weekday + 6) % 7;
  const thisMonday = jstDayStartMs(today) - sinceMonday * DAY_MS;
  const start = thisMonday - 7 * DAY_MS;
  return { week: jstDayString(start), start_ms: start, end_ms: start + 7 * DAY_MS };
}

export function previousUsageWeek(window: UsageWeekWindow): UsageWeekWindow {
  const start = window.start_ms - 7 * DAY_MS;
  return { week: jstDayString(start), start_ms: start, end_ms: window.start_ms };
}

/** UTC file dates whose audit files can hold records of the window. */
export function auditFileDatesForWindow(window: UsageWeekWindow): string[] {
  const dates: string[] = [];
  const first = Math.floor(window.start_ms / DAY_MS) * DAY_MS;
  for (let ms = first; ms < window.end_ms; ms += DAY_MS) {
    dates.push(new Date(ms).toISOString().slice(0, 10));
  }
  return dates;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export function defaultAuditDir(): string {
  return pathResolver.shared('logs/audit');
}

/** Stream the audit records whose timestamp falls inside the window. Malformed lines are skipped. */
export function readAuditRecordsForWindow(
  window: UsageWeekWindow,
  auditDir: string = defaultAuditDir()
): UsageAuditRecord[] {
  const records: UsageAuditRecord[] = [];
  for (const date of auditFileDatesForWindow(window)) {
    const filePath = path.join(auditDir, `audit-${date}.jsonl`);
    if (!safeExistsSync(filePath)) continue;
    for (const raw of streamJsonLines<unknown>(filePath, { onMalformed: 'skip' })) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const record = raw as UsageAuditRecord;
      const ms = Date.parse(String(record.timestamp ?? ''));
      if (Number.isFinite(ms) && ms >= window.start_ms && ms < window.end_ms) records.push(record);
    }
  }
  return records;
}

/** Repo-wide (system partition) execution-metrics ledger. */
export function defaultExecutionMetricsFile(): string {
  return pathResolver.resolve('work/metrics/execution-metrics.jsonl');
}

/** Root of the `<tier>/<tenant|shared>/execution-metrics.jsonl` partitions. */
export function defaultExecutionMetricsPartitionRoot(): string {
  return pathResolver.shared('runtime/execution-metrics');
}

export function defaultSupervisorEventsDir(): string {
  return pathResolver.shared('observability/mission-control');
}

function plainObject(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

function readJsonlWindow(
  filePath: string,
  window: UsageWeekWindow,
  timestampOf: (row: Record<string, unknown>) => unknown,
  out: Record<string, unknown>[]
): void {
  if (!safeExistsSync(filePath)) return;
  for (const raw of streamJsonLines<unknown>(filePath, { onMalformed: 'skip' })) {
    const row = plainObject(raw);
    if (!row) continue;
    const ms = Date.parse(String(timestampOf(row) ?? ''));
    if (Number.isFinite(ms) && ms >= window.start_ms && ms < window.end_ms) out.push(row);
  }
}

function listDirs(dir: string): string[] {
  try {
    return safeExistsSync(dir) ? safeReaddir(dir) : [];
  } catch {
    return [];
  }
}

/**
 * Execution-metrics rows inside the window: the system ledger plus every
 * readable `<tier>/<scope>/` partition. A partition the current persona may
 * not read (tier-guard) is skipped, not fatal.
 */
export function readExecutionMetricsForWindow(
  window: UsageWeekWindow,
  options: { file?: string; partitionRoot?: string } = {}
): ExecutionMetricRecord[] {
  const rows: Record<string, unknown>[] = [];
  readJsonlWindow(options.file ?? defaultExecutionMetricsFile(), window, (r) => r.timestamp, rows);
  const root = options.partitionRoot ?? defaultExecutionMetricsPartitionRoot();
  for (const tier of listDirs(root)) {
    for (const scope of listDirs(path.join(root, tier))) {
      try {
        readJsonlWindow(
          path.join(root, tier, scope, 'execution-metrics.jsonl'),
          window,
          (r) => r.timestamp,
          rows
        );
      } catch {
        // Partition not readable by this persona — skip.
      }
    }
  }
  return rows as ExecutionMetricRecord[];
}

/** Supervisor events inside the window from the UTC-dated rotated files (legacy file is pre-rotation history). */
export function readSupervisorEventsForWindow(
  window: UsageWeekWindow,
  dir: string = defaultSupervisorEventsDir()
): SupervisorEventRecord[] {
  const rows: Record<string, unknown>[] = [];
  for (const date of auditFileDatesForWindow(window)) {
    readJsonlWindow(
      path.join(dir, `agent-runtime-supervisor-events-${date}.jsonl`),
      window,
      (r) => r.ts ?? r.timestamp,
      rows
    );
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Classification helpers
// ---------------------------------------------------------------------------

const TENANT_PATH_RE = /(knowledge|active\/missions)\/confidential\/([a-z0-9][a-z0-9-]*)\//gu;
const MISSION_TOUCH_RE = /active\/missions\/|\bMSN-[A-Z0-9]|mission_controller|\bpnpm mission\b/u;
const UPPER_CODE_RE = /\[([A-Z][A-Z0-9_]{2,})\]/gu;

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function meta(record: UsageAuditRecord): Record<string, unknown> {
  return record.metadata && typeof record.metadata === 'object' ? record.metadata : {};
}

function sessionHook(record: UsageAuditRecord): { session_id: string; host: string } | null {
  const hook = meta(record).session_hook;
  if (!hook || typeof hook !== 'object') return null;
  const sessionId = str((hook as Record<string, unknown>).session_id);
  if (!sessionId) return null;
  return { session_id: sessionId, host: str((hook as Record<string, unknown>).host) || 'unknown' };
}

/** Text fields that locate the work (never copied into the report). */
function locatorText(record: UsageAuditRecord): string {
  const m = meta(record);
  return [str(m.cwd), str(m.command), str(m.file_path)].join('\n');
}

function knowledgeTenant(repoPath: string): string | undefined {
  try {
    return tenantOfPath(repoPath);
  } catch {
    return undefined;
  }
}

export function tenantsInText(text: string): string[] {
  const found = new Set<string>();
  TENANT_PATH_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TENANT_PATH_RE.exec(text))) {
    const slug = match[2]!;
    if (!isValidTenantSlug(slug) || isReservedScopeName(slug)) continue;
    // Shared knowledge prefixes (tenant-groups/, heuristics/, …) are not
    // tenants; tenantOfPath applies the policy's shared_prefixes list.
    if (match[1] === 'knowledge' && !knowledgeTenant(`knowledge/confidential/${slug}/x`)) continue;
    found.add(slug);
  }
  return [...found];
}

/**
 * Collapse a trigger failure reason into a stable category. Laptop sleep
 * (`host suspended`) is its own bucket — it is not a failure.
 */
export function normalizeTriggerFailureReason(reason: unknown): string {
  const text = str(reason);
  if (!text) return 'unspecified';
  if (/host suspended/iu.test(text)) return HOST_SUSPENDED_REASON;
  const codes = [...text.matchAll(UPPER_CODE_RE)].map((m) => m[1]!);
  const failover = /reasoning-backend:failover/u.test(text) ? 'failover:' : '';
  if (codes.length > 0) return `${failover}${codes.slice(0, 2).join('/')}`;
  if (/wall_clock budget/u.test(text)) return 'wall_clock_budget_exceeded';
  if (/timed out/iu.test(text)) return `${failover}timeout`;
  if (/exited with code/iu.test(text)) return `${failover}cli_exit_nonzero`;
  // Free text may name tenants or customers; keep only a coarse category.
  return `${failover}other`;
}

/** Denial reasons are free text from tenant-scoped dots: keep a code, never the prose. */
function denialReasonCode(reason: string): string {
  if (!reason) return 'unspecified';
  const code = /\[([A-Z][A-Z0-9_]{2,})\]/u.exec(reason)?.[1];
  if (code) return code;
  // Known system phrases map to fixed codes; any other prose collapses to 'other'.
  if (/approval (?:has )?expired/iu.test(reason)) return 'approval_expired';
  if (/approval (?:required|missing|pending)/iu.test(reason)) return 'approval_required';
  if (/budget/iu.test(reason)) return 'budget_exceeded';
  if (/rate.?limit/iu.test(reason)) return 'rate_limited';
  const ident = reason.match(/^[a-z][a-z0-9_.-]{2,40}$/u)?.[0];
  return ident ?? 'other';
}

/** `wake:dot:<id>:…` / `cron:dot:<id>:…` → `dot:<id>`; anything else → its first segment. */
export function triggerSource(operation: unknown): string {
  const parts = str(operation).split(':');
  if (parts[1] === 'dot' && parts[2]) return `dot:${parts[2]}`;
  return parts[0] || 'unknown';
}

function missionFamily(missionId: string): string {
  return missionId.replace(/-\d{8}.*$/u, '') || missionId;
}

function bump(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

function sorted(map: Map<string, number>, limit?: number): UsageCount[] {
  const rows = [...map.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  return limit === undefined ? rows : rows.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

interface SessionAccumulator {
  host: string;
  events: number;
  prompts: number;
  tool_events: number;
  touched_mission: boolean;
  first_ms: number;
  last_ms: number;
}

export function aggregateUsageWeek(
  records: readonly UsageAuditRecord[],
  window: UsageWeekWindow,
  longSessionThreshold = LONG_SESSION_EVENT_THRESHOLD
): UsageWeekSummary {
  const byAction = new Map<string, number>();
  const days = new Map<
    string,
    { events: number; prompts: number; tools: number; sessions: Set<string> }
  >();
  for (let i = 0; i < 7; i++) {
    days.set(jstDayString(window.start_ms + i * DAY_MS), {
      events: 0,
      prompts: 0,
      tools: 0,
      sessions: new Set(),
    });
  }
  const promptHours = new Map<string, number>();
  const sessions = new Map<string, SessionAccumulator>();
  const toolMix = new Map<string, number>();
  const tenants = new Map<string, number>();
  const missionVerbs = new Map<string, number>();
  const createdFamilies = new Map<string, number>();
  let created = 0;
  let started = 0;
  const triggerReasons = new Map<string, number>();
  const triggerSources = new Map<string, number>();
  let delivered = 0;
  let failed = 0;
  let hostSuspended = 0;
  const dotDenialReasons = new Map<string, number>();
  const dotDenialDots = new Map<string, number>();
  let dotDenials = 0;
  let scopeViolations = 0;
  let prompts = 0;
  let unattributedPrompts = 0;
  let toolEvents = 0;

  const inWindow = records.filter((record) => {
    const ms = Date.parse(str(record.timestamp));
    return Number.isFinite(ms) && ms >= window.start_ms && ms < window.end_ms;
  });
  for (const record of inWindow) {
    const action = str(record.action) || 'unknown';
    const ms = Date.parse(str(record.timestamp));
    bump(byAction, action);
    const day = Number.isFinite(ms) ? days.get(jstDayString(ms)) : undefined;
    if (day) day.events += 1;

    const hook = sessionHook(record);
    const locator = locatorText(record);
    if (hook) {
      let session = sessions.get(hook.session_id);
      if (!session) {
        session = {
          host: hook.host,
          events: 0,
          prompts: 0,
          tool_events: 0,
          touched_mission: false,
          first_ms: ms,
          last_ms: ms,
        };
        sessions.set(hook.session_id, session);
      }
      session.events += 1;
      if (Number.isFinite(ms)) {
        session.first_ms = Math.min(session.first_ms, ms);
        session.last_ms = Math.max(session.last_ms, ms);
      }
      if (MISSION_TOUCH_RE.test(locator)) session.touched_mission = true;
      day?.sessions.add(hook.session_id);
    }

    for (const slug of tenantsInText(locator)) bump(tenants, slug);

    switch (action) {
      case 'claude_code_user_prompt': {
        prompts += 1;
        if (day) day.prompts += 1;
        if (Number.isFinite(ms)) bump(promptHours, String(jstHour(ms)).padStart(2, '0'));
        if (hook) sessions.get(hook.session_id)!.prompts += 1;
        else unattributedPrompts += 1;
        break;
      }
      case 'claude_code_tool': {
        toolEvents += 1;
        if (day) day.tools += 1;
        if (hook) sessions.get(hook.session_id)!.tool_events += 1;
        bump(toolMix, str(meta(record).tool) || str(record.operation) || 'unknown');
        break;
      }
      case 'mission.lifecycle_verb': {
        const [verb = 'unknown', missionId = ''] = str(record.operation).split(':');
        bump(missionVerbs, verb);
        if (verb === 'create') {
          created += 1;
          if (missionId) bump(createdFamilies, missionFamily(missionId));
        }
        if (verb === 'start') started += 1;
        break;
      }
      case 'trigger.delivered':
        delivered += 1;
        break;
      case 'trigger.failed': {
        failed += 1;
        const reason = normalizeTriggerFailureReason(record.reason);
        bump(triggerReasons, reason);
        if (reason === HOST_SUSPENDED_REASON) hostSuspended += 1;
        else bump(triggerSources, triggerSource(record.operation));
        break;
      }
      case 'dot_action': {
        if (record.result !== 'denied') break;
        dotDenials += 1;
        const m = meta(record);
        bump(
          dotDenialReasons,
          `${str(record.operation) || 'unknown'}: ${denialReasonCode(str(m.check_id) || str(m.reason) || str(record.reason))}`
        );
        bump(dotDenialDots, str(m.dot_id) || 'unknown');
        break;
      }
      case 'tenant.scope_violation':
        scopeViolations += 1;
        break;
      default:
        break;
    }
  }

  const sessionRows: UsageSessionRow[] = [...sessions.entries()]
    .map(([id, s]) => ({
      session: id.slice(0, 8),
      host: s.host,
      events: s.events,
      prompts: s.prompts,
      tool_events: s.tool_events,
      touched_mission: s.touched_mission,
      first_at: Number.isFinite(s.first_ms) ? new Date(s.first_ms).toISOString() : '',
      last_at: Number.isFinite(s.last_ms) ? new Date(s.last_ms).toISOString() : '',
    }))
    .sort((a, b) => b.events - a.events || a.session.localeCompare(b.session));
  const outside = sessionRows.filter((row) => row.prompts > 0 && !row.touched_mission);
  const outsidePrompts = outside.reduce((sum, row) => sum + row.prompts, 0);

  return {
    week: window.week,
    total_events: inWindow.length,
    prompts,
    tool_events: toolEvents,
    by_action: sorted(byAction, 12),
    by_day: [...days.entries()].map(([d, v]) => ({
      day: d,
      events: v.events,
      prompts: v.prompts,
      tool_events: v.tools,
      sessions: v.sessions.size,
    })),
    peak_prompt_hours_jst: sorted(promptHours, 3),
    sessions: {
      count: sessionRows.length,
      long_session_threshold: longSessionThreshold,
      long_sessions: sessionRows.filter((row) => row.events >= longSessionThreshold).length,
      top: sessionRows.slice(0, TOP_ROWS),
    },
    tool_mix: sorted(toolMix),
    tenants_touched: sorted(tenants),
    missions: {
      by_verb: sorted(missionVerbs),
      created,
      started,
      created_families: sorted(createdFamilies),
    },
    prompts_outside_mission: {
      prompts: outsidePrompts,
      sessions: outside.length,
      // Ratio over prompts that carry a session id; unattributed ones are excluded.
      ratio:
        prompts - unattributedPrompts > 0 ? outsidePrompts / (prompts - unattributedPrompts) : null,
      unattributed_prompts: unattributedPrompts,
    },
    trigger: {
      delivered,
      failed,
      failed_excluding_host_suspended: failed - hostSuspended,
      host_suspended: hostSuspended,
      by_reason: sorted(triggerReasons),
      by_source: sorted(triggerSources, TOP_ROWS),
    },
    dot_denials: {
      total: dotDenials,
      by_reason: sorted(dotDenialReasons, TOP_ROWS),
      by_dot: sorted(dotDenialDots, TOP_ROWS),
    },
    tenant_scope_violations: scopeViolations,
  };
}

// ---------------------------------------------------------------------------
// Execution origin (実行元)
// ---------------------------------------------------------------------------

/** Audit agentIds of chronos triggers and resident daemons. */
const TRIGGER_DAEMON_AGENTS = new Set([
  'chronos_gateway',
  'daemon_watchdog',
  'infrastructure_sentinel',
  'organization_operator',
  'surface_runtime',
]);
const INTERACTIVE_CLI_AGENTS = new Set(['claude-code', 'claude_code']);
/** Stop-hook metric component for the interactive CLI (claude-code-hook.ts). */
const INTERACTIVE_CLI_METRIC_COMPONENT = 'claude-code-cli';
const BACKEND_CLI_METRIC_COMPONENT = 'claude-cli';
const AGENT_RUNTIME_METRIC_COMPONENT = 'agent-runtime:ask';
const AUDIT_FAILURE_RESULTS = new Set(['error', 'failed', 'failure']);
export const INTERACTIVE_CLI_TOKENS_UNAVAILABLE = 'n/a (transcripts only)';
export const INTERACTIVE_CLI_TOKENS_OVERCOUNT =
  'Stop-hook metric; rows before the hook fix are ~2x over-counted';

export function executionOriginOf(agentId: unknown): ExecutionOrigin {
  const id = str(agentId);
  if (INTERACTIVE_CLI_AGENTS.has(id)) return 'interactive_cli';
  if (id.startsWith('dot:')) return 'dot';
  if (TRIGGER_DAEMON_AGENTS.has(id)) return 'trigger_daemon';
  if (id.startsWith('kyberion://agent/')) return 'agent_runtime';
  return 'other';
}

function metricOrigin(row: ExecutionMetricRecord): ExecutionOrigin | null {
  const component = str(row.component);
  if (component === INTERACTIVE_CLI_METRIC_COMPONENT) return 'interactive_cli';
  if (component === AGENT_RUNTIME_METRIC_COMPONENT) return 'agent_runtime';
  if (component === BACKEND_CLI_METRIC_COMPONENT) return executionOriginOf(row.actor_id);
  return null;
}

interface TokenAccumulator {
  metered: number;
  cached: number;
  prompt: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

function tokenNum(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function addUsage(acc: TokenAccumulator, usage: unknown): void {
  const u = plainObject(usage);
  if (!u) return;
  acc.metered += 1;
  acc.prompt += tokenNum(u.prompt_tokens);
  acc.output += tokenNum(u.completion_tokens);
  if (u.cache_read_tokens !== undefined || u.cache_write_tokens !== undefined) acc.cached += 1;
  acc.cache_read += tokenNum(u.cache_read_tokens);
  acc.cache_write += tokenNum(u.cache_write_tokens) + tokenNum(u.cache_write_1h_tokens);
}

/**
 * The Stop hook (`claude-code-cli`) keeps cache counters beside `usage`, not in it:
 * its prompt_tokens already include cache creation, so only cache_read is added
 * to the input; cache creation is counted once through prompt_tokens.
 */
function metricUsageWithTopLevelCache(metric: ExecutionMetricRecord): unknown {
  const usage = plainObject(metric.usage);
  if (!usage || metric.component !== INTERACTIVE_CLI_METRIC_COMPONENT) return metric.usage;
  if (metric.cache_read_tokens === undefined && metric.cache_creation_tokens === undefined)
    return usage;
  return { ...usage, cache_read_tokens: tokenNum(metric.cache_read_tokens), cache_write_tokens: 0 };
}

function tokenTotals(acc: TokenAccumulator): ExecutionTokenTotals | null {
  if (acc.metered === 0) return null;
  const input = acc.prompt + acc.cache_read + acc.cache_write;
  return {
    input_tokens: input,
    output_tokens: acc.output,
    cache_read_tokens: acc.cache_read,
    cache_hit_ratio: acc.cached > 0 && input > 0 ? acc.cache_read / input : null,
  };
}

function emptyTokens(): TokenAccumulator {
  return { metered: 0, cached: 0, prompt: 0, output: 0, cache_read: 0, cache_write: 0 };
}

export function aggregateExecutionOrigins(input: {
  window: UsageWeekWindow;
  audit: readonly UsageAuditRecord[];
  metrics: readonly ExecutionMetricRecord[];
  supervisor: readonly SupervisorEventRecord[];
}): ExecutionOriginSummary {
  const { window } = input;
  const inWindow = (ts: unknown): boolean => {
    const ms = Date.parse(str(ts));
    return Number.isFinite(ms) && ms >= window.start_ms && ms < window.end_ms;
  };
  const rows = new Map<
    ExecutionOrigin,
    {
      audit: number;
      auditFailures: number;
      calls: number;
      callFailures: number;
      tokens: TokenAccumulator;
    }
  >(
    EXECUTION_ORIGINS.map((o) => [
      o,
      { audit: 0, auditFailures: 0, calls: 0, callFailures: 0, tokens: emptyTokens() },
    ])
  );
  const dots = new Map<
    string,
    { audit: number; calls: number; failures: number; wakes: Set<string>; tokens: TokenAccumulator }
  >();
  const dotRow = (id: string) => {
    let row = dots.get(id);
    if (!row) {
      row = { audit: 0, calls: 0, failures: 0, wakes: new Set(), tokens: emptyTokens() };
      dots.set(id, row);
    }
    return row;
  };
  const triggerAgents = new Map<string, number>();
  const otherAgents = new Map<string, number>();
  const routes = new Map<string, number>();

  const audit = input.audit.filter((r) => inWindow(r.timestamp));
  for (const record of audit) {
    const origin = executionOriginOf(record.agentId);
    const row = rows.get(origin)!;
    row.audit += 1;
    if (AUDIT_FAILURE_RESULTS.has(str(record.result))) row.auditFailures += 1;
    if (origin === 'dot') dotRow(str(record.agentId)).audit += 1;
    if (origin === 'trigger_daemon') bump(triggerAgents, str(record.agentId));
    if (origin === 'other') bump(otherAgents, str(record.agentId) || '(none)');
  }

  const metrics = input.metrics.filter((r) => inWindow(r.timestamp));
  let interactiveMetered = 0;
  let interactiveRows = 0;
  for (const metric of metrics) {
    const component = str(metric.component);
    if (component.startsWith('reasoning:')) {
      bump(routes, `${component}${metric.status ? ` (${str(metric.status)})` : ''}`);
      continue;
    }
    const origin = metricOrigin(metric);
    if (!origin) continue;
    const row = rows.get(origin)!;
    const failed = str(metric.status) !== 'success';
    row.calls += 1;
    if (failed) row.callFailures += 1;
    addUsage(row.tokens, metricUsageWithTopLevelCache(metric));
    if (component === INTERACTIVE_CLI_METRIC_COMPONENT) interactiveRows += 1;
    // Rows written before the Stop-hook dedupe fix carry no cache counters and
    // were ~2x over-counted; only those earn the over-count note.
    if (
      component === INTERACTIVE_CLI_METRIC_COMPONENT &&
      metric.cache_read_tokens === undefined &&
      metric.cache_creation_tokens === undefined
    )
      interactiveMetered += 1;
    if (origin === 'dot') {
      const dot = dotRow(str(metric.actor_id));
      dot.calls += 1;
      if (failed) dot.failures += 1;
      if (metric.accounting_id) dot.wakes.add(str(metric.accounting_id));
      addUsage(dot.tokens, metric.usage);
    }
  }

  const supervisor = input.supervisor.filter((r) => inWindow(r.ts ?? r.timestamp));
  const stops = new Map<string, number>();
  let asksCompleted = 0;
  let asksFailed = 0;
  let askIn = 0;
  let askOut = 0;
  let asksEstimated = 0;
  let daemonStarted = 0;
  for (const event of supervisor) {
    switch (event.decision) {
      case 'agent_runtime_ask_completed':
        asksCompleted += 1;
        askIn += tokenNum(event.input_tokens);
        askOut += tokenNum(event.output_tokens);
        if (event.usage_estimated === true) asksEstimated += 1;
        break;
      case 'agent_runtime_ask_failed':
        asksFailed += 1;
        break;
      case 'agent_runtime_supervisor_daemon_started':
        daemonStarted += 1;
        break;
      case 'agent_runtime_supervisor_daemon_stopping':
        bump(stops, str(event.reason) || 'unspecified');
        break;
      default:
        break;
    }
  }

  return {
    sources: {
      audit_records: audit.length,
      execution_metrics_records: metrics.length,
      supervisor_events: supervisor.length,
    },
    by_origin: EXECUTION_ORIGINS.map((origin) => {
      const r = rows.get(origin)!;
      const row: ExecutionOriginRow = {
        origin,
        audit_events: r.audit,
        audit_failures: r.auditFailures,
        llm_calls: r.calls,
        llm_failures: r.callFailures,
        tokens: tokenTotals(r.tokens),
      };
      if (origin === 'interactive_cli') {
        if (interactiveMetered > 0) row.token_note = INTERACTIVE_CLI_TOKENS_OVERCOUNT;
        else if (interactiveRows === 0) row.token_note = INTERACTIVE_CLI_TOKENS_UNAVAILABLE;
      }
      return row;
    }),
    trigger_daemon_agents: sorted(triggerAgents),
    other_agents: sorted(otherAgents, TOP_ROWS),
    dots: [...dots.entries()]
      .map(([dot, d]) => ({
        dot,
        audit_events: d.audit,
        llm_calls: d.calls,
        llm_failures: d.failures,
        wakes: d.wakes.size,
        calls_per_wake: d.wakes.size > 0 ? d.calls / d.wakes.size : null,
        tokens: tokenTotals(d.tokens),
      }))
      .sort(
        (a, b) =>
          b.llm_calls - a.llm_calls || b.audit_events - a.audit_events || a.dot.localeCompare(b.dot)
      ),
    reasoning_routes: sorted(routes),
    supervisor: {
      asks_completed: asksCompleted,
      asks_failed: asksFailed,
      ask_input_tokens: askIn,
      ask_output_tokens: askOut,
      asks_usage_estimated: asksEstimated,
      daemon_started: daemonStarted,
      daemon_stops_by_reason: sorted(stops),
    },
  };
}

// ---------------------------------------------------------------------------
// Rules → improvement candidates
// ---------------------------------------------------------------------------

function pct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function deriveImprovementCandidates(
  current: UsageWeekSummary,
  previous: UsageWeekSummary
): UsageImprovementCandidate[] {
  const out: UsageImprovementCandidate[] = [];
  if (current.tenant_scope_violations > 0) {
    out.push({
      id: 'tenant-scope-violation',
      severity: 'high',
      text: `${current.tenant_scope_violations} tenant.scope_violation record(s) — inspect them before anything else.`,
    });
  }
  if (current.sessions.long_sessions > 0) {
    const largest = current.sessions.top[0];
    out.push({
      id: 'long-sessions',
      severity: 'medium',
      text:
        `${current.sessions.long_sessions} session(s) reached ${current.sessions.long_session_threshold}+ recorded events` +
        (largest
          ? ` (largest ${largest.events}: ${largest.prompts} prompts, ${largest.tool_events} tool events)`
          : '') +
        '. Hand off with a short note and /clear earlier to cap context cost.',
    });
  }
  const outside = current.prompts_outside_mission;
  if (
    outside.ratio !== null &&
    outside.ratio >= OUTSIDE_MISSION_RATIO &&
    current.prompts >= OUTSIDE_MISSION_MIN_PROMPTS
  ) {
    const families = current.missions.created_families.map((row) => row.key);
    const meetingOnly =
      families.length > 0 && families.every((f) => /MEETING|MTG|MINUTES/u.test(f));
    out.push({
      id: 'work-outside-missions',
      severity: 'medium',
      text:
        `${pct(outside.ratio)} of prompts (${outside.prompts}/${current.prompts}) ran in ${outside.sessions} session(s) that never touched a mission` +
        (meetingOnly ? '; every mission created this week was a meeting mission' : '') +
        '. Start a mission for substantive work so evidence and learnings are kept.',
    });
  }
  for (const row of current.trigger.by_reason) {
    if (row.key === HOST_SUSPENDED_REASON || row.count < TRIGGER_CLUSTER_MIN) continue;
    out.push({
      id: `trigger-failure:${row.key}`,
      severity: 'medium',
      text: `Trigger failures "${row.key}" x${row.count} — a recurring cause; fix the configuration or grant instead of letting sweeps retry.`,
    });
  }
  if (current.trigger.host_suspended >= HOST_SUSPENDED_NOTE_MIN) {
    out.push({
      id: 'host-suspended',
      severity: 'info',
      text: `${current.trigger.host_suspended} wake(s) overlapped host sleep (not failures; retried on the next sweep).`,
    });
  }
  for (const row of current.dot_denials.by_reason) {
    if (row.count < DOT_DENIAL_CLUSTER_MIN) continue;
    out.push({
      id: `dot-denial:${row.key}`,
      severity: 'medium',
      text: `Dot delegation denied "${row.key}" x${row.count} — review the approval loop (requests expiring or cancelled unanswered).`,
    });
  }
  if (previous.total_events > 0) {
    const swing = (current.total_events - previous.total_events) / previous.total_events;
    if (Math.abs(swing) >= VOLUME_SWING_RATIO) {
      out.push({
        id: 'volume-swing',
        severity: 'info',
        text: `Event volume ${swing > 0 ? 'rose' : 'fell'} ${pct(Math.abs(swing))} week over week (${previous.total_events} → ${current.total_events}).`,
      });
    }
  }
  return out;
}

export function buildUsageWeeklyReport(input: {
  window: UsageWeekWindow;
  current: readonly UsageAuditRecord[];
  previous: readonly UsageAuditRecord[];
  now?: Date;
  longSessionThreshold?: number;
  metrics?: readonly ExecutionMetricRecord[];
  supervisor?: readonly SupervisorEventRecord[];
}): UsageWeeklyReport {
  const previousWindow = previousUsageWeek(input.window);
  const current = aggregateUsageWeek(input.current, input.window, input.longSessionThreshold);
  const previous = aggregateUsageWeek(input.previous, previousWindow, input.longSessionThreshold);
  return {
    generated_at: (input.now ?? new Date()).toISOString(),
    window: {
      week: input.window.week,
      start: new Date(input.window.start_ms).toISOString(),
      end: new Date(input.window.end_ms).toISOString(),
      timezone: 'Asia/Tokyo',
    },
    current,
    previous,
    delta: {
      total_events: current.total_events - previous.total_events,
      prompts: current.prompts - previous.prompts,
      tool_events: current.tool_events - previous.tool_events,
      sessions: current.sessions.count - previous.sessions.count,
      trigger_failed: current.trigger.failed - previous.trigger.failed,
    },
    execution_origin: aggregateExecutionOrigins({
      window: input.window,
      audit: input.current,
      metrics: input.metrics ?? [],
      supervisor: input.supervisor ?? [],
    }),
    improvement_candidates: deriveImprovementCandidates(current, previous),
  };
}

/** Read the audit chain and build the report for `window` (plus the week before it). */
export function collectUsageWeeklyReport(input: {
  window: UsageWeekWindow;
  auditDir?: string;
  metricsFile?: string;
  metricsPartitionRoot?: string;
  supervisorDir?: string;
  now?: Date;
}): UsageWeeklyReport {
  const auditDir = input.auditDir ?? defaultAuditDir();
  return buildUsageWeeklyReport({
    window: input.window,
    current: readAuditRecordsForWindow(input.window, auditDir),
    previous: readAuditRecordsForWindow(previousUsageWeek(input.window), auditDir),
    metrics: readExecutionMetricsForWindow(input.window, {
      file: input.metricsFile,
      partitionRoot: input.metricsPartitionRoot,
    }),
    supervisor: readSupervisorEventsForWindow(input.window, input.supervisorDir),
    now: input.now,
  });
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function countTable(header: string, rows: readonly UsageCount[]): string[] {
  if (rows.length === 0) return ['_none_'];
  return [
    `| ${header} | count |`,
    '| --- | ---: |',
    ...rows.map((r) => `| ${r.key} | ${r.count} |`),
  ];
}

function outsideCell(summary: UsageWeekSummary): string {
  const o = summary.prompts_outside_mission;
  const ratio = o.ratio === null ? '-' : pct(o.ratio);
  return `${o.prompts} (${ratio})${o.unattributed_prompts > 0 ? ` +${o.unattributed_prompts} unattributed` : ''}`;
}

function ratioCell(ratio: number | null | undefined): string {
  return ratio === null || ratio === undefined ? '-' : pct(ratio);
}

function tokenCells(row: { tokens: ExecutionTokenTotals | null; token_note?: string }): string {
  if (!row.tokens) {
    const na = row.token_note ?? '-';
    return `${na} | ${na} | -`;
  }
  const mark = row.token_note ? ' †' : '';
  return `${row.tokens.input_tokens}${mark} | ${row.tokens.output_tokens}${mark} | ${ratioCell(row.tokens.cache_hit_ratio)}`;
}

function renderExecutionOrigin(o: ExecutionOriginSummary): string[] {
  const notes = o.by_origin.filter((r) => r.tokens && r.token_note);
  const sup = o.supervisor;
  return [
    '## Execution origin (実行元)',
    '',
    `Sources: ${o.sources.audit_records} audit records, ${o.sources.execution_metrics_records} execution-metrics rows, ${o.sources.supervisor_events} supervisor events.`,
    'LLM calls = backend CLI calls (`claude-cli`), interactive Stop-hook rows (`claude-code-cli`) and supervisor asks (`agent-runtime:ask`). Input tokens include cache read/write.',
    '',
    '| origin | audit events | audit failures | LLM calls | LLM failures | input tokens (incl. cache) | output tokens | cache hit |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...o.by_origin.map(
      (r) =>
        `| ${r.origin} | ${r.audit_events} | ${r.audit_failures} | ${r.llm_calls} | ${r.llm_failures} | ${tokenCells(r)} |`
    ),
    ...(notes.length > 0 ? ['', ...notes.map((r) => `† ${r.origin}: ${r.token_note}.`)] : []),
    '',
    'Trigger / daemon agents (audit events):',
    '',
    ...countTable('agent', o.trigger_daemon_agents),
    '',
    'Other agents (audit events, top):',
    '',
    ...countTable('agent', o.other_agents),
    '',
    '### Dots',
    '',
    ...(o.dots.length === 0
      ? ['_none_']
      : [
          '| dot | audit events | LLM calls | LLM failures | wakes | calls / wake | input tokens (incl. cache) | output tokens | cache hit |',
          '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
          ...o.dots.map(
            (d) =>
              `| ${d.dot} | ${d.audit_events} | ${d.llm_calls} | ${d.llm_failures} | ${d.wakes} | ${d.calls_per_wake === null ? '-' : d.calls_per_wake.toFixed(1)} | ${tokenCells(d)} |`
          ),
        ]),
    '',
    'Reasoning route events (no actor id; not attributed to an origin):',
    '',
    ...countTable('component (status)', o.reasoning_routes),
    '',
    '### Supervisor-hosted agent runtimes',
    '',
    `Asks completed ${sup.asks_completed} (input ${sup.ask_input_tokens} / output ${sup.ask_output_tokens} tokens; ${sup.asks_usage_estimated} estimated), failed ${sup.asks_failed}. Daemon starts ${sup.daemon_started}.`,
    '',
    ...countTable('daemon stop reason', sup.daemon_stops_by_reason),
    '',
  ];
}

export function renderUsageWeeklyMarkdown(report: UsageWeeklyReport): string {
  const c = report.current;
  const p = report.previous;
  const d = report.delta;
  const outsideRatio =
    c.prompts_outside_mission.ratio === null ? '-' : pct(c.prompts_outside_mission.ratio);
  const lines: string[] = [
    `# Kyberion usage — week of ${report.window.week} (JST)`,
    '',
    `Window ${report.window.start} → ${report.window.end} · generated ${report.generated_at}.`,
    'Counts and categories only; no prompt text is copied into this report.',
    '',
    '## Headline',
    '',
    '| metric | this week | previous week | change |',
    '| --- | ---: | ---: | ---: |',
    `| audit events | ${c.total_events} | ${p.total_events} | ${signed(d.total_events)} |`,
    `| user prompts | ${c.prompts} | ${p.prompts} | ${signed(d.prompts)} |`,
    `| tool events | ${c.tool_events} | ${p.tool_events} | ${signed(d.tool_events)} |`,
    `| sessions | ${c.sessions.count} | ${p.sessions.count} | ${signed(d.sessions)} |`,
    `| trigger failures (all) | ${c.trigger.failed} | ${p.trigger.failed} | ${signed(d.trigger_failed)} |`,
    `| — of which host_suspended (sleep, not errors) | ${c.trigger.host_suspended} | ${p.trigger.host_suspended} | ${signed(c.trigger.host_suspended - p.trigger.host_suspended)} |`,
    `| long sessions (≥ ${c.sessions.long_session_threshold} events) | ${c.sessions.long_sessions} | ${p.sessions.long_sessions} | ${signed(c.sessions.long_sessions - p.sessions.long_sessions)} |`,
    `| prompts outside any mission | ${outsideCell(c)} | ${outsideCell(p)} | ${signed(c.prompts_outside_mission.prompts - p.prompts_outside_mission.prompts)} |`,
    `| missions created / started | ${c.missions.created} / ${c.missions.started} | ${p.missions.created} / ${p.missions.started} | |`,
    `| dot delegation denials | ${c.dot_denials.total} | ${p.dot_denials.total} | ${signed(c.dot_denials.total - p.dot_denials.total)} |`,
    `| tenant scope violations | ${c.tenant_scope_violations} | ${p.tenant_scope_violations} | ${signed(c.tenant_scope_violations - p.tenant_scope_violations)} |`,
    '',
    '## Improvement candidates',
    '',
    ...(report.improvement_candidates.length === 0
      ? ['_No rule fired this week._']
      : report.improvement_candidates.map((x) => `- **${x.severity}** \`${x.id}\` — ${x.text}`)),
    '',
    ...renderExecutionOrigin(report.execution_origin),
    '## Volume by day (JST)',
    '',
    '| day | events | prompts | tool events | sessions |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...c.by_day.map(
      (r) => `| ${r.day} | ${r.events} | ${r.prompts} | ${r.tool_events} | ${r.sessions} |`
    ),
    '',
    `Peak prompt hours (JST): ${c.peak_prompt_hours_jst.map((r) => `${r.key}:00 (${r.count})`).join(', ') || '-'}`,
    '',
    '## Events by action',
    '',
    ...countTable('action', c.by_action),
    '',
    '## Sessions',
    '',
    `${c.sessions.count} session(s); ${c.sessions.long_sessions} at or above ${c.sessions.long_session_threshold} events.`,
    '',
    '| session | host | events | prompts | tool events | touched mission | first | last |',
    '| --- | --- | ---: | ---: | ---: | --- | --- | --- |',
    ...c.sessions.top.map(
      (s) =>
        `| ${s.session}${s.events >= c.sessions.long_session_threshold ? ' ⚠' : ''} | ${s.host} | ${s.events} | ${s.prompts} | ${s.tool_events} | ${s.touched_mission ? 'yes' : 'no'} | ${s.first_at} | ${s.last_at} |`
    ),
    '',
    '## Tool mix',
    '',
    ...countTable('tool', c.tool_mix),
    '',
    '## Tenants touched (events referencing a tenant path)',
    '',
    ...countTable('tenant', c.tenants_touched),
    '',
    '## Missions',
    '',
    ...countTable('lifecycle verb', c.missions.by_verb),
    '',
    'Created mission families (date suffix removed):',
    '',
    ...countTable('family', c.missions.created_families),
    '',
    `Prompts outside any mission: ${c.prompts_outside_mission.prompts} of ${c.prompts} (${outsideRatio}) across ${c.prompts_outside_mission.sessions} session(s)` +
      (c.prompts_outside_mission.unattributed_prompts > 0
        ? `; ${c.prompts_outside_mission.unattributed_prompts} prompt(s) carried no session id and are not classified.`
        : '.'),
    '',
    '## Trigger failures',
    '',
    `Delivered ${c.trigger.delivered}; failed ${c.trigger.failed} — ${c.trigger.failed_excluding_host_suspended} real failures + ${c.trigger.host_suspended} host_suspended (laptop sleep, retried; not an error).`,
    '',
    ...countTable('normalized reason', c.trigger.by_reason),
    '',
    'Real failures by trigger source:',
    '',
    ...countTable('source', c.trigger.by_source),
    '',
    '## Dot delegation denials',
    '',
    ...countTable('operation: reason', c.dot_denials.by_reason),
    '',
    ...countTable('dot', c.dot_denials.by_dot),
    '',
  ];
  return lines.join('\n');
}
