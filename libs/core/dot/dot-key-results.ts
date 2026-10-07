/**
 * Key-result measurement engine (DL-03, dot side).
 *
 * Measures `goal.key_results` of dot charters (and the key results of the
 * organization objectives a dot is attached to), appends one
 * {@link KrMeasurementRow} per measurement, and renders the "largest goal gap
 * first" view the wake prompt, digest and status use. Every port is injectable
 * so the engine is fully testable offline; a failed measurement never throws —
 * it logs a diagnostic warn and leaves the previous value in place.
 */

import * as path from 'node:path';
import { withExecutionContextAsync } from '../authority.js';
import { appendJsonLine, readJsonLines } from '../foundation/json.js';
import { createLogger } from '../logger.js';
import { pathResolver } from '../path-resolver.js';
import { isTenantPhysicalNamespacePath, physicalScopedPath } from '../physical-namespace.js';
import { assertSafeRepositoryPath, safeMkdir, safeReadFile } from '../secure-io.js';
import { evaluateStateProbe, type StateProbeDeps, type StateProbeResult } from '../state-probe.js';
import {
  keyResultProgress,
  type KeyResultOrgMetric,
  type KeyResultSpec,
  type ObjectiveRef,
} from '../key-result-spec.js';
import {
  listOrganizationIncidents,
  listOrganizationDecisions,
  listOrganizationServiceStates,
} from '../organization/organization-operating-model-management.js';
import { listOrganizationOperationStates } from '../organization/organization-operating-model-operations.js';
import { loadOrganizationPurpose } from '../organization/organization-operating-model-persistence.js';
import type {
  OrganizationPurposeRecord,
  OrganizationTier,
} from '../organization/organization-operating-model.js';
import type {
  ObjectiveProgressScope,
  KrMeasurementRow as OrgKrMeasurementRow,
} from '../organization/organization-objective-progress.js';
import type { DotCharter } from './dot-charter.js';
import type { DotDigestSection, DotPromptSection, DotStatusSection } from './dot-extensions.js';
import { readDotSignals, type DotSignalEntry } from './dot-feedback.js';
import {
  DOT_KR_LEDGER_FILE,
  DOT_ORG_KR_LEDGER_FILE,
  DOT_STATE_ROOT,
  dotStatePath,
  type KrMeasurementRow,
} from './dot-state-paths.js';

const logger = createLogger('dot-key-results');

export const KR_PROBE_TIMEOUT_MS = 15_000;
export const KR_DEFAULT_EVERY_S = 900;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SIGNAL_WINDOW_HOURS = 24;

export interface OrgMetricScope {
  organizationId?: string;
  tenantSlug?: string;
  tier: OrganizationTier;
}

export interface DotKeyResultDeps {
  rootDir?: string;
  now?: () => Date;
  /** Probe evaluator; defaults to `evaluateStateProbe`. */
  runProbe?: (
    spec: Parameters<typeof evaluateStateProbe>[0],
    deps: StateProbeDeps
  ) => Promise<StateProbeResult>;
  serviceCall?: StateProbeDeps['serviceCall'];
  /** Reads a repo-relative file as text; defaults to a repo-confined secure-io read. */
  readFile?: (relPath: string) => string;
  /** Measure every key result now, ignoring its `every_s` throttle (on-demand sweeps). */
  force?: boolean;
  /** Organization metric port; defaults to the persisted organization records. */
  orgMetric?: (metric: KeyResultOrgMetric, scope: OrgMetricScope) => number | undefined;
  readSignals?: (dotId: string) => DotSignalEntry[];
  loadPurpose?: (scope: ObjectiveProgressScope) => OrganizationPurposeRecord | null | undefined;
  probeTimeoutMs?: number;
  /**
   * Runs one charter's measurement inside its execution context (role, tenant,
   * organization); defaults to `withExecutionContextAsync`. Test seam.
   */
  runAs?: <T>(c: DotCharter, fn: () => Promise<T>) => Promise<T>;
}

/** Run `fn` as the charter: its authority role, tenant and organization. */
export function runAsDotCharter<T>(c: DotCharter, fn: () => Promise<T>): Promise<T> {
  return withExecutionContextAsync(
    c.authority.authority_role,
    fn,
    undefined,
    c.scope.tenant_slug,
    c.scope.organization_id
  );
}

function diag(what: string, why: unknown, next: string, evidence: string): string {
  return `${what} — ${why instanceof Error ? why.message : String(why)} | next: ${next} | evidence: ${evidence}`;
}

function absolute(rootDir: string | undefined, rel: string): string {
  return path.join(rootDir ?? pathResolver.rootDir(), rel);
}

function readLedger(rel: string, rootDir: string | undefined): KrMeasurementRow[] {
  return readJsonLines<KrMeasurementRow>(absolute(rootDir, rel), { onMalformed: 'skip' }).filter(
    (row) => row && typeof row.kr_id === 'string' && Number.isFinite(row.value)
  );
}

function appendLedger(rel: string, rows: KrMeasurementRow[], rootDir: string | undefined): void {
  if (rows.length === 0) return;
  const file = absolute(rootDir, rel);
  safeMkdir(path.dirname(file), { recursive: true });
  for (const row of rows) appendJsonLine(file, row);
}

/** Repo-relative org-scoped KR ledger path (`org-kr-ledger.jsonl`). */
export function orgKrLedgerPath(scope: { tenantSlug?: string; organizationId?: string }): string {
  // Untenanted organizations share the flat ledger; rows carry organization_id.
  if (!scope.tenantSlug) return `${DOT_STATE_ROOT}/${DOT_ORG_KR_LEDGER_FILE}`;
  return physicalScopedPath(
    DOT_STATE_ROOT,
    { tenant_slug: scope.tenantSlug, organization_id: scope.organizationId },
    DOT_ORG_KR_LEDGER_FILE
  );
}

function extractJsonPath(value: unknown, jsonPath: string): unknown {
  let current: unknown = value;
  for (const segment of jsonPath.split('.')) {
    if (segment === '') continue;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
    } else if (current && typeof current === 'object') {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function toNumber(value: unknown, aggregate: 'value' | 'count' | undefined): number | undefined {
  if (aggregate === 'count') {
    if (Array.isArray(value)) return value.length;
    if (value && typeof value === 'object') return Object.keys(value).length;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function defaultReadFile(rootDir: string | undefined): (rel: string) => string {
  return (rel) => {
    if (path.isAbsolute(rel)) throw new Error(`file path must be repository-relative: ${rel}`);
    const resolved = assertSafeRepositoryPath(absolute(rootDir, rel));
    return String(safeReadFile(resolved, { encoding: 'utf8' }));
  };
}

function defaultOrgMetric(rootDir: string | undefined): NonNullable<DotKeyResultDeps['orgMetric']> {
  return (metric, scope) => {
    if (!scope.organizationId) return undefined;
    const query = {
      organizationId: scope.organizationId,
      tier: scope.tier,
      tenantSlug: scope.tenantSlug,
      rootDir,
    };
    switch (metric) {
      case 'overdue_operations':
        return listOrganizationOperationStates(query).filter((s) => s.due_status === 'overdue')
          .length;
      case 'open_incidents':
        return listOrganizationIncidents(query).filter(
          (i) => i.status !== 'resolved' && i.status !== 'closed'
        ).length;
      case 'pending_decisions':
        return listOrganizationDecisions(query).filter(
          (d) => d.status === 'proposed' || d.status === 'pending_approval'
        ).length;
      case 'unhealthy_services':
        return listOrganizationServiceStates(query).filter(
          (s) => s.health === 'degraded' || s.health === 'critical'
        ).length;
    }
  };
}

interface MeasureTarget {
  dotId?: string;
  orgScope: OrgMetricScope;
  /** The measuring scope's own dot state subtree (tenant scopes only). */
  stateRoot?: string;
}

/**
 * Tenant confinement for `file` metrics: a tenant scope may read only
 * `knowledge/public/**`, its own `knowledge/confidential/<slug>/**`, or its
 * own dot state subtree; an untenanted scope may read neither confidential nor
 * personal knowledge nor any tenant-namespaced runtime floor. Throws on denial.
 */
export function assertDotKrFilePathAllowed(
  rel: string,
  scope: { tenantSlug?: string; stateRoot?: string }
): void {
  const raw = String(rel ?? '').replace(/\\/g, '/');
  const normalized = path.posix.normalize(raw);
  if (!raw || path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) {
    throw new Error(`file path must be repository-relative and confined: ${rel}`);
  }
  const under = (prefix: string) =>
    normalized === prefix.replace(/\/$/, '') || normalized.startsWith(prefix);
  if (under('knowledge/personal/')) {
    throw new Error(`file metric may not read personal knowledge: ${normalized}`);
  }
  if (scope.tenantSlug) {
    const allowed =
      under('knowledge/public/') ||
      under(`knowledge/confidential/${scope.tenantSlug}/`) ||
      (scope.stateRoot !== undefined && under(`${scope.stateRoot.replace(/\/$/, '')}/`));
    if (!allowed) {
      throw new Error(
        `file metric path outside tenant '${scope.tenantSlug}' scope (allowed: knowledge/public/, knowledge/confidential/${scope.tenantSlug}/, the dot state subtree): ${normalized}`
      );
    }
    return;
  }
  if (under('knowledge/confidential/') || isTenantPhysicalNamespacePath(normalized)) {
    throw new Error(`untenanted file metric may not read tenant-scoped data: ${normalized}`);
  }
}

/** Returns a numeric value, or undefined when the metric is unmeasurable right now. */
async function measureSpec(
  spec: KeyResultSpec,
  target: MeasureTarget,
  deps: DotKeyResultDeps,
  now: Date
): Promise<number | undefined> {
  const metric = spec.metric;
  switch (metric.source) {
    case 'probe': {
      const run = deps.runProbe ?? evaluateStateProbe;
      const result = await withTimeout(
        run(metric.probe, { rootDir: deps.rootDir, serviceCall: deps.serviceCall }),
        deps.probeTimeoutMs ?? KR_PROBE_TIMEOUT_MS
      );
      if (!result) throw new Error('probe timed out');
      const value = toNumber(result.value, metric.aggregate);
      if (value !== undefined) return value;
      if (metric.aggregate === 'count') return result.matched ? 1 : 0;
      throw new Error(`probe value is not numeric (${typeof result.value})`);
    }
    case 'file': {
      assertDotKrFilePathAllowed(metric.path, {
        tenantSlug: target.orgScope.tenantSlug,
        stateRoot: target.stateRoot,
      });
      const raw = (deps.readFile ?? defaultReadFile(deps.rootDir))(metric.path);
      const value = toNumber(extractJsonPath(JSON.parse(raw), metric.json_path), metric.aggregate);
      if (value === undefined) throw new Error(`no numeric value at ${metric.json_path}`);
      return value;
    }
    case 'signal_ratio': {
      if (!target.dotId) throw new Error('signal_ratio needs a dot scope');
      const rows = (deps.readSignals ?? ((id) => readDotSignals(id, { rootDir: deps.rootDir })))(
        target.dotId
      );
      const cutoff =
        now.getTime() - (metric.window_hours ?? DEFAULT_SIGNAL_WINDOW_HOURS) * 3_600_000;
      const inWindow = rows.filter(
        (row) => row.signal === metric.signal && Date.parse(row.measured_at) >= cutoff
      );
      if (inWindow.length === 0) throw new Error(`no '${metric.signal}' signal rows in window`);
      return (100 * inWindow.filter((row) => row.healthy).length) / inWindow.length;
    }
    case 'org_metric': {
      const value = (deps.orgMetric ?? defaultOrgMetric(deps.rootDir))(
        metric.metric,
        target.orgScope
      );
      if (value === undefined) throw new Error(`organization metric ${metric.metric} unavailable`);
      return value;
    }
    case 'manual':
      // Recorded by a person through recordOrganizationKeyResult; nothing to sweep.
      return undefined;
  }
}

function isDue(spec: KeyResultSpec, last: KrMeasurementRow | undefined, now: Date): boolean {
  if (!last) return true;
  const everyMs = (spec.every_s ?? KR_DEFAULT_EVERY_S) * 1000;
  const lastMs = Date.parse(last.measured_at);
  return !Number.isFinite(lastMs) || now.getTime() - lastMs >= everyMs;
}

function latestBy(
  rows: KrMeasurementRow[],
  keyOf: (row: KrMeasurementRow) => string
): Map<string, KrMeasurementRow> {
  const latest = new Map<string, KrMeasurementRow>();
  for (const row of rows) {
    const key = keyOf(row);
    const prev = latest.get(key);
    if (!prev || row.measured_at >= prev.measured_at) latest.set(key, row);
  }
  return latest;
}

/** Measures every due `goal.key_results` entry; returns the rows appended. */
export async function measureDotKeyResults(
  c: DotCharter,
  deps: DotKeyResultDeps = {}
): Promise<KrMeasurementRow[]> {
  const specs = c.goal.key_results ?? [];
  if (specs.length === 0) return [];
  const now = deps.now?.() ?? new Date();
  const ledger = dotStatePath(c, DOT_KR_LEDGER_FILE);
  let latest: Map<string, KrMeasurementRow>;
  try {
    latest = latestBy(
      readLedger(ledger, deps.rootDir).filter(
        (row) => row.scope === 'dot' && row.dot_id === c.dot_id
      ),
      (row) => row.kr_id
    );
  } catch (error) {
    logger.warn(
      diag(`KR ledger unreadable for ${c.dot_id}`, error, 'measuring without throttle', ledger)
    );
    latest = new Map();
  }
  const rows: KrMeasurementRow[] = [];
  const target: MeasureTarget = {
    dotId: c.dot_id,
    ...(c.scope.tenant_slug ? { stateRoot: dotStatePath(c) } : {}),
    orgScope: {
      organizationId: c.scope.organization_id,
      tenantSlug: c.scope.tenant_slug,
      tier: c.scope.tier,
    },
  };
  for (const spec of specs) {
    if (!isDue(spec, latest.get(spec.kr_id), now)) continue;
    try {
      const value = await measureSpec(spec, target, deps, now);
      if (value === undefined) continue;
      rows.push({
        scope: 'dot',
        dot_id: c.dot_id,
        kr_id: spec.kr_id,
        value,
        progress: keyResultProgress(spec, value),
        measured_at: now.toISOString(),
      });
    } catch (error) {
      logger.warn(
        diag(
          `KR measurement failed for ${c.dot_id}/${spec.kr_id}`,
          error,
          'the previous value stays; retried next sweep',
          ledger
        )
      );
    }
  }
  try {
    appendLedger(ledger, rows, deps.rootDir);
  } catch (error) {
    logger.warn(
      diag(`KR ledger write failed for ${c.dot_id}`, error, 'rows dropped this sweep', ledger)
    );
    return [];
  }
  return rows;
}

/** Latest measurement per `kr_id` for this dot. */
export function readLatestDotKeyResults(
  c: DotCharter,
  deps: Pick<DotKeyResultDeps, 'rootDir'> = {}
): Map<string, KrMeasurementRow> {
  try {
    return latestBy(
      readLedger(dotStatePath(c, DOT_KR_LEDGER_FILE), deps.rootDir).filter(
        (row) => row.scope === 'dot' && row.dot_id === c.dot_id
      ),
      (row) => row.kr_id
    );
  } catch (error) {
    logger.warn(
      diag(
        `KR ledger unreadable for ${c.dot_id}`,
        error,
        'treating KRs as unmeasured',
        DOT_KR_LEDGER_FILE
      )
    );
    return new Map();
  }
}

/** All org-scope rows in the org's ledger — usable as `rollUpObjectiveProgress`'s readMeasurements port. */
export function readOrganizationKrMeasurements(
  scope: ObjectiveProgressScope,
  deps: Pick<DotKeyResultDeps, 'rootDir'> = {}
): OrgKrMeasurementRow[] {
  const ledger = orgKrLedgerPath({
    tenantSlug: scope.tenantSlug,
    organizationId: scope.organizationId,
  });
  try {
    return readLedger(ledger, deps.rootDir).filter(
      (row) =>
        row.scope === 'org' &&
        (!row.organization_id || row.organization_id === scope.organizationId)
    );
  } catch (error) {
    logger.warn(
      diag(
        `org KR ledger unreadable for ${scope.organizationId}`,
        error,
        'objectives read as unmeasured',
        ledger
      )
    );
    return [];
  }
}

/** Measures every due key result of every objective of the organization. */
export async function measureOrganizationKeyResults(
  scope: ObjectiveProgressScope,
  deps: DotKeyResultDeps = {}
): Promise<KrMeasurementRow[]> {
  const now = deps.now?.() ?? new Date();
  const ledger = orgKrLedgerPath({
    tenantSlug: scope.tenantSlug,
    organizationId: scope.organizationId,
  });
  let purpose: OrganizationPurposeRecord | null | undefined;
  try {
    purpose = (
      deps.loadPurpose ??
      ((s) =>
        loadOrganizationPurpose(s.organizationId, {
          tier: s.tier,
          tenantSlug: s.tenantSlug,
          rootDir: deps.rootDir,
        }))
    )(scope);
  } catch (error) {
    logger.warn(
      diag(
        `organization purpose unreadable for ${scope.organizationId}`,
        error,
        'org KRs skipped this sweep',
        ledger
      )
    );
    return [];
  }
  const latest = latestBy(
    readOrganizationKrMeasurements(scope, deps),
    (row) => `${row.objective_id}\u0000${row.kr_id}`
  );
  const target: MeasureTarget = {
    ...(scope.tenantSlug
      ? {
          stateRoot: physicalScopedPath(DOT_STATE_ROOT, {
            tenant_slug: scope.tenantSlug,
            organization_id: scope.organizationId,
          }),
        }
      : {}),
    orgScope: {
      organizationId: scope.organizationId,
      tenantSlug: scope.tenantSlug,
      tier: scope.tier,
    },
  };
  const rows: KrMeasurementRow[] = [];
  for (const objective of purpose?.objectives ?? []) {
    for (const spec of objective.key_results ?? []) {
      if (
        !deps.force &&
        !isDue(spec, latest.get(`${objective.objective_id}\u0000${spec.kr_id}`), now)
      )
        continue;
      try {
        const value = await measureSpec(spec, target, deps, now);
        if (value === undefined) continue;
        rows.push({
          scope: 'org',
          organization_id: scope.organizationId,
          objective_id: objective.objective_id,
          kr_id: spec.kr_id,
          value,
          progress: keyResultProgress(spec, value),
          measured_at: now.toISOString(),
        });
      } catch (error) {
        logger.warn(
          diag(
            `org KR measurement failed for ${scope.organizationId}/${objective.objective_id}/${spec.kr_id}`,
            error,
            'the previous value stays; retried next sweep',
            ledger
          )
        );
      }
    }
  }
  try {
    appendLedger(ledger, rows, deps.rootDir);
  } catch (error) {
    logger.warn(
      diag(
        `org KR ledger write failed for ${scope.organizationId}`,
        error,
        'rows dropped this sweep',
        ledger
      )
    );
    return [];
  }
  return rows;
}

/**
 * Records a value for one organization key result, as measured outside
 * Kyberion (a survey, a spreadsheet, a meeting). Any KR source accepts a
 * recorded value; it is the KR's latest measurement until the next sweep.
 */
export function recordOrganizationKeyResult(
  scope: ObjectiveProgressScope,
  input: { objectiveId: string; krId: string; value: number; measuredAt?: string },
  deps: Pick<DotKeyResultDeps, 'rootDir' | 'loadPurpose' | 'now'> = {}
): KrMeasurementRow {
  if (!Number.isFinite(input.value)) {
    throw new Error(`Key result value must be a finite number (got ${input.value}).`);
  }
  const measuredAt = input.measuredAt ?? (deps.now?.() ?? new Date()).toISOString();
  if (Number.isNaN(Date.parse(measuredAt))) {
    throw new Error(`--measured-at must be an ISO-8601 timestamp (got ${measuredAt}).`);
  }
  const purpose = (
    deps.loadPurpose ??
    ((s) =>
      loadOrganizationPurpose(s.organizationId, {
        tier: s.tier,
        tenantSlug: s.tenantSlug,
        rootDir: deps.rootDir,
      }))
  )(scope);
  const objective = purpose?.objectives?.find((entry) => entry.objective_id === input.objectiveId);
  if (!objective) {
    throw new Error(`Objective not found in ${scope.organizationId}: ${input.objectiveId}`);
  }
  const spec = objective.key_results?.find((entry) => entry.kr_id === input.krId);
  if (!spec) {
    throw new Error(`Key result not found in ${input.objectiveId}: ${input.krId}`);
  }
  const row: KrMeasurementRow = {
    scope: 'org',
    organization_id: scope.organizationId,
    objective_id: input.objectiveId,
    kr_id: input.krId,
    value: input.value,
    progress: keyResultProgress(spec, input.value),
    measured_at: new Date(measuredAt).toISOString(),
  };
  appendLedger(
    orgKrLedgerPath({ tenantSlug: scope.tenantSlug, organizationId: scope.organizationId }),
    [row],
    deps.rootDir
  );
  return row;
}

// ---------------------------------------------------------------------------
// goal-gap view
// ---------------------------------------------------------------------------

export interface DotGoalGap {
  kr_id: string;
  title: string;
  unit?: string;
  target: number;
  weight: number;
  value?: number;
  progress?: number;
  /** weight * (1 - progress); unmeasured KRs carry the full weight. */
  gap: number;
  /** Progress change over the last 24 h, in progress points (0..1). */
  trend_24h?: number;
  measured_at?: string;
}

export function dotGoalGaps(c: DotCharter, deps: DotKeyResultDeps = {}): DotGoalGap[] {
  const specs = c.goal.key_results ?? [];
  if (specs.length === 0) return [];
  const now = (deps.now?.() ?? new Date()).getTime();
  let all: KrMeasurementRow[] = [];
  try {
    all = readLedger(dotStatePath(c, DOT_KR_LEDGER_FILE), deps.rootDir).filter(
      (row) => row.scope === 'dot' && row.dot_id === c.dot_id
    );
  } catch (error) {
    logger.warn(
      diag(
        `KR ledger unreadable for ${c.dot_id}`,
        error,
        'goal gap shows KRs unmeasured',
        DOT_KR_LEDGER_FILE
      )
    );
  }
  return specs.map((spec) => {
    const rows = all
      .filter((row) => row.kr_id === spec.kr_id)
      .sort((a, b) => a.measured_at.localeCompare(b.measured_at));
    const last = rows[rows.length - 1];
    const weight = spec.weight !== undefined && spec.weight > 0 ? spec.weight : 1;
    if (!last)
      return {
        kr_id: spec.kr_id,
        title: spec.title,
        unit: spec.unit,
        target: spec.target,
        weight,
        gap: weight,
      };
    const progress = Math.min(1, Math.max(0, last.progress));
    const lastMs = Date.parse(last.measured_at);
    // Reference = newest row at least 24 h older than the latest, else the oldest row inside the window.
    const windowRows = rows.filter((row) => {
      const ms = Date.parse(row.measured_at);
      return ms >= now - DAY_MS && ms < lastMs;
    });
    const older = rows.filter((row) => Date.parse(row.measured_at) <= lastMs - DAY_MS);
    const reference = older[older.length - 1] ?? windowRows[0];
    return {
      kr_id: spec.kr_id,
      title: spec.title,
      unit: spec.unit,
      target: spec.target,
      weight,
      value: last.value,
      progress,
      gap: weight * (1 - progress),
      ...(reference ? { trend_24h: progress - reference.progress } : {}),
      measured_at: last.measured_at,
    };
  });
}

function rankGaps(gaps: DotGoalGap[]): DotGoalGap[] {
  return [...gaps].sort((a, b) => {
    const am = a.progress !== undefined ? 0 : 1;
    const bm = b.progress !== undefined ? 0 : 1;
    return am - bm || b.gap - a.gap || a.kr_id.localeCompare(b.kr_id);
  });
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, '');
}

function trendMark(trend: number | undefined): string {
  if (trend === undefined) return '';
  const pp = Math.round(trend * 100);
  if (pp === 0) return ', trend → flat 24h';
  return `, trend ${pp > 0 ? '↑' : '↓'} ${pp > 0 ? '+' : ''}${pp}pp/24h`;
}

function gapLine(g: DotGoalGap): string {
  const unit = g.unit ? ` ${g.unit}` : '';
  if (g.progress === undefined) {
    return `- ${g.kr_id} "${g.title}": not measured yet (target ${fmt(g.target)}${unit}, weight ${fmt(g.weight)})`;
  }
  return `- ${g.kr_id} "${g.title}": ${fmt(g.value ?? 0)}${unit} → target ${fmt(g.target)}${unit} (progress ${Math.round(g.progress * 100)}%, gap ${fmt(Math.round(g.gap * 100) / 100)}, weight ${fmt(g.weight)}${trendMark(g.trend_24h)})`;
}

/** KR lines ranked by weight*(1-progress), largest gap first. Empty when the charter has no KRs. */
export function dotGoalGapLines(c: DotCharter, deps: DotKeyResultDeps = {}): string[] {
  return rankGaps(dotGoalGaps(c, deps)).map(gapLine);
}

const extDeps = (ctx: { rootDir?: string; now: () => Date }): DotKeyResultDeps => ({
  rootDir: ctx.rootDir,
  now: ctx.now,
});

export const DOT_GOAL_GAP_PROMPT_SECTION: DotPromptSection = {
  id: 'dot-goal-gap',
  order: 40,
  lines(c, ctx) {
    const lines = dotGoalGapLines(c, extDeps(ctx));
    return lines.length ? ['Largest goal gap first:', ...lines] : [];
  },
};

export const DOT_KEY_RESULTS_DIGEST_SECTION: DotDigestSection = {
  id: 'key-results',
  lines(c, _since, ctx) {
    const lines = dotGoalGapLines(c, extDeps(ctx));
    return lines.length ? ['Key results (largest gap first):', ...lines] : [];
  },
};

export const DOT_KEY_RESULTS_STATUS_SECTION: DotStatusSection = {
  id: 'key_results',
  collect(c, ctx) {
    return {
      key_results: rankGaps(dotGoalGaps(c, extDeps(ctx))).map((g) => ({
        kr_id: g.kr_id,
        title: g.title,
        value: g.value ?? null,
        target: g.target,
        progress: g.progress ?? null,
        gap: g.gap,
        trend_24h: g.trend_24h ?? null,
        measured_at: g.measured_at ?? null,
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// supervisor sweep
// ---------------------------------------------------------------------------

function isObjectiveRef(ref: unknown): ref is ObjectiveRef {
  return Boolean(ref) && typeof ref === 'object';
}

export interface DotKeyResultSweepResult {
  dot_rows: number;
  org_rows: number;
  orgs_measured: number;
}

/** Measures KRs for the active dots, then once per org referenced by an ObjectiveRef goal. Never throws. */
export async function measureActiveDotKeyResults(
  charters: DotCharter[],
  deps: DotKeyResultDeps = {}
): Promise<DotKeyResultSweepResult> {
  const result: DotKeyResultSweepResult = { dot_rows: 0, org_rows: 0, orgs_measured: 0 };
  const orgs = new Map<string, { scope: ObjectiveProgressScope; as: DotCharter }>();
  const runAs = deps.runAs ?? runAsDotCharter;
  for (const c of charters) {
    try {
      result.dot_rows += (await runAs(c, () => measureDotKeyResults(c, deps))).length;
    } catch (error) {
      logger.warn(
        diag(
          `KR measurement failed for ${c.dot_id}`,
          error,
          'retried next sweep',
          DOT_KR_LEDGER_FILE
        )
      );
    }
    const ref = c.team?.goal_ref;
    if (!isObjectiveRef(ref)) continue;
    const organizationId = ref.organization_id ?? c.scope.organization_id;
    if (!organizationId) continue;
    const key = [c.scope.tier, c.scope.tenant_slug ?? '', organizationId].join('\u0000');
    if (!orgs.has(key)) {
      orgs.set(key, {
        scope: { organizationId, tenantSlug: c.scope.tenant_slug, tier: c.scope.tier },
        as: c,
      });
    }
  }
  // Each organization is measured as the first charter (same tier + tenant) that references it.
  for (const { scope, as } of orgs.values()) {
    try {
      result.org_rows += (await runAs(as, () => measureOrganizationKeyResults(scope, deps))).length;
      result.orgs_measured += 1;
    } catch (error) {
      logger.warn(
        diag(
          `org KR measurement failed for ${scope.organizationId}`,
          error,
          'retried next sweep',
          DOT_ORG_KR_LEDGER_FILE
        )
      );
    }
  }
  return result;
}
