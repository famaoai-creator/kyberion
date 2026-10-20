/** Immutable, exclusive execution reservation. A reservation is never a retry grant. */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { safeWriteFile } from '../secure-io.js';
import { rootResolve } from '../path-resolver.js';
import {
  storageFloorRelativePath,
  storagePartitionSegments,
  PARTITIONED_RUNTIME_STATE_ROOTS,
} from '../storage-layout.js';
import { getRegisteredEnvText, isVitestProcess } from '../foundation/env.js';

export interface ExternalOperationReservation {
  tenantSlug?: string;
  operationId: string;
  invocationId: string;
  effectHash: string;
}

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

export function externalOperationReservationRelativePath(
  input: ExternalOperationReservation,
  env: Record<string, string | undefined> = process.env
): string {
  const partition = {
    kind: 'tier' as const,
    tier: input.tenantSlug ? ('confidential' as const) : ('personal' as const),
    ...(input.tenantSlug ? { tenant: input.tenantSlug } : {}),
  };
  const key = digest(
    JSON.stringify([input.tenantSlug ?? '', input.operationId, input.invocationId])
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
    safeWriteFile(
      rootResolve(externalOperationReservationRelativePath(input)),
      JSON.stringify({
        version: 1,
        state: 'started',
        started_at: new Date().toISOString(),
        operation_hash: digest(input.operationId),
        invocation_hash: digest(input.invocationId),
        effect_hash: input.effectHash,
      }),
      { createOnly: true, mode: 0o600 }
    );
  } catch (error) {
    if ((error as { code?: string }).code === 'EEXIST') {
      throw new Error(
        '[EXTERNAL_EXECUTION_ALREADY_RESERVED] Verify prior execution; do not rerun the effect'
      );
    }
    throw error;
  }
}
