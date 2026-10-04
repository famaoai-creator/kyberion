/**
 * scripts/dot_charters.ts — resident-agent ('dot') charter commands.
 *
 * Usage:
 *   pnpm kyberion dot list [--all|--status=<s>] [--json]
 *   pnpm kyberion dot validate [<dot_id>]        # schema + activation gate check
 *   pnpm kyberion dot activate <dot_id>          # governed draft|paused → active
 *   pnpm kyberion dot pause <dot_id>             # active → paused (wakes stop)
 *   pnpm kyberion dot retire <dot_id>            # any non-retired → retired
 *   pnpm kyberion dot wake <dot_id>              # run one bounded wake now
 *   pnpm kyberion dot status [<dot_id>]          # wakes, tokens, actions, waiting decisions, signals, feedback
 *   pnpm kyberion dot memory|followups|kr|autonomy|outcomes|work <dot_id>   # read-only views
 *   pnpm kyberion dot event ingest --source <s> --file <json> [--type <t>]   # local test event
 *   pnpm kyberion dot inbox append --channel <ch> [--dot-id <id>] [--text <s>]
 *                                                # append a wake-lane row (manual/testing)
 *
 * Charters are the declarative contract for resident agents; see dots/README.md
 * and knowledge/product/architecture/resident-dot-model.md. Status changes are
 * gated by @agent/core/dot/dot-lifecycle — activation validates the authority
 * role and heartbeat uniqueness before flipping status.
 */

import {
  listDotCharterSources,
  loadDotCharterSource,
  type DotCharter,
  type DotCharterStatus,
} from '@agent/core/dot/dot-charter';
import { DOT_STATUS_SECTIONS } from '@agent/core/dot/dot-extension-registry';
import { readDotMemory } from '@agent/core/dot/dot-memory';
import { listPendingDotFollowups } from '@agent/core/dot/dot-followups';
import { dotGoalGaps, readLatestDotKeyResults } from '@agent/core/dot/dot-key-results';
import {
  dotAutonomyMetrics,
  readDotAutonomyShadow,
  readDotAutonomyState,
} from '@agent/core/dot/dot-autonomy';
import { dotOutcomeStats, readDotOutcomes } from '@agent/core/dot/dot-outcomes';
import { readDotWorkResults } from '@agent/core/dot/dot-executor';
import { ingestLocalEvent } from '@agent/core/dot/dot-event-intake';
import { safeReadFile } from '@agent/core/secure-io';
import { parseSafeJsonObjectInput } from '@agent/core/foundation';
import {
  checkDotActivationReadiness,
  transitionDotCharterStatus,
} from '@agent/core/dot/dot-lifecycle';
import { withExecutionContext, withExecutionContextAsync } from '@agent/core/authority';
import { dotTokensUsedToday, readDotWakeLedger } from '@agent/core/dot/dot-runtime';
import { appendDotInboxEntry } from '@agent/core/dot/dot-inbox';
import { currentDotActions } from '@agent/core/dot/dot-dispatch';
import { dotFeedbackPromptLines, latestDotSignals } from '@agent/core/dot/dot-feedback';
import { runDotWakeWithGoalDriver } from '@agent/core/dot/dot-wake-orchestration';
import { installReasoningBackends } from '@agent/core/reasoning/reasoning-bootstrap';
import { DEFAULT_DAEMONS } from './daemon_watchdog.js';
import { defineScript, isDirectScript } from './lib/harness.js';

const STATUSES: DotCharterStatus[] = ['draft', 'active', 'paused', 'retired'];
const SUBCOMMANDS = [
  'list',
  'validate',
  'activate',
  'pause',
  'retire',
  'wake',
  'status',
  'inbox',
  'memory',
  'followups',
  'kr',
  'autonomy',
  'outcomes',
  'work',
  'event',
] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

function loadAll() {
  const loaded = [];
  const errors = [];
  for (const source of listDotCharterSources()) {
    try {
      loaded.push({
        path: source.path,
        charter: loadDotCharterSource(source),
        ...(source.tenant_slug ? { tenant_slug: source.tenant_slug } : {}),
      });
    } catch (error) {
      errors.push({
        path: source.path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { loaded, errors };
}

function findDot(dotId: string) {
  const found = loadAll().loaded.find((entry) => entry.charter.dot_id === dotId);
  if (!found) throw new Error(`[DOT_NOT_FOUND] no charter for dot_id '${dotId}' under dots/`);
  return found;
}

function reportList(argv: string[]) {
  const wantAll = argv.includes('--all');
  const statusArg = argv.find((arg) => arg.startsWith('--status='))?.split('=')[1];
  if (statusArg && !STATUSES.includes(statusArg as DotCharterStatus)) {
    throw new Error(`--status must be one of: ${STATUSES.join(', ')}`);
  }
  const wanted: DotCharterStatus | undefined = wantAll
    ? undefined
    : ((statusArg as DotCharterStatus | undefined) ?? 'active');
  const { loaded, errors } = loadAll();
  const dots = loaded
    .filter((entry) => !wanted || entry.charter.status === wanted)
    .map((entry) => ({
      dot_id: entry.charter.dot_id,
      status: entry.charter.status,
      title: entry.charter.title,
      authority_role: entry.charter.authority.authority_role,
      heartbeat_id: entry.charter.runtime.heartbeat_id,
      triggers: entry.charter.attention.triggers.map((trigger) => trigger.kind),
      path: entry.path,
    }));
  return {
    ok: errors.length === 0,
    count: dots.length,
    dots,
    ...(errors.length ? { errors } : {}),
  };
}

function reportValidate(argv: string[]) {
  const dotId = argv.find((arg) => !arg.startsWith('--'));
  const { loaded, errors } = loadAll();
  const results = loaded
    .filter((entry) => !dotId || entry.charter.dot_id === dotId)
    .map((entry) => {
      const gate =
        entry.charter.status === 'active' || entry.charter.status === 'paused'
          ? checkDotActivationReadiness(entry.charter, {
              supervisedDaemonIds: DEFAULT_DAEMONS,
            })
          : { ready: true, errors: [] as string[] };
      return {
        dot_id: entry.charter.dot_id,
        status: entry.charter.status,
        schema_ok: true,
        activation_ready: gate.ready,
        gate_errors: gate.errors,
        path: entry.path,
      };
    });
  if (dotId && results.length === 0 && errors.length === 0) {
    throw new Error(`[DOT_NOT_FOUND] no charter for dot_id '${dotId}' under dots/`);
  }
  return {
    ok: errors.length === 0 && results.every((r) => r.activation_ready),
    results,
    schema_errors: errors,
  };
}

function reportTransition(verb: 'activate' | 'pause' | 'retire', argv: string[]) {
  const dotId = argv.find((arg) => !arg.startsWith('--'));
  if (!dotId) throw new Error(`usage: pnpm kyberion dot ${verb} <dot_id>`);
  const target: DotCharterStatus =
    verb === 'activate' ? 'active' : verb === 'pause' ? 'paused' : 'retired';
  const charter = transitionDotCharterStatus(dotId, target, {
    supervisedDaemonIds: DEFAULT_DAEMONS,
  });
  return { ok: true, dot_id: dotId, status: charter.status };
}

async function reportWake(argv: string[]) {
  const dotId = argv.find((arg) => !arg.startsWith('--'));
  if (!dotId) throw new Error('usage: pnpm kyberion dot wake <dot_id>');
  const loaded = findDot(dotId);
  installReasoningBackends();
  // Same attribution as the daemon sweep: ledger/heartbeat writes and the
  // turn all happen under the charter's declared role.
  const receipt = await withExecutionContextAsync(
    loaded.charter.authority.authority_role,
    () => runDotWakeWithGoalDriver(loaded, {}),
    undefined,
    loaded.charter.scope.tenant_slug
  );
  return {
    ok: receipt.outcome !== 'failed',
    ...receipt,
    result: receipt.result
      ? { final_state: receipt.result.finalState, turns_run: receipt.result.turnsRun }
      : undefined,
  };
}

/**
 * `dot inbox append` — manual wake-lane producer. Writes the same row shape
 * channel bridges and state probes emit, so an operator can fire a wake
 * without waiting on a real channel message.
 */
function reportInbox(argv: string[]) {
  const [action, ...rest] = argv;
  if (action !== 'append') {
    throw new Error(
      'usage: pnpm kyberion dot inbox append --channel <ch> [--dot-id <id>] [--text <s>]'
    );
  }
  const flag = (name: string): string | undefined => {
    const index = rest.indexOf(`--${name}`);
    return index >= 0 ? rest[index + 1] : undefined;
  };
  const channel = flag('channel');
  if (!channel)
    throw new Error(
      'dot inbox append requires --channel <slack|telegram|discord|imessage|surface|inbox>'
    );
  const entry = appendDotInboxEntry({
    channel,
    ...(flag('dot-id') ? { dot_id: flag('dot-id') } : {}),
    ...(flag('text') ? { text: flag('text') } : {}),
    source: 'cli',
  });
  return { ok: true, appended: entry };
}

/** Run a read under the charter's own role and tenant so tenant-scoped state is readable. */
function asCharter<T>(charter: DotCharter, fn: () => T): T {
  return withExecutionContext(
    charter.authority.authority_role,
    fn,
    undefined,
    charter.scope.tenant_slug
  );
}

/** Every registered DOT_STATUS_SECTIONS entry; a failing section never fails the status. */
function collectStatusSections(charter: DotCharter): Record<string, Record<string, unknown>> {
  const sections: Record<string, Record<string, unknown>> = {};
  for (const section of DOT_STATUS_SECTIONS) {
    try {
      sections[section.id] = asCharter(charter, () =>
        section.collect(charter, { now: () => new Date() })
      );
    } catch (error) {
      sections[section.id] = {
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return sections;
}

function reportStatus(argv: string[]) {
  const dotId = argv.find((arg) => !arg.startsWith('--'));
  const ledger = readDotWakeLedger({});
  const { loaded } = loadAll();
  const dots = loaded
    .filter((entry) => !dotId || entry.charter.dot_id === dotId)
    .map((entry) => {
      const wakes = ledger.filter((row) => row.dot_id === entry.charter.dot_id);
      const last = wakes[wakes.length - 1];
      const actions = currentDotActions(entry.charter.dot_id);
      const actionCounts: Record<string, number> = {};
      for (const action of actions) {
        actionCounts[action.status] = (actionCounts[action.status] ?? 0) + 1;
      }
      return {
        dot_id: entry.charter.dot_id,
        status: entry.charter.status,
        heartbeat_id: entry.charter.runtime.heartbeat_id,
        tokens_today: dotTokensUsedToday(entry.charter.dot_id, {}),
        wake_count: wakes.length,
        last_wake: last
          ? {
              at: last.fired_at,
              outcome: last.outcome,
              trigger: last.trigger_key,
              ...(last.summary ? { summary: last.summary } : {}),
            }
          : null,
        actions: actionCounts,
        waiting_on_operator: actions
          .filter((action) => action.status === 'parked')
          .map((action) => ({ title: action.title, request_id: action.request_id })),
        signals: latestDotSignals(entry.charter).map(({ signal, latest }) => ({
          signal,
          healthy: latest?.healthy ?? null,
          measured_at: latest?.measured_at ?? null,
        })),
        recent_feedback: dotFeedbackPromptLines(entry.charter.dot_id),
        sections: collectStatusSections(entry.charter),
      };
    });
  if (dotId && dots.length === 0) {
    throw new Error(`[DOT_NOT_FOUND] no charter for dot_id '${dotId}' under dots/`);
  }
  return { ok: true, dots };
}

const VIEW_LIMIT = 20;

/** Read-only per-dot views: `dot memory|followups|kr|autonomy|outcomes|work <dot_id>`. */
function reportView(
  view: 'memory' | 'followups' | 'kr' | 'autonomy' | 'outcomes' | 'work',
  argv: string[]
) {
  const dotId = argv.find((arg) => !arg.startsWith('--'));
  if (!dotId) throw new Error(`usage: pnpm kyberion dot ${view} <dot_id>`);
  const { charter } = findDot(dotId);
  const deps = { now: () => new Date() };
  const data = asCharter(charter, (): Record<string, unknown> => {
    switch (view) {
      case 'memory':
        return { ...readDotMemory(charter, deps) };
      case 'followups':
        return { pending: listPendingDotFollowups(charter, deps) };
      case 'kr':
        return {
          latest: [...readLatestDotKeyResults(charter, {}).values()],
          gaps: dotGoalGaps(charter, deps),
        };
      case 'autonomy':
        return {
          state: readDotAutonomyState(charter, deps),
          metrics: dotAutonomyMetrics(charter, deps),
          shadow: readDotAutonomyShadow(charter, {}).slice(-VIEW_LIMIT),
        };
      case 'outcomes':
        return {
          stats: dotOutcomeStats(charter),
          recent: readDotOutcomes(charter, { limit: VIEW_LIMIT }),
        };
      case 'work':
        return { recent: readDotWorkResults(charter, deps).slice(-VIEW_LIMIT) };
    }
  });
  return { ok: true, view: { dot_id: dotId, kind: view, ...data } };
}

/** `dot event ingest` — local test event through the governed policy (no HMAC, source must exist). */
function reportEvent(argv: string[]) {
  const [action, ...rest] = argv;
  const usage = 'usage: pnpm kyberion dot event ingest --source <s> --file <json> [--type <t>]';
  if (action !== 'ingest') throw new Error(usage);
  const flag = (name: string): string | undefined => {
    const index = rest.indexOf(`--${name}`);
    return index >= 0 ? rest[index + 1] : undefined;
  };
  const source = flag('source');
  const file = flag('file');
  if (!source || !file) throw new Error(usage);
  const body = parseSafeJsonObjectInput(
    safeReadFile(file, { encoding: 'utf8' }) as string,
    `event file ${file}`
  );
  const result = ingestLocalEvent({ source, body, type: flag('type') });
  return { ok: true, ingested: result };
}

async function main(argv: string[]): Promise<Record<string, unknown>> {
  const [sub, ...rest] = argv;
  const subcommand = (SUBCOMMANDS as readonly string[]).includes(sub)
    ? (sub as Subcommand)
    : 'list';
  const args = subcommand === sub ? rest : argv;
  switch (subcommand) {
    case 'validate':
      return reportValidate(args);
    case 'activate':
    case 'pause':
    case 'retire':
      return reportTransition(subcommand, args);
    case 'wake':
      return reportWake(args);
    case 'inbox':
      return reportInbox(args);
    case 'status':
      return reportStatus(args);
    case 'memory':
    case 'followups':
    case 'kr':
    case 'autonomy':
    case 'outcomes':
    case 'work':
      return reportView(subcommand, args);
    case 'event':
      return reportEvent(args);
    case 'list':
    default:
      return reportList(args);
  }
}

function compact(value: unknown, max = 240): string {
  const text = Object.entries(value as Record<string, unknown>)
    .map(
      ([key, v]) => `${key}=${typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}`
    )
    .join(' ');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function printReport(report: Record<string, unknown>, print: (line: string) => void): void {
  if (Array.isArray(report.dots)) {
    for (const dot of report.dots as Array<Record<string, unknown>>) {
      const last = dot.last_wake as Record<string, unknown> | null | undefined;
      const tail =
        last !== undefined
          ? `  wakes=${dot.wake_count} tokens_today=${dot.tokens_today}${last ? `  last=${last.at} ${last.outcome}` : ''}`
          : `  [${dot.authority_role}]  triggers=${(dot.triggers as string[]).join(',')}  heartbeat=${dot.heartbeat_id}`;
      print(`${dot.status}  ${String(dot.dot_id).padEnd(24)} ${dot.title ?? ''}${tail}`.trimEnd());
      if (last?.summary) print(`    last said: ${String(last.summary).slice(0, 200)}`);
      const actions = dot.actions as Record<string, number> | undefined;
      if (actions && Object.keys(actions).length > 0) {
        print(
          `    actions: ${Object.entries(actions)
            .map(([status, count]) => `${status}=${count}`)
            .join(' ')}`
        );
      }
      for (const waiting of (dot.waiting_on_operator ?? []) as Array<Record<string, unknown>>) {
        print(`    waiting on you: ${waiting.title} (${waiting.request_id ?? 'no request'})`);
      }
      for (const signal of (dot.signals ?? []) as Array<Record<string, unknown>>) {
        const mark = signal.healthy === null ? '??' : signal.healthy ? 'OK' : 'NG';
        print(`    signal ${mark} ${signal.signal}`);
      }
      for (const line of (dot.recent_feedback ?? []) as string[]) {
        print(`    feedback ${line.replace(/^- /, '')}`);
      }
      for (const [id, section] of Object.entries(
        (dot.sections ?? {}) as Record<string, Record<string, unknown>>
      )) {
        print(`    ${id}: ${compact(section)}`);
      }
    }
    print(`-- ${(report.dots as unknown[]).length} dot(s)`);
  }
  for (const error of (report.errors ?? report.schema_errors ?? []) as Array<{
    path: string;
    error: string;
  }>) {
    print(`invalid  ${error.path}: ${error.error}`);
  }
  for (const result of (report.results ?? []) as Array<Record<string, unknown>>) {
    const gate = result.activation_ready
      ? 'ready'
      : `BLOCKED: ${(result.gate_errors as string[]).join('; ')}`;
    print(`${result.dot_id}  schema=ok  activation=${gate}`);
  }
  const view = report.view as Record<string, unknown> | undefined;
  if (view) {
    print(`${view.kind} ${view.dot_id}`);
    for (const [key, value] of Object.entries(view)) {
      if (key === 'kind' || key === 'dot_id') continue;
      if (Array.isArray(value)) {
        print(`  ${key}: ${value.length}`);
        for (const row of value) print(`    ${JSON.stringify(row).slice(0, 300)}`);
      } else if (value && typeof value === 'object') {
        print(`  ${key}: ${compact(value, 400)}`);
      } else {
        print(`  ${key}: ${String(value)}`);
      }
    }
  } else if (report.ingested) {
    print(JSON.stringify(report.ingested));
  } else if (report.status || report.outcome) {
    print(JSON.stringify(report));
  }
}

export const runDotCharters = defineScript({
  name: 'dot-charters',
  flags: ['json'],
  async run(context) {
    const report = await main(context.argv);
    if (context.json) {
      context.print(report);
      return report;
    }
    printReport(report, context.print);
    return report;
  },
});

if (
  isDirectScript(import.meta.url, 'dot_charters.ts') ||
  isDirectScript(import.meta.url, 'dot_charters.js')
) {
  void runDotCharters();
}
