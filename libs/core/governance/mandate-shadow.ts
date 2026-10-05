import * as path from 'node:path';
import { isVitestProcess } from '../foundation/env.js';
import { appendJsonLine, readJson, readJsonLines } from '../foundation/json.js';
import { createLogger } from '../logger.js';
import * as pathResolver from '../path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeMkdir } from '../secure-io.js';
import { matchHighRiskPaths } from './autonomous-ops-gate.js';

const logger = createLogger('mandate-shadow');

/**
 * Autonomous-operation P4 in shadow mode: for every mission brief that goes to
 * the operator for plan approval, record whether a standing mandate (包括委任)
 * WOULD have covered it, then compare with what the operator decided.
 *
 * This is record-only. It never approves, skips or alters the plan gate, which
 * stays `human_only`; it only produces the agreement evidence needed to decide
 * later whether `mission_start_mandate` may leave shadow mode. A mandate never
 * covers a brief unless every condition holds, and any doubt means "not covered".
 */

export interface StandingMandate {
  id: string;
  title: string;
  work_type_patterns: string[];
  allowed_path_globs: string[];
  max_risk_level: number;
  expires_at: string;
}

export interface MandateCatalog {
  version: string;
  external_effect_patterns: string[];
  mandates: StandingMandate[];
}

/** The slice of a mission brief the evaluator reads (a structural subset of MissionBrief). */
export interface MandateBriefInput {
  title?: string;
  intent?: string;
  tier?: string;
  deliverables?: string[];
  scope?: { in?: string[]; out?: string[] };
  flow?: Array<{ title?: string; detail?: string }>;
  gate?: { riskLevel?: string | number };
}

export interface MandateEvaluation {
  covered: boolean;
  mandate_id?: string;
  /** Why not covered (empty when covered), or what matched. */
  reasons: string[];
}

const CATALOG_REL = 'product/governance/standing-mandates.json';

export function loadMandateCatalog(): MandateCatalog {
  return readJson<MandateCatalog>(pathResolver.knowledge(CATALOG_REL));
}

function riskLevelOf(brief: MandateBriefInput): number {
  const level = brief.gate?.riskLevel;
  if (typeof level === 'number') return level;
  const parsed = typeof level === 'string' ? Number.parseInt(level, 10) : Number.NaN;
  if (Number.isFinite(parsed)) return parsed;
  // Unknown or word levels ("high", "critical") count as above any mandate's ceiling.
  return typeof level === 'string' && /^(low)$/iu.test(level.trim()) ? 1 : 99;
}

function textOf(brief: MandateBriefInput): string {
  return [
    brief.title,
    brief.intent,
    ...(brief.deliverables ?? []),
    ...(brief.flow ?? []).flatMap((step) => [step.title, step.detail]),
  ]
    .filter((part): part is string => typeof part === 'string')
    .join('\n')
    .toLowerCase();
}

/** Scope entries that name files or directories (everything else is prose). */
function pathScopeOf(brief: MandateBriefInput): string[] {
  return (brief.scope?.in ?? [])
    .map((entry) => entry.trim())
    .filter(
      (entry) => entry !== '' && /[/\\]|\.[a-z0-9]{1,5}$/iu.test(entry) && !/\s/u.test(entry)
    );
}

export function evaluateBriefAgainstMandates(
  brief: MandateBriefInput,
  options: { catalog?: MandateCatalog; now?: Date } = {}
): MandateEvaluation {
  const catalog = options.catalog ?? loadMandateCatalog();
  const now = (options.now ?? new Date()).getTime();
  const text = textOf(brief);
  const reasons: string[] = [];

  if (brief.tier === 'personal') reasons.push('personal tier is never delegated');
  const external = catalog.external_effect_patterns.filter((p) => text.includes(p.toLowerCase()));
  if (external.length) reasons.push(`external effect: ${external.join(', ')}`);
  const paths = pathScopeOf(brief);
  if (!paths.length) reasons.push('no file scope declared');
  if (reasons.length) return { covered: false, reasons };

  const level = riskLevelOf(brief);
  const candidates = catalog.mandates.filter((mandate) =>
    mandate.work_type_patterns.some((p) => text.includes(p.toLowerCase()))
  );
  if (!candidates.length) return { covered: false, reasons: ['no mandate matches the work type'] };

  const misses: string[] = [];
  for (const mandate of candidates) {
    if (Date.parse(mandate.expires_at) <= now) {
      misses.push(`${mandate.id}: expired`);
    } else if (level > mandate.max_risk_level) {
      misses.push(`${mandate.id}: risk level ${level} above ${mandate.max_risk_level}`);
    } else if (matchHighRiskPaths(paths, mandate.allowed_path_globs).length !== paths.length) {
      misses.push(`${mandate.id}: scope outside allowed paths`);
    } else {
      return { covered: true, mandate_id: mandate.id, reasons: [] };
    }
  }
  return { covered: false, reasons: misses };
}

export interface MandateObservation {
  kind: 'observation';
  ts: string;
  mission_id: string;
  covered: boolean;
  mandate_id?: string;
  reasons: string[];
}

export interface MandateOutcome {
  kind: 'outcome';
  ts: string;
  mission_id: string;
  verdict: 'approved' | 'rejected';
}

export type MandateShadowRecord = MandateObservation | MandateOutcome;

let configuredRoot: string | null | undefined;

/** Point the ledger elsewhere (tests); `null` disables it. Under vitest it writes nothing by default. */
export function configureMandateShadowRoot(root: string | null | undefined): void {
  configuredRoot = root;
}

function ledgerFile(): string | null {
  const root =
    configuredRoot !== undefined
      ? configuredRoot
      : isVitestProcess()
        ? null
        : pathResolver.shared('runtime/mandate-shadow');
  if (!root) return null;
  if (!safeExistsSync(root)) safeMkdir(root, { recursive: true });
  return assertSafeRepositoryPath(path.join(root, 'ledger.jsonl'), { allowMissingLeaf: true });
}

export function listMandateShadowRecords(): MandateShadowRecord[] {
  const file = ledgerFile();
  if (!file) return [];
  return readJsonLines<MandateShadowRecord>(file, {
    onMalformed: 'skip',
    map: (value) => value as MandateShadowRecord,
  }).filter((r) => r && (r.kind === 'observation' || r.kind === 'outcome'));
}

function append(record: MandateShadowRecord): boolean {
  try {
    const file = ledgerFile();
    if (!file) return false;
    appendJsonLine(file, record);
    return true;
  } catch (error) {
    logger.warn(
      `mandate shadow record not written — ${error instanceof Error ? error.message : String(error)} | next: check active/shared/runtime/mandate-shadow is writable`
    );
    return false;
  }
}

/** Record what a mandate would have done for this brief. Never throws; never changes the gate. */
export function observeMandateCoverage(
  missionId: string,
  brief: MandateBriefInput,
  now: Date = new Date()
): MandateEvaluation | null {
  try {
    const evaluation = evaluateBriefAgainstMandates(brief, { now });
    append({
      kind: 'observation',
      ts: now.toISOString(),
      mission_id: missionId,
      covered: evaluation.covered,
      ...(evaluation.mandate_id ? { mandate_id: evaluation.mandate_id } : {}),
      reasons: evaluation.reasons,
    });
    return evaluation;
  } catch (error) {
    logger.warn(
      `mandate coverage not evaluated — ${error instanceof Error ? error.message : String(error)} | next: check standing-mandates.json`
    );
    return null;
  }
}

/** Record the operator's decision once per mission, and only for missions that were observed. */
export function recordMandateOutcome(
  missionId: string,
  verdict: 'approved' | 'rejected',
  now: Date = new Date()
): boolean {
  try {
    const records = listMandateShadowRecords();
    if (!records.some((r) => r.kind === 'observation' && r.mission_id === missionId)) return false;
    if (records.some((r) => r.kind === 'outcome' && r.mission_id === missionId)) return false;
    return append({ kind: 'outcome', ts: now.toISOString(), mission_id: missionId, verdict });
  } catch {
    return false;
  }
}

export interface MandateShadowSummary {
  observed: number;
  settled: number;
  /** Covered and the operator approved. */
  agreed: number;
  /** Covered but the operator rejected: the dangerous disagreement. */
  false_positive: number;
  /** Not covered although the operator approved: lost coverage, harmless. */
  missed: number;
  by_mandate: Record<string, { agreed: number; false_positive: number }>;
  readiness: string;
}

export const MANDATE_EXIT_MIN_SAMPLES = 20;

export function summarizeMandateShadow(
  records: readonly MandateShadowRecord[]
): MandateShadowSummary {
  const observations = new Map<string, MandateObservation>();
  const outcomes = new Map<string, MandateOutcome>();
  for (const record of records) {
    if (record.kind === 'observation') observations.set(record.mission_id, record);
    else outcomes.set(record.mission_id, record);
  }
  const summary: MandateShadowSummary = {
    observed: observations.size,
    settled: 0,
    agreed: 0,
    false_positive: 0,
    missed: 0,
    by_mandate: {},
    readiness: '',
  };
  for (const [missionId, observation] of observations) {
    const outcome = outcomes.get(missionId);
    if (!outcome) continue;
    summary.settled += 1;
    if (observation.covered) {
      const row = (summary.by_mandate[observation.mandate_id ?? 'unknown'] ??= {
        agreed: 0,
        false_positive: 0,
      });
      if (outcome.verdict === 'approved') {
        summary.agreed += 1;
        row.agreed += 1;
      } else {
        summary.false_positive += 1;
        row.false_positive += 1;
      }
    } else if (outcome.verdict === 'approved') {
      summary.missed += 1;
    }
  }
  const covered = summary.agreed + summary.false_positive;
  summary.readiness =
    summary.false_positive > 0
      ? `blocked: ${summary.false_positive} covered mission(s) were rejected — narrow the mandate`
      : covered < MANDATE_EXIT_MIN_SAMPLES
        ? `${covered}/${MANDATE_EXIT_MIN_SAMPLES} covered missions settled, 0 false positives so far`
        : `bar met (${covered} covered missions, 0 false positives) — operator may decide to leave shadow mode`;
  return summary;
}
