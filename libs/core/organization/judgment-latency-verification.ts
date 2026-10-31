/** Pure fixed-cost fixture verification, not real performance or execution authority. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { judgmentCanonicalHash } from './judgment-precedents.js';
import {
  measureSyntheticLatency,
  syntheticLatencyMeasurementContract,
} from './judgment-latency-fixture.js';

const unavailable = (detail: string) => ({
  status: 'unavailable' as const,
  reason: 'missing_evidence' as const,
  detail,
});
const key = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value === value.trim());
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const proofSchema = z
  .object({
    work_ref: key,
    effect_ref: key,
    action_ref: key,
    operation_key: key,
    work_item_id: key,
    claim_actor_id: key,
    lease_id: key,
    run_id: key,
  })
  .strict();
/** Structure only. The caller must reconstruct these fields from actual execution/claim stores. */
export type SyntheticLatencyExecutionProof = z.infer<typeof proofSchema>;
const verificationSchema = z
  .object({
    artifactBytes: z.string().min(1),
    expectedFileSha256: hash,
    expectedConfigurationHash: hash,
    workerProof: proofSchema,
    verifierProof: proofSchema,
    trustedMeasurement: z.unknown(),
  })
  .strict();
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const sha256 = (bytes: string) => createHash('sha256').update(bytes, 'utf8').digest('hex');

/** Canonical bytes for one of the two fixed known fixture configurations, at most 1 KiB. */
export function syntheticLatencyArtifactBytes(configuration: unknown) {
  try {
    const before = judgmentCanonicalHash(configuration);
    const measured = measureSyntheticLatency(configuration, 100);
    if (measured.status !== 'measured' || before !== measured.configuration_hash)
      return unavailable('Unknown or lossy synthetic configuration');
    const bytes = JSON.stringify(measured.configuration);
    if (Buffer.byteLength(bytes, 'utf8') > 1024)
      return unavailable('Fixture artifact exceeds 1 KiB');
    return freeze({
      status: 'ready' as const,
      bytes,
      file_sha256: sha256(bytes),
      configuration_hash: measured.configuration_hash,
    });
  } catch {
    return unavailable('Synthetic configuration cannot be encoded');
  }
}

/**
 * Expected hashes and measurement contract must come independently from the controller, never
 * from worker claims or the supplied file. Proof DTO checks establish structure, not authenticity.
 * A valid result is neither completed work nor permission: the caller still requires actual
 * independent claims and same-condition reobservation before declaring its parent work complete.
 */
export function verifySyntheticLatencyArtifact(input: {
  artifactBytes: unknown;
  expectedFileSha256: unknown;
  expectedConfigurationHash: unknown;
  workerProof: unknown;
  verifierProof: unknown;
  trustedMeasurement: unknown;
}) {
  try {
    const before = judgmentCanonicalHash(input);
    const parsed = verificationSchema.parse(input);
    if (before !== judgmentCanonicalHash(parsed)) return unavailable('Verification input is lossy');
    if (Buffer.byteLength(parsed.artifactBytes, 'utf8') > 1024)
      return unavailable('Fixture artifact exceeds 1 KiB');
    const contract = syntheticLatencyMeasurementContract();
    if (judgmentCanonicalHash(parsed.trustedMeasurement) !== judgmentCanonicalHash(contract))
      return unavailable('Fixed measurement specification, model or load profile differs');
    const artifact = syntheticLatencyArtifactBytes(JSON.parse(parsed.artifactBytes));
    if (
      artifact.status !== 'ready' ||
      artifact.bytes !== parsed.artifactBytes ||
      artifact.file_sha256 !== parsed.expectedFileSha256 ||
      artifact.configuration_hash !== parsed.expectedConfigurationHash
    )
      return unavailable('Artifact bytes or independent expected hashes differ');
    if (parsed.workerProof.work_ref !== parsed.verifierProof.work_ref)
      return unavailable('Execution proofs belong to different parent work');
    for (const field of [
      'effect_ref',
      'action_ref',
      'operation_key',
      'work_item_id',
      'claim_actor_id',
      'lease_id',
      'run_id',
    ] as const) {
      if (parsed.workerProof[field] === parsed.verifierProof[field])
        return unavailable(`Independent execution proof differs insufficiently: ${field}`);
    }
    const measurement = measureSyntheticLatency(JSON.parse(artifact.bytes), 100);
    if (
      measurement.status !== 'measured' ||
      measurement.users !== 100 ||
      measurement.p95_ms > 500 ||
      measurement.load_profile_hash !== contract.load_profile_hash ||
      measurement.model_hash !== contract.model_hash
    )
      return unavailable('Original fixed 100-user latency goal is not met');
    // Both known configurations incur zero synthetic incremental JPY; arbitrary cost/model
    // parameters are not part of the accepted artifact schema.
    return freeze({
      status: 'artifact_content_verified' as const,
      work_ref: parsed.workerProof.work_ref,
      worker_proof: structuredClone(parsed.workerProof),
      verifier_proof: structuredClone(parsed.verifierProof),
      artifact_sha256: artifact.file_sha256,
      configuration_hash: artifact.configuration_hash,
      measurement_contract_hash: judgmentCanonicalHash(contract),
      incremental_monthly_cost: 0 as const,
      currency: 'JPY' as const,
      measurement,
    });
  } catch {
    return unavailable('Synthetic artifact or execution proof is malformed');
  }
}
