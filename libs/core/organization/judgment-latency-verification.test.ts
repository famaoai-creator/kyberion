import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { syntheticLatencyMeasurementContract } from './judgment-latency-fixture.js';
import { judgmentCanonicalHash } from './judgment-precedents.js';
import {
  syntheticLatencyArtifactBytes,
  verifySyntheticLatencyArtifact,
  type SyntheticLatencyExecutionProof,
} from './judgment-latency-verification.js';

const repair = { kind: 'synthetic-latency-configuration-v1', variant: 'bounded_parallel_v1' };
const baseline = { ...repair, variant: 'serial_v1' };
const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
function proof(id: string): SyntheticLatencyExecutionProof {
  return {
    work_ref: 'incident-1',
    effect_ref: `effect-${id}`,
    action_ref: `action-${id}`,
    operation_key: `operation-${id}`,
    work_item_id: `work-${id}`,
    claim_actor_id: `dot:${id}`,
    lease_id: `lease-${id}`,
    run_id: `run-${id}`,
  };
}
function fixture(configuration = repair) {
  // These expectations are independently pinned by controller code, not read from worker bytes.
  const bytes = JSON.stringify(configuration);
  return {
    artifactBytes: bytes,
    expectedFileSha256: digest(bytes),
    expectedConfigurationHash: judgmentCanonicalHash(configuration),
    workerProof: proof('repair'),
    verifierProof: proof('verify'),
    trustedMeasurement: syntheticLatencyMeasurementContract(),
  };
}

describe('pure synthetic artifact verification, with structural proofs only', () => {
  it('encodes deterministic known configurations and distinguishes bytes SHA from semantic hash', () => {
    for (const configuration of [baseline, repair]) {
      const encoded = syntheticLatencyArtifactBytes(configuration);
      expect(encoded.status).toBe('ready');
      if (encoded.status !== 'ready') throw new Error(encoded.detail);
      expect(encoded.bytes).toBe(JSON.stringify(configuration));
      expect(encoded.file_sha256).toBe(digest(encoded.bytes));
      expect(encoded.configuration_hash).toBe(judgmentCanonicalHash(configuration));
      expect(Buffer.byteLength(encoded.bytes)).toBeLessThanOrEqual(1024);
      expect(Object.isFrozen(encoded)).toBe(true);
    }
  });

  it('recomputes fixed synthetic p95 for the original 100 users without completion or authority', () => {
    const input = fixture();
    const before = structuredClone(input);
    const result = verifySyntheticLatencyArtifact(input);
    expect(result).toMatchObject({
      status: 'artifact_content_verified',
      work_ref: 'incident-1',
      artifact_sha256: input.expectedFileSha256,
      configuration_hash: input.expectedConfigurationHash,
      incremental_monthly_cost: 0,
      currency: 'JPY',
      measurement: { users: 100, p95_ms: 500, samples_ms: expect.any(Array) },
    });
    expect(input).toEqual(before);
    if (result.status !== 'artifact_content_verified') throw new Error(result.detail);
    expect(result.measurement.samples_ms).toHaveLength(100);
    expect(Object.isFrozen(result.measurement.samples_ms)).toBe(true);
    expect(Object.isFrozen(result.worker_proof)).toBe(true);
    expect(result.worker_proof).not.toBe(input.workerProof);
    input.workerProof.claim_actor_id = 'changed';
    expect(result.worker_proof.claim_actor_id).toBe('dot:repair');
    expect(result).not.toHaveProperty('authorized');
    expect(result).not.toHaveProperty('work_complete');
    expect(result).not.toHaveProperty('proof_authenticity');
    expect(verifySyntheticLatencyArtifact(before)).toEqual(result);
  });

  it('rejects a valid baseline that still misses the original latency goal', () => {
    expect(verifySyntheticLatencyArtifact(fixture(baseline))).toMatchObject({
      status: 'unavailable',
    });
  });

  it('rejects malformed, unknown, lossy and nonfinite configurations', () => {
    for (const configuration of [
      null,
      [],
      {},
      { ...repair, variant: 'unknown' },
      { ...repair, users: 65 },
      { ...repair, incremental_monthly_cost: 10 },
      { ...repair, model: 'worker-selected' },
      { ...repair, seed: 1 },
      { ...repair, hidden: undefined },
      { ...repair, p95: NaN },
      Object.defineProperty({ ...repair }, 'hidden', { value: true }),
      Object.defineProperty({ ...repair }, 'variant', {
        enumerable: true,
        get: () => 'bounded_parallel_v1',
      }),
      JSON.parse(
        '{"__proto__":{},"kind":"synthetic-latency-configuration-v1","variant":"bounded_parallel_v1"}'
      ),
    ])
      expect(syntheticLatencyArtifactBytes(configuration)).toMatchObject({ status: 'unavailable' });
  });

  it('rejects trailing, reordered, duplicate, padded, oversized and malformed JSON bytes even with recomputed file hashes', () => {
    const input = fixture();
    for (const bytes of [
      '',
      '{}',
      '{',
      `${input.artifactBytes}\n`,
      ` ${input.artifactBytes}`,
      `${input.artifactBytes}null`,
      'x'.repeat(1025),
      '{"variant":"bounded_parallel_v1","kind":"synthetic-latency-configuration-v1"}',
      '{"kind":"synthetic-latency-configuration-v1","variant":"serial_v1","variant":"bounded_parallel_v1"}',
      '{"kind":"synthetic-latency-configuration-v1","variant":"bounded_parallel_v1","p95_ms":1}',
    ])
      expect(
        verifySyntheticLatencyArtifact({
          ...input,
          artifactBytes: bytes,
          expectedFileSha256: digest(bytes),
        })
      ).toMatchObject({ status: 'unavailable' });
  });

  it('requires independently expected bytes and configuration hashes instead of hashes claimed by the worker', () => {
    const input = fixture();
    for (const changed of [
      { expectedFileSha256: 'f'.repeat(64) },
      { expectedConfigurationHash: 'f'.repeat(64) },
      { expectedFileSha256: 'not-a-hash' },
      { expectedConfigurationHash: judgmentCanonicalHash(baseline) },
      { artifactBytes: JSON.stringify(baseline) },
    ])
      expect(verifySyntheticLatencyArtifact({ ...input, ...changed })).toMatchObject({
        status: 'unavailable',
      });
  });

  it('pins the entire immutable specification, scope, seed, load profile and cost model', () => {
    const input = fixture();
    const contract = input.trustedMeasurement;
    for (const trustedMeasurement of [
      null,
      { ...contract, extra: true },
      { ...contract, model_hash: 'f'.repeat(64) },
      { ...contract, load_profile_hash: 'f'.repeat(64) },
      { ...contract, scope: { ...contract.scope, tenant_slug: 'other' } },
      { ...contract, load_profile: { ...contract.load_profile, seed: 1 } },
      { ...contract, load_profile: { ...contract.load_profile, cohort_users: [65] } },
      { ...contract, cost_model: { ...contract.cost_model, percentile: 1 } },
      { ...contract, cost_model: { ...contract.cost_model, parallel_overhead_ms: 0 } },
    ])
      expect(verifySyntheticLatencyArtifact({ ...input, trustedMeasurement })).toMatchObject({
        status: 'unavailable',
      });
  });

  it('requires same parent work and distinct structural actor/item/effect/action/operation/lease/run identities', () => {
    const input = fixture();
    expect(
      verifySyntheticLatencyArtifact({
        ...input,
        verifierProof: { ...input.verifierProof, work_ref: 'other-parent' },
      })
    ).toMatchObject({ status: 'unavailable' });
    for (const field of [
      'effect_ref',
      'action_ref',
      'operation_key',
      'work_item_id',
      'claim_actor_id',
      'lease_id',
      'run_id',
    ] as const) {
      expect(
        verifySyntheticLatencyArtifact({
          ...input,
          verifierProof: { ...input.verifierProof, [field]: input.workerProof[field] },
        })
      ).toMatchObject({ status: 'unavailable' });
    }
    for (const field of Object.keys(input.verifierProof)) {
      const missing: Record<string, unknown> = { ...input.verifierProof };
      delete missing[field];
      expect(verifySyntheticLatencyArtifact({ ...input, verifierProof: missing })).toMatchObject({
        status: 'unavailable',
      });
      expect(
        verifySyntheticLatencyArtifact({
          ...input,
          workerProof: { ...input.workerProof, [field]: ' padded ' },
        })
      ).toMatchObject({ status: 'unavailable' });
    }
    expect(
      verifySyntheticLatencyArtifact({
        ...input,
        verifierProof: { ...input.verifierProof, attempt_id: 'ambiguous' },
      })
    ).toMatchObject({ status: 'unavailable' });
  });

  it('refuses worker reported success metrics, unknown authority labels and lossy verification inputs', () => {
    const input = fixture();
    for (const extra of [
      { workerReport: { p95_ms: 1, users: 100, passed: true } },
      { approved: true },
      { model: 'alternative' },
      { verified: true },
      { path: '/tmp/worker' },
    ])
      expect(verifySyntheticLatencyArtifact({ ...input, ...extra })).toMatchObject({
        status: 'unavailable',
      });
    expect(
      verifySyntheticLatencyArtifact(Object.defineProperty({ ...input }, 'hidden', { value: true }))
    ).toMatchObject({ status: 'unavailable' });
    expect(
      verifySyntheticLatencyArtifact({
        ...input,
        verifierProof: { ...input.verifierProof, approved: true },
      })
    ).toMatchObject({ status: 'unavailable' });
  });
});
