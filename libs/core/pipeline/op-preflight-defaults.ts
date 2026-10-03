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
import { checkProviderEgress } from '../provider/provider-egress-gate.js';
import {
  listOpGuards,
  listOpPreflightListeners,
  registerOpGuard,
  registerOpPreflightListener,
  type OpPreflightCall,
  type OpPreflightListenerResult,
} from './op-preflight.js';
import { checkSpendGuard } from '../spend-guard.js';
import {
  validateContextSecurityScope,
  type ContextSecurityScope,
} from '../context-security-scope.js';
import {
  currentScopeEnvelope,
  envelopeNarrowRequestErrors,
  noteMissingScopeEnvelope,
  securityScopeNarrowErrors,
} from '../scope-envelope.js';
import { validateScopeContext, type ScopeContextInput } from '../scope-context.js';
import {
  lookupOpCapability,
  resolveCapabilityEffect,
  resolveCapabilityEgressDestination,
  resolveCapabilityResourceRef,
} from '../actuator/actuator-manifest-index.js';
import type { TierLevel } from '../types.js';
import { introductionResult, provenanceEgressResult, taintResult } from './op-preflight-stages.js';

const TIER_VALUES = new Set<TierLevel>(['public', 'confidential', 'personal']);

const DEFAULT_LISTENER_IDS = [
  'core:scope',
  'core:effect',
  'core:introduction',
  'core:taint',
  'core:provenance-egress',
  'core:adf-guardrails',
  'core:provider-egress',
] as const;
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
  const activeEnvelope = currentScopeEnvelope();

  // SC-01: an input scope_envelope is a narrow request — it must reference a
  // runtime-minted envelope and may only narrow it, never enlarge it.
  const inputEnvelope = firstValue(search, 'scope_envelope', 'scopeEnvelope');
  if (inputEnvelope !== undefined) {
    const errors = envelopeNarrowRequestErrors(inputEnvelope, activeEnvelope);
    if (errors.length > 0) {
      return {
        decision: 'block',
        reason: `[OP_SCOPE_DENIED] ${errors.join('; ')}`,
        terminate: true,
      };
    }
  }

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
    // SC-01: with a minted envelope active, a caller-provided security_scope
    // may only narrow it — identity contradictions or policy enlargement deny.
    if (activeEnvelope) {
      const narrowErrors = securityScopeNarrowErrors(
        explicitSecurityScope as ContextSecurityScope,
        activeEnvelope
      );
      if (narrowErrors.length > 0) {
        return {
          decision: 'block',
          reason: `[OP_SCOPE_DENIED] ${narrowErrors.join('; ')}`,
          terminate: true,
        };
      }
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

  // SC-01 rollout: governed ops without a minted envelope are allowed but
  // measured, so the enforce rollout has counts before it tightens.
  if (!activeEnvelope && inputEnvelope === undefined) noteMissingScopeEnvelope(call.op);
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

/**
 * SC-02: resolve the op's declared effect class and stamp it onto the input
 * so downstream stages (introduction, observation, egress) and the executing
 * op can read it. Undeclared ops resolve to 'write' — the fail-safe class.
 */
function effectResult(call: OpPreflightCall, input: RecordLike): OpPreflightListenerResult | void {
  const capability = lookupOpCapability(call.op);
  const effect = capability ? resolveCapabilityEffect(capability, input) : 'write';
  const resourceRef = capability ? resolveCapabilityResourceRef(capability, input) : undefined;
  const destination = capability
    ? resolveCapabilityEgressDestination(capability, input)
    : undefined;
  return {
    repaired_input: {
      _effect: effect,
      // Always write the key — an unresolved ref clears any client-injected
      // value so downstream stages only ever see the stage-resolved ref.
      _resource_ref: resourceRef,
      // Same hygiene: always written, so a caller-injected destination never survives.
      _egress_destination: destination,
    },
  };
}

/** Install the standard listeners after a test/worker reset or during boot. */
export function ensureDefaultOpPreflight(): void {
  const listenerIds = new Set(listOpPreflightListeners().map((listener) => listener.id));
  const registrations: { id: string; order: number; run: typeof scopeResult }[] = [
    { id: DEFAULT_LISTENER_IDS[0], order: 100, run: scopeResult },
    { id: DEFAULT_LISTENER_IDS[1], order: 110, run: effectResult },
    { id: DEFAULT_LISTENER_IDS[2], order: 112, run: introductionResult },
    { id: DEFAULT_LISTENER_IDS[3], order: 115, run: taintResult },
    { id: DEFAULT_LISTENER_IDS[4], order: 118, run: provenanceEgressResult },
    { id: DEFAULT_LISTENER_IDS[5], order: 120, run: adfResult },
    { id: DEFAULT_LISTENER_IDS[6], order: 130, run: providerEgressResult },
  ];
  for (const registration of registrations) {
    if (!listenerIds.has(registration.id)) {
      registerOpPreflightListener(registration);
    }
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
