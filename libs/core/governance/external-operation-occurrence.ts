import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

export interface ExternalOperationReservation {
  tenantSlug?: string;
  operationId: string;
  invocationId: string;
  effectHash: string;
}

const occurrences = new AsyncLocalStorage<readonly string[]>();
const empty: readonly string[] = Object.freeze([]);

/** Execution-owned nesting identity; never hydrate this from action JSON. */
export function withExternalOperationOccurrence<T>(segment: string, body: () => T): T {
  return occurrences.run(Object.freeze([...currentExternalOperationOccurrence(), segment]), body);
}

export function currentExternalOperationOccurrence(): readonly string[] {
  return occurrences.getStore() ?? empty;
}

/** Opaque correlation key a provider adapter may attach to its request. */
export function externalOperationProviderReference(input: ExternalOperationReservation): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.tenantSlug ?? '',
        input.operationId,
        input.invocationId,
        input.effectHash,
      ])
    )
    .digest('hex');
}
