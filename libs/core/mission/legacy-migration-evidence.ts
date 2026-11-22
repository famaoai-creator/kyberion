/**
 * Structural proof for the legacy_migration workflow gates.
 *
 * Design source: Reversa's migration team (sandeco/reversa) — paradigm
 * decision, rule-by-rule disposition (MIGRATE / DISCARD / HUMAN DECISION),
 * strategy choice, and parity specs that prove behavioral equivalence — bound
 * to a reverse_spec mission whose audit passed with purpose `rebuild`.
 */
import * as path from 'node:path';
import { parseSafeJsonObjectInput } from '../foundation/safe-json.js';
import { isRecord } from '../foundation/primitives.js';
import { findMissionPath } from '../path-resolver.js';
import { safeExistsSync, safeReadFile, safeStat } from '../secure-io.js';
import {
  readReverseSpecPurpose,
  readReverseSpecSpecIds,
  resolveReverseSpecMissionDir,
  validateReverseSpecEvidenceAt,
} from './reverse-spec-evidence.js';

export const LEGACY_MIGRATION_EVIDENCE_STAGES = [
  'brief',
  'decisions',
  'pin',
  'implement',
  'equivalence',
] as const;
export type LegacyMigrationEvidenceStage = (typeof LEGACY_MIGRATION_EVIDENCE_STAGES)[number];

export const LEGACY_MIGRATION_STRATEGIES = [
  'strangler_fig',
  'big_bang',
  'parallel_run',
  'branch_by_abstraction',
] as const;
export const LEGACY_MIGRATION_DISPOSITIONS = ['migrate', 'discard', 'human_decision'] as const;
export const LEGACY_MIGRATION_SCENARIO_KINDS = ['gherkin', 'golden', 'characterization'] as const;

export const LEGACY_MIGRATION_EVIDENCE_FILES = {
  brief: 'evidence/migration-brief.json',
  decisions: 'evidence/migration-decisions.json',
  pin: 'evidence/parity-matrix.json',
  implement: 'evidence/migration-report.md',
  equivalence: 'evidence/equivalence-report.json',
} as const satisfies Record<LegacyMigrationEvidenceStage, string>;

const MAX_LISTED = 12;

export interface LegacyMigrationEvidenceResult {
  stage: LegacyMigrationEvidenceStage;
  path: string;
  ok: true;
  summary: Record<string, number | string>;
}

export class LegacyMigrationEvidenceError extends Error {
  readonly problems: string[];
  constructor(stage: string, evidencePath: string, problems: string[]) {
    const listed = problems.slice(0, MAX_LISTED).map((problem) => `  - ${problem}`);
    if (problems.length > MAX_LISTED) listed.push(`  - … and ${problems.length - MAX_LISTED} more`);
    super(
      `[LEGACY_MIGRATION_EVIDENCE] ${stage} evidence invalid — ${problems.length} problem(s) | next: fix the listed items and re-run the gate | evidence: ${evidencePath}\n${listed.join('\n')}`
    );
    this.name = 'LegacyMigrationEvidenceError';
    this.problems = problems;
  }
}

type Json = Record<string, unknown>;

function fail(message: string): never {
  throw new Error(`[LEGACY_MIGRATION_EVIDENCE] ${message}`);
}

function readEvidenceText(missionDir: string, relative: string): string {
  const abs = path.join(missionDir, relative);
  if (!safeExistsSync(abs) || !safeStat(abs).isFile())
    fail(
      `missing ${relative} — the stage deliverable has not been written | next: produce ${relative}`
    );
  return String(safeReadFile(abs, { encoding: 'utf8' }));
}

function readJsonEvidence(missionDir: string, relative: string): Json {
  return parseSafeJsonObjectInput(readEvidenceText(missionDir, relative), relative);
}

function records(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function capList(ids: string[]): string {
  const shown = ids.slice(0, MAX_LISTED).join(', ');
  return ids.length > MAX_LISTED ? `${shown} … (+${ids.length - MAX_LISTED})` : shown;
}

function existsUnder(baseDir: string, relative: string): boolean {
  const abs = path.resolve(baseDir, relative);
  return abs.startsWith(path.resolve(baseDir) + path.sep) && safeExistsSync(abs);
}

interface Brief {
  sourceMissionDir: string;
  essenceSpecIds: Set<string>;
  allSpecIds: Set<string>;
}

export interface LegacyMigrationValidationOptions {
  /** Resolves the source reverse_spec mission directory (defaults to the mission locator). */
  resolveMissionDir?: (missionId: string) => string;
}

function validateBrief(
  missionDir: string,
  options: LegacyMigrationValidationOptions,
  verifySourceAudit: boolean
): Brief {
  const brief = readJsonEvidence(missionDir, LEGACY_MIGRATION_EVIDENCE_FILES.brief);
  const problems: string[] = [];
  if (!nonEmpty(brief.objective)) problems.push('objective required (why migrate)');
  if (stringList(brief.success_metrics).length < 1)
    problems.push('success_metrics must list at least one metric');
  const stack = isRecord(brief.target_stack) ? brief.target_stack : {};
  if (!nonEmpty(stack.language)) problems.push('target_stack.language required');
  const scope = isRecord(brief.scope) ? brief.scope : {};
  if (stringList(scope.included).length < 1)
    problems.push('scope.included must list at least one module/area');
  if (!Array.isArray(scope.excluded))
    problems.push('scope.excluded must be an array (may be empty)');
  if (!nonEmpty(brief.source_spec_mission_id)) {
    problems.push(
      'source_spec_mission_id required — migration starts from an audited reverse_spec mission'
    );
    throw new LegacyMigrationEvidenceError(
      'brief',
      LEGACY_MIGRATION_EVIDENCE_FILES.brief,
      problems
    );
  }
  let sourceMissionDir = '';
  try {
    sourceMissionDir = (options.resolveMissionDir ?? resolveReverseSpecMissionDir)(
      brief.source_spec_mission_id
    );
    // The brief gate re-runs the source mission's audit: a spec that no longer passes cannot seed
    // a rebuild. Later stages rely on that frozen result — a strangler-fig or in-place rebuild
    // changes the legacy tree by design, so its fingerprint is not re-checked after the brief.
    if (verifySourceAudit) {
      validateReverseSpecEvidenceAt(sourceMissionDir, 'audit');
      // Read through the scope (resolves the live source root): only at the brief, so a legacy
      // tree retired after cut-over does not break the later gates.
      const purpose = readReverseSpecPurpose(sourceMissionDir);
      if (purpose !== 'rebuild')
        problems.push(
          `source reverse_spec mission purpose is ${purpose}; a migration needs purpose rebuild (implementation-depth specs)`
        );
    }
  } catch (error) {
    problems.push(
      `source reverse_spec mission ${brief.source_spec_mission_id} does not pass its audit: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`
    );
  }
  if (problems.length)
    throw new LegacyMigrationEvidenceError(
      'brief',
      LEGACY_MIGRATION_EVIDENCE_FILES.brief,
      problems
    );
  const specs = readReverseSpecSpecIds(sourceMissionDir);
  return {
    sourceMissionDir,
    essenceSpecIds: new Set(
      specs.filter((spec) => spec.layer === 'essence').map((spec) => spec.spec_id)
    ),
    allSpecIds: new Set(specs.map((spec) => spec.spec_id)),
  };
}

function validateDecisions(
  missionDir: string,
  brief: Brief
): { migrate: Set<string>; discarded: number } {
  const decisions = readJsonEvidence(missionDir, LEGACY_MIGRATION_EVIDENCE_FILES.decisions);
  const problems: string[] = [];
  const paradigm = isRecord(decisions.paradigm) ? decisions.paradigm : {};
  for (const key of ['legacy', 'target', 'gap'] as const) {
    if (!nonEmpty(paradigm[key])) problems.push(`paradigm.${key} required`);
  }
  const migrate = new Set<string>();
  const dispositioned = new Set<string>();
  const open: string[] = [];
  const unknownSpecs: string[] = [];
  let discarded = 0;
  for (const entry of records(decisions.dispositions)) {
    const specId = String(entry.spec_id ?? '');
    if (!brief.allSpecIds.has(specId)) {
      unknownSpecs.push(specId);
      continue;
    }
    if (dispositioned.has(specId)) {
      problems.push(`${specId}: more than one disposition — keep exactly one decision per spec`);
      continue;
    }
    dispositioned.add(specId);
    switch (entry.disposition) {
      case 'migrate':
        migrate.add(specId);
        break;
      case 'discard':
        discarded += 1;
        if (!nonEmpty(entry.reason))
          problems.push(
            `${specId}: discard needs a reason (a dropped rule disappears from the new system)`
          );
        break;
      case 'human_decision':
        open.push(specId);
        break;
      default:
        problems.push(`${specId}: disposition must be ${LEGACY_MIGRATION_DISPOSITIONS.join('|')}`);
    }
  }
  if (unknownSpecs.length)
    problems.push(`dispositions for specs not in the source ledger: ${capList(unknownSpecs)}`);
  if (open.length)
    problems.push(
      `${open.length} open human decision(s) — decide migrate or discard: ${capList(open)}`
    );
  const missing = [...brief.essenceSpecIds].filter((id) => !dispositioned.has(id));
  if (missing.length)
    problems.push(`essence-layer specs without a disposition: ${capList(missing)}`);
  const strategy = isRecord(decisions.strategy) ? decisions.strategy : {};
  if (!(LEGACY_MIGRATION_STRATEGIES as readonly unknown[]).includes(strategy.selected))
    problems.push(`strategy.selected must be one of ${LEGACY_MIGRATION_STRATEGIES.join('|')}`);
  if (stringList(strategy.alternatives).filter((alt) => alt !== strategy.selected).length < 1)
    problems.push('strategy.alternatives must name at least one rejected alternative');
  if (!nonEmpty(strategy.rationale)) problems.push('strategy.rationale required');
  if (problems.length)
    throw new LegacyMigrationEvidenceError(
      'decisions',
      LEGACY_MIGRATION_EVIDENCE_FILES.decisions,
      problems
    );
  return { migrate, discarded };
}

function validatePin(missionDir: string, migrate: Set<string>): Map<string, string> {
  const matrix = readJsonEvidence(missionDir, LEGACY_MIGRATION_EVIDENCE_FILES.pin);
  const problems: string[] = [];
  const scenarios = new Map<string, string>();
  const covered = new Set<string>();
  for (const scenario of records(matrix.scenarios)) {
    const id = String(scenario.scenario_id ?? '');
    if (!id) {
      problems.push('every scenario needs a scenario_id');
      continue;
    }
    if (scenarios.has(id)) problems.push(`duplicate scenario id ${id}`);
    if (!(LEGACY_MIGRATION_SCENARIO_KINDS as readonly unknown[]).includes(scenario.kind))
      problems.push(`${id}: kind must be ${LEGACY_MIGRATION_SCENARIO_KINDS.join('|')}`);
    if (!nonEmpty(scenario.path) || !existsUnder(missionDir, scenario.path))
      problems.push(`${id}: scenario file ${String(scenario.path)} not found in the mission`);
    if (scenario.legacy_result !== 'pass' && scenario.legacy_result !== 'fail_recorded')
      problems.push(
        `${id}: legacy_result must be pass|fail_recorded (pin legacy bugs, do not hide them)`
      );
    const specId = String(scenario.spec_id ?? '');
    if (!migrate.has(specId))
      problems.push(`${id}: spec_id ${specId} is not dispositioned migrate`);
    else covered.add(specId);
    scenarios.set(id, String(scenario.legacy_result));
  }
  const uncovered = [...migrate].filter((id) => !covered.has(id));
  if (uncovered.length)
    problems.push(`migrate specs without a parity scenario: ${capList(uncovered)}`);
  if (problems.length)
    throw new LegacyMigrationEvidenceError('pin', LEGACY_MIGRATION_EVIDENCE_FILES.pin, problems);
  return scenarios;
}

function validateImplement(missionDir: string): void {
  const text = readEvidenceText(missionDir, LEGACY_MIGRATION_EVIDENCE_FILES.implement);
  const problems: string[] = [];
  if (text.trim().length < 40)
    problems.push('migration-report.md is empty or too short to be proof');
  const lower = text.toLowerCase();
  const missing = ['spec', 'scenario', 'green'].filter((marker) => !lower.includes(marker));
  if (missing.length)
    problems.push(`migration-report.md missing required markers: ${missing.join(', ')}`);
  if (problems.length)
    throw new LegacyMigrationEvidenceError(
      'implement',
      LEGACY_MIGRATION_EVIDENCE_FILES.implement,
      problems
    );
}

function validateEquivalence(
  missionDir: string,
  scenarios: Map<string, string>
): Record<string, number> {
  const report = readJsonEvidence(missionDir, LEGACY_MIGRATION_EVIDENCE_FILES.equivalence);
  const problems: string[] = [];
  const results = new Map<string, Json>();
  for (const result of records(report.results)) {
    const id = String(result.scenario_id ?? '');
    if (results.has(id))
      problems.push(`${id}: more than one result — record one result per scenario`);
    results.set(id, result);
  }
  const missing: string[] = [];
  let deviations = 0;
  for (const scenarioId of scenarios.keys()) {
    const result = results.get(scenarioId);
    if (!result) {
      missing.push(scenarioId);
      continue;
    }
    // A legacy bug pinned as fail_recorded that now passes is a behavior change too.
    if (result.target_result === 'pass' && scenarios.get(scenarioId) !== 'fail_recorded') continue;
    if (result.target_result !== 'deviation' && result.target_result !== 'pass') {
      problems.push(`${scenarioId}: target_result must be pass|deviation`);
      continue;
    }
    deviations += 1;
    const deviation = isRecord(result.deviation) ? result.deviation : {};
    if (!nonEmpty(deviation.reason) || !nonEmpty(deviation.approved_by))
      problems.push(
        `${scenarioId}: deviation needs reason and approved_by (an approved behavior change)`
      );
  }
  if (missing.length)
    problems.push(`parity scenarios without a target result: ${capList(missing)}`);
  const extra = [...results.keys()].filter((id) => !scenarios.has(id));
  if (extra.length)
    problems.push(`results for scenarios not in the parity matrix: ${capList(extra)}`);
  if (problems.length)
    throw new LegacyMigrationEvidenceError(
      'equivalence',
      LEGACY_MIGRATION_EVIDENCE_FILES.equivalence,
      problems
    );
  return { scenarios: scenarios.size, deviations };
}

/** Validate one legacy_migration stage against a mission directory; throws on failure. */
export function validateLegacyMigrationEvidenceAt(
  missionDir: string,
  stage: LegacyMigrationEvidenceStage,
  options: LegacyMigrationValidationOptions = {}
): LegacyMigrationEvidenceResult {
  if (!(LEGACY_MIGRATION_EVIDENCE_STAGES as readonly string[]).includes(stage))
    fail(`unknown stage ${stage}`);
  const evidencePath = path.join(missionDir, LEGACY_MIGRATION_EVIDENCE_FILES[stage]);
  if (stage === 'implement') {
    validateImplement(missionDir);
    return { stage, path: evidencePath, ok: true, summary: {} };
  }
  const brief = validateBrief(missionDir, options, stage === 'brief');
  if (stage === 'brief')
    return {
      stage,
      path: evidencePath,
      ok: true,
      summary: { source_specs: brief.allSpecIds.size, essence_specs: brief.essenceSpecIds.size },
    };
  const decisions = validateDecisions(missionDir, brief);
  if (stage === 'decisions')
    return {
      stage,
      path: evidencePath,
      ok: true,
      summary: { migrate: decisions.migrate.size, discarded: decisions.discarded },
    };
  const scenarios = validatePin(missionDir, decisions.migrate);
  if (stage === 'pin')
    return { stage, path: evidencePath, ok: true, summary: { scenarios: scenarios.size } };
  return {
    stage,
    path: evidencePath,
    ok: true,
    summary: validateEquivalence(missionDir, scenarios),
  };
}

/** Validate one legacy_migration evidence stage for a mission; throws on failure. */
export function assertLegacyMigrationEvidence(
  missionId: string,
  stage: LegacyMigrationEvidenceStage
): LegacyMigrationEvidenceResult {
  const dir = findMissionPath(missionId);
  if (!dir) fail(`mission directory not found for ${missionId}`);
  return validateLegacyMigrationEvidenceAt(dir, stage);
}
