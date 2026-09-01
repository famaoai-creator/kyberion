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
}

export interface RiskyApprovalResult {
  allowed: boolean;
  status: 'approved' | 'pending' | 'not_required';
  requestId?: string;
  message?: string;
}

export type RiskyApprovalHandler = (params: RiskyApprovalRequest) => RiskyApprovalResult;

const riskyApprovalHandlerSeam = createSeam<RiskyApprovalHandler>({
  key: 'risky-approval-handler',
  multiplicity: 'sole',
  catalog: coreSeamCatalog,
});

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
  const registeredHandler = riskyApprovalHandlerSeam.getOptional();
  return (
    registeredHandler?.(params) ?? {
      allowed: false,
      status: 'pending',
      message: 'Approval gate is not registered',
    }
  );
}
