/** Calibrated contract checks and saved-byte recovery; never execution authority. */
import { createHash, randomUUID } from 'node:crypto';
import { assertSafeRepositoryPath, safeLstat, safeReadFile, safeWriteFile } from '../secure-io.js';
import { resolveStorageFloor } from '../storage-layout.js';
import { runtimeScopeIdentity } from '../scope-envelope.js';
import { highestTierForPaths } from '../provider/provider-egress-gate.js';
import { KNOWLEDGE_TIER_RANK } from '../foundation/knowledge-tier.js';
import { pathResolver } from '../path-resolver.js';
import { withLock } from '../foundation/lock-utils.js';
import { readTextFile } from '../foundation/text.js';
import { parseSafeJsonInput } from '../foundation/safe-json.js';
import { createLogger } from '../logger.js';

const logger = createLogger('adf-repair:assurance');

export interface AssuredRepairResult {
  repaired: boolean;
  errors?: string[];
  report?: string;
  assurance?: {
    verifier: VerifierMeasurement;
    snapshot: RepairSnapshot;
    recoverability_class: 'saved_file';
    rolled_back: boolean;
    after_sha256?: string;
    rollback_refused?: boolean;
  };
}

/** Reviewed controls calibrate contract/guardrail discrimination, not business intent. */
function controlsForSchema(schemaName: string): VerifierSample[] {
  const positives =
    schemaName === 'pipeline-adf'
      ? [
          { steps: [{ op: 'system:log', params: {} }] },
          { id: 'calibration', steps: [{ op: 'system:log', params: { message: 'control' } }] },
        ]
      : schemaName === 'capability-input'
        ? [
            { capability: 'demo', action: 'run' },
            { skill: 'demo', action: 'run' },
          ]
        : [];
  return [
    ...positives.map((value, index) => ({ id: `valid-${index}`, value, expected: true })),
    ...[null, {}, { steps: 'invalid', action: 123 }, []].map((value, index) => ({
      id: `invalid-${index}`,
      value,
      expected: false,
    })),
    ...(schemaName === 'pipeline-adf'
      ? [
          {
            id: 'forbidden-shell-hook',
            value: {
              steps: [
                {
                  op: 'system:log',
                  params: {},
                  hooks: { before: [{ type: 'command', cmd: 'rm -rf /' }] },
                },
              ],
            },
            expected: false,
          },
        ]
      : []),
  ];
}

/** Serialized file-only repair transaction. The supplied repair is the host's
 * fixed advisory candidate path, never a model/caller-supplied mutator. */
export function withMeasuredAdfRepair(input: {
  target: string;
  schemaName: string;
  repairRequired: boolean;
  verify: (value: unknown) => boolean;
  repair: (commitCandidate: (content: string) => void) => Promise<AssuredRepairResult>;
  /** Additional narrowing verifier runs before releasing the same target lock. */
  postRepairValidation?: () => Promise<unknown>;
}): Promise<AssuredRepairResult> {
  const resource = createHash('sha256').update(input.target).digest('hex');
  return withLock(`adf-repair:${resource}`, async () => {
    const original = readTextFile(regularFile(input.target));
    try {
      if (!input.repairRequired && input.verify(parseSafeJsonInput(original, 'ADF input')))
        return { repaired: false };
    } catch {
      /* Invalid input is the reason repair is needed. */
    }
    const verifier = measureVerifier(controlsForSchema(input.schemaName), input.verify);
    const calibration = evaluateUnattendedRepair({
      measurement: verifier,
      snapshotVerified: true,
      externalEffects: false,
    });
    if (!calibration.allowed) {
      logger.warn(
        `repair refused — ${calibration.reason} | next: add reviewed calibration controls or request operator review | evidence: ${JSON.stringify(verifier)}`
      );
      return { repaired: false, errors: [`[REPAIR_ASSURANCE] ${calibration.reason}`] };
    }
    const snapshot = saveRepairSnapshot(input.target);
    const assurance: NonNullable<AssuredRepairResult['assurance']> = {
      verifier,
      snapshot,
      recoverability_class: 'saved_file',
      rolled_back: false,
    };
    let expectedDigest = snapshot.before_sha256;
    let hostWrote = false;
    const currentDigest = () =>
      digest(safeReadFile(regularFile(input.target), { encoding: null }) as Buffer);
    const commitCandidate = (content: string) => {
      if (currentDigest() !== expectedDigest)
        throw new Error('[REPAIR_ASSURANCE] target changed before host commit');
      const nextDigest = digest(Buffer.from(content, 'utf8'));
      safeWriteFile(input.target, content, { encoding: 'utf8' });
      if (currentDigest() !== nextDigest)
        throw new Error('[REPAIR_ASSURANCE] host commit read-back mismatch');
      expectedDigest = nextDigest;
      hostWrote = true;
    };
    const rejectMutation = () => {
      let current: string;
      try {
        current = currentDigest();
      } catch {
        assurance.rollback_refused = true;
        return;
      }
      assurance.after_sha256 = current;
      // Only the host's own last write is eligible for an inverse operation.
      // A changed target before the first host write is external as well.
      if (current !== expectedDigest) {
        assurance.rollback_refused = true;
      } else if (hostWrote && current !== snapshot.before_sha256) {
        restoreRepairSnapshot(snapshot);
        assurance.rolled_back = true;
        assurance.after_sha256 = snapshot.before_sha256;
      }
    };
    try {
      const result = await input.repair(commitCandidate);
      if (currentDigest() !== expectedDigest)
        throw new Error('[REPAIR_ASSURANCE] target changed outside host commit');
      if (result.repaired) {
        if (!hostWrote)
          throw new Error('[REPAIR_ASSURANCE] repair reported success without a host commit');
        await input.postRepairValidation?.();
        if (currentDigest() !== expectedDigest)
          throw new Error('[REPAIR_ASSURANCE] target changed during caller verification');
      }
      if (!result.repaired) rejectMutation();
      assurance.after_sha256 = currentDigest();
      logger.info(JSON.stringify({ repaired: result.repaired, ...assurance }));
      return { ...result, assurance };
    } catch (error) {
      rejectMutation();
      logger.warn(
        `repair rejected — ${assurance.rollback_refused ? 'newer bytes preserved; rollback refused' : 'saved bytes restored'} | next: inspect repair errors before retry | evidence: ${JSON.stringify(assurance)}`
      );
      return {
        repaired: false,
        errors: [error instanceof Error ? error.message : String(error)],
        assurance,
      };
    }
  });
}

export interface VerifierSample {
  id: string;
  value: unknown;
  expected: boolean;
}

export interface VerifierMeasurement {
  samples: number;
  positives: number;
  negatives: number;
  false_admits: number;
  false_rejects: number;
  errors: number;
  agreement: number;
  discriminates: boolean;
}

/** Labels come from reviewed control cases, not the model being evaluated. */
export function measureVerifier(
  samples: readonly VerifierSample[],
  verify: (value: unknown) => boolean
): VerifierMeasurement {
  let false_admits = 0;
  let false_rejects = 0;
  let errors = 0;
  const observed = new Set<boolean>();
  for (const sample of samples) {
    try {
      const result = verify(sample.value);
      if (typeof result !== 'boolean') throw new Error('verifier must return a boolean');
      observed.add(result);
      if (result && !sample.expected) false_admits++;
      if (!result && sample.expected) false_rejects++;
    } catch {
      errors++;
    }
  }
  return {
    samples: samples.length,
    positives: samples.filter((sample) => sample.expected).length,
    negatives: samples.filter((sample) => !sample.expected).length,
    false_admits,
    false_rejects,
    errors,
    agreement: samples.length
      ? (samples.length - false_admits - false_rejects - errors) / samples.length
      : 0,
    discriminates: observed.size === 2,
  };
}

export function evaluateUnattendedRepair(input: {
  measurement: VerifierMeasurement;
  snapshotVerified: boolean;
  externalEffects: boolean;
}): { allowed: boolean; reason: string; recoverability_class: 'saved_file' | 'unrecoverable' } {
  const m = input.measurement;
  const calibrated =
    m.samples >= 4 &&
    m.positives >= 2 &&
    m.negatives >= 2 &&
    m.discriminates &&
    m.false_admits === 0 &&
    m.false_rejects === 0 &&
    m.errors === 0 &&
    m.agreement === 1;
  if (!calibrated)
    return {
      allowed: false,
      reason: 'verifier failed reviewed positive/negative controls',
      recoverability_class: 'unrecoverable',
    };
  if (input.externalEffects || !input.snapshotVerified)
    return {
      allowed: false,
      reason: 'exact file recovery is not established or external effects are present',
      recoverability_class: 'unrecoverable',
    };
  return {
    allowed: true,
    reason: 'reviewed contract controls passed; saved file verified',
    recoverability_class: 'saved_file',
  };
}

export interface RepairSnapshot {
  target: string;
  snapshot_ref: string;
  before_sha256: string;
}
const issuedSnapshots = new WeakSet<RepairSnapshot>();

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function regularFile(filePath: string): string {
  const resolved = assertSafeRepositoryPath(filePath);
  if (!safeLstat(resolved).isFile()) throw new Error('[REPAIR_ASSURANCE] expected regular file');
  return resolved;
}

export function saveRepairSnapshot(target: string): RepairSnapshot {
  const resolved = regularFile(target);
  const scope = runtimeScopeIdentity();
  const pathTier = highestTierForPaths([resolved]);
  const tier =
    KNOWLEDGE_TIER_RANK[scope.tier] > KNOWLEDGE_TIER_RANK[pathTier] ? scope.tier : pathTier;
  if (tier === 'confidential' && !scope.tenant_slug)
    throw new Error('[REPAIR_ASSURANCE] confidential snapshot requires runtime tenant scope');
  const bytes = safeReadFile(resolved, { encoding: null }) as Buffer;
  const snapshotPath = resolveStorageFloor(
    'scratch',
    { kind: 'tier', tier, tenant: scope.tenant_slug },
    'adf-repair',
    randomUUID(),
    'original.json'
  );
  safeWriteFile(snapshotPath, bytes, { mkdir: true });
  if (
    digest(safeReadFile(regularFile(snapshotPath), { encoding: null }) as Buffer) !== digest(bytes)
  )
    throw new Error('[REPAIR_ASSURANCE] snapshot verification failed');
  const snapshot = Object.freeze({
    target: pathResolver.toRepoRelative(resolved),
    snapshot_ref: pathResolver.toRepoRelative(snapshotPath),
    before_sha256: digest(bytes),
  });
  issuedSnapshots.add(snapshot);
  return snapshot;
}

/** Restores saved bytes; generating an inverse edit is deliberately impossible. */
export function restoreRepairSnapshot(snapshot: RepairSnapshot): void {
  if (!issuedSnapshots.has(snapshot))
    throw new Error('[REPAIR_ASSURANCE] snapshot was not issued by this repair host');
  const bytes = safeReadFile(regularFile(pathResolver.rootResolve(snapshot.snapshot_ref)), {
    encoding: null,
  }) as Buffer;
  if (digest(bytes) !== snapshot.before_sha256)
    throw new Error('[REPAIR_ASSURANCE] snapshot digest mismatch');
  const target = regularFile(pathResolver.rootResolve(snapshot.target));
  safeWriteFile(target, bytes);
  if (digest(safeReadFile(target, { encoding: null }) as Buffer) !== snapshot.before_sha256)
    throw new Error('[REPAIR_ASSURANCE] exact restoration failed');
}
