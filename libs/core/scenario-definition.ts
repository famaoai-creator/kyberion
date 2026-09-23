/**
 * ES-01: Kyberion scenario definition (`kyberion-scenario.v1`).
 *
 * `knowledge/product/schemas/kyberion-scenario.schema.json` validates
 * structure. Cross-field invariants the schema cannot express — lane vs.
 * executionProfile, lane vs. judge/intent turns, deferred vs. lane, and seed
 * file path containment — are enforced here so a malformed scenario always
 * fails at parse time instead of surfacing mid-run (later waves: the
 * interceptor and runner build on these types).
 */

import type { ValidateFunction } from 'ajv';
import * as path from 'node:path';
import { compileSchema } from './foundation/ajv.js';
import { readJson } from './foundation/json.js';
import { pathResolver } from './path-resolver.js';

const SCENARIO_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/kyberion-scenario.schema.json'
);

export type ScenarioLane = 'pr-deterministic' | 'live-only';
export type ScenarioExecutionProfile = 'simulated' | 'provider-qualified';
export type ScenarioModelFixtureMode = 'fixtures' | 'model-free';
export type ScenarioApprovalDecision = 'approved' | 'rejected' | 'pending';

export interface ScenarioRequires {
  actuators?: readonly string[];
  env?: readonly string[];
  backends?: readonly string[];
}

export interface ScenarioDeferred {
  reason: string;
}

export interface ScenarioSeedFile {
  /** Relative to the scenario run root; no '..' segments, no absolute paths. */
  path: string;
  content: string;
}

export interface ScenarioSeedClock {
  start_iso?: string;
}

export interface ScenarioSeed {
  context?: Record<string, unknown>;
  files?: readonly ScenarioSeedFile[];
  approvals?: readonly Record<string, unknown>[];
  clock?: ScenarioSeedClock;
}

export interface ScenarioOpFixture {
  ctx_patch?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
}

export interface ScenarioReasoningFixtureMatch {
  contains?: string;
  regex?: string;
}

export interface ScenarioReasoningFixture {
  match: ScenarioReasoningFixtureMatch;
  response: string;
}

export interface ScenarioFixtures {
  /** Keyed by 'domain:action' op id. */
  ops: Record<string, ScenarioOpFixture>;
  reasoning?: readonly ScenarioReasoningFixture[];
}

export interface ScenarioResponseMatcher {
  path: string;
  equals?: unknown;
  regex?: string;
  includes?: string;
}

export interface ScenarioJudge {
  rubric: string;
  minScore: number;
}

export interface ScenarioTurnChecks {
  expectedOps?: readonly string[];
  forbiddenOps?: readonly string[];
  responseMatchers?: readonly ScenarioResponseMatcher[];
  judge?: ScenarioJudge;
}

export interface ScenarioPipelineTurn {
  kind: 'pipeline';
  /** Relative path to a pipeline JSON file; mutually exclusive with `steps`. */
  pipeline?: string;
  steps?: readonly Record<string, unknown>[];
  context?: Record<string, unknown>;
  /** Negative scenario: the pipeline must fail with an error containing this substring. */
  expectError?: string;
  checks?: ScenarioTurnChecks;
}

export interface ScenarioIntentTurn {
  kind: 'intent';
  text: string;
  checks?: ScenarioTurnChecks;
}

export interface ScenarioAdvanceClockTurn {
  kind: 'advance_clock';
  ms: number;
  checks?: ScenarioTurnChecks;
}

export interface ScenarioApprovalDecisionTurn {
  kind: 'approval_decision';
  op: string;
  decision: ScenarioApprovalDecision;
  checks?: ScenarioTurnChecks;
}

export type ScenarioTurn =
  | ScenarioPipelineTurn
  | ScenarioIntentTurn
  | ScenarioAdvanceClockTurn
  | ScenarioApprovalDecisionTurn;

export interface ScenarioFinalCheckOpCalled {
  type: 'opCalled';
  op: string;
  times?: number;
}
export interface ScenarioFinalCheckOpNotCalled {
  type: 'opNotCalled';
  op: string;
}
export interface ScenarioFinalCheckOpArgs {
  type: 'opArgs';
  op: string;
  match: Record<string, unknown>;
}
export interface ScenarioFinalCheckApprovalRequested {
  type: 'approvalRequested';
  op: string;
}
export interface ScenarioFinalCheckApprovalTransition {
  type: 'approvalTransition';
  op: string;
  from: ScenarioApprovalDecision;
  to: ScenarioApprovalDecision;
}
export interface ScenarioFinalCheckNoSideEffectOnReject {
  type: 'noSideEffectOnReject';
  op: string;
}
export interface ScenarioFinalCheckArtifactExists {
  type: 'artifactExists';
  path: string;
}
export interface ScenarioFinalCheckTraceSpanExists {
  type: 'traceSpanExists';
  name: string;
}

export type ScenarioFinalCheck =
  | ScenarioFinalCheckOpCalled
  | ScenarioFinalCheckOpNotCalled
  | ScenarioFinalCheckOpArgs
  | ScenarioFinalCheckApprovalRequested
  | ScenarioFinalCheckApprovalTransition
  | ScenarioFinalCheckNoSideEffectOnReject
  | ScenarioFinalCheckArtifactExists
  | ScenarioFinalCheckTraceSpanExists;

export interface ScenarioDefinition {
  schema_version: 'kyberion-scenario.v1';
  id: string;
  title: string;
  description?: string;
  tier: 1 | 2 | 3;
  lane: ScenarioLane;
  executionProfile: ScenarioExecutionProfile;
  modelFixtures: ScenarioModelFixtureMode;
  requires: ScenarioRequires;
  deferred?: ScenarioDeferred;
  seed: ScenarioSeed;
  fixtures: ScenarioFixtures;
  turns: readonly ScenarioTurn[];
  finalChecks: readonly ScenarioFinalCheck[];
}

/** Raw, not-yet-defaulted shape as read off disk — `lane` may be absent. */
export type ScenarioDefinitionInput = Omit<ScenarioDefinition, 'lane'> & {
  lane?: ScenarioLane;
};

export type ScenarioDefinitionErrorCode = 'SCENARIO_INVALID';

export class ScenarioDefinitionError extends Error {
  readonly code: ScenarioDefinitionErrorCode = 'SCENARIO_INVALID';
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`[SCENARIO_INVALID] ${issues.join('; ')}`);
    this.name = 'ScenarioDefinitionError';
    this.issues = issues;
  }
}

let scenarioValidateFn: ValidateFunction | null = null;

function ensureScenarioValidator(): ValidateFunction {
  if (!scenarioValidateFn) scenarioValidateFn = compileSchema(SCENARIO_SCHEMA_PATH);
  return scenarioValidateFn;
}

function schemaErrors(validate: ValidateFunction): string[] {
  return (validate.errors || []).map((error) =>
    `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim()
  );
}

/** `undefined`/anything that isn't exactly 'pr-deterministic' resolves to the safe default, 'live-only'. */
export function resolveScenarioLane(raw: { lane?: unknown }): ScenarioLane {
  return raw.lane === 'pr-deterministic' ? 'pr-deterministic' : 'live-only';
}

function relativeContainedPathIssue(label: string, value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) {
    return `${label} must be a non-empty string`;
  }
  if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value)) {
    return `${label} must be a relative path, got an absolute path: ${value}`;
  }
  const segments = value.split(/[\\/]+/u);
  if (segments.some((segment) => segment === '..')) {
    return `${label} must not contain '..' segments: ${value}`;
  }
  return null;
}

function collectInvariantIssues(def: ScenarioDefinition): string[] {
  const issues: string[] = [];

  if (def.executionProfile === 'provider-qualified' && def.lane !== 'live-only') {
    issues.push('executionProfile "provider-qualified" requires lane "live-only"');
  }

  if (def.lane === 'pr-deterministic') {
    if (def.turns.some((turn) => turn.kind === 'intent')) {
      issues.push('lane "pr-deterministic" cannot contain intent turns');
    }
    if (def.turns.some((turn) => Boolean(turn.checks?.judge))) {
      issues.push('lane "pr-deterministic" cannot use judge checks');
    }
    if (!def.modelFixtures) {
      issues.push('lane "pr-deterministic" requires modelFixtures to be declared');
    }
  }

  if (def.deferred && def.lane === 'pr-deterministic') {
    issues.push('a deferred scenario cannot use lane "pr-deterministic"');
  }

  (def.seed.files ?? []).forEach((file, index) => {
    const issue = relativeContainedPathIssue(`seed.files[${index}].path`, file.path);
    if (issue) issues.push(issue);
  });

  def.turns.forEach((turn, index) => {
    if (turn.kind === 'pipeline' && turn.pipeline !== undefined) {
      const issue = relativeContainedPathIssue(`turns[${index}].pipeline`, turn.pipeline);
      if (issue) issues.push(issue);
    }
  });

  return issues;
}

/** Validate against the schema, apply the `lane` default, and enforce cross-field invariants. */
export function parseScenarioDefinition(raw: unknown): ScenarioDefinition {
  const validate = ensureScenarioValidator();
  const valid = validate(raw);
  if (!valid) throw new ScenarioDefinitionError(schemaErrors(validate));

  const candidate = raw as ScenarioDefinitionInput;
  const normalized: ScenarioDefinition = {
    ...(candidate as ScenarioDefinition),
    lane: resolveScenarioLane(candidate),
  };

  const invariantIssues = collectInvariantIssues(normalized);
  if (invariantIssues.length > 0) throw new ScenarioDefinitionError(invariantIssues);

  return normalized;
}

/** Read and parse a scenario file from disk via secure-io (`foundation/json.ts`). */
export function loadScenarioFile(filePath: string): ScenarioDefinition {
  const raw = readJson<unknown>(filePath);
  return parseScenarioDefinition(raw);
}
