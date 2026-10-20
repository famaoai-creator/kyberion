import { AsyncLocalStorage } from 'node:async_hooks';
import { currentScopeEnvelope } from '../scope-envelope.js';
import { computeApprovalPayloadHash } from '../governance/approval-store.js';
import {
  runExternalOperation,
  type ExternalOperationAuthority,
} from '../governance/external-operation.js';

export type CalendarMutationKind = 'create_event' | 'update_event' | 'delete_event';
interface Admission {
  kind: CalendarMutationKind;
  hash: string;
  consumed: boolean;
}
const context = new AsyncLocalStorage<Map<object, Admission>>();

function consume(input: object, kind: CalendarMutationKind): boolean {
  const admission = context.getStore()?.get(input);
  if (!admission) return false;
  if (
    admission.kind !== kind ||
    admission.hash !== computeApprovalPayloadHash(input as Record<string, unknown>) ||
    admission.consumed
  ) {
    throw new Error(
      '[CALENDAR_ADMISSION_MISMATCH] Calendar admission changed or was already consumed'
    );
  }
  admission.consumed = true;
  return true;
}

function scoped<T>(input: object, kind: CalendarMutationKind, body: () => T): T {
  const entries = new Map(context.getStore());
  entries.set(input, {
    kind,
    hash: computeApprovalPayloadHash(input as Record<string, unknown>),
    consumed: false,
  });
  return context.run(entries, body);
}

/** Carry one exact admitted adapter input to its mapped provider request. */
export function forwardCalendarExternalEffect<T>(
  source: object,
  target: object,
  kind: CalendarMutationKind,
  body: () => T
): T {
  return consume(source, kind) ? scoped(target, kind, body) : body();
}

/** Mutation admission, including direct workflow/backend callers. Nested calls
 * consume an object/hash-bound single-use capability rather than re-approving. */
export function runCalendarExternalEffect<T>(
  input: object,
  kind: CalendarMutationKind,
  effect: Record<string, unknown>,
  execute: () => Promise<T>,
  authority?: ExternalOperationAuthority
): Promise<T> {
  if (consume(input, kind)) return scoped(input, kind, execute);
  const tenantSlug = currentScopeEnvelope()?.identity.tenant_slug;
  return runExternalOperation(
    {
      operationId: `calendar:${kind}`,
      effect,
      requiresApproval: true,
      delegable: kind !== 'delete_event',
      ...(tenantSlug ? { tenantSlug } : {}),
      authority,
    },
    () => scoped(input, kind, execute),
    (result) => {
      const record =
        result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
      if (record.ok === false || ['error', 'failed', 'denied'].includes(String(record.status)))
        return 'failed';
      if (
        record.ok === true ||
        ['success', 'created', 'updated', 'deleted', 'cancelled'].includes(String(record.status))
      )
        return 'succeeded';
      return 'unknown';
    }
  );
}
