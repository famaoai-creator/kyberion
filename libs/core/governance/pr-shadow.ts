import * as path from 'node:path';
import { isVitestProcess } from '../foundation/env.js';
import { appendJsonLine, readJsonLines } from '../foundation/json.js';
import { createLogger } from '../logger.js';
import * as pathResolver from '../path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeMkdir } from '../secure-io.js';
import { evaluateAutonomousOpsAction, matchHighRiskPaths } from './autonomous-ops-gate.js';

const logger = createLogger('pr-shadow');

/**
 * Autonomous-operation P2 in shadow mode: watch every pull request, say what the
 * autonomy gate WOULD do with it, and later compare that with what the operator
 * actually did. Nothing here merges, comments or changes a PR — it reads and
 * records. The comparison is the evidence for deciding, per risk tier, when the
 * `pr_merge_*` actions can leave shadow mode (see the plan's "試行モード").
 *
 * The safety number is the false positive: a PR the gate would have auto-merged
 * (low or medium tier, CI green) that the operator closed instead of merging.
 */

export type PrRiskTier = 'low' | 'medium' | 'high';
export type PrCiState = 'success' | 'failure' | 'pending' | 'none';

export interface PrFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface PrSummary {
  number: number;
  title: string;
  headSha: string;
  isDraft: boolean;
  author?: string;
}

export interface PrFinalState {
  state: 'open' | 'merged' | 'closed';
  at?: string;
}

/** Read-only view of GitHub; the real one shells out to `gh`, tests pass a fake. */
export interface PrReadPort {
  listOpen(): PrSummary[];
  files(prNumber: number): PrFile[];
  ciState(
    prNumber: number,
    ignoredChecks: readonly string[]
  ): { state: PrCiState; failing: string[] };
  finalState(prNumber: number): PrFinalState;
}

/** Tests, docs, changelog fragments and retired code: low risk when nothing else changes. */
export const LOW_RISK_GLOBS: readonly string[] = [
  '**/*.test.ts',
  '**/*.test.tsx',
  'tests/**',
  'tests_ai/**',
  'docs/**',
  'changelog.d/**',
  'retired/**',
];

/**
 * Checks that say nothing about the change itself. `github-advanced-security`
 * fails whenever the Copilot code-scanning quota is exhausted (HTTP 402), which
 * would otherwise make "CI green" unreachable and every PR look blocked.
 */
export const DEFAULT_IGNORED_CHECKS: readonly string[] = ['github-advanced-security'];

export interface PrClassification {
  tier: PrRiskTier;
  actionId: 'pr_merge_low' | 'pr_merge_medium';
  gateDecision: 'auto' | 'notify' | 'approve';
  vetoWindowMinutes?: number;
  escalations: string[];
  highRiskMatches: string[];
  filesChanged: number;
  linesChanged: number;
}

export function classifyPullRequest(files: readonly PrFile[]): PrClassification {
  const paths = files.map((file) => file.path);
  const lowMatches = matchHighRiskPaths(paths, LOW_RISK_GLOBS);
  const lowOnly = paths.length > 0 && lowMatches.length === paths.length;
  const actionId = lowOnly ? 'pr_merge_low' : 'pr_merge_medium';
  const gate = evaluateAutonomousOpsAction({ actionId, changedPaths: paths });
  const highRisk = gate.highRiskPathMatches.length > 0 || gate.decision === 'approve';
  return {
    tier: highRisk ? 'high' : lowOnly ? 'low' : 'medium',
    actionId,
    gateDecision: gate.decision,
    ...(gate.vetoWindowMinutes ? { vetoWindowMinutes: gate.vetoWindowMinutes } : {}),
    escalations: gate.escalations,
    highRiskMatches: gate.highRiskPathMatches,
    filesChanged: files.length,
    linesChanged: files.reduce((sum, file) => sum + file.additions + file.deletions, 0),
  };
}

export interface PrObservation {
  kind: 'observation';
  ts: string;
  pr: number;
  head_sha: string;
  title: string;
  tier: PrRiskTier;
  gate_decision: PrClassification['gateDecision'];
  veto_window_minutes?: number;
  escalations: string[];
  high_risk_matches: string[];
  files_changed: number;
  lines_changed: number;
  ci: PrCiState;
  failing_checks: string[];
  /** The gate's own evidence rule (`cross_provider_review`) cannot be observed yet. */
  evidence_gaps: string[];
  /** Tier says no human is needed and CI is green; only the missing review evidence stands in the way. */
  would_auto_merge_if_reviewed: boolean;
}

export interface PrOutcome {
  kind: 'outcome';
  ts: string;
  pr: number;
  state: 'merged' | 'closed';
  at?: string;
}

export type PrShadowRecord = PrObservation | PrOutcome;

export function buildObservation(
  pr: PrSummary,
  classification: PrClassification,
  ci: { state: PrCiState; failing: string[] },
  now: Date = new Date()
): PrObservation {
  return {
    kind: 'observation',
    ts: now.toISOString(),
    pr: pr.number,
    head_sha: pr.headSha,
    title: pr.title.slice(0, 120),
    tier: classification.tier,
    gate_decision: classification.gateDecision,
    ...(classification.vetoWindowMinutes
      ? { veto_window_minutes: classification.vetoWindowMinutes }
      : {}),
    escalations: classification.escalations,
    high_risk_matches: classification.highRiskMatches.slice(0, 10),
    files_changed: classification.filesChanged,
    lines_changed: classification.linesChanged,
    ci: ci.state,
    failing_checks: ci.failing.slice(0, 10),
    evidence_gaps: ['cross_provider_review'],
    would_auto_merge_if_reviewed:
      classification.gateDecision !== 'approve' && ci.state === 'success',
  };
}

let configuredRoot: string | null | undefined;

/** Point the ledger elsewhere (tests); `null` disables it. Under vitest it writes nothing by default. */
export function configurePrShadowRoot(root: string | null | undefined): void {
  configuredRoot = root;
}

function ledgerFile(): string | null {
  const root =
    configuredRoot !== undefined
      ? configuredRoot
      : isVitestProcess()
        ? null
        : pathResolver.shared('runtime/pr-shadow');
  if (!root) return null;
  if (!safeExistsSync(root)) safeMkdir(root, { recursive: true });
  return assertSafeRepositoryPath(path.join(root, 'ledger.jsonl'), { allowMissingLeaf: true });
}

export function listPrShadowRecords(): PrShadowRecord[] {
  const file = ledgerFile();
  if (!file) return [];
  return readJsonLines<PrShadowRecord>(file, {
    onMalformed: 'skip',
    map: (value) => value as PrShadowRecord,
  }).filter((record) => record && (record.kind === 'observation' || record.kind === 'outcome'));
}

export function appendPrShadowRecord(record: PrShadowRecord): boolean {
  try {
    const file = ledgerFile();
    if (!file) return false;
    appendJsonLine(file, record);
    return true;
  } catch (error) {
    logger.warn(
      `pr shadow record not written — ${error instanceof Error ? error.message : String(error)} | next: check active/shared/runtime/pr-shadow is writable`
    );
    return false;
  }
}

export interface ObserveResult {
  observed: number;
  unchanged: number;
  outcomes: number;
  skippedDrafts: number;
  errors: string[];
}

function sameObservation(a: PrObservation, b: PrObservation): boolean {
  return (
    a.head_sha === b.head_sha &&
    a.tier === b.tier &&
    a.ci === b.ci &&
    a.gate_decision === b.gate_decision
  );
}

/**
 * One observation pass: record each open PR whose picture changed (new head,
 * tier or CI state), then settle every earlier-observed PR that has since been
 * merged or closed. Read-only toward GitHub; never throws for one bad PR.
 */
export function observePullRequests(
  port: PrReadPort,
  options: { ignoredChecks?: readonly string[]; now?: Date } = {}
): ObserveResult {
  const now = options.now ?? new Date();
  const ignored = options.ignoredChecks ?? DEFAULT_IGNORED_CHECKS;
  const result: ObserveResult = {
    observed: 0,
    unchanged: 0,
    outcomes: 0,
    skippedDrafts: 0,
    errors: [],
  };
  const records = listPrShadowRecords();
  const lastObservation = new Map<number, PrObservation>();
  const settled = new Set<number>();
  for (const record of records) {
    if (record.kind === 'observation') lastObservation.set(record.pr, record);
    else settled.add(record.pr);
  }

  const openNow = new Set<number>();
  for (const pr of port.listOpen()) {
    openNow.add(pr.number);
    if (pr.isDraft) {
      result.skippedDrafts += 1;
      continue;
    }
    try {
      const observation = buildObservation(
        pr,
        classifyPullRequest(port.files(pr.number)),
        port.ciState(pr.number, ignored),
        now
      );
      const previous = lastObservation.get(pr.number);
      if (previous && sameObservation(previous, observation)) {
        result.unchanged += 1;
        continue;
      }
      if (appendPrShadowRecord(observation)) result.observed += 1;
    } catch (error) {
      result.errors.push(
        `#${pr.number}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  for (const prNumber of lastObservation.keys()) {
    if (settled.has(prNumber) || openNow.has(prNumber)) continue;
    try {
      const final = port.finalState(prNumber);
      if (final.state === 'open') continue;
      const outcome: PrOutcome = {
        kind: 'outcome',
        ts: now.toISOString(),
        pr: prNumber,
        state: final.state,
        ...(final.at ? { at: final.at } : {}),
      };
      if (appendPrShadowRecord(outcome)) result.outcomes += 1;
    } catch (error) {
      result.errors.push(`#${prNumber}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}

export interface TierAgreement {
  tier: PrRiskTier;
  /** PRs with a recorded outcome. */
  settled: number;
  merged: number;
  closed: number;
  /** Gate would have auto-merged (given review evidence) and the operator merged: agreement. */
  agreed: number;
  /** Gate would have auto-merged, the operator did not merge: the dangerous disagreement. */
  false_positive: number;
  /** Operator merged although CI was not green at the last look. */
  merged_despite_ci: number;
}

export interface PrShadowSummary {
  observed_prs: number;
  settled_prs: number;
  by_tier: TierAgreement[];
  /** Per tier: how far from the suggested bar for leaving shadow mode. Advice only. */
  readiness: Record<PrRiskTier, string>;
}

export const SHADOW_EXIT_MIN_SAMPLES = 30;

export function summarizePrShadow(records: readonly PrShadowRecord[]): PrShadowSummary {
  const lastObservation = new Map<number, PrObservation>();
  const outcome = new Map<number, PrOutcome>();
  for (const record of records) {
    if (record.kind === 'observation') lastObservation.set(record.pr, record);
    else outcome.set(record.pr, record);
  }
  const tiers = new Map<PrRiskTier, TierAgreement>();
  const row = (tier: PrRiskTier): TierAgreement => {
    const existing = tiers.get(tier);
    if (existing) return existing;
    const created: TierAgreement = {
      tier,
      settled: 0,
      merged: 0,
      closed: 0,
      agreed: 0,
      false_positive: 0,
      merged_despite_ci: 0,
    };
    tiers.set(tier, created);
    return created;
  };
  for (const [pr, observation] of lastObservation) {
    const final = outcome.get(pr);
    if (!final) continue;
    const entry = row(observation.tier);
    entry.settled += 1;
    if (final.state === 'merged') entry.merged += 1;
    else entry.closed += 1;
    if (observation.would_auto_merge_if_reviewed) {
      if (final.state === 'merged') entry.agreed += 1;
      else entry.false_positive += 1;
    } else if (final.state === 'merged' && observation.ci !== 'success') {
      entry.merged_despite_ci += 1;
    }
  }
  const order: PrRiskTier[] = ['low', 'medium', 'high'];
  const byTier = order.map((tier) => tiers.get(tier) ?? row(tier));
  const readiness = {} as Record<PrRiskTier, string>;
  for (const entry of byTier) {
    if (entry.tier === 'high') {
      readiness.high = 'always a human decision; never leaves shadow mode';
    } else if (entry.false_positive > 0) {
      readiness[entry.tier] =
        `not ready: ${entry.false_positive} false positive(s) — review them first`;
    } else if (entry.settled < SHADOW_EXIT_MIN_SAMPLES) {
      readiness[entry.tier] = `collecting: ${entry.settled}/${SHADOW_EXIT_MIN_SAMPLES} settled PRs`;
    } else {
      readiness[entry.tier] =
        `candidate: ${entry.settled} settled PRs, no false positive — decide whether to enable`;
    }
  }
  return {
    observed_prs: lastObservation.size,
    settled_prs: [...lastObservation.keys()].filter((pr) => outcome.has(pr)).length,
    by_tier: byTier,
    readiness,
  };
}
