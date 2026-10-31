/**
 * scripts/dot_charters.ts — resident-agent ('dot') charter commands.
 *
 * Usage:
 *   pnpm kyberion dot list [--all|--status=<s>] [--json]
 *   pnpm kyberion dot create --file <reviewed-draft.json> [--apply] # preview by default
 *   pnpm kyberion dot validate [<dot_id>]        # schema + activation gate check
 *   pnpm kyberion dot activate <dot_id>          # governed draft|paused → active
 *   pnpm kyberion dot pause <dot_id>             # active → paused (wakes stop)
 *   pnpm kyberion dot retire <dot_id>            # any non-retired → retired
 *   pnpm kyberion dot wake <dot_id>              # run one bounded wake now
 *   pnpm kyberion dot status [<dot_id>]          # wakes, tokens, actions, waiting decisions, signals, feedback
 *   pnpm kyberion dot memory|followups|kr|autonomy|outcomes|work <dot_id>   # read-only views
 *   pnpm kyberion dot release <dot_id> <work_item_id> --reason "<text>" [--by <requester>]
 *                                                # request a human-approved release of a quarantined item
 *   pnpm kyberion dot event ingest --source <s> --file <json> [--type <t>]   # local test event
 *   pnpm kyberion dot intake [--json]            # which source wakes which dot, and what it may do
 *   pnpm kyberion dot inbox append --channel <ch> [--dot-id <id>] [--text <s>]
 *                                                # append a wake-lane row (manual/testing)
 *
 * Charters are the declarative contract for resident agents; see dots/README.md
 * and knowledge/product/architecture/resident-dot-model.md. Status changes are
 * gated by @agent/core/dot/dot-lifecycle — activation validates the authority
 * role and heartbeat uniqueness before flipping status.
 */

import { hasCliFlag, cliOptionValue, cliPositionals } from '@agent/core/cli-guard';
import {
  findDotCharter,
  listDotCharters,
  type DotCharterLoadError,
  type DotCharter,
  type DotCharterStatus,
} from '@agent/core/dot/dot-charter';
import { DOT_STATUS_SECTIONS } from '@agent/core/dot/dot-extension-registry';
import '@agent/core/dot/dot-extension-bootstrap';
import { readDotMemory } from '@agent/core/dot/dot-memory';
import { listPendingDotFollowups } from '@agent/core/dot/dot-followups';
import { dotGoalGaps, readLatestDotKeyResults } from '@agent/core/dot/dot-key-results';
import {
  dotAutonomyMetrics,
  readDotAutonomyShadow,
  readDotAutonomyState,
} from '@agent/core/dot/dot-autonomy';
import { dotOutcomeStats, readDotOutcomes } from '@agent/core/dot/dot-outcomes';
import { readDotWorkResults, requestDotWorkItemRelease } from '@agent/core/dot/dot-executor';
import { ingestLocalEvent, loadEventIntakePolicy } from '@agent/core/dot/dot-event-intake';
import { describeDotIntakePlan, type DotIntakePlan } from '@agent/core/dot/dot-intake-plan';
import { getRegisteredEnvText } from '@agent/core/foundation/env';
import { safeReadFile } from '@agent/core/secure-io';
import { parseSafeJsonObjectInput } from '@agent/core/foundation';
import {
  checkDotActivationReadiness,
  createDraftDotCharter,
  enableDotEventContinuation,
  transitionDotCharterStatus,
  configureDotDelegationCapacity,
} from '@agent/core/dot/dot-lifecycle';
import { withExecutionContext, withExecutionContextAsync } from '@agent/core/authority';
import { resolveIdentityContext } from '@agent/core/authority';
import { validateReadPermission } from '@agent/core/tier-guard';
import { pathResolver } from '@agent/core/path-resolver';
import { migrateLegacyDotState } from '@agent/core/dot/dot-state-paths';
import { migrateLegacyDotActions, observeDotActions } from '@agent/core/dot/dot-action-ledger';
import { dotTokensUsedToday, readScopedDotWakeLedger } from '@agent/core/dot/dot-runtime';
import { appendDotInboxEntry } from '@agent/core/dot/dot-inbox';
import { dotDelegationCapacity } from '@agent/core/dot/dot-dispatch';
import { dotFeedbackPromptLines, latestDotSignals } from '@agent/core/dot/dot-feedback';
import { runDotWakeWithGoalDriver } from '@agent/core/dot/dot-wake-orchestration';
import { installReasoningBackends } from '@agent/core/reasoning/reasoning-bootstrap';
import { DEFAULT_DAEMONS } from './daemon_watchdog.js';
import {
  defineScript,
  isDirectScript,
  ScriptExitError,
  stripSharedScriptFlags,
} from './lib/harness.js';

const STATUSES: DotCharterStatus[] = ['draft', 'active', 'paused', 'retired'];
const SUBCOMMANDS = [
  'migrate-state',
  'capacity',
  'create',
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
  'intake',
  'release',
] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

function visibleCharter(charter: DotCharter, argv: string[] = []): boolean {
  const identity = resolveIdentityContext();
  const system = hasCliFlag(argv, '--system');
  if (system && !['sovereign', 'ecosystem_architect'].includes(identity.persona))
    throw new Error('[DOT_INVENTORY_SCOPE] --system requires an authorized operator');
  const tier = argv.find((arg) => arg.startsWith('--tier='))?.slice(7);
  const tenant = argv.find((arg) => arg.startsWith('--tenant='))?.slice(9);
  if (tier && !['public', 'confidential', 'personal'].includes(tier))
    throw new Error('[DOT_INVENTORY_SCOPE] invalid tier');
  if ((tier && charter.scope.tier !== tier) || (tenant && charter.scope.tenant_slug !== tenant))
    return false;
  if (
    charter.scope.tier === 'personal' &&
    charter.scope.owner_nhi !== getRegisteredEnvText('KYBERION_NHI_ID')?.trim()
  )
    return false;
  if (!system && charter.scope.tenant_slug && charter.scope.tenant_slug !== identity.tenantSlug)
    return false;
  const relative =
    charter.scope.tier === 'confidential'
      ? `knowledge/confidential/${charter.scope.tenant_slug ?? ''}`
      : `knowledge/${charter.scope.tier}`;
  return validateReadPermission(pathResolver.rootResolve(relative)).allowed;
}

function loadAll(argv: string[] = []) {
  const system = hasCliFlag(argv, '--system');
  if (system && !['sovereign', 'ecosystem_architect'].includes(resolveIdentityContext().persona))
    throw new Error('[DOT_INVENTORY_SCOPE] --system requires an authorized operator');
  const errors: DotCharterLoadError[] = [];
  const loaded = listDotCharters(undefined, { errors });
  return {
    loaded: loaded.filter((entry) => visibleCharter(entry.charter, argv)),
    errors: system
      ? errors
      : errors.filter(
          (entry) =>
            !entry.path.includes('/knowledge/confidential/') &&
            !entry.path.includes('/knowledge/personal/')
        ),
  };
}

function findDot(dotId: string) {
  const found = findDotCharter(dotId);
  if (!found || !visibleCharter(found.charter))
    throw new Error(`[DOT_NOT_FOUND] no visible charter for dot_id '${dotId}'`);
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
  const { loaded, errors } = loadAll(argv);
  const dots = loaded
    .filter((entry) => !wanted || entry.charter.status === wanted)
    .map((entry) => ({
      dot_id: entry.charter.dot_id,
      status: entry.charter.status,
      scope: entry.charter.scope,
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
  const { loaded, errors } = loadAll(argv);
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

function reportCreate(argv: string[]) {
  const index = argv.indexOf('--file');
  const file = index >= 0 ? argv[index + 1] : undefined;
  if (!file || file.startsWith('--'))
    throw new Error('usage: pnpm kyberion dot create --file <reviewed-draft.json> [--apply]');
  const input = parseSafeJsonObjectInput(
    safeReadFile(file, { encoding: 'utf8' }) as string,
    'dot draft'
  );
  const applied = argv.includes('--apply');
  const charter = createDraftDotCharter(input, { dryRun: !applied });
  return {
    ok: true,
    applied,
    dot_id: charter.dot_id,
    status: charter.status,
    scope: charter.scope,
    ...(charter.work_binding ? { work_binding: charter.work_binding } : {}),
    next: applied
      ? `pnpm kyberion dot validate ${charter.dot_id}; activate separately after reviewing readiness`
      : 'Review the draft and rerun with --apply; activation remains separate.',
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
  const dotId = flag('dot-id');
  const target = dotId ? findDot(dotId).charter : undefined;
  if (!target && !rest.includes('--public-broadcast'))
    throw new Error('[DOT_INBOX_SCOPE] specify --dot-id or explicit --public-broadcast');
  const entry = appendDotInboxEntry({
    channel,
    scope: target?.scope ?? { tier: 'public' },
    ...(dotId ? { dot_id: dotId } : {}),
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
    charter.scope.tenant_slug ?? '',
    charter.scope.organization_id,
    { missionId: null, taskId: null, projectId: charter.scope.project_id ?? null }
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
  const { loaded } = loadAll(argv);
  const dots = loaded
    .filter((entry) => !dotId || entry.charter.dot_id === dotId)
    .map((entry) => {
      const wakes = asCharter(entry.charter, () => readScopedDotWakeLedger(entry.charter));
      const last = wakes[wakes.length - 1];
      // Observation path (R07): malformed or out-of-scope rows flag integrity
      // instead of aborting the status. Execution still uses the strict
      // hydrate — this read never rewrites the ledger.
      const observation = observeDotActions(entry.charter.dot_id);
      const actions = [...observation.actions, ...observation.index_only];
      const actionCounts: Record<string, number> = {};
      for (const action of actions) {
        actionCounts[action.status] = (actionCounts[action.status] ?? 0) + 1;
      }
      let delegationCapacity: Record<string, unknown>;
      try {
        delegationCapacity = asCharter(entry.charter, () => dotDelegationCapacity(entry.charter));
      } catch {
        // Capacity derives from the same strict hydrate; when observation
        // reports degraded integrity, report it unavailable rather than dying.
        delegationCapacity = {
          status: 'unavailable',
          reason:
            'the action ledger could not be fully read; resolve action_integrity findings before trusting capacity',
        };
      }
      return {
        dot_id: entry.charter.dot_id,
        status: entry.charter.status,
        scope: entry.charter.scope,
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
        action_integrity: observation.integrity,
        action_anomalies: observation.anomalies,
        ...(observation.repair.length ? { action_repair: observation.repair } : {}),
        actions: actionCounts,
        delegation_capacity: delegationCapacity,
        waiting_for_capacity: actions
          .filter((action) => action.status === 'waiting_capacity')
          .map((action) => ({
            action_ref: action.action_ref,
            title: action.title,
            reason: action.reason,
          })),
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
  const integrity = dots.some((dot) => dot.action_integrity === 'integrity_error')
    ? 'integrity_error'
    : dots.some((dot) => dot.action_integrity === 'partial')
      ? 'partial'
      : 'complete';
  return { ok: integrity !== 'integrity_error', integrity, dots };
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

/**
 * `dot release <dot_id> <work_item_id> --reason "<text>" [--by <requester>]` —
 * asks a human to release a quarantined/escalated item. Only an approval
 * request is created (visible in `pnpm kyberion approvals`); the executor
 * sweep returns the item to `ready` once an authenticated human approves it,
 * recording the approver (not `--by`) as the verifier.
 */
function reportRelease(argv: string[]) {
  const usage =
    'usage: pnpm kyberion dot release <dot_id> <work_item_id> --reason "<what you verified>" [--by <requester>]';
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const valued = new Set(['--reason', '--by']);
  const positional = argv.filter(
    (arg, index) => !arg.startsWith('--') && !valued.has(argv[index - 1] ?? '')
  );
  const [dotId, workItemId] = positional;
  const reason = flag('reason');
  if (!dotId || !workItemId || !reason) throw new Error(usage);
  const { charter } = findDot(dotId);
  const { request, reused } = requestDotWorkItemRelease(charter, {
    workItemId,
    reason,
    by: flag('by'),
  });
  return {
    ok: true,
    release_requested: {
      dot_id: dotId,
      work_item_id: workItemId,
      approval_request_id: request.id,
      reused,
      expires_at: request.expiresAt,
      next: `pnpm kyberion approvals --approve ${request.id}  (a human decision; the executor applies it on its next sweep)`,
    },
  };
}

/** `dot event ingest` — local test event through the governed policy (no HMAC, source must exist). */
function reportEvent(argv: string[]) {
  const [action, ...rest] = argv;
  if (action === 'continue') {
    const dotId = rest.find((arg) => !arg.startsWith('--'));
    if (!dotId)
      throw new Error('usage: pnpm kyberion dot event continue <dot_id> --confirm-quiescent');
    const charter = enableDotEventContinuation(dotId, {
      confirmQuiescent: rest.includes('--confirm-quiescent'),
    });
    return {
      ok: true,
      dot_id: dotId,
      status: charter.status,
      event_delivery: charter.attention.event_delivery,
      next: 'Review dot status before separately activating the paused/draft charter. Historical events remain untouched.',
    };
  }
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

/** `dot intake` — read-only activation table derived from charters, policy and feed state. */
function reportIntake(): { ok: true; intake: DotIntakePlan; schema_errors: string[] } {
  const errors: DotCharterLoadError[] = [];
  const charters = listDotCharters(undefined, { errors }).map((entry) => entry.charter);
  const policy = loadEventIntakePolicy({ tenantOverlays: true });
  const intake = describeDotIntakePlan({
    charters,
    policy,
    hostOptIn: getRegisteredEnvText('KYBERION_EVENT_INTAKE_SOURCES'),
  });
  return {
    ok: true,
    intake,
    schema_errors: errors.map((error) => `${error.path}: ${error.error}`),
  };
}

async function main(argv: string[]): Promise<Record<string, unknown>> {
  const [sub, ...rest] = argv;
  const subcommand = (SUBCOMMANDS as readonly string[]).includes(sub)
    ? (sub as Subcommand)
    : 'list';
  const args = subcommand === sub ? rest : argv;
  switch (subcommand) {
    case 'migrate-state': {
      const dotId = cliPositionals(args, ['--legacy-tier'])[0];
      const legacyTier = cliOptionValue(args, '--legacy-tier');
      if (
        !dotId ||
        !hasCliFlag(args, '--apply') ||
        !['public', 'confidential', 'personal'].includes(legacyTier ?? '')
      )
        throw new Error(
          'usage: pnpm kyberion dot migrate-state <dot_id> --legacy-tier <tier> --apply; review the historical namespace before moving it'
        );
      const { charter } = findDot(dotId);
      if (charter.scope.tier !== legacyTier)
        throw new Error(
          '[DOT_STATE_MIGRATION_SCOPE] historical tier differs from destination; use a reviewed brokered migration'
        );
      return {
        ok: true,
        ...migrateLegacyDotState(charter, {
          ...charter.scope,
          tier: legacyTier as DotCharter['scope']['tier'],
        }),
        actions_migrated: migrateLegacyDotActions(charter),
      };
    }
    case 'capacity': {
      const [dotId, ...options] = stripSharedScriptFlags(args);
      const limitIndex = options.indexOf('--limit');
      const inherit = options.includes('--inherit');
      if (
        !dotId ||
        dotId.startsWith('--') ||
        limitIndex < 0 === !inherit ||
        options.some(
          (option, index) =>
            !['--limit', '--inherit', '--apply'].includes(option) &&
            !(limitIndex >= 0 && index === limitIndex + 1)
        )
      )
        throw new Error(
          'usage: pnpm kyberion dot capacity <dot_id> (--limit <1..256> | --inherit) [--apply]'
        );
      const limit = inherit ? undefined : Number(options[limitIndex + 1]);
      const result = configureDotDelegationCapacity(dotId, limit, {
        dryRun: !options.includes('--apply'),
      });
      return {
        ok: true,
        dot_id: dotId,
        ...result,
        next: result.applied
          ? 'Capacity saved. Review dot status, then activate separately.'
          : 'Review this capacity and rerun with --apply. The dot remains draft/paused.',
      };
    }
    case 'create':
      return reportCreate(args);
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
    case 'intake':
      return reportIntake();
    case 'release':
      return reportRelease(args);
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

function printIntake(intake: DotIntakePlan, print: (line: string) => void): void {
  const pad = (value: string, width: number) => value.padEnd(width).slice(0, width);
  print(
    `${pad('SOURCE', 20)} ${pad('MODE', 4)} ${pad('DOT', 22)} ${pad('ARMED', 5)} ${pad('TYPES', 34)} AUTHORITY / SHAPE / DECISION`
  );
  for (const row of intake.rows) {
    print(
      `${pad(row.source, 20)} ${pad(row.mode, 4)} ${pad(row.dot_id, 22)} ${pad(row.armed ? 'yes' : 'no', 5)} ${pad(
        row.types.join(',') || '(all)',
        34
      )} ${row.authority_role} / ${row.work_shapes.join('|')} / ${row.decision}`
    );
    print(
      `  ${row.mode === 'pull' ? `feed ${row.feed?.service_id}:${row.feed?.action} every ${row.feed?.every_s}s — ${row.feed?.coverage.state}: ${row.feed?.coverage.detail}` : `enablement: ${row.enabled_by}`}`
    );
    if (row.goal) print(`  goal: ${row.goal.slice(0, 160)}`);
    for (const warning of row.warnings) print(`  ! ${warning}`);
  }
  if (intake.rows.length === 0) print('no charter declares an event or feed trigger');
  print('declared sources:');
  for (const source of intake.declared_sources) {
    print(
      `  ${source.id}: ${source.enabled ? 'enabled' : 'disabled'}${source.local_only ? ' (tenant-local)' : ''}${source.tenant_slug ? ` tenant=${source.tenant_slug}` : ''}`
    );
  }
  for (const warning of intake.warnings) print(`! ${warning}`);
  for (const note of intake.notes) print(`- ${note}`);
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
      if (dot.scope) print('    scope: ' + JSON.stringify(dot.scope));
      if (last?.summary) print(`    last said: ${String(last.summary).slice(0, 200)}`);
      const actions = dot.actions as Record<string, number> | undefined;
      if (actions && Object.keys(actions).length > 0) {
        print(
          `    actions: ${Object.entries(actions)
            .map(([status, count]) => `${status}=${count}`)
            .join(' ')}`
        );
      }
      if (dot.action_integrity && dot.action_integrity !== 'complete') {
        const anomalies = dot.action_anomalies as {
          malformed_rows: number;
          missing_evidence: number;
          not_visible: number;
        } | null;
        print(
          `    action ledger: ${dot.action_integrity}` +
            (anomalies
              ? ` (malformed=${anomalies.malformed_rows} missing_evidence=${anomalies.missing_evidence} not_visible=${anomalies.not_visible})`
              : ' (counts unknown — shared index unreadable)')
        );
        for (const hint of (dot.action_repair ?? []) as string[]) {
          print(`      next: ${hint}`);
        }
      }
      for (const waiting of (dot.waiting_on_operator ?? []) as Array<Record<string, unknown>>) {
        print(`    waiting on you: ${waiting.title} (${waiting.request_id ?? 'no request'})`);
      }
      if (dot.delegation_capacity)
        print('    delegation capacity: ' + compact(dot.delegation_capacity));
      for (const waiting of (dot.waiting_for_capacity ?? []) as Array<Record<string, unknown>>) {
        print(
          `    waiting for capacity: ${waiting.title} (${waiting.action_ref}); ${waiting.reason}`
        );
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
        if (id === 'executor' && section.execution) {
          const { execution, ...history } = section;
          print('    executor history: ' + compact(history));
          const current = execution as Record<string, unknown>;
          print('    execution: ' + String(current.inventory) + ' | ' + String(current.reason));
          const scheduling = current.scheduling as Record<string, unknown>;
          print('      scheduling ' + String(scheduling.state) + ': ' + String(scheduling.reason));
          print('        next: ' + String(scheduling.next));
          for (const item of (current.items ?? []) as Array<Record<string, unknown>>) {
            print(
              '      ' +
                String(item.state) +
                ' ' +
                String(item.work_item_id) +
                ' [' +
                String(item.reason_code) +
                '] status=' +
                String(item.item_status)
            );
            print(
              '        current_attempt=' +
                String(item.current_attempt_id ?? 'none') +
                ' latest_recorded_attempt=' +
                String(item.latest_recorded_attempt_id ?? 'none') +
                ' held_attempt=' +
                String(item.held_attempt_id ?? 'none') +
                (item.blocking_work_item_id
                  ? ' blocking_item=' + String(item.blocking_work_item_id)
                  : '') +
                ' age_ms=' +
                String(item.age_ms ?? 'unknown')
            );
            print('        reason: ' + String(item.reason));
            print('        next: ' + String(item.next));
          }
          if (Number(current.items_omitted) > 0)
            print(
              '      ' +
                String(current.items_omitted) +
                ' additional items omitted; inspect exact work items separately.'
            );
          print('      ' + String(current.limitations));
        } else {
          print(`    ${id}: ${compact(section)}`);
        }
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
  if (report.intake) {
    printIntake(report.intake as DotIntakePlan, print);
  } else if (view) {
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
  } else if (report.release_requested) {
    print(JSON.stringify(report.release_requested));
  } else if (report.status || report.outcome || report.effective_limit !== undefined) {
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
    } else {
      printReport(report, context.print);
    }
    // R05 convention: a typed report may still exit non-zero — ledger
    // integrity findings are attention, never a silent 'healthy'.
    if (report.integrity === 'integrity_error') {
      throw new ScriptExitError(1, '', true, report);
    }
    return report;
  },
});

if (
  isDirectScript(import.meta.url, 'dot_charters.ts') ||
  isDirectScript(import.meta.url, 'dot_charters.js')
) {
  void runDotCharters();
}
