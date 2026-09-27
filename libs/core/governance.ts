export {
  resolveIdentityContext,
  hasAuthority,
  inferPersonaFromRole,
  buildExecutionEnv,
  withExecutionContext,
  withExecutionContextAsync,
} from './authority.js';
export {
  detectTier,
  validateReadPermission,
  validateWritePermission,
  scanForConfidentialMarkers,
  validateSovereignBoundary,
} from './tier-guard.js';
export {
  createApprovalRequest,
  loadApprovalRequest,
  decideApprovalRequest,
  listApprovalRequests,
} from './governance/approval-store.js';
export type {
  ApprovalApplyResult,
  ApprovalDecisionPayload,
  ApprovalJustification,
  ApprovalRecord,
  ApprovalRequestDraft,
  ApprovalRequestRecord,
  ApprovalRequesterContext,
  ApprovalRiskProfile,
  ApprovalStage,
  ApprovalTargetDescriptor,
  ApprovalWorkflowState,
} from './governance/approval-store.js';
export type { IdentityContext, Persona, Authority } from './types.js';
