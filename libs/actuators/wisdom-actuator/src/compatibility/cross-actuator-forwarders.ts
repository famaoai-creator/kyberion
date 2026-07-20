import { getActuatorForwardingPort, type ContextSecurityScope } from '@agent/core';
import { assignWisdomContextValue } from '../contracts/wisdom-context.js';
import type { WisdomContext } from '../contracts/wisdom-context.js';
import { getWisdomOperationSpec } from '../op-catalog.js';

export interface WisdomBoundaryForwardOptions {
  compatibilityMode?: boolean;
  defaultExportKey: string;
}

/**
 * The compatibility boundary is the only Wisdom-side entry point for work
 * owned by another actuator. The target actuator is resolved by the registry;
 * Wisdom never imports the target package or executes its implementation.
 */
export async function forwardWisdomBoundaryOperation(
  op: string,
  params: Record<string, unknown>,
  context: WisdomContext,
  options: WisdomBoundaryForwardOptions
): Promise<WisdomContext | undefined> {
  const spec = getWisdomOperationSpec(op);
  if (!spec?.forward_to) return undefined;

  const forwarded = await getActuatorForwardingPort().forward({
    source_actuator: 'wisdom-actuator',
    requested_op: op,
    target_actuator: spec.forward_to.actuator,
    target_op: spec.forward_to.op,
    params,
    context,
    security_scope:
      context.security_scope && typeof context.security_scope === 'object'
        ? (context.security_scope as ContextSecurityScope)
        : undefined,
    idempotency_key: String(
      params.idempotency_key || context.idempotency_key || `wisdom:${op}:${Date.now()}`
    ),
  });

  if (forwarded.status !== 'succeeded') {
    throw new Error(
      `[FORWARDED_OP_FAILED] ${op} -> ${spec.forward_to.actuator}:${spec.forward_to.op}: ${forwarded.error || forwarded.status}`
    );
  }
  if (forwarded.context) return forwarded.context as WisdomContext;

  return assignWisdomContextValue(
    context,
    String(params.export_as || options.defaultExportKey),
    forwarded.result,
    { compatibilityMode: options.compatibilityMode }
  );
}
