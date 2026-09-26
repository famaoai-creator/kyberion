import { coreSeamCatalog, createSeam, type SeamProviderMetadata } from './seam.js';

export interface RiskyApprovalRequest {
  opId: string;
  agentId: string;
  correlationId?: string;
  channel?: string;
  /** Trusted execution-boundary presence; never read from operation payload. */
  hasHuman?: boolean;
  hasUI?: boolean;
  nonInteractive?: boolean;
  payload?: Record<string, unknown>;
  draft?: {
    title: string;
    summary: string;
    severity?: 'low' | 'medium' | 'high';
  };
  /**
   * ISO expiry for a newly created request. Opts into renewable requests: once
   * a matched request (pending, rejected or approved) lapses it no longer binds
   * the correlation id, and the next call opens a fresh request.
   */
  expiresAt?: string;
}

export interface RiskyApprovalResult {
  allowed: boolean;
  status: 'approved' | 'pending' | 'not_required';
  requestId?: string;
  message?: string;
}

export type RiskyApprovalHandler = (params: RiskyApprovalRequest) => RiskyApprovalResult;

/** An override may return `undefined` to defer to the canonical handler. */
export type RiskyApprovalOverride = (
  params: RiskyApprovalRequest
) => RiskyApprovalResult | undefined;

const riskyApprovalHandlerSeam = createSeam<RiskyApprovalHandler>({
  key: 'risky-approval-handler',
  multiplicity: 'sole',
  catalog: coreSeamCatalog,
});

/**
 * ES-02: scoped override consulted before the canonical handler. The
 * canonical handler registers at import time without keeping its disposer,
 * so a scenario run cannot swap it out; it binds here instead and disposes
 * the override afterwards. Unregistered (or an `undefined` answer) ->
 * canonical behaviour.
 */
const riskyApprovalOverrideSeam = createSeam<RiskyApprovalOverride>({
  key: 'risky-approval-override',
  multiplicity: 'sole',
  catalog: coreSeamCatalog,
});

const OVERRIDE_METADATA: SeamProviderMetadata = {
  provenance: 'builtin',
  source: 'libs/core/scenario-interceptor.ts',
  reason: 'scenario runner approval decisions (never registered in production processes)',
};

export function overrideRiskyApprovalHandler(
  handler: RiskyApprovalOverride,
  metadata: SeamProviderMetadata = OVERRIDE_METADATA
): () => void {
  return riskyApprovalOverrideSeam.register('scenario-runner', handler, metadata);
}

const DEFAULT_METADATA: SeamProviderMetadata = {
  provenance: 'builtin',
  source: 'libs/core/risky-op-approval-port.ts',
  reason: 'risky operation approval registry registration',
};

export function registerRiskyApprovalHandler(
  handler: RiskyApprovalHandler,
  metadata: SeamProviderMetadata = DEFAULT_METADATA
): () => void {
  const registeredHandler = riskyApprovalHandlerSeam.getOptional();
  if (registeredHandler && registeredHandler !== handler) {
    throw new Error(
      '[RISKY_APPROVAL_HANDLER_ALREADY_REGISTERED] refusing to replace the canonical approval handler'
    );
  }
  if (registeredHandler === handler) return () => undefined;
  return riskyApprovalHandlerSeam.register('approval-registry', handler, metadata);
}

/** Deny by default until the governed approval implementation is registered. */
export function requireRiskyApproval(params: RiskyApprovalRequest): RiskyApprovalResult {
  const overridden = riskyApprovalOverrideSeam.getOptional()?.(params);
  if (overridden) return overridden;
  const registeredHandler = riskyApprovalHandlerSeam.getOptional();
  return (
    registeredHandler?.(params) ?? {
      allowed: false,
      status: 'pending',
      message: 'Approval gate is not registered',
    }
  );
}
