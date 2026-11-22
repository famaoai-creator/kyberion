/** Immutable, exclusive execution reservation. A reservation is never a retry grant. */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { safeWriteFile } from '../secure-io.js';
import { rootResolve } from '../path-resolver.js';
import { readJsonIfPresent } from '../foundation/json.js';
import {
  storageFloorRelativePath,
  storagePartitionSegments,
  PARTITIONED_RUNTIME_STATE_ROOTS,
} from '../storage-layout.js';
import { getRegisteredEnvText, isVitestProcess } from '../foundation/env.js';
import {
  currentPrPublicationScope,
  withPrPublicationStoreAccess,
  currentVcsPublicationOperation,
} from './pr-publication-runtime.js';
import { currentInstalledPersonCharterRuntime } from './person-charter-runtime.js';
import { withPersonReservationAccess } from './person-charter-store-access.js';
import {
  externalOperationProviderReference,
  type ExternalOperationReservation,
} from './external-operation-occurrence.js';
export {
  externalOperationProviderReference,
  type ExternalOperationReservation,
} from './external-operation-occurrence.js';

export interface ExternalOperationOutcome {
  outcome: 'succeeded' | 'failed' | 'unknown';
  providerReceiptId?: string;
}

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

export function externalOperationReservationRelativePath(
  input: ExternalOperationReservation,
  env: Record<string, string | undefined> = process.env,
  kind: 'reservation' | 'outcome' = 'reservation'
): string {
  const partition = {
    kind: 'tier' as const,
    tier: input.tenantSlug ? ('confidential' as const) : ('personal' as const),
    ...(input.tenantSlug ? { tenant: input.tenantSlug } : {}),
  };
  const key = digest(
    JSON.stringify([
      input.tenantSlug ?? '',
      input.operationId,
      input.invocationId,
      ...(kind === 'outcome' ? ['outcome'] : []),
    ])
  );
  if (isVitestProcess(env)) {
    const run = String(getRegisteredEnvText('KYBERION_VITEST_RUN_ID', { env }) || 'run').replace(
      /[^\w-]/g,
      ''
    );
    const pool = String(env.VITEST_POOL_ID || 'pool').replace(/[^\w-]/g, '');
    return storageFloorRelativePath(
      'scratch',
      partition,
      'vitest-external-operations',
      run,
      pool,
      `${key}.json`
    );
  }
  return path.posix.join(
    PARTITIONED_RUNTIME_STATE_ROOTS.external_operations,
    ...storagePartitionSegments(partition),
    `${key}.json`
  );
}

/** Cross-process atomic creation survives restarts. Existing records always block. */
export function reserveExternalOperation(input: ExternalOperationReservation): void {
  if (!input.operationId.trim() || !input.invocationId.trim())
    throw new Error('[EXTERNAL_IDENTITY_REQUIRED] Reservation needs operation and invocation');
  try {
    writeOperationRecord(input, 'reservation', {
      version: 1,
      state: 'started',
      started_at: new Date().toISOString(),
      operation_hash: digest(input.operationId),
      invocation_hash: digest(input.invocationId),
      effect_hash: input.effectHash,
    });
  } catch (error) {
    if ((error as { code?: string }).code === 'EEXIST') {
      throw new Error(
        '[EXTERNAL_EXECUTION_ALREADY_RESERVED] Verify prior execution; do not rerun the effect'
      );
    }
    throw error;
  }
}

function writeOperationRecord(
  input: ExternalOperationReservation,
  kind: 'reservation' | 'outcome',
  record: Record<string, unknown>
): void {
  const relative = externalOperationReservationRelativePath(input, process.env, kind);
  const write = () =>
    safeWriteFile(rootResolve(relative), JSON.stringify(record), {
      createOnly: true,
      mode: 0o600,
    });
  const publication = currentPrPublicationScope();
  if (
    publication &&
    input.operationId === currentVcsPublicationOperation() &&
    (publication.kind === 'person'
      ? !input.tenantSlug
      : publication.tenant_slug === input.tenantSlug)
  )
    withPrPublicationStoreAccess('reservation-write', [], [relative], write);
  else if (!input.tenantSlug && currentInstalledPersonCharterRuntime())
    withPersonReservationAccess(relative, write);
  else write();
}

const RECEIPT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/** Append an immutable result beside the reservation without reopening execution. */
export function persistExternalOperationOutcome(
  input: ExternalOperationReservation,
  result: ExternalOperationOutcome
): void {
  const providerReceiptId = result.providerReceiptId;
  writeOperationRecord(input, 'outcome', {
    version: 1,
    state: result.outcome,
    effect_hash: input.effectHash,
    ...(typeof providerReceiptId === 'string' && RECEIPT_ID.test(providerReceiptId)
      ? { provider_receipt_id: providerReceiptId }
      : {}),
  });
}

/** Read under the caller's ordinary tenant/tier authority. No provider calls or retries. */
export function readExternalOperationStatus(
  input: ExternalOperationReservation
): { state: 'started' | ExternalOperationOutcome['outcome']; providerReceiptId?: string } | null {
  const read = (kind: 'reservation' | 'outcome') =>
    readJsonIfPresent<{
      version: number;
      state: string;
      effect_hash: string;
      provider_receipt_id?: string;
    }>(rootResolve(externalOperationReservationRelativePath(input, process.env, kind)));
  const start = read('reservation');
  if (!start) return null;
  const result = read('outcome');
  if (
    start.version !== 1 ||
    start.state !== 'started' ||
    start.effect_hash !== input.effectHash ||
    (result && (result.version !== 1 || result.effect_hash !== start.effect_hash))
  ) {
    throw new Error(
      '[EXTERNAL_EVIDENCE_MISMATCH] reservation or outcome does not match the effect'
    );
  }
  if (!result) return { state: 'started' };
  const state = result.state;
  if (state !== 'succeeded' && state !== 'failed' && state !== 'unknown')
    throw new Error('[EXTERNAL_EVIDENCE_MISMATCH] invalid outcome');
  const id = result.provider_receipt_id;
  return {
    state,
    ...(typeof id === 'string' && RECEIPT_ID.test(id) ? { providerReceiptId: id } : {}),
  };
}

/** Check a provider through a trusted read-only adapter. A lookup never creates a reservation. */
export async function reconcileExternalOperation(
  input: ExternalOperationReservation,
  lookup: (reference: {
    correlationId: string;
    providerReceiptId?: string;
  }) => Promise<ExternalOperationOutcome | null>
): Promise<ExternalOperationOutcome | null> {
  const local = readExternalOperationStatus(input);
  if (!local) return null;
  return lookup({
    correlationId: externalOperationProviderReference(input),
    ...(local.providerReceiptId ? { providerReceiptId: local.providerReceiptId } : {}),
  });
}
