export {
  resolveIdentityContext,
  hasAuthority,
  inferPersonaFromRole,
  buildExecutionEnv,
  withExecutionContext,
} from './authority.js';
export {
  detectTier,
  validateReadPermission,
  validateWritePermission,
  scanForConfidentialMarkers,
  validateSovereignBoundary,
} from './tier-guard.js';
export { createApprovalRequest, loadApprovalRequest, decideApprovalRequest, listApprovalRequests } from './approval-store.js';
export type { IdentityContext, Persona, Authority } from './types.js';
