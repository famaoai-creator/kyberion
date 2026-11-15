/** Encrypted local registration only. No runtime material reader or session transport. */
import { createHash } from 'node:crypto';
import { resolveAssumedRole } from '../authority.js';
import { credentialExecutionIdentity } from '../foundation/credential-binding.js';
import { assertGwsSessionRegistrationAdmission } from '../foundation/gws-session-registration-admission.js';
import { withLockSync } from '../foundation/lock-utils.js';
import { readJson, writeJson } from '../foundation/json.js';
import { pathResolver } from '../path-resolver.js';
import { getPluginExecutionContext } from '../shell/sandbox-policy.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  withSensitivePathMediation,
} from '../secure-io.js';
import {
  decryptConnectionDocument,
  encryptConnectionDocument,
  isEncryptedConnectionEnvelope,
} from './secret-encryption.js';
import {
  preflightGwsSessionRegistration,
  validateGwsSessionMaterial,
  type GwsAuthorizedUserMaterial,
  type GwsSessionRegistrationTarget,
  type GwsSessionStageIdentity,
} from './gws-session-registration-contract.js';

type Entry = { stage: GwsSessionStageIdentity; material: GwsAuthorizedUserMaterial };
type State = { current: Entry | null; pending: Entry | null };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digest = /^[0-9a-f]{64}$/;
const identifier = /^[A-Za-z0-9:._-]{1,160}$/;
const deny = (reason: string): never => {
  throw new Error(`[GWS_SESSION_STORE] ${reason}`);
};

function guarded<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof Error && /^\[GWS_SESSION_STORE\] [a-z_]+$/.test(error.message))
      throw error;
    return deny('unavailable');
  }
}
function operator(): void {
  const actor = credentialExecutionIdentity();
  if (
    actor.tenantSlug ||
    actor.personalClaim ||
    getPluginExecutionContext() ||
    resolveAssumedRole() !== 'sovereign_concierge'
  )
    deny('operator_required');
}
/** Inspect data descriptors so even malformed caller objects cannot run getters. */
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).sort().join(',') !== [...keys].sort().join(',')
  )
    deny('invalid_record');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((field) => !('value' in field))) deny('invalid_record');
  return Object.fromEntries(Object.entries(descriptors).map(([key, field]) => [key, field.value]));
}
function targetCopy(value: unknown): GwsSessionRegistrationTarget {
  const copy = exact(value, [
    'bindingId',
    'serviceId',
    'ownerKind',
    'ownerRef',
    'tenantSlug',
    'authMode',
    'expectedGeneration',
  ]);
  preflightGwsSessionRegistration(copy as unknown as GwsSessionRegistrationTarget);
  return Object.freeze(copy) as unknown as GwsSessionRegistrationTarget;
}
function stageCopy(value: unknown): GwsSessionStageIdentity {
  const copy = exact(value, [
    'version',
    'requestId',
    'target',
    'generation',
    'requesterActorId',
    'approvalId',
    'bindingSnapshotDigest',
    'brokerConfigurationDigest',
  ]);
  const target = targetCopy(copy.target);
  if (
    copy.version !== 1 ||
    typeof copy.requestId !== 'string' ||
    !uuid.test(copy.requestId) ||
    typeof copy.generation !== 'string' ||
    !uuid.test(copy.generation) ||
    copy.generation === target.expectedGeneration ||
    typeof copy.requesterActorId !== 'string' ||
    !identifier.test(copy.requesterActorId) ||
    typeof copy.approvalId !== 'string' ||
    !identifier.test(copy.approvalId) ||
    typeof copy.bindingSnapshotDigest !== 'string' ||
    !digest.test(copy.bindingSnapshotDigest) ||
    typeof copy.brokerConfigurationDigest !== 'string' ||
    !digest.test(copy.brokerConfigurationDigest)
  )
    deny('invalid_stage');
  return Object.freeze({
    version: 1,
    requestId: copy.requestId,
    target,
    generation: copy.generation,
    requesterActorId: copy.requesterActorId,
    approvalId: copy.approvalId,
    bindingSnapshotDigest: copy.bindingSnapshotDigest,
    brokerConfigurationDigest: copy.brokerConfigurationDigest,
  }) as GwsSessionStageIdentity;
}
function account(target: GwsSessionRegistrationTarget): string {
  return JSON.stringify([
    target.serviceId,
    target.bindingId,
    target.ownerKind,
    target.ownerRef,
    target.tenantSlug,
  ]);
}
function location(target: GwsSessionRegistrationTarget) {
  const id = createHash('sha256').update(account(target)).digest('hex');
  const file = pathResolver.resolve(
    `knowledge/personal/connections/accounts/${id}/gws-session-registration.json`
  );
  return { id, file };
}
function entry(value: unknown, target: GwsSessionRegistrationTarget): Entry | null {
  if (value === null) return null;
  const fields = exact(value, ['stage', 'material']);
  const stage = stageCopy(fields.stage);
  if (account(stage.target) !== account(target)) deny('identity_mismatch');
  return { stage, material: validateGwsSessionMaterial(fields.material) };
}
function read(target: GwsSessionRegistrationTarget): State {
  return withSensitivePathMediation(() => {
    const file = assertSafeRepositoryPath(location(target).file, { allowMissingLeaf: true });
    if (!safeExistsSync(file)) return { current: null, pending: null };
    const envelope = readJson<unknown>(file, {
      maxSizeMB: 0.25,
      label: 'encrypted GWS session',
    });
    if (!isEncryptedConnectionEnvelope(envelope)) return deny('encrypted_record_required');
    const raw = exact(decryptConnectionDocument(envelope), [
      'kind',
      'version',
      'account',
      'current',
      'pending',
    ]);
    if (
      raw.kind !== 'gws-session-registration' ||
      raw.version !== 1 ||
      raw.account !== account(target)
    )
      deny('identity_mismatch');
    const state = { current: entry(raw.current, target), pending: entry(raw.pending, target) };
    if (
      state.pending &&
      state.pending.stage.target.expectedGeneration !== (state.current?.stage.generation ?? null)
    )
      deny('invalid_record');
    return state;
  });
}
function write(target: GwsSessionRegistrationTarget, state: State): void {
  const envelope = encryptConnectionDocument(
    {
      kind: 'gws-session-registration',
      version: 1,
      account: account(target),
      current: state.current,
      pending: state.pending,
    },
    { createKeyIfMissing: false }
  );
  withSensitivePathMediation(() => {
    const file = assertSafeRepositoryPath(location(target).file, { allowMissingLeaf: true });
    // secure-io atomically replaces and fsyncs the file and parent directory.
    writeJson(file, envelope, { mode: 0o600 });
  });
}
function same(a: GwsSessionStageIdentity, b: GwsSessionStageIdentity): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
function metadata(state: State) {
  return Object.freeze({
    generation: state.current?.stage.generation ?? null,
    ...(state.current ? { currentStage: state.current.stage } : {}),
    ...(state.pending ? { pendingStage: state.pending.stage } : {}),
  });
}

/** Metadata only; expectedGeneration is ignored for read addressing. */
export function loadGwsSessionRegistration(target: GwsSessionRegistrationTarget) {
  return guarded(() => {
    operator();
    return metadata(read(targetCopy(target)));
  });
}
export function prepareGwsSessionRegistration(
  stage: GwsSessionStageIdentity,
  material: GwsAuthorizedUserMaterial
) {
  return guarded(() => {
    operator();
    assertGwsSessionRegistrationAdmission(stage);
    const copy = stageCopy(stage);
    const values = validateGwsSessionMaterial(material);
    return withLockSync(`gws-session-store:${location(copy.target).id}`, () => {
      operator();
      assertGwsSessionRegistrationAdmission(stage);
      const state = read(copy.target);
      if (state.pending) deny('recovery_required');
      if ((state.current?.stage.generation ?? null) !== copy.target.expectedGeneration)
        deny('generation_conflict');
      write(copy.target, { ...state, pending: { stage: copy, material: values } });
      return Object.freeze({ stage: copy, status: 'staged' as const });
    });
  });
}
export function commitGwsSessionRegistration(
  stage: GwsSessionStageIdentity,
  revalidate: () => void
) {
  return guarded(() => {
    operator();
    assertGwsSessionRegistrationAdmission(stage);
    const copy = stageCopy(stage);
    return withLockSync(`gws-session-store:${location(copy.target).id}`, () => {
      const state = read(copy.target);
      if (!state.pending || !same(state.pending.stage, copy)) deny('stage_changed');
      if ((state.current?.stage.generation ?? null) !== copy.target.expectedGeneration)
        deny('generation_conflict');
      // Admission has already come from the approved facade; callback supplies fresh
      // approval/owner/binding checks, not a substitute caller-created capability.
      if (revalidate() !== undefined) deny('synchronous_revalidation_required');
      operator();
      assertGwsSessionRegistrationAdmission(stage);
      if (!same(stageCopy(stage), copy)) deny('stage_changed');
      const next = read(copy.target);
      if (JSON.stringify(next) !== JSON.stringify(state)) deny('stage_changed');
      write(copy.target, { current: state.pending, pending: null });
      return Object.freeze({ stage: copy, status: 'committed' as const });
    });
  });
}
export function abortGwsSessionRegistration(stage: GwsSessionStageIdentity) {
  return guarded(() => {
    operator();
    assertGwsSessionRegistrationAdmission(stage);
    const copy = stageCopy(stage);
    return withLockSync(`gws-session-store:${location(copy.target).id}`, () => {
      operator();
      assertGwsSessionRegistrationAdmission(stage);
      const state = read(copy.target);
      if (state.current && same(state.current.stage, copy)) deny('already_committed');
      if (state.pending && !same(state.pending.stage, copy)) deny('stage_changed');
      if (state.pending) write(copy.target, { ...state, pending: null });
      return Object.freeze({ stage: copy, status: 'aborted' as const });
    });
  });
}
