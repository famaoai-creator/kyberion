/**
 * DH-01: standard governance listeners for the operation waterfall.
 *
 * The primitive in op-preflight.ts is intentionally registry-like so tests
 * and managed packs can add policy. This module supplies the built-in
 * listeners that public dispatch boundaries install before invoking it.
 * Each listener is metadata-driven: operations that do not declare a scope,
 * an ADF, provider material, or a reasoning call keep their existing
 * behaviour.
 */
import { validatePipelineGuardrails } from './adf-guardrails.js';
import { checkProviderEgress } from './provider-egress-gate.js';
import {
  listOpGuards,
  listOpPreflightListeners,
  registerOpGuard,
  registerOpPreflightListener,
  type OpPreflightCall,
  type OpPreflightListenerResult,
} from './op-preflight.js';
import { checkSpendGuard } from './spend-guard.js';
import {
  validateContextSecurityScope,
  type ContextSecurityScope,
} from './context-security-scope.js';
import { validateScopeContext, type ScopeContextInput } from './scope-context.js';
import type { TierLevel } from './types.js';

const TIER_VALUES = new Set<TierLevel>(['public', 'confidential', 'personal']);

const DEFAULT_LISTENER_IDS = ['core:scope', 'core:adf-guardrails', 'core:provider-egress'] as const;
const DEFAULT_GUARD_IDS = ['core:spend'] as const;

type RecordLike = Record<string, unknown>;

function records(call: OpPreflightCall, input: RecordLike): RecordLike[] {
  const context = call.context && typeof call.context === 'object' ? call.context : {};
  return [context as RecordLike, input];
}

function firstValue(recordsToSearch: RecordLike[], ...keys: string[]): unknown {
  for (const record of recordsToSearch) {
    for (const key of keys) {
      const value = record[key];
      if (value !== undefined && value !== null) return value;
    }
  }
  return undefined;
}

function stringValue(recordsToSearch: RecordLike[], ...keys: string[]): string | undefined {
  const value = firstValue(recordsToSearch, ...keys);
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function tierValue(recordsToSearch: RecordLike[]): TierLevel | undefined {
  const value = firstValue(recordsToSearch, 'data_tier', 'dataTier', 'tier');
  return typeof value === 'string' && TIER_VALUES.has(value as TierLevel)
    ? (value as TierLevel)
    : undefined;
}

function scopeResult(call: OpPreflightCall, input: RecordLike): OpPreflightListenerResult | void {
  const search = records(call, input);
  const explicitSecurityScope = firstValue(search, 'security_scope', 'securityScope');
  if (explicitSecurityScope && typeof explicitSecurityScope === 'object') {
    const errors = validateContextSecurityScope(explicitSecurityScope as ContextSecurityScope);
    if (errors.length > 0) {
      return {
        decision: 'block',
        reason: `[OP_SCOPE_DENIED] ${errors.join('; ')}`,
        terminate: true,
      };
    }
  }

  const tier = tierValue(search);
  const hasScopeFields = search.some((record) =>
    ['tenant_slug', 'tenant_id', 'organization_id', 'project_id', 'mission_id', 'task_id'].some(
      (key) => record[key] !== undefined
    )
  );
  // A protected tier is never allowed to proceed without a tenant binding.
  // Public operations may still carry an optional scope envelope.
  if (tier && (hasScopeFields || tier !== 'public')) {
    const scopeInput: ScopeContextInput = {
      tier,
      ...(stringValue(search, 'tenant_slug')
        ? { tenant_slug: stringValue(search, 'tenant_slug') }
        : {}),
      ...(stringValue(search, 'tenant_id') ? { tenant_id: stringValue(search, 'tenant_id') } : {}),
      ...(stringValue(search, 'organization_id')
        ? { organization_id: stringValue(search, 'organization_id') }
        : {}),
      ...(stringValue(search, 'project_id')
        ? { project_id: stringValue(search, 'project_id') }
        : {}),
      ...(stringValue(search, 'mission_id')
        ? { mission_id: stringValue(search, 'mission_id') }
        : {}),
      ...(stringValue(search, 'task_id') ? { task_id: stringValue(search, 'task_id') } : {}),
    };
    const errors = validateScopeContext(scopeInput, { requireTenant: tier !== 'public' });
    if (errors.length > 0) {
      return {
        decision: 'block',
        reason: `[OP_SCOPE_DENIED] ${errors.join('; ')}`,
        terminate: true,
      };
    }
  }
}

function adfResult(call: OpPreflightCall, input: RecordLike): OpPreflightListenerResult | void {
  const search = records(call, input);
  const candidate = firstValue(search, 'adf', 'pipeline', '_adf');
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    !Array.isArray((candidate as RecordLike).steps)
  ) {
    return;
  }
  const report = validatePipelineGuardrails(candidate as any, `op:${call.op}`);
  const finding = report.findings.find((entry) => entry.severity === 'error');
  if (finding) {
    return {
      decision: 'block',
      reason: `[OP_ADF_DENIED] ${finding.code}: ${finding.message}`,
      terminate: true,
    };
  }
}

function providerEgressResult(
  call: OpPreflightCall,
  input: RecordLike
): OpPreflightListenerResult | void {
  const search = records(call, input);
  const provider = stringValue(search, 'provider', 'provider_id', 'providerId');
  const dataTier = tierValue(search);
  if (!provider || !dataTier) return;
  const result = checkProviderEgress({
    provider,
    dataTier,
    ...(stringValue(search, 'tenant_slug')
      ? { tenant_slug: stringValue(search, 'tenant_slug') }
      : {}),
  });
  if (!result.allowed) {
    return { decision: 'block', reason: result.reason, terminate: true };
  }
}

function isReasoningCall(call: OpPreflightCall): boolean {
  return (
    call.op.startsWith('reasoning:') ||
    call.op.startsWith('reasoning.') ||
    call.context?._reasoning_call === true
  );
}

/** Install the standard listeners after a test/worker reset or during boot. */
export function ensureDefaultOpPreflight(): void {
  const listenerIds = new Set(listOpPreflightListeners().map((listener) => listener.id));
  if (!listenerIds.has(DEFAULT_LISTENER_IDS[0])) {
    registerOpPreflightListener({ id: DEFAULT_LISTENER_IDS[0], order: 100, run: scopeResult });
  }
  if (!listenerIds.has(DEFAULT_LISTENER_IDS[1])) {
    registerOpPreflightListener({ id: DEFAULT_LISTENER_IDS[1], order: 110, run: adfResult });
  }
  if (!listenerIds.has(DEFAULT_LISTENER_IDS[2])) {
    registerOpPreflightListener({
      id: DEFAULT_LISTENER_IDS[2],
      order: 120,
      run: providerEgressResult,
    });
  }

  const guardIds = new Set(listOpGuards().map((guard) => guard.id));
  if (!guardIds.has(DEFAULT_GUARD_IDS[0])) {
    registerOpGuard({
      id: DEFAULT_GUARD_IDS[0],
      order: 200,
      check: (call, input) => {
        if (!isReasoningCall(call)) return;
        const search = records(call, input);
        const result = checkSpendGuard({
          missionId: stringValue(search, 'mission_id', 'missionId'),
          tenantId: stringValue(search, 'tenant_slug', 'tenant_id'),
        });
        if (!result.allowed) {
          return {
            decision: 'block',
            reason: `[OP_SPEND_DENIED] cap reached: ${result.breached.join(', ')}`,
            terminate: true,
          };
        }
      },
    });
  }
}
