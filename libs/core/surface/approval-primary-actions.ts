/**
 * Approval primary actions — Deny / Allow once / Always(+scope).
 *
 * Concierge Needs You and chat surfaces share this vocabulary. The approval
 * store stays binary (`approved` | `rejected`); Always settles approved and
 * seeds the process-session cache (a session standing grant) when an action
 * descriptor is available. Categories that forbid Always (send_out, paid
 * generation, …) never offer the Always button.
 *
 * @see knowledge/product/architecture/pibot-absorption-model.md
 */

import {
  compactApprovalPresentedDigest,
  decideApprovalRequest,
  requiresTenantOwnerApproval,
  type ApprovalActionDescriptor,
  type ApprovalRequestRecord,
} from '../governance/approval-store.js';
import {
  renderDecisionCardExplanation,
  resolveApprovalLocale,
  viewDecisionCard,
} from '../governance/approval-decision-card.js';
import {
  allowsAlwaysPrimaryAction,
  isPolicyCategory,
  type PolicyCategory,
} from '../governance/policy-category.js';
import type { SupportedLocale } from '../localization/locale.js';

function explainWhy(record: ApprovalRequestRecord, locale?: SupportedLocale): string {
  const resolved = resolveApprovalLocale(record, locale);
  return renderDecisionCardExplanation(viewDecisionCard(record, { locale: resolved }), resolved);
}

export const APPROVAL_PRIMARY_ACTIONS = ['deny', 'allow_once', 'allow_always'] as const;
export type ApprovalPrimaryAction = (typeof APPROVAL_PRIMARY_ACTIONS)[number];

export interface ApprovalPrimaryActionButton {
  kind: ApprovalPrimaryAction;
  /** Compact presented digest bound into the callback (HA-06). */
  presentedDigestCompact: string;
  /** Human-visible scope string for Always (empty when not always). */
  scopeLabel?: string;
  enabled: boolean;
  disabledReason?: string;
}

export interface ApprovalPrimaryActionSet {
  why: string;
  buttons: ApprovalPrimaryActionButton[];
  policyCategory?: PolicyCategory;
  scopeLabel: string;
}

export function isApprovalPrimaryAction(value: unknown): value is ApprovalPrimaryAction {
  return (
    typeof value === 'string' && (APPROVAL_PRIMARY_ACTIONS as readonly string[]).includes(value)
  );
}

/** Map a primary action onto the binary store decision. */
export function primaryActionToStoreDecision(
  action: ApprovalPrimaryAction
): 'approved' | 'rejected' {
  return action === 'deny' ? 'rejected' : 'approved';
}

/**
 * Derive a Policy Category from the approval subject / title when present.
 * Unknown subjects leave Always available (Grant path still needs a binding).
 */
export function inferPolicyCategoryFromApproval(
  record: Pick<ApprovalRequestRecord, 'subject' | 'title' | 'summary'>
): PolicyCategory | undefined {
  const haystack = [record.subject, record.title, record.summary]
    .filter((part): part is string => typeof part === 'string')
    .join(' ')
    .toLowerCase();
  if (!haystack) return undefined;
  if (/\bsend[_ ]?out\b|egress|email|webhook/.test(haystack)) return 'send_out';
  if (/\bimage[_ ]?generation\b|paid.?generat/.test(haystack)) return 'image_generation';
  if (/\brun[_ ]?command\b|system:exec|shell/.test(haystack)) return 'run_command';
  if (/\bwrite[_ ]?file\b|file:write/.test(haystack)) return 'write_file';
  if (/\bread[_ ]?file\b|file:read/.test(haystack)) return 'read_file';
  if (/\bweb\b|network.?fetch|http/.test(haystack)) return 'web';
  const capabilityMatch = haystack.match(/capability:([a-z0-9_.-]+)/);
  if (capabilityMatch && isPolicyCategory(capabilityMatch[1])) return capabilityMatch[1];
  return undefined;
}

export function approvalAlwaysScopeLabel(
  record: Pick<ApprovalRequestRecord, 'subject' | 'channel' | 'requester' | 'title'>
): string {
  const subject = String(record.subject ?? '').trim();
  if (subject) return subject;
  const channel = String(record.channel ?? '').trim();
  if (channel) return `channel:${channel}`;
  return String(record.title ?? 'this action').trim() || 'this action';
}

/**
 * Build Why text + primary buttons bound to the presented digest.
 * Always is disabled (not omitted) when the category forbids standing allow,
 * so the card vocabulary stays stable for tests.
 */
export function buildApprovalPrimaryActions(
  record: ApprovalRequestRecord,
  options: { locale?: SupportedLocale } = {}
): ApprovalPrimaryActionSet {
  const why = explainWhy(record, options.locale);
  const digest = compactApprovalPresentedDigest(record);
  const policyCategory = inferPolicyCategoryFromApproval(record);
  const scopeLabel = approvalAlwaysScopeLabel(record);
  const alwaysOk = allowsAlwaysPrimaryAction(policyCategory);
  const hasBinding = Boolean(
    record.accountability?.finalDecision === 'human_only' &&
      record.accountability.payloadHash &&
      record.accountability.effectBinding
  );
  // PR #1563: Owner Allow once + CLI Grant resume — not process-session Always.
  const ownerGrant = requiresTenantOwnerApproval(record);
  const alwaysEnabled = alwaysOk && hasBinding && !ownerGrant;
  const alwaysDisabledReason = !alwaysOk
    ? 'always_forbidden_for_category'
    : ownerGrant
      ? 'grant_resume_not_session_always'
      : !hasBinding
        ? 'always_requires_effect_binding'
        : undefined;

  const buttons: ApprovalPrimaryActionButton[] = [
    {
      kind: 'deny',
      presentedDigestCompact: digest,
      enabled: true,
    },
    {
      kind: 'allow_once',
      presentedDigestCompact: digest,
      enabled: true,
    },
    {
      kind: 'allow_always',
      presentedDigestCompact: digest,
      scopeLabel,
      enabled: alwaysEnabled,
      ...(alwaysDisabledReason ? { disabledReason: alwaysDisabledReason } : {}),
    },
  ];

  return {
    why,
    buttons,
    ...(policyCategory ? { policyCategory } : {}),
    scopeLabel,
  };
}

export interface ApplyApprovalPrimaryActionParams {
  role: Parameters<typeof decideApprovalRequest>[0];
  record: ApprovalRequestRecord;
  action: ApprovalPrimaryAction;
  decidedBy: string;
  /** PR #1563: Owner role must travel with credential Grant decisions. */
  decidedByRole?: string;
  presentedDigest?: string;
  /** Required for allow_always — seeds the process-session standing grant. */
  sessionCache?: ApprovalActionDescriptor;
  authMethod?: Parameters<typeof decideApprovalRequest>[1]['authMethod'];
  note?: string;
}

/**
 * Settle through the binary store. Allow once → approved; Deny → rejected;
 * Always → approved + sessionCache (refused when category/binding forbids it).
 */
export function applyApprovalPrimaryAction(
  params: ApplyApprovalPrimaryActionParams
): ApprovalRequestRecord {
  const { record, action } = params;
  if (!isApprovalPrimaryAction(action)) {
    throw new Error(`[POLICY_VIOLATION] Unknown approval primary action: ${String(action)}`);
  }

  const set = buildApprovalPrimaryActions(record);
  const button = set.buttons.find((item) => item.kind === action);
  if (!button?.enabled) {
    throw new Error(
      `[POLICY_VIOLATION] Primary action ${action} is not available` +
        `${button?.disabledReason ? ` (${button.disabledReason})` : ''}`
    );
  }

  const decision = primaryActionToStoreDecision(action);
  const sessionCache =
    action === 'allow_always'
      ? (params.sessionCache ??
        ({
          action: set.scopeLabel,
          targetClass: set.policyCategory ? `policy:${set.policyCategory}` : 'approval:primary',
        } satisfies ApprovalActionDescriptor))
      : undefined;

  if (action === 'allow_always' && !sessionCache) {
    throw new Error('[POLICY_VIOLATION] Always require a session cache descriptor');
  }

  return decideApprovalRequest(params.role, {
    channel: record.channel,
    storageChannel: record.storageChannel,
    requestId: record.id,
    decision,
    decidedBy: params.decidedBy,
    decidedByType: 'human',
    authenticated: true,
    ...(params.decidedByRole ? { decidedByRole: params.decidedByRole } : {}),
    ...(params.authMethod ? { authMethod: params.authMethod } : {}),
    ...(params.presentedDigest ? { presentedDigest: params.presentedDigest } : {}),
    ...(params.note ? { note: params.note } : {}),
    ...(sessionCache ? { sessionCache } : {}),
  });
}
