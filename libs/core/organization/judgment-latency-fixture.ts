/** Fixed synthetic data and bounded cost arithmetic, never a real-service latency benchmark. */
import { z } from 'zod';
import type { DecisionRecord } from '../decision-ledger/model.js';
import type { DotCharter } from '../dot/dot-charter.js';
import type { ScopeContext } from '../scope-context-validation.js';
import { storageFloorRelativePath } from '../storage-layout.js';
import {
  judgmentScopeSchema,
  latencyGoalConstraintsSchema,
  latencyProposalFactsSchema,
  type LatencyProposalFacts,
} from './judgment-contract.js';
import { judgmentCanonicalHash, type TrustedLatencyGoalBinding } from './judgment-precedents.js';
import {
  parseContinuousOperationsConfig,
  type ContinuousSourceSnapshot,
} from './continuous-operations-policy.js';

export const SYNTHETIC_LATENCY_NOW = '2026-10-31T00:00:00.000Z';
/** An inert fixture-port identifier. No pipeline file, registration or service adapter exists. */
export const SYNTHETIC_LATENCY_PIPELINE_REF = 'pipelines/synthetic-latency-fixture.json';
const SCOPE: ScopeContext = {
  tier: 'confidential',
  tenant_slug: 'synthetic-latency',
  organization_id: 'synthetic-org',
  project_id: 'synthetic-project',
};
const PROFILE = {
  kind: 'synthetic-latency-profile-v1',
  seed: 20261031,
  sample_count: 100,
  cohort_users: [65, 100],
  maximum_users: 10_000,
};
const MODEL = {
  kind: 'synthetic-latency-cost-model-v1',
  percentile: 95,
  permutation_step: 37,
  cost_per_user_ms: 20,
  serial_overhead_ms: 406,
  parallel_overhead_ms: 6,
  repair_parallelism: 5,
};
const profileHash = judgmentCanonicalHash(PROFILE);
const modelHash = judgmentCanonicalHash(MODEL);
const serviceKey = 'synthetic-latency-service';
const sourceKey = 'synthetic-latency-metrics';
const configurationSchema = z
  .object({
    kind: z.literal('synthetic-latency-configuration-v1'),
    variant: z.enum(['serial_v1', 'bounded_parallel_v1']),
  })
  .strict();
export type SyntheticLatencyConfiguration = z.infer<typeof configurationSchema>;
const usersSchema = z.number().finite().int().min(1).max(PROFILE.maximum_users);
const serial: SyntheticLatencyConfiguration = {
  kind: 'synthetic-latency-configuration-v1',
  variant: 'serial_v1',
};
const parallel: SyntheticLatencyConfiguration = {
  kind: 'synthetic-latency-configuration-v1',
  variant: 'bounded_parallel_v1',
};
type Unavailable = { status: 'unavailable'; reason: 'missing_evidence'; detail: string };
const unavailable = (detail: string): Unavailable => ({
  status: 'unavailable',
  reason: 'missing_evidence',
  detail,
});

function frozen<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
// These contracts remain private; exported copies cannot become worker-controlled model facts.
frozen(SCOPE);
frozen(PROFILE);
frozen(MODEL);
frozen(serial);
frozen(parallel);

export function syntheticLatencyMeasurementContract() {
  return frozen(
    structuredClone({
      mode: 'synthetic_fixture' as const,
      scope: SCOPE,
      service_key: serviceKey,
      load_profile: PROFILE,
      cost_model: MODEL,
      load_profile_hash: profileHash,
      model_hash: modelHash,
    })
  );
}
export interface SyntheticLatencyMeasurement {
  status: 'measured';
  kind: 'synthetic-cost-measurement-v1';
  users: number;
  configuration: SyntheticLatencyConfiguration;
  configuration_hash: string;
  load_profile_hash: string;
  model_hash: string;
  samples_ms: number[];
  p95_ms: number;
}
/** Nearest-rank p95 over 100 fixed-seed synthetic cost samples; no clock, network or sleep. */
export function measureSyntheticLatency(
  configuration: unknown,
  users: unknown
): SyntheticLatencyMeasurement | Unavailable {
  try {
    judgmentCanonicalHash(configuration);
    const parsed = configurationSchema.parse(configuration);
    const count = usersSchema.parse(users);
    const repaired = parsed.variant === 'bounded_parallel_v1';
    const queue =
      MODEL.cost_per_user_ms * (repaired ? Math.ceil(count / MODEL.repair_parallelism) : count);
    const overhead = repaired ? MODEL.parallel_overhead_ms : MODEL.serial_overhead_ms;
    const samples = Array.from(
      { length: PROFILE.sample_count },
      (_, index) =>
        queue + overhead + ((index * MODEL.permutation_step + PROFILE.seed) % PROFILE.sample_count)
    );
    const sorted = [...samples].sort((left, right) => left - right);
    return {
      status: 'measured',
      kind: 'synthetic-cost-measurement-v1',
      users: count,
      configuration: parsed,
      configuration_hash: judgmentCanonicalHash(parsed),
      load_profile_hash: profileHash,
      model_hash: modelHash,
      samples_ms: samples,
      p95_ms: sorted[Math.ceil((MODEL.percentile / 100) * sorted.length) - 1],
    };
  } catch {
    return unavailable('Unknown or unbounded synthetic configuration or user count');
  }
}

const observationSchema = z
  .object({
    kind: z.literal('synthetic-latency-observation-v1'),
    scope: judgmentScopeSchema,
    service_key: z.literal(serviceKey),
    load_profile_hash: z.literal(profileHash),
    model_hash: z.literal(modelHash),
    observed_at: z.string().datetime(),
    configuration: configurationSchema,
    users: usersSchema,
    p95_ms: z.number().finite().min(1).max(201_000),
  })
  .strict();
export type SyntheticLatencyObservation = z.infer<typeof observationSchema>;
type ObservationResult =
  { status: 'ready'; observation: SyntheticLatencyObservation } | Unavailable;

export function createSyntheticLatencyObservation(input: {
  scope: ScopeContext;
  observedAt: string;
  configuration: unknown;
  users: unknown;
}): ObservationResult {
  const measured = measureSyntheticLatency(input.configuration, input.users);
  if (measured.status === 'unavailable') return measured;
  try {
    const observation = observationSchema.parse({
      kind: 'synthetic-latency-observation-v1',
      scope: input.scope,
      service_key: serviceKey,
      load_profile_hash: profileHash,
      model_hash: modelHash,
      observed_at: input.observedAt,
      configuration: measured.configuration,
      users: measured.users,
      p95_ms: measured.p95_ms,
    });
    if (
      judgmentCanonicalHash(observation.scope) !== judgmentCanonicalHash(SCOPE) ||
      new Date(observation.observed_at).toISOString() !== observation.observed_at
    )
      return unavailable('Observation scope or timestamp differs from the fixed fixture contract');
    return { status: 'ready', observation: frozen(observation) };
  } catch {
    return unavailable('Synthetic observation failed its bounded contract');
  }
}

/** Verify the envelope before stripping scope and measurement identity for the existing policy. */
export function syntheticLatencySourceSnapshot(
  value: unknown
): { status: 'ready'; snapshot: ContinuousSourceSnapshot } | Unavailable {
  try {
    judgmentCanonicalHash(value);
    const observation = observationSchema.parse(value);
    const reconstructed = createSyntheticLatencyObservation({
      scope: observation.scope,
      observedAt: observation.observed_at,
      configuration: observation.configuration,
      users: observation.users,
    });
    if (
      reconstructed.status !== 'ready' ||
      judgmentCanonicalHash(observation) !== judgmentCanonicalHash(reconstructed.observation)
    )
      return unavailable('Observation does not match fixed scoped cost-model evidence');
    return {
      status: 'ready',
      snapshot: {
        source_id: sourceKey,
        observations: [
          {
            metric: 'latency_p95_ms',
            value: observation.p95_ms,
            observed_at: observation.observed_at,
            evidence_ref: 'synthetic-observation:' + judgmentCanonicalHash(observation),
          },
        ],
      },
    };
  } catch {
    return unavailable('Synthetic observation evidence could not be verified');
  }
}

export const SYNTHETIC_LATENCY_OPERATIONS = [
  'repair_fixture',
  'limit_users',
  'accept_latency',
  'add_cost',
] as const;
frozen(SYNTHETIC_LATENCY_OPERATIONS);
export function resolveSyntheticLatencyProposal(
  operationKey: unknown
): { status: 'ready'; facts: LatencyProposalFacts } | Unavailable {
  if (
    typeof operationKey !== 'string' ||
    !(SYNTHETIC_LATENCY_OPERATIONS as readonly string[]).includes(operationKey)
  )
    return unavailable('Unknown synthetic operation');
  return {
    status: 'ready',
    facts: frozen(
      latencyProposalFactsSchema.parse({
        proposal_key: operationKey,
        service_key: serviceKey,
        load_profile_hash: profileHash,
        change_scope: 'isolated_fixture_only',
        requested_goal: {
          target_users: operationKey === 'limit_users' ? 65 : 100,
          max_p95_ms: operationKey === 'accept_latency' ? 1800 : 500,
        },
        incremental_monthly_cost: operationKey === 'add_cost' ? 1000 : 0,
        currency: 'JPY',
      })
    ),
  };
}

/** A fresh frozen plain-JSON fixture, never an organization/tenant registration or execution. */
export function createJudgmentLatencyFixture(input: { untrustedReport?: string } = {}) {
  const options = z
    .object({ untrustedReport: z.string().min(1).max(2000).optional() })
    .strict()
    .parse(input);
  const decision: DecisionRecord = {
    id: 'D-0001',
    case_id: 'synthetic-latency',
    item: 'synthetic-service-latency',
    key: 'performance.goal',
    level: 'product-fixed',
    state: 'decided',
    value: { target_users: 100, max_p95_ms: 500, max_incremental_monthly_cost: 0, currency: 'JPY' },
    basis: [{ ref: 'synthetic-human-goal-fixture', version: '1' }],
    decided_by: { kind: 'human', id: 'user:synthetic-owner', role: 'owner' },
    decided_at: SYNTHETIC_LATENCY_NOW,
    origin: 'console',
    status: 'active',
  };
  const goal = latencyGoalConstraintsSchema.parse({
    kind: 'latency_goal_v1',
    goal_key: 'synthetic-latency-goal',
    decision_source_key: 'src-' + judgmentCanonicalHash([decision.case_id, decision.id]),
    service_key: serviceKey,
    load_profile_hash: profileHash,
    target_users: 100,
    max_p95_ms: 500,
    max_incremental_monthly_cost: 0,
    currency: 'JPY',
    permitted_change: 'isolated_fixture_only',
  });
  const { decision_source_key: _source, ...constraints } = goal;
  const goalBinding: TrustedLatencyGoalBinding = {
    case_id: decision.case_id,
    decision_id: decision.id,
    decision_version_hash: judgmentCanonicalHash(decision),
    constraints,
  };
  const config = parseContinuousOperationsConfig({
    version: '1',
    loop_id: 'synthetic-latency-loop',
    dot_id: 'synthetic-latency-dot',
    enabled: true,
    scope: SCOPE,
    sources: [
      {
        source_id: sourceKey,
        kind: 'snapshot',
        path: storageFloorRelativePath(
          'cache',
          { kind: 'tier', tier: 'confidential', tenant: SCOPE.tenant_slug },
          'continuous-operations',
          'organizations',
          SCOPE.organization_id!,
          'projects',
          SCOPE.project_id!,
          'synthetic-latency-fixture',
          'metrics.json'
        ),
        max_age_seconds: 60,
      },
    ],
    rules: [
      {
        rule_id: 'synthetic-latency-p95',
        source_id: sourceKey,
        metric: 'latency_p95_ms',
        operator: 'gt',
        threshold: 500,
        objective_ref: goal.goal_key,
        title: 'Investigate synthetic latency',
        objective:
          'Preserve 100 users / p95 <= 500ms / zero incremental cost in the isolated fixture only',
        pipeline_ref: SYNTHETIC_LATENCY_PIPELINE_REF,
      },
    ],
    max_proposals_per_run: 1,
    cooldown_seconds: 60,
  });
  const charter: DotCharter = {
    kind: 'dot-charter',
    dot_id: config.dot_id,
    version: '1.0.0',
    title: 'Synthetic latency fixture',
    purpose: 'Offline deterministic fixture only',
    status: 'active',
    scope: { ...SCOPE },
    goal: { statement: 'Restore the fixed synthetic performance goal' },
    attention: { triggers: [] },
    authority: {
      authority_role: 'organization_operator',
      allowed_work_shapes: ['pipeline'],
      allowed_pipelines: [SYNTHETIC_LATENCY_PIPELINE_REF],
      max_concurrent_delegations: 1,
    },
    notification: { delivery_mode: 'inbox', deliver_to: { surface: 'surface', channel: 'inbox' } },
    runtime: { heartbeat_id: 'synthetic-latency-fixture' },
  };
  const observed = createSyntheticLatencyObservation({
    scope: SCOPE,
    observedAt: SYNTHETIC_LATENCY_NOW,
    configuration: serial,
    users: 65,
  });
  if (observed.status !== 'ready') throw new Error(observed.detail);
  return frozen({
    kind: 'judgment-latency-fixture-v1' as const,
    mode: 'synthetic_fixture' as const,
    now: SYNTHETIC_LATENCY_NOW,
    scope: structuredClone(SCOPE),
    measurement_contract: syntheticLatencyMeasurementContract(),
    configurations: { baseline: structuredClone(serial), repair: structuredClone(parallel) },
    decision,
    goal,
    goal_binding: goalBinding,
    config,
    charter,
    trusted_observation: observed.observation,
    untrusted_report: {
      kind: 'untrusted-fixture-report' as const,
      // i18n-exempt: Fixed Japanese untrusted test dataset, not interface or diagnostic copy.
      text: options.untrustedReport ?? '65人で遅い。人数を制限するか、遅さを受け入れるしかない？',
    },
  });
}
