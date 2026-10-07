/**
 * @agent/core - Unified Entry Point
 * Public exports are split into bounded barrel parts to keep this entrypoint navigable.
 */

export * from './index-part-01.js';
export * from './index-part-02.js';
export * from './index-part-03.js';
export * from './index-part-04.js';
export * from './index-part-05.js';
export * from './index-part-06.js';
export * from './index-part-07.js';
export * from './index-part-08.js';
export * from './index-part-09.js';
export * from './index-part-10.js';
export * from './index-part-11.js';

// Preserve the original explicit export precedence for names also surfaced by
// broad compatibility barrels.
export type { NextActionType } from './next-action.js';

export {
  completedConversationContext,
  narrowFrontDeskConversationViewer,
  frontDeskRuntimeScope,
  markConversationTurnNotStarted,
  conversationRef,
  reserveConversationTurn,
  beginConversationTurn,
  completeConversationTurn,
  markConversationTurnUncertain,
  frontDeskConversationScope,
  presenceFrontDeskConversationViewer,
  ConversationStoreError,
  readConversationHistory as readFrontDeskConversationHistory,
  readFrontDeskConversationWork,
} from './surface/front-desk-conversation-store.js';
export type {
  FrontDeskConversationViewer,
  FrontDeskConversationWork,
  FrontDeskConversationWorkTask,
  FrontDeskConversationWorkArtifact,
  ReservedConversationTurn,
} from './surface/front-desk-conversation-store.js';
export * from './surface/front-desk-conversation-history.js';

export {
  SurfaceConversationAdmissionError,
  SurfaceConversationCapabilityError,
} from './surface/surface-conversation-runtime-context.js';

export * from './surface/conversation-task-routing.js';

export * from './surface/front-desk-execution-contract.js';
export {
  runFrontDeskExecutionIntake,
  prepareFrontDeskExecution,
  verifyFrontDeskExecution,
} from './surface/front-desk-execution.js';
export { projectFrontDeskExecution } from './surface/front-desk-execution-status.js';
export {
  listConfiguredFrontDeskExecutions,
  inspectFrontDeskExecution,
  readConversationExecutionReports,
} from './surface/front-desk-conversation-store.js';

export * from './surface/first-job-contract.js';

export * from './surface/first-job.js';
export * from './surface/first-job-setup.js';

export * from './surface/first-job-approval.js';
export * from './surface/first-job-recovery.js';
export * from './surface/first-job-approval-proof.js';
