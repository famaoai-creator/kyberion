/**
 * Organization standup (DL-06): what the organization and its resident dots did
 * since the last standup, what waits on a human, and how objectives moved.
 *
 * `buildOrganizationStandup` is pure over injected readers; `runOrganizationStandup`
 * is the governed entry point (sovereign across tenants, or scoped to one
 * organization inside its bound tenant; audited) that renders, files each
 * organization's standup as a published report in its own scope and sends one
 * `decision_digest` notification per organization with something to report.
 */
import { createHash } from 'node:crypto';
import { calendarDateInZone } from '../business-calendar.js';
import { auditChain } from '../governance/audit-chain.js';
import { createLogger } from '../logger.js';
import { listDotCharters, type DotCharter, type LoadedDotCharter } from '../dot/dot-charter.js';
import { readDotActionLedger, type DotActionRecord } from '../dot/dot-dispatch.js';
import { readDotWorkResults } from '../dot/dot-executor.js';
import { readOrganizationKrMeasurements } from '../dot/dot-key-results.js';
import type { DotWorkResultRow, KrMeasurementRow } from '../dot/dot-state-paths.js';
import { localeToBcp47, type SupportedLocale } from '../locale-normalize.js';
import type { MessageParams } from '../message-format.js';
import type { VocabularyKey } from '../knowledge/vocabulary-keys.generated.js';
import { t } from '../t.js';
import { notifyOperatorSync } from '../surface/operator-notifications.js';
import { listWorkItems, type WorkItem } from '../workforce/work-coordination.js';
import { writeScopedArtifact } from '../workforce/artifact-store.js';
import {
  authorizeOrganizationCadence,
  cadenceOrganizations,
  normalizeCadenceTenant,
  type OrganizationCadenceScope,
} from './organization-cadence.js';
import { listOrganizationDecisions } from './organization-operating-model-management.js';
import { listOrganizationOperationRuns } from './organization-operating-model-operations.js';
import type {
  OrganizationDecisionRecord,
  OrganizationOperationRun,
  OrganizationTier,
} from './organization-operating-model.js';
import type { OrganizationScopeRef } from './organization-operation-tick.js';
import {
  rollUpObjectiveProgress,
  type ObjectiveProgressDeps,
  type ObjectiveProgressScope,
} from './organization-objective-progress.js';

const logger = createLogger('organization-standup');

export const ORGANIZATION_CADENCE_DEFAULT_TIMEZONE = 'Asia/Tokyo';
export const ORGANIZATION_CADENCE_DEFAULT_LOCALE: SupportedLocale = 'ja';
const HOUR_MS = 3_600_000;
const MAX_LINES_PER_SECTION = 8;
const MAX_TEXT_CHARS = 120;
const PENDING_DECISION_STATUSES = new Set(['proposed', 'pending_approval']);

export interface OrganizationCadenceDeps {
  rootDir?: string;
  now?: () => Date;
  listCharters?: () => LoadedDotCharter[];
  readActionLedger?: () => DotActionRecord[];
  readWorkResults?: (charter: DotCharter) => DotWorkResultRow[];
  listOperationRuns?: (scope: OrganizationScopeRef) => OrganizationOperationRun[];
  listDecisions?: (scope: OrganizationScopeRef) => OrganizationDecisionRecord[];
  listBlockedWorkItems?: () => WorkItem[];
  readKrMeasurements?: (scope: ObjectiveProgressScope) => KrMeasurementRow[];
  /** Defaults to the persisted organization purpose. */
  loadPurpose?: ObjectiveProgressDeps['loadPurpose'];
  writeArtifact?: typeof writeScopedArtifact;
  notify?: typeof notifyOperatorSync;
  audit?: (entry: Parameters<typeof auditChain.record>[0]) => void;
}

export function truncateText(value: string, max = MAX_TEXT_CHARS): string {
  const chars = [...value.replace(/\s+/gu, ' ').trim()];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}

/** Directory-level tenant (`shared`) normalised to the tenant a record carries. */
export function cadenceTenant(scope: OrganizationScopeRef): string | undefined {
  return normalizeCadenceTenant(scope.tenantSlug);
}

export function objectiveScope(scope: OrganizationScopeRef): ObjectiveProgressScope {
  return {
    organizationId: scope.organizationId,
    tier: scope.tier,
    ...(scope.tenantSlug ? { tenantSlug: scope.tenantSlug } : {}),
  };
}

/** Active-or-not dot charters owned by this organization scope. */
export function organizationDotCharters(
  scope: OrganizationScopeRef,
  deps: OrganizationCadenceDeps
): DotCharter[] {
  const loaded = deps.listCharters
    ? deps.listCharters()
    : listDotCharters(deps.rootDir, { errors: [] });
  return loaded
    .map((entry) => entry.charter)
    .filter(
      (charter) =>
        charter.scope.organization_id === scope.organizationId &&
        charter.scope.tier === scope.tier &&
        charter.scope.tenant_slug === cadenceTenant(scope)
    );
}

function inWindow(iso: string | undefined, since: Date, until: Date): boolean {
  if (!iso) return false;
  const at = Date.parse(iso);
  return Number.isFinite(at) && at >= since.getTime() && at <= until.getTime();
}

/** Latest ledger row per action_ref for the given dots, restricted by `pick`. */
export function organizationActions(
  dotIds: Set<string>,
  deps: OrganizationCadenceDeps
): DotActionRecord[] {
  const latest = new Map<string, DotActionRecord>();
  for (const row of (
    deps.readActionLedger ?? (() => readDotActionLedger({ rootDir: deps.rootDir }))
  )()) {
    if (dotIds.has(row.dot_id)) latest.set(row.action_ref, row);
  }
  return [...latest.values()];
}

export interface ObjectiveProgressChange {
  objective_id: string;
  title: string;
  /** Percent 0..100; absent while any key result is unmeasured. */
  before?: number;
  after?: number;
  /** after - before in percentage points; absent unless both are known. */
  delta?: number;
}

const pct = (value: number | undefined): number | undefined =>
  value === undefined ? undefined : Math.round(value * 100);

/** Objective progress now versus as it stood at `since` (measurements before `since`). */
export function objectiveProgressChanges(
  scope: OrganizationScopeRef,
  since: Date,
  deps: OrganizationCadenceDeps
): ObjectiveProgressChange[] {
  const target = objectiveScope(scope);
  const read =
    deps.readKrMeasurements ??
    ((s: ObjectiveProgressScope) => readOrganizationKrMeasurements(s, { rootDir: deps.rootDir }));
  const rows = read(target);
  const after = rollUpObjectiveProgress(target, {
    readMeasurements: () => rows,
    loadPurpose: deps.loadPurpose,
  });
  const before = rollUpObjectiveProgress(target, {
    readMeasurements: () => rows.filter((row) => Date.parse(row.measured_at) < since.getTime()),
    loadPurpose: deps.loadPurpose,
  });
  const beforeById = new Map(before.objectives.map((o) => [o.objective_id, o.progress]));
  return after.objectives.map((objective) => {
    const prior = pct(beforeById.get(objective.objective_id));
    const current = pct(objective.progress);
    return {
      objective_id: objective.objective_id,
      title: objective.title,
      ...(prior !== undefined ? { before: prior } : {}),
      ...(current !== undefined ? { after: current } : {}),
      ...(prior !== undefined && current !== undefined ? { delta: current - prior } : {}),
    };
  });
}

export interface OrganizationStandup {
  kind: 'organization_standup';
  generated_at: string;
  since: string;
  timezone: string;
  organization_id: string;
  tier: OrganizationTier;
  tenant_slug?: string;
  operation_runs: Array<{ run_id: string; operation_id: string; status: string; at: string }>;
  dot_work: Array<{ dot_id: string; status: string; summary: string; at: string }>;
  actions: Array<{ dot_id: string; status: 'dispatched' | 'parked'; title: string; at: string }>;
  pending_decisions: Array<{ decision_id: string; title: string; due_at: string }>;
  blocked_work_items: Array<{ item_id: string; title: string }>;
  objective_changes: ObjectiveProgressChange[];
  /** True when there is nothing to report. */
  quiet: boolean;
}

export function buildOrganizationStandup(
  scope: OrganizationScopeRef,
  since: Date,
  deps: OrganizationCadenceDeps = {},
  options: { timezone?: string } = {}
): OrganizationStandup {
  const now = deps.now?.() ?? new Date();
  const tenant = cadenceTenant(scope);
  const charters = organizationDotCharters(scope, deps);
  const dotIds = new Set(charters.map((charter) => charter.dot_id));

  const runs = (
    deps.listOperationRuns ??
    ((s: OrganizationScopeRef) =>
      listOrganizationOperationRuns({
        organizationId: s.organizationId,
        tier: s.tier,
        tenantSlug: s.tenantSlug,
        rootDir: deps.rootDir,
      }))
  )(scope)
    .filter((run) => inWindow(run.completed_at ?? run.started_at, since, now))
    .map((run) => ({
      run_id: run.run_id,
      operation_id: run.operation_id,
      status: run.status,
      at: run.completed_at ?? run.started_at,
    }))
    .sort((a, b) => a.at.localeCompare(b.at));

  const readResults =
    deps.readWorkResults ??
    ((charter: DotCharter) => readDotWorkResults(charter, { rootDir: deps.rootDir }));
  const dotWork = charters
    .flatMap((charter) => readResults(charter))
    .filter((row) => inWindow(row.completed_at, since, now))
    .map((row) => ({
      dot_id: row.dot_id,
      status: row.status,
      summary: truncateText(row.summary),
      at: row.completed_at,
    }))
    .sort((a, b) => a.at.localeCompare(b.at));

  const actions = organizationActions(dotIds, deps)
    .filter(
      (row): row is DotActionRecord & { status: 'dispatched' | 'parked' } =>
        // Parked actions stay relevant until decided; dispatched ones only inside the window.
        row.status === 'parked' || (row.status === 'dispatched' && inWindow(row.at, since, now))
    )
    .map((row) => ({
      dot_id: row.dot_id,
      status: row.status,
      title: truncateText(row.title),
      at: row.at,
    }))
    .sort((a, b) => a.at.localeCompare(b.at));

  const decisions = (
    deps.listDecisions ??
    ((s: OrganizationScopeRef) =>
      listOrganizationDecisions({
        organizationId: s.organizationId,
        tier: s.tier,
        tenantSlug: s.tenantSlug,
        rootDir: deps.rootDir,
      }))
  )(scope)
    .filter((entry) => PENDING_DECISION_STATUSES.has(entry.status))
    .map((entry) => ({
      decision_id: entry.decision_id,
      title: truncateText(entry.title),
      due_at: entry.due_at,
    }))
    .sort((a, b) => a.due_at.localeCompare(b.due_at));

  const blocked = (
    deps.listBlockedWorkItems ??
    (() => listWorkItems({ status: ['blocked'] }, deps.rootDir ? { rootDir: deps.rootDir } : {}))
  )()
    .filter(
      (item) =>
        item.status === 'blocked' &&
        item.context?.organization_id === scope.organizationId &&
        item.context?.tenant_slug === tenant
    )
    .map((item) => ({ item_id: item.item_id, title: truncateText(item.title) }));

  const objectiveChanges = objectiveProgressChanges(scope, since, deps).filter(
    (change) => change.delta !== undefined && change.delta !== 0
  );

  const standup: OrganizationStandup = {
    kind: 'organization_standup',
    generated_at: now.toISOString(),
    since: since.toISOString(),
    timezone: options.timezone ?? ORGANIZATION_CADENCE_DEFAULT_TIMEZONE,
    organization_id: scope.organizationId,
    tier: scope.tier,
    ...(tenant ? { tenant_slug: tenant } : {}),
    operation_runs: runs,
    dot_work: dotWork,
    actions,
    pending_decisions: decisions,
    blocked_work_items: blocked,
    objective_changes: objectiveChanges,
    quiet: false,
  };
  standup.quiet =
    runs.length +
      dotWork.length +
      actions.length +
      decisions.length +
      blocked.length +
      objectiveChanges.length ===
    0;
  return standup;
}

export function formatCadenceLocal(iso: string, timeZone: string, locale: SupportedLocale): string {
  return new Intl.DateTimeFormat(localeToBcp47(locale), {
    timeZone,
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));
}

/** Slack-style bulleted section capped at MAX_LINES_PER_SECTION lines. */
export function cadenceSection(
  title: string,
  lines: string[],
  moreLabel: (n: number) => string
): string[] {
  if (lines.length === 0) return [];
  const shown = lines.slice(0, MAX_LINES_PER_SECTION).map((line) => `• ${line}`);
  const rest = lines.length - MAX_LINES_PER_SECTION;
  return [`*${title}*`, ...shown, ...(rest > 0 ? [`• ${moreLabel(rest)}`] : [])];
}

export function renderOrganizationStandupText(
  standup: OrganizationStandup,
  organizationName: string,
  locale: SupportedLocale = ORGANIZATION_CADENCE_DEFAULT_LOCALE
): string {
  const tr = (key: VocabularyKey, params?: MessageParams) => t(key, params, locale);
  const at = (iso: string) => formatCadenceLocal(iso, standup.timezone, locale);
  const more = (count: number) => tr('organization_cadence_more', { count });
  const header = tr('organization_standup_header', {
    name: organizationName,
    since: at(standup.since),
  });
  if (standup.quiet) return `${header}\n${tr('organization_standup_quiet')}`;
  const blocks = [
    cadenceSection(
      tr('organization_standup_section_runs'),
      standup.operation_runs.map((run) =>
        tr('organization_standup_run_line', { status: run.status, operation: run.operation_id })
      ),
      more
    ),
    cadenceSection(
      tr('organization_standup_section_dot_work'),
      standup.dot_work.map((row) =>
        tr('organization_standup_work_line', {
          status: row.status,
          dot: row.dot_id,
          summary: row.summary,
        })
      ),
      more
    ),
    cadenceSection(
      tr('organization_standup_section_actions'),
      standup.actions.map((row) =>
        tr('organization_standup_action_line', {
          status: row.status,
          dot: row.dot_id,
          title: row.title,
        })
      ),
      more
    ),
    cadenceSection(
      tr('organization_standup_section_decisions'),
      standup.pending_decisions.map((row) =>
        tr('organization_standup_decision_line', { title: row.title, when: at(row.due_at) })
      ),
      more
    ),
    cadenceSection(
      tr('organization_standup_section_blocked'),
      standup.blocked_work_items.map((row) =>
        tr('organization_standup_blocked_line', { title: row.title })
      ),
      more
    ),
    cadenceSection(
      tr('organization_standup_section_objectives'),
      standup.objective_changes.map((row) =>
        tr('organization_standup_objective_line', {
          title: row.title,
          from: row.before ?? 0,
          to: row.after ?? 0,
          delta: `${(row.delta ?? 0) > 0 ? '+' : ''}${row.delta ?? 0}`,
        })
      ),
      more
    ),
  ].filter((block) => block.length > 0);
  return [header, ...blocks.map((block) => block.join('\n'))].join('\n\n');
}

export function cadenceDateStamp(now: Date, timezone: string): string {
  const date = calendarDateInZone(now, timezone);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.year}-${pad(date.month)}-${pad(date.day)}`;
}

export function cadenceArtifactId(
  prefix: string,
  scope: OrganizationScopeRef,
  stamp: string
): string {
  const scopeKey = `${scope.tier}/${cadenceTenant(scope) || 'shared'}/${scope.organizationId}`;
  const digest = createHash('sha256').update(scopeKey).digest('hex').slice(0, 20).toUpperCase();
  return `${prefix}-${stamp.replace(/-/gu, '')}-${digest}`;
}

export interface CadencePersistence {
  organization_id: string;
  tier: OrganizationTier;
  tenant_slug?: string;
  path?: string;
  artifact_id?: string;
  notified: boolean;
  error?: string;
}

/** File one cadence report in the organization's scope and notify the operator (best effort). */
export function persistOrganizationCadenceReport(input: {
  scope: OrganizationScopeRef;
  kind: 'standup' | 'retro';
  content: Record<string, unknown>;
  text: string;
  organizationName: string;
  now: Date;
  timezone: string;
  deps: OrganizationCadenceDeps;
}): CadencePersistence {
  const { scope, kind, content, text, organizationName, now, timezone, deps } = input;
  const tenant = cadenceTenant(scope);
  const stamp = cadenceDateStamp(now, timezone);
  const result: CadencePersistence = {
    organization_id: scope.organizationId,
    tier: scope.tier,
    ...(tenant ? { tenant_slug: tenant } : {}),
    notified: false,
  };
  try {
    const written = (deps.writeArtifact ?? writeScopedArtifact)({
      scope: { organization: scope.organizationId, ...(tenant ? { tenant } : {}) },
      tier: scope.tier,
      artifact_class: 'report',
      name: `${kind === 'standup' ? 'standups' : 'retros'}/${stamp}.json`,
      content: { ...content, text },
      format: 'json',
      publish: {
        artifact_id: cadenceArtifactId(
          kind === 'standup' ? 'ART-ORGSTANDUP' : 'ART-ORGRETRO',
          scope,
          stamp
        ),
        kind: 'report',
        preview_text: `${organizationName} ${kind} ${stamp}`,
        metadata: { cadence: kind, date: stamp },
      },
    });
    result.path = written.repo_relative_path;
    if (written.artifact_id) result.artifact_id = written.artifact_id;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    logger.warn(
      `organization ${kind} artifact not written — ${result.error} | the text is still delivered | organization=${scope.organizationId}`
    );
  }
  try {
    result.notified = (deps.notify ?? notifyOperatorSync)(
      'decision_digest',
      {
        title: `${organizationName} ${kind} ${stamp}`,
        body: text,
        correlation_id: `org-${kind}-${scope.organizationId}-${stamp}`,
      },
      { route: { surface: 'inbox', target: `organization-${kind}` } }
    );
  } catch (error) {
    logger.warn(
      `organization ${kind} notification failed — ${error instanceof Error ? error.message : String(error)} | the artifact is kept | organization=${scope.organizationId}`
    );
  }
  return result;
}

/**
 * Hours since the previous weekday standup (the schedule runs Monday–Friday):
 * 72 on Monday (covers the weekend), 48 on Sunday, otherwise 24.
 */
export function defaultStandupWindowHours(now: Date, timezone: string): number {
  const date = calendarDateInZone(now, timezone);
  const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  return weekday === 1 ? 72 : weekday === 0 ? 48 : 24;
}

export interface RunOrganizationStandupOptions {
  /** Scoped mode: only this organization (no sovereign persona; bound tenant must match). */
  scope?: OrganizationCadenceScope;
  /** Hours of history to report (default: since the previous weekday standup). */
  sinceHours?: number;
  timezone?: string;
  locale?: SupportedLocale;
  tiers?: OrganizationTier[];
  persist?: boolean;
  env?: Record<string, string | undefined>;
}

export interface OrganizationStandupRun {
  standups: Array<{ standup: OrganizationStandup; text: string; persistence?: CadencePersistence }>;
  organization_count: number;
  reported_count: number;
  text: string;
}

export function organizationDisplayName(scope: OrganizationScopeRef): string {
  return scope.name || scope.organizationId;
}

/** Governed standup: every organization (sovereign-only) or one scoped organization; audited. */
export function runOrganizationStandup(
  options: RunOrganizationStandupOptions = {},
  deps: OrganizationCadenceDeps & {
    listOrganizations?: (tier: OrganizationTier) => OrganizationScopeRef[];
  } = {}
): OrganizationStandupRun {
  const auth = authorizeOrganizationCadence('standup', options.scope, options.env);
  const now = deps.now?.() ?? new Date();
  const timezone = options.timezone ?? ORGANIZATION_CADENCE_DEFAULT_TIMEZONE;
  const locale = options.locale ?? ORGANIZATION_CADENCE_DEFAULT_LOCALE;
  const hours =
    options.sinceHours && options.sinceHours > 0
      ? options.sinceHours
      : defaultStandupWindowHours(now, timezone);
  const since = new Date(now.getTime() - hours * HOUR_MS);
  const tiers = options.scope
    ? [options.scope.tier]
    : (options.tiers ?? ['confidential', 'public']);
  const standups: OrganizationStandupRun['standups'] = [];
  let organizationCount = 0;
  for (const tier of tiers) {
    const scopes = cadenceOrganizations(tier, options.scope, deps.rootDir, deps.listOrganizations);
    for (const scope of scopes) {
      organizationCount += 1;
      const standup = buildOrganizationStandup(
        scope,
        since,
        { ...deps, now: () => now },
        { timezone }
      );
      if (standup.quiet) continue;
      const name = organizationDisplayName(scope);
      const text = renderOrganizationStandupText(standup, name, locale);
      const persistence =
        options.persist === false
          ? undefined
          : persistOrganizationCadenceReport({
              scope,
              kind: 'standup',
              content: standup as unknown as Record<string, unknown>,
              text,
              organizationName: name,
              now,
              timezone,
              deps,
            });
      standups.push({ standup, text, ...(persistence ? { persistence } : {}) });
    }
  }
  (deps.audit ?? ((entry) => auditChain.record(entry)))({
    agentId: auth.agentId,
    action: 'organization.standup',
    operation: `standup:${auth.mode}`,
    result: 'completed',
    ...(auth.tenantSlug ? { tenantSlug: auth.tenantSlug } : {}),
    metadata: {
      tiers,
      ...(options.scope ? { organization_id: options.scope.organizationId } : {}),
      organization_count: organizationCount,
      reported_count: standups.length,
    },
  });
  return {
    standups,
    organization_count: organizationCount,
    reported_count: standups.length,
    text: standups.map((entry) => entry.text).join('\n\n'),
  };
}
