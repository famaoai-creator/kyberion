/** Domain barrel — public surface for libs/core/integrations */
export * from './bluebubbles-adapter.js';
export * from './email-account-catalog.js';
export * from './email-bridge.js';
export * from './email-types.js';
export type {
  EmailDraftArtifact,
  EmailDraftGenerationInput,
  EmailDraftGenerationResult,
  EmailDeliveryRequest,
  OutlookInboxListInput,
  OutlookInboxMessage,
  OutlookInboxArchiveResult,
  GwsAuthStatus,
  GmailMessageHeader,
  GmailMessageListItem,
  GmailMessageMetadata,
  GmailInboxArchiveCandidate,
  GmailInboxArchiveResult,
  GmailInboxArchiveInput,
  OutlookInboxArchiveInput,
} from './email-workflow.js';
export {
  resolveEmailDraftDir,
  resolveEmailTriagePath,
  resolveLatestEmailDraftPaths,
  isRegularEmailDraftPath,
  extractFirstJsonBlock,
  parseEmailDraftArtifact,
  extractBodyMarkdownFromDraft,
  summarizeEmailSubject,
  parseEmailAddressHeader,
  organizeGmailInboxWithFilters,
  buildFallbackEmailDraft,
  readEmailDraftArtifact,
  readGwsAuthStatus,
  generateEmailReplyDraft,
  executeGmailDelivery,
  readM365EmailAuthStatus,
  executeOutlookDelivery,
  listOutlookInbox,
  organizeOutlookInbox,
  EmailAccountRegistry,
  emailAccountRegistry,
  executeEmailDelivery,
  organizeEmailInbox,
} from './email-workflow.js';
export * from './github-issues.js';
export * from './jira-issues.js';
export * from './slack-approval-ui.js';
export * from './slack-mission-proposal-ui.js';
export * from './slack-onboarding.js';
