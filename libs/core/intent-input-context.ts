import { getRegisteredEnvText } from './foundation/env.js';
import type { CompileUserIntentFlowInput } from './intent-contract-types.js';

export function resolveTenantId(input: CompileUserIntentFlowInput): string | undefined {
  const runtime = input.runtimeContext || {};
  const candidates = [
    input.tenantId,
    input.tenantSlug,
    typeof runtime.tenant_id === 'string' ? runtime.tenant_id : undefined,
    typeof runtime.tenantId === 'string' ? runtime.tenantId : undefined,
    typeof runtime.tenant_slug === 'string' ? runtime.tenant_slug : undefined,
    typeof runtime.tenantSlug === 'string' ? runtime.tenantSlug : undefined,
    getRegisteredEnvText('KYBERION_TENANT'),
    getRegisteredEnvText('KYBERION_CUSTOMER'),
  ];
  return candidates
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
    ?.trim();
}

export function resolveCorrelationId(input: CompileUserIntentFlowInput): string | undefined {
  const runtime = input.runtimeContext || {};
  const candidates = [
    input.correlationId,
    typeof runtime.correlation_id === 'string' ? runtime.correlation_id : undefined,
    typeof runtime.correlationId === 'string' ? runtime.correlationId : undefined,
  ];
  return candidates
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
    ?.trim();
}
