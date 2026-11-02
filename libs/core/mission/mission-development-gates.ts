/** Typed completion checks for an owner-bound development plan; never human overrides. */
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { readJson } from '../foundation/json.js';
import { currentScopeEnvelope } from '../scope-envelope.js';
import { resolveScopeContext } from '../scope-context.js';
import { findMissionPath } from '../path-resolver.js';
import { missionPathOrNull } from '../mission-lookup.js';
import { parseContinuousWorkPlan } from '../organization/continuous-work-plan.js';
import { loadState } from './mission-state.js';
import { assertMissionOwnerPath } from './mission-git.js';
import {
  loadMissionPhaseGateDefinitionAtPath,
  type PersistedPhaseGateDefinition,
} from './mission-phase-gate-definition-reader.js';
import { provisionMissionEntry, writeProvisionedJson } from './mission-orchestration-journal.js';
import type { MissionDevelopmentSpec } from './mission-development-continuation.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export type MissionDevelopmentProofVerifier = (
  missionId: string,
  development: MissionDevelopmentSpec,
  mode?: 'review' | 'ci' | 'publication'
) => Promise<{ ok: boolean; reason?: string; waiting?: boolean }>;
let installedProofVerifier: MissionDevelopmentProofVerifier | undefined;
/** Installed by the trusted executable composition, never by a model task. */
export function installMissionDevelopmentProofVerifier(
  verifier: MissionDevelopmentProofVerifier
): void {
  assertMissionOwnerPath('install the development phase proof verifier');
  installedProofVerifier = verifier;
}
export type MissionDevelopmentGateKind =
  'development_reviews_verified' | 'development_ci_verified' | 'development_publication_verified';
interface ReviewedDevelopment {
  directory: string;
  development: MissionDevelopmentSpec;
  hash: string;
}
export interface MissionDevelopmentGateDeps {
  proof?: MissionDevelopmentProofVerifier;
  state?: typeof loadState;
  missionPath?: typeof findMissionPath;
  read?: (file: string) => unknown;
  scope?: typeof resolveScopeContext;
  definition?: typeof loadMissionPhaseGateDefinitionAtPath;
  write?: (directory: string, definition: PersistedPhaseGateDefinition) => void;
}
function reviewedDevelopment(
  missionId: string,
  deps: MissionDevelopmentGateDeps
): ReviewedDevelopment {
  const state = (deps.state ?? loadState)(missionId);
  if (!state) throw new Error('Development gate mission is missing');
  const scope = deps.scope
    ? deps.scope()
    : (currentScopeEnvelope()?.identity ?? resolveScopeContext());
  if (
    scope.tier !== state.tier ||
    (scope.tenant_slug ?? '') !== (state.tenant_slug ?? '') ||
    (scope.organization_id ?? '') !== (state.organization_id ?? '')
  )
    throw new Error('Development gate scope differs from the mission');
  const directory = missionPathOrNull(deps.missionPath ?? findMissionPath, missionId);
  if (!directory) throw new Error('Development gate mission directory is missing');
  const marker = (deps.read ?? readJson)(
    path.join(directory, 'evidence/continuous-owner.json')
  ) as Record<string, unknown>;
  if (
    !marker ||
    typeof marker !== 'object' ||
    typeof marker.operation_key !== 'string' ||
    typeof marker.request_hash !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(marker.request_hash)
  )
    throw new Error('Development gate requires its reviewed continuous owner binding');
  const development = parseContinuousWorkPlan({
    kind: 'mission',
    missions: [
      {
        key: 'bound',
        title: 'Bound development',
        goal: 'Verify the reviewed development',
        success_condition: 'Verified publication',
        development: marker.development,
      },
    ],
  }).missions[0]!.development!;
  const hash = digest(development);
  if (hash !== marker.development_hash)
    throw new Error('Development gate descriptor differs from its reviewed pin');
  return { directory, development, hash };
}

/** Canonical process-definition specialization, only for the admitted owner descriptor. */
export function configureMissionDevelopmentGates(
  input: { missionId: string; development: MissionDevelopmentSpec; assertCurrent: () => void },
  deps: MissionDevelopmentGateDeps = {}
): void {
  assertMissionOwnerPath('configure owner-bound development completion gates');
  input.assertCurrent();
  const bound = reviewedDevelopment(input.missionId, deps);
  if (digest(input.development) !== bound.hash)
    throw new Error('Development gate configuration drift');
  const replacements: Array<{
    id: string;
    phase: string;
    original: string;
    kind: MissionDevelopmentGateKind;
    append?: boolean;
  }> = [
    {
      id: 'CODE_REVIEW_PASSED',
      phase: 'self_review',
      original: 'reviewer_approved',
      kind: 'development_reviews_verified',
    },
    {
      id: 'DELIVERY_APPROVED',
      phase: 'delivery',
      original: 'human_override',
      kind: 'development_publication_verified',
    },
    {
      id: 'TESTS_PASSED',
      phase: 'test',
      original: 'evidence_exists',
      kind: 'development_ci_verified',
      append: true,
    },
  ];
  const definitions = replacements.map((replacement) => {
    const definition = (deps.definition ?? loadMissionPhaseGateDefinitionAtPath)(
      path.join(bound.directory, 'gates/definitions', `${replacement.id}.json`),
      input.missionId
    );
    if (
      definition.gate.id !== replacement.id ||
      definition.phase !== replacement.phase ||
      definition.position !== 'exit'
    )
      throw new Error('Development completion gate phase mismatch');
    if (
      !definition.gate.checks.some(
        (check) => check.kind === replacement.original || check.kind === replacement.kind
      )
    )
      throw new Error('Development completion gate contract changed');
    const updated: PersistedPhaseGateDefinition = {
      ...definition,
      gate: {
        ...definition.gate,
        checks: definition.gate.checks.map((check) => {
          if (check.kind === replacement.kind && check.params?.development_hash !== bound.hash)
            throw new Error('Development completion gate binding changed');
          if (
            check.kind === 'reviewer_approved' &&
            String(check.params?.task_id ?? check.params?.taskId ?? '') !==
              bound.development.review_task_id
          )
            throw new Error(
              'Development completion gate names a different independent reviewer contract'
            );
          if (check.kind === 'human_override' && check.params && Object.keys(check.params).length)
            throw new Error('Development completion cannot replace an explicit human decision');
          return !replacement.append && check.kind === replacement.original
            ? { kind: replacement.kind, params: { development_hash: bound.hash } }
            : check;
        }),
      },
    };
    if (replacement.append && !updated.gate.checks.some((check) => check.kind === replacement.kind))
      updated.gate.checks.push({
        kind: replacement.kind,
        params: { development_hash: bound.hash },
      });
    return updated;
  });
  for (const updated of definitions) {
    input.assertCurrent();
    if (deps.write) deps.write(bound.directory, updated);
    else
      writeProvisionedJson({
        missionId: input.missionId,
        filePath: path.join(bound.directory, 'gates/definitions', `${updated.gate.id}.json`),
        targetPath: `gates/definitions/${updated.gate.id}.json`,
        missionPathHint: bound.directory,
        provisioned: provisionMissionEntry(updated),
      });
  }
}

export async function evaluateMissionDevelopmentGate(
  input: {
    missionId: string;
    gateId: string;
    kind: MissionDevelopmentGateKind;
    developmentHash: unknown;
  },
  deps: MissionDevelopmentGateDeps = {}
): Promise<{ passed: boolean; reason?: string }> {
  try {
    const expected = {
      development_reviews_verified: 'CODE_REVIEW_PASSED',
      development_ci_verified: 'TESTS_PASSED',
      development_publication_verified: 'DELIVERY_APPROVED',
    }[input.kind];
    if (input.gateId !== expected)
      throw new Error('Development predicate cannot replace another phase gate');
    const bound = reviewedDevelopment(input.missionId, deps);
    if (bound.hash !== input.developmentHash)
      throw new Error('Development gate source binding changed');
    if (input.kind === 'development_reviews_verified') {
      const verifier = deps.proof ?? installedProofVerifier;
      if (!verifier) throw new Error('Development proof verifier is not installed by the host');
      const proof = await verifier(input.missionId, bound.development, 'review');
      return proof.ok
        ? { passed: true }
        : {
            passed: false,
            reason: proof.reason ?? 'Current independent development revision review unavailable',
          };
    }
    const verifier = deps.proof ?? installedProofVerifier;
    if (!verifier) throw new Error('Development proof verifier is not installed by the host');
    const proof =
      input.kind === 'development_ci_verified'
        ? await verifier(input.missionId, bound.development, 'ci')
        : await verifier(input.missionId, bound.development);
    return proof.ok
      ? { passed: true }
      : {
          passed: false,
          reason: `${input.kind === 'development_ci_verified' && proof.waiting ? '[DEVELOPMENT_CI_WAITING] ' : ''}${proof.reason ?? 'Immutable development publication proof unavailable'}`,
        };
  } catch (error) {
    return {
      passed: false,
      reason: error instanceof Error ? error.message : 'Development gate refused',
    };
  }
}
