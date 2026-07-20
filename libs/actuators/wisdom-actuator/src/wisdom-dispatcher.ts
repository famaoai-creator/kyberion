import { buildWisdomOperationRegistry, getWisdomOperationSpec } from './op-catalog.js';
import type { WisdomContext } from './contracts/wisdom-context.js';
import { makeWisdomReceipt, type WisdomReceipt } from './contracts/wisdom-result.js';
import type { WisdomOperationKind } from './contracts/wisdom-operation.js';

export interface WisdomStepHandlers {
  capture(op: string, params: unknown, context: WisdomContext): Promise<WisdomContext | undefined>;
  transform(
    op: string,
    params: unknown,
    context: WisdomContext
  ): Promise<WisdomContext | undefined>;
  apply(op: string, params: unknown, context: WisdomContext): Promise<WisdomContext | undefined>;
}

export interface WisdomDispatcherOptions {
  fallback?: (
    kind: WisdomOperationKind,
    op: string,
    params: unknown,
    context: WisdomContext
  ) => Promise<WisdomContext>;
}

export interface WisdomDispatchResult {
  context: WisdomContext;
  receipt: WisdomReceipt;
}

export interface WisdomDispatchOptions {
  compatibilityMode?: boolean;
}

function assertOperationKind(op: string, requestedKind: WisdomOperationKind): void {
  const spec = getWisdomOperationSpec(op);
  if (!spec) throw new Error(`[UNKNOWN_OP] Unknown wisdom operation: ${op}`);
  if (spec.kind !== requestedKind) {
    throw new Error(
      `[OP_KIND_MISMATCH] ${op} is registered as ${spec.kind}, but was invoked as ${requestedKind}`
    );
  }
}

export function createWisdomDispatcher(
  handlers: WisdomStepHandlers,
  options: WisdomDispatcherOptions = {}
) {
  const dispatch = async (
    kind: WisdomOperationKind,
    op: string,
    params: unknown,
    context: WisdomContext,
    _options: WisdomDispatchOptions = {}
  ): Promise<WisdomDispatchResult> => {
    assertOperationKind(op, kind);
    const spec = getWisdomOperationSpec(op);
    if (!spec) throw new Error(`[UNKNOWN_OP] Unknown wisdom operation: ${op}`);

    const handledContext = await handlers[kind](op, params, context);
    const nextContext =
      handledContext ??
      (options.fallback
        ? await options.fallback(kind, op, params, context)
        : (() => {
            throw new Error(`[UNKNOWN_OP] Unknown ${kind} operation: ${op}`);
          })());
    const canonicalOp = spec.canonical_op || op;
    const compatibility =
      spec.deprecated || spec.forward_to
        ? {
            ...(spec.forward_to ? { compatibility_alias: `wisdom:${op}` } : {}),
            ...(spec.deprecated ? { deprecated_alias: op } : {}),
            ...(spec.forward_to
              ? { forwarded_to: `${spec.forward_to.actuator}:${spec.forward_to.op}` }
              : {}),
            deprecated: true,
          }
        : undefined;
    return {
      context: nextContext,
      receipt: makeWisdomReceipt({
        requestedOp: op,
        canonicalOp,
        executionKind: spec.execution_kind || 'deterministic',
        compatibility,
        securityScope:
          nextContext.security_scope && typeof nextContext.security_scope === 'object'
            ? (nextContext.security_scope as WisdomReceipt['security_scope'])
            : undefined,
        retry: {
          attempts: 1,
          idempotency_class: spec.idempotency,
          automatic_retry: spec.idempotency === 'read' || spec.idempotency === 'idempotent_write',
        },
        traceSummary: {
          owner: spec.owner,
          idempotency_class: spec.idempotency,
          forwarded: Boolean(spec.forward_to),
        },
      }),
    };
  };

  return {
    dispatch,
    registry: buildWisdomOperationRegistry(async (op, input, context) => {
      const spec = getWisdomOperationSpec(op);
      if (!spec) throw new Error(`[UNKNOWN_OP] Unknown wisdom operation: ${op}`);
      return handlers[spec.kind](op, input, context);
    }),
  };
}
