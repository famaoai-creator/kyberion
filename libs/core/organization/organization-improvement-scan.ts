/**
 * Organization improvement scan — the discovery layer of the purpose-driven
 * improvement loop. Deterministically correlates objective progress, KR
 * stagnation, operations friction, dot outcome verdicts and usage-ledger cost
 * into a ranked candidate report. The scan only discovers: every candidate is
 * a proposal routed through existing governed facades (dot dispatch gate,
 * mission_controller, `pnpm organization`, `dot_lifecycle_writer`), never a
 * new write path. All ports are injectable for hermetic tests.
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { readJsonLinesSince } from '../storage/jsonl-read.js';
import { safeExistsSync } from '../secure-io.js';
import {
  rollUpObjectiveProgress,
  type ObjectiveProgress,
  type ObjectiveProgressScope,
} from './organization-objective-progress.js';
import {
  organizationCostMetrics,
  type OrganizationCostMetricsDeps,
} from './organization-cost-metrics.js';
import {
  listOrganizationDecisions,
  listOrganizationIncidents,
  listOrganizationServiceStates,
} from './organization-operating-model-management.js';
import { listOrganizationOperationStates } from './organization-operating-model-operations.js';
import { loadOrganizationPurpose } from './organization-operating-model-persistence.js';
import type { OrganizationTier } from './organization-operating-model.js';
import { listDotCharters, type DotCharter } from '../dot/dot-charter.js';
import {
  DOT_OUTCOMES_FILE,
  dotStatePath,
  orgKrLedgerPath,
  type DotOutcomeRow,
  type KrMeasurementRow,
} from '../dot/dot-state-paths.js';
import { buildCostReportFromHistory, type CostReport } from '../finance/cost-report.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 7;
const STAGNANT_SAMPLE_COUNT = 3;

export type ImprovementTargetKind =
  'pipeline' | 'charter' | 'runbook' | 'kr_definition' | 'process' | 'measurement' | 'cost';

export interface ImprovementExpectedEffect {
  /** Optional by design: measurement/process rules target metrics or the purpose record itself, not an objective. */
  objective_id?: string;
  kr_id?: string;
  /** Metric the candidate is expected to move (e.g. `cost_usd`, `measurement_coverage`). */
  metric: string;
  direction: 'increase' | 'decrease';
  note?: string;
}

export interface ImprovementCandidate {
  candidate_id: string;
  rule_id: string;
  target_kind: ImprovementTargetKind;
  title: string;
  summary: string;
  evidence_refs: string[];
  expected_kr_effect: ImprovementExpectedEffect;
  /** 0..1 deterministic rank input: rule weight x evidence strength. */
  priority_score: number;
  status: 'proposed';
}

export interface ImprovementKrTrend {
  objective_id?: string;
  kr_id: string;
  latest_progress: number;
  latest_value: number;
  measurements: number;
  /** Last-3 progress delta <= 0: no recent improvement. */
  stagnant: boolean;
  last_measured_at: string;
}

export interface ImprovementOutcomeSummary {
  dots_observed: number;
  improved: number;
  no_change: number;
  regressed: number;
  unmeasurable: number;
  /** (kr_id|signal, dot) pairs with >=2 consecutive non-improving verdicts. */
  non_improving_streaks: Array<{
    dot_id: string;
    ref: string;
    streak: number;
    /** Every tail verdict is `unmeasurable` — a measurement defect, not a SOP defect. */
    unmeasurable_only: boolean;
  }>;
}

export interface ImprovementCostSection {
  window_days: number;
  current: {
    since: string;
    until: string;
    cost_usd: number;
    llm_tokens: number;
    llm_calls: number;
    unknown_cost_calls: number;
    cost_complete: boolean;
    withheld_partitions: number;
  };
  prior: { cost_usd: number; llm_tokens: number; llm_calls: number } | null;
  /** (current-prior)/prior in percent; null when prior had no measurable cost. */
  cost_delta_pct: number | null;
  /**
   * Same window, no scope filter: total spend vs the org-scoped share.
   * A high unattributed share means usage rows lack organization scope and
   * org-level cost evaluation is structurally blind, not merely zero.
   */
  unscoped_total_usd: number;
  /** Spend in the visible baseline with no `organization_id` on the usage row. */
  unattributed_usd: number;
  unattributed_share_pct: number | null;
  /** Partitions withheld from the unscoped baseline itself (total understates). */
  unscoped_withheld_partitions: number;
  top_models: Array<{ model: string; cost_usd: number; share_pct: number; calls: number }>;
  top_missions: Array<{ mission_id: string; cost_usd: number; calls: number }>;
}

export interface OrganizationImprovementScanReport {
  version: '1';
  report_id: string;
  generated_at: string;
  scope: {
    tier: OrganizationTier;
    tenant_slug?: string;
    organization_id: string;
  };
  window_days: number;
  objectives: ObjectiveProgress[];
  purpose_missing: boolean;
  kr_trends: ImprovementKrTrend[];
  operations: Record<string, number>;
  outcomes: ImprovementOutcomeSummary;
  cost: ImprovementCostSection;
  candidates: ImprovementCandidate[];
}

export interface ImprovementScanInput {
  organizationId: string;
  tier: OrganizationTier;
  tenantSlug?: string;
  windowDays?: number;
  maxCandidates?: number;
}

export interface ImprovementScanDeps {
  rootDir?: string;
  now?: () => Date;
  loadPurpose?: typeof loadOrganizationPurpose;
  readOrgKrRows?: (scope: ObjectiveProgressScope) => KrMeasurementRow[];
  readOutcomeRows?: (charter: DotCharter) => DotOutcomeRow[];
  listCharters?: (rootDir: string) => DotCharter[];
  costReport?: OrganizationCostMetricsDeps['loadReport'];
  readOperations?: (scope: ImprovementScanInput, rootDir: string) => Record<string, number>;
}

function defaultOrgKrRows(rootDir: string | undefined, sinceMs: number) {
  return (scope: ObjectiveProgressScope): KrMeasurementRow[] => {
    const rel = orgKrLedgerPath(scope);
    const abs = rootDir ? path.join(rootDir, rel) : pathResolver.resolve(rel);
    if (!safeExistsSync(abs)) return [];
    return readJsonLinesSince<KrMeasurementRow>(abs, {
      onMalformed: 'skip',
      sinceMs,
      timeOf: (row) => Date.parse(row.measured_at),
    });
  };
}

function defaultOutcomeRows(rootDir: string | undefined, sinceMs: number) {
  return (charter: DotCharter): DotOutcomeRow[] => {
    const rel = dotStatePath(charter, DOT_OUTCOMES_FILE);
    const abs = rootDir ? path.join(rootDir, rel) : pathResolver.resolve(rel);
    if (!safeExistsSync(abs)) return [];
    return readJsonLinesSince<DotOutcomeRow>(abs, {
      onMalformed: 'skip',
      sinceMs,
      timeOf: (row) => Date.parse(row.measured_at),
    });
  };
}

function defaultOperations(scope: ImprovementScanInput, rootDir: string): Record<string, number> {
  const query = {
    organizationId: scope.organizationId,
    tier: scope.tier,
    tenantSlug: scope.tenantSlug,
    rootDir,
  };
  return {
    overdue_operations: listOrganizationOperationStates(query).filter(
      (row) => row.due_status === 'overdue'
    ).length,
    open_incidents: listOrganizationIncidents(query).filter(
      (row) => row.status !== 'resolved' && row.status !== 'closed'
    ).length,
    pending_decisions: listOrganizationDecisions(query).filter(
      (row) => row.status === 'proposed' || row.status === 'pending_approval'
    ).length,
    unhealthy_services: listOrganizationServiceStates(query).filter(
      (row) => row.health === 'degraded' || row.health === 'critical'
    ).length,
  };
}

function candidateId(ruleId: string, ...parts: Array<string | undefined>): string {
  const hash = createHash('sha256')
    .update([ruleId, ...parts.map((p) => p ?? '-')].join('|'))
    .digest('hex')
    .slice(0, 12);
  return `imp-${hash}`;
}

function candidate(
  ruleId: string,
  targetKind: ImprovementTargetKind,
  title: string,
  summary: string,
  evidenceRefs: string[],
  expected: ImprovementExpectedEffect,
  score: number,
  ...idParts: Array<string | undefined>
): ImprovementCandidate {
  return {
    candidate_id: candidateId(ruleId, ...idParts),
    rule_id: ruleId,
    target_kind: targetKind,
    title,
    summary,
    evidence_refs: evidenceRefs,
    expected_kr_effect: expected,
    priority_score: Math.round(Math.min(1, Math.max(0, score)) * 1000) / 1000,
    status: 'proposed',
  };
}

function krTrends(rows: KrMeasurementRow[], organizationId: string): ImprovementKrTrend[] {
  const groups = new Map<string, KrMeasurementRow[]>();
  for (const row of rows) {
    if (row.scope !== 'org') continue;
    if (row.organization_id && row.organization_id !== organizationId) continue;
    if (!Number.isFinite(row.value) || !Number.isFinite(row.progress)) continue;
    if (!Number.isFinite(Date.parse(row.measured_at))) continue;
    const key = `${row.objective_id ?? ''}\u0000${row.kr_id}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const trends: ImprovementKrTrend[] = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => a.measured_at.localeCompare(b.measured_at));
    const latest = sorted[sorted.length - 1];
    const sample = sorted.slice(-STAGNANT_SAMPLE_COUNT);
    const stagnant =
      sample.length >= 2 ? sample[sample.length - 1].progress <= sample[0].progress : false;
    trends.push({
      ...(latest.objective_id ? { objective_id: latest.objective_id } : {}),
      kr_id: latest.kr_id,
      latest_progress: latest.progress,
      latest_value: latest.value,
      measurements: sorted.length,
      stagnant,
      last_measured_at: latest.measured_at,
    });
  }
  return trends.sort((a, b) => a.kr_id.localeCompare(b.kr_id));
}

const KNOWN_VERDICTS = new Set(['improved', 'no_change', 'regressed', 'unmeasurable']);

function outcomeSummary(
  charters: DotCharter[],
  readRows: (charter: DotCharter) => DotOutcomeRow[],
  sinceMs: number
): ImprovementOutcomeSummary {
  const counts = { improved: 0, no_change: 0, regressed: 0, unmeasurable: 0 };
  const streaks = new Map<
    string,
    { dot_id: string; ref: string; streak: number; unmeasurable_only: boolean }
  >();
  let dotsObserved = 0;
  for (const charter of charters) {
    const rows = readRows(charter);
    const inWindow = rows
      .filter(
        (row) => KNOWN_VERDICTS.has(row.verdict) && Date.parse(row.measured_at ?? '') >= sinceMs
      )
      .sort((a, b) => (a.measured_at ?? '').localeCompare(b.measured_at ?? ''));
    // dots_observed counts charters with outcomes inside the report window.
    if (inWindow.length === 0) continue;
    dotsObserved += 1;
    for (const row of inWindow) counts[row.verdict] += 1;
    // Consecutive non-improving tail per (kr_id|signal) within the window.
    const byRef = new Map<string, DotOutcomeRow[]>();
    for (const row of inWindow) {
      const ref = row.ref.kr_id ?? row.ref.signal;
      if (!ref) continue;
      byRef.set(ref, [...(byRef.get(ref) ?? []), row]);
    }
    for (const [ref, refRows] of byRef) {
      const tail: DotOutcomeRow[] = [];
      for (let i = refRows.length - 1; i >= 0; i -= 1) {
        if (refRows[i].verdict === 'improved') break;
        tail.push(refRows[i]);
      }
      if (tail.length >= 2)
        streaks.set(`${charter.dot_id}|${ref}`, {
          dot_id: charter.dot_id,
          ref,
          streak: tail.length,
          unmeasurable_only: tail.every((row) => row.verdict === 'unmeasurable'),
        });
    }
  }
  return {
    dots_observed: dotsObserved,
    ...counts,
    non_improving_streaks: [...streaks.values()],
  };
}

function topBuckets(
  report: CostReport,
  buckets: 'by_model' | 'by_mission',
  limit: number
): Array<{ key: string; cost_usd: number; calls: number }> {
  return report[buckets]
    .slice()
    .sort((a, b) => b.cost_usd - a.cost_usd)
    .slice(0, limit)
    .map((bucket) => ({ key: bucket.key, cost_usd: bucket.cost_usd, calls: bucket.calls }));
}

function costSection(
  scope: ImprovementScanInput,
  windowDays: number,
  deps: ImprovementScanDeps
): ImprovementCostSection {
  const current = organizationCostMetrics(
    {
      organizationId: scope.organizationId,
      tenantSlug: scope.tenantSlug,
      tier: scope.tier,
    },
    windowDays,
    { loadReport: deps.costReport, now: deps.now }
  );
  const priorUntil = current.since;
  const priorSince = new Date(Date.parse(priorUntil) - windowDays * DAY_MS).toISOString();
  const scopeFilter = {
    ...(scope.organizationId ? { organization_id: scope.organizationId } : {}),
    ...(scope.tenantSlug ? { tenant_slug: scope.tenantSlug } : {}),
  };
  const load = deps.costReport ?? buildCostReportFromHistory;
  // Baseline is the visible total in the same tenant scope (operator-wide when
  // no tenant is given). "Unattributed" means rows with NO organization_id —
  // the report's `(no organization)` bucket — never spend scoped to other orgs.
  const unscoped = load({
    since: current.since,
    until: current.until,
    // include_untenanted: rows missing tenant scope belong to this baseline —
    // they are the very signal the unattributed measure looks for.
    ...(scope.tenantSlug
      ? { scopeFilter: { tenant_slug: scope.tenantSlug, include_untenanted: true } }
      : {}),
  });
  const unattributedUsd =
    unscoped?.by_organization.find((bucket) => bucket.key === '(no organization)')?.cost_usd ?? 0;
  const unattributedSharePct =
    unscoped && unscoped.total_usd > 0
      ? Math.round((unattributedUsd / unscoped.total_usd) * 1000) / 10
      : null;
  let prior: ImprovementCostSection['prior'] = null;
  {
    const priorReport = load({
      since: priorSince,
      until: priorUntil,
      ...(Object.keys(scopeFilter).length > 0 ? { scopeFilter } : {}),
    });
    const priorTokens = priorReport.by_model.reduce(
      (sum, b) =>
        sum +
        b.prompt_tokens +
        b.completion_tokens +
        b.cache_read_tokens +
        b.cache_write_tokens +
        b.cache_write_1h_tokens,
      0
    );
    prior = {
      cost_usd: priorReport.total_usd,
      llm_tokens: priorTokens,
      llm_calls: priorReport.calls,
    };
  }
  const costDeltaPct =
    prior && prior.cost_usd > 0
      ? ((current.cost_usd - prior.cost_usd) / prior.cost_usd) * 100
      : null;
  const report = current.report;
  const topModels = topBuckets(report, 'by_model', 3).map((row) => ({
    model: row.key,
    cost_usd: row.cost_usd,
    share_pct: report.total_usd > 0 ? (row.cost_usd / report.total_usd) * 100 : 0,
    calls: row.calls,
  }));
  const topMissions = topBuckets(report, 'by_mission', 3).map((row) => ({
    mission_id: row.key,
    cost_usd: row.cost_usd,
    calls: row.calls,
  }));
  return {
    window_days: windowDays,
    current: {
      since: current.since,
      until: current.until,
      cost_usd: current.cost_usd,
      llm_tokens: current.llm_tokens,
      llm_calls: current.llm_calls,
      unknown_cost_calls: current.unknown_cost_calls,
      cost_complete: current.cost_complete,
      withheld_partitions: current.withheld_partitions,
    },
    prior,
    cost_delta_pct: costDeltaPct === null ? null : Math.round(costDeltaPct * 10) / 10,
    unscoped_total_usd: unscoped?.total_usd ?? current.cost_usd,
    unattributed_usd: Math.round(unattributedUsd * 100) / 100,
    unattributed_share_pct: unattributedSharePct,
    unscoped_withheld_partitions: unscoped?.withheld_partitions ?? 0,
    top_models: topModels,
    top_missions: topMissions,
  };
}

/**
 * Runs the scan. `readOnly` is implied — this function never writes; the
 * pipeline op decides whether the report lands as a scoped artifact.
 */
export function runOrganizationImprovementScan(
  input: ImprovementScanInput,
  deps: ImprovementScanDeps = {}
): OrganizationImprovementScanReport {
  const rootDir = deps.rootDir ?? pathResolver.rootDir();
  const now = deps.now?.() ?? new Date();
  const windowDays =
    Number.isFinite(input.windowDays) && (input.windowDays ?? 0) > 0
      ? Math.min(input.windowDays ?? DEFAULT_WINDOW_DAYS, 90)
      : DEFAULT_WINDOW_DAYS;
  const sinceMs = now.getTime() - windowDays * DAY_MS;
  // Ledger horizon covers the window plus a prior reference so trend/stall
  // rules can compare against earlier measurements without whole-file reads.
  const ledgerSinceMs = now.getTime() - Math.max(windowDays * 2, 90) * DAY_MS;
  const scope: ObjectiveProgressScope = {
    organizationId: input.organizationId,
    tier: input.tier,
    ...(input.tenantSlug ? { tenantSlug: input.tenantSlug } : {}),
  };
  const readRows = deps.readOrgKrRows ?? defaultOrgKrRows(deps.rootDir, ledgerSinceMs);
  const readOutcomes = deps.readOutcomeRows ?? defaultOutcomeRows(deps.rootDir, ledgerSinceMs);
  const charters = (
    deps.listCharters ?? ((root) => listDotCharters(root, { errors: [] }).map((l) => l.charter))
  )(rootDir);
  // Active + paused charters only (same precedent as the wake scheduler):
  // draft/archived dots' ledgers must not feed outcome streak candidates.
  const orgDots = charters.filter(
    (c) =>
      (c.status === 'active' || c.status === 'paused') &&
      c.scope.organization_id === input.organizationId &&
      c.scope.tier === input.tier &&
      (c.scope.tenant_slug ?? undefined) === (input.tenantSlug ?? undefined)
  );

  const purpose = (deps.loadPurpose ?? loadOrganizationPurpose)(input.organizationId, {
    tier: input.tier,
    tenantSlug: input.tenantSlug,
    rootDir,
  });
  const progress = rollUpObjectiveProgress(scope, {
    loadPurpose: () => purpose,
    readMeasurements: readRows,
  });
  const trends = krTrends(readRows(scope), input.organizationId);
  const operations = (deps.readOperations ?? defaultOperations)(input, rootDir);
  const outcomes = outcomeSummary(orgDots, readOutcomes, sinceMs);
  const cost = costSection(input, windowDays, deps);
  const orgRef = `organization:${input.organizationId}`;

  const candidates: ImprovementCandidate[] = [];
  for (const objective of progress.objectives) {
    if (objective.unmeasured_krs.length > 0) {
      const total = objective.key_results.length || objective.unmeasured_krs.length;
      candidates.push(
        candidate(
          'unmeasured-kr',
          'kr_definition',
          `KR未測定: ${objective.title}`,
          `objective ${objective.objective_id} の KR ${objective.unmeasured_krs.join(', ')} が未測定。メトリクスを配備するか manual 記録に切り替える。`, // i18n-exempt: improvement report candidates are fixed-locale ja text (org-facing deliverable)
          [`${orgRef}/objectives/${objective.objective_id}`, `${orgRef}/org-kr-ledger`],
          {
            objective_id: objective.objective_id,
            metric: 'measurement_coverage',
            direction: 'increase',
            note: `unmeasured: ${objective.unmeasured_krs.join(',')}`,
          },
          0.8 * Math.min(1, objective.unmeasured_krs.length / Math.max(total, 1)),
          objective.objective_id
        )
      );
    }
    const trend = trends.find((t) => t.objective_id === objective.objective_id && t.stagnant);
    // Stall requires trend evidence: a fully-measured objective ramping below
    // 50% on improving KRs is not "stalled" — progress<0.5 alone must not fire.
    if (objective.progress !== undefined && objective.progress < 0.5 && trend) {
      candidates.push(
        candidate(
          'stalled-objective',
          'process',
          `目的停滞: ${objective.title}`,
          `objective ${objective.objective_id} の progress=${objective.progress.toFixed(2)} で直近測定が非改善。担当ロールと実行経路を retro で見直す。`, // i18n-exempt: improvement report candidates are fixed-locale ja text (org-facing deliverable)
          [`${orgRef}/objectives/${objective.objective_id}`, `${orgRef}/org-kr-ledger`],
          {
            objective_id: objective.objective_id,
            metric: 'objective_progress',
            direction: 'increase',
          },
          0.9 * (1 - objective.progress),
          objective.objective_id
        )
      );
    }
  }
  const purposeMissing =
    !purpose || purpose.approval_state !== 'approved' || progress.objectives.length === 0;
  if (purposeMissing) {
    const purposeReason = !purpose
      ? 'purpose record なし' // i18n-exempt: improvement report candidates are fixed-locale ja text (org-facing deliverable)
      : purpose.approval_state !== 'approved'
        ? `approval_state=${purpose.approval_state}`
        : 'objectives が 0 件'; // i18n-exempt: improvement report candidates are fixed-locale ja text (org-facing deliverable)
    candidates.push(
      candidate(
        'purpose-missing',
        'process',
        '組織目的が未宣言または未承認', // i18n-exempt: improvement report candidates are fixed-locale ja text (org-facing deliverable)
        `${purposeReason}。purpose record を approved へ進め、KR 付き objectives を宣言する。`, // i18n-exempt: improvement report candidates are fixed-locale ja text (org-facing deliverable)
        [`${orgRef}/purpose`],
        { metric: 'measurement_coverage', direction: 'increase' },
        0.95,
        input.organizationId
      )
    );
  }
  for (const streak of outcomes.non_improving_streaks) {
    candidates.push(
      candidate(
        streak.unmeasurable_only ? 'unmeasurable-streak' : 'regressed-streak',
        streak.unmeasurable_only ? 'measurement' : 'runbook',
        streak.unmeasurable_only
          ? `測定不能ストリーク: ${streak.ref}` // i18n-exempt: improvement report candidates are fixed-locale ja text (org-facing deliverable)
          : `非改善ストリーク: ${streak.ref}`, // i18n-exempt: improvement report candidates are fixed-locale ja text (org-facing deliverable)
        streak.unmeasurable_only
          ? `dot ${streak.dot_id} の ${streak.ref} が直近 ${streak.streak} 件連続で verdict=unmeasurable。実行ではなく計測系の欠陥 — expected_effect の KR 配線か測定ウィンドウを見直す。` // i18n-exempt: improvement report candidates are fixed-locale ja text (org-facing deliverable)
          : `dot ${streak.dot_id} の ${streak.ref} が直近 ${streak.streak} 件連続で非改善。仮説・ツール・分解の見直しを次 wake で要求済み — runbook/SOP の更新候補。`, // i18n-exempt: improvement report candidates are fixed-locale ja text (org-facing deliverable)
        [`dot:${streak.dot_id}/outcomes`, `${orgRef}/learning`],
        {
          kr_id: streak.ref,
          metric: 'outcome_verdicts',
          direction: 'increase',
          note: `${streak.streak} consecutive non-improving`,
        },
        0.7 * Math.min(1, streak.streak / 3),
        streak.dot_id,
        streak.ref
      )
    );
  }
  // Prior=0 with new spend is an increase too — pct delta is undefined then.
  const costIncreased =
    (cost.cost_delta_pct !== null && cost.cost_delta_pct > 20) ||
    (cost.cost_delta_pct === null &&
      (cost.prior?.cost_usd ?? 0) === 0 &&
      cost.current.cost_usd > 0);
  if (costIncreased && progress.objectives.every((o) => (o.progress ?? 0) <= 0.5)) {
    const deltaLabel =
      cost.cost_delta_pct !== null ? `+${cost.cost_delta_pct}%` : 'new spend (prior 0)';
    candidates.push(
      candidate(
        'cost-up-progress-flat',
        'cost',
        `コスト増だが進捗なし (${deltaLabel})`, // i18n-exempt: improvement report candidates are fixed-locale ja text (org-facing deliverable)
        `直近 ${windowDays}d のコストが前期比 ${deltaLabel} (${cost.current.cost_usd} USD / ${cost.current.llm_calls} calls)。objective progress は停滞。モデルルーティング・コンテキスト経済・キャッシュ利用を見直す。`, // i18n-exempt: improvement report candidates are fixed-locale ja text (org-facing deliverable)
        ['work/metrics/execution-metrics.jsonl', `${orgRef}/objectives`],
        { metric: 'cost_usd', direction: 'decrease' },
        0.75 * Math.min(1, (cost.cost_delta_pct ?? 50) / 100),
        'cost-trend'
      )
    );
  }
  if (cost.current.llm_calls > 0 && cost.current.unknown_cost_calls > 0) {
    candidates.push(
      candidate(
        'unknown-cost-evidence',
        'measurement',
        `価格エビデンス欠落: ${cost.current.unknown_cost_calls} calls`, // i18n-exempt: improvement report candidates are fixed-locale ja text (org-facing deliverable)
        `${cost.current.llm_calls} calls 中 ${cost.current.unknown_cost_calls} 件が cost_status=unknown (model-cost-registry 未掲載モデル等)。コストレポートが実際より安く見える。レジストリ整備または provider 報告の修復が必要。`, // i18n-exempt: improvement report candidates are fixed-locale ja text (org-facing deliverable)
        [
          'work/metrics/execution-metrics.jsonl',
          'knowledge/product/governance/model-cost-registry.json',
        ],
        { metric: 'unknown_cost_calls', direction: 'decrease' },
        0.6 * Math.min(1, cost.current.unknown_cost_calls / cost.current.llm_calls),
        'cost-evidence'
      )
    );
  }
  if (
    cost.unattributed_share_pct !== null &&
    cost.unattributed_share_pct >= 50 &&
    cost.unscoped_total_usd > 0
  ) {
    candidates.push(
      candidate(
        'cost-unattributed',
        'measurement',
        `コスト帰属不明: ${cost.unattributed_share_pct.toFixed(0)}% (${cost.unattributed_usd} USD) が organization_id 未付与`, // i18n-exempt: improvement report candidates are fixed-locale ja text (org-facing deliverable)
        `同期間の総コスト ${cost.unscoped_total_usd} USD のうち ${cost.unattributed_usd} USD が organization_id 未付与の行。usage ledger の scope 付与が欠落しており、目的あたりのコスト評価が構造的に見えない。mission/task 実行時の scope 伝播を確認する。`, // i18n-exempt: improvement report candidates are fixed-locale ja text (org-facing deliverable)
        ['work/metrics/execution-metrics.jsonl', 'libs/core/finance/usage-accounting.ts'],
        { metric: 'cost_attribution_coverage', direction: 'increase' },
        0.65 * Math.min(1, cost.unattributed_share_pct / 100),
        'cost-attribution'
      )
    );
  }
  const topModel = cost.top_models[0];
  if (topModel && cost.current.llm_calls >= 20 && topModel.share_pct > 60) {
    candidates.push(
      candidate(
        'model-concentration',
        'cost',
        `モデル集中: ${topModel.model} ${topModel.share_pct.toFixed(0)}%`, // i18n-exempt: improvement report candidates are fixed-locale ja text (org-facing deliverable)
        `コストの ${topModel.share_pct.toFixed(1)}% が ${topModel.model} (${topModel.calls} calls)。単純 shape のルーティング先(安価モデル/キャッシュ)を検討。`, // i18n-exempt: improvement report candidates are fixed-locale ja text (org-facing deliverable)
        ['work/metrics/execution-metrics.jsonl'],
        { metric: 'cost_usd', direction: 'decrease', note: `top model ${topModel.model}` },
        0.5 * Math.min(1, Math.max(0, (topModel.share_pct - 60) / 40)),
        'model-mix'
      )
    );
  }
  if (operations.pending_decisions > 0) {
    candidates.push(
      candidate(
        'pending-decisions',
        'process',
        `判断待ち ${operations.pending_decisions} 件`, // i18n-exempt: improvement report candidates are fixed-locale ja text (org-facing deliverable)
        `未決の organization decisions が ${operations.pending_decisions} 件滞留。standup でオーナー承認へ提示する導線を確認。`, // i18n-exempt: improvement report candidates are fixed-locale ja text (org-facing deliverable)
        [`${orgRef}/decisions`],
        { metric: 'pending_decisions', direction: 'decrease' },
        0.4 * Math.min(1, operations.pending_decisions / 5),
        'decisions'
      )
    );
  }
  if (cost.current.withheld_partitions > 0) {
    candidates.push(
      candidate(
        'cost-scope-withheld',
        'measurement',
        `コスト集計が不完全: ${cost.current.withheld_partitions} partitions withheld`, // i18n-exempt: improvement report candidates are fixed-locale ja text (org-facing deliverable)
        `この読み手には ${cost.current.withheld_partitions} 個の usage partition が見えていない。コスト評価は過小評価。テナント権限付きリーダーでの再実行が必要。`, // i18n-exempt: improvement report candidates are fixed-locale ja text (org-facing deliverable)
        ['work/metrics/'],
        { metric: 'measurement_coverage', direction: 'increase' },
        0.5,
        'cost-scope'
      )
    );
  }

  const maxCandidates = Math.max(1, Math.min(input.maxCandidates ?? 20, 100));
  const ranked = candidates
    .sort(
      (a, b) => b.priority_score - a.priority_score || a.candidate_id.localeCompare(b.candidate_id)
    )
    .slice(0, maxCandidates);

  const reportId = candidateId(
    'report',
    input.organizationId,
    now.toISOString().slice(0, 16)
  ).replace('imp-', 'scan-');
  return {
    version: '1',
    report_id: reportId,
    generated_at: now.toISOString(),
    scope: {
      tier: input.tier,
      ...(input.tenantSlug ? { tenant_slug: input.tenantSlug } : {}),
      organization_id: input.organizationId,
    },
    window_days: windowDays,
    objectives: progress.objectives,
    purpose_missing: purposeMissing,
    kr_trends: trends,
    operations,
    outcomes,
    cost,
    candidates: ranked,
  };
}
