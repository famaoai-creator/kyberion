import {
  createApprovalRequest,
  decideApprovalRequest,
  expireApprovalRequest,
  isApprovalRequestExpired,
  listApprovalRequests,
  loadApprovalRequest,
  annotateApprovalRejectionReason,
  APPROVAL_CHANGE_INSTRUCTION_MAX,
  type ApprovalRecord,
  type ApprovalRequestDraft,
  type ApprovalRequestRecord,
} from '../governance/approval-store.js';
import {
  REJECTION_REASON_CATEGORIES,
  normalizeRejectionReasonCategory,
  type RejectionReasonCategory,
} from '../rejection-reason.js';
import {
  renderIntentAuthorityLabel,
  renderIntentOutcomeLabel,
  type IntentResolutionContract,
} from '../intent/intent-resolution-contract.js';
import { resolveLocale, type SupportedLocale } from '../locale.js';
import { t, type VocabularyKey } from '../t.js';
import {
  AUTONOMY_APPROVAL_CHANNEL,
  renderDecisionCardExplanation,
  renderDecisionCardLines,
  renderDecisionCardText,
  resolveApprovalLocale,
  viewDecisionCard,
} from '../governance/approval-decision-card.js';
import type { DecisionCard } from '../governance/decision-card.js';

/** MO-11 S-2: `brief` = the mission-brief HTML review surface (report-review). */
export type SurfaceApproval = 'slack' | 'telegram' | 'discord' | 'imessage' | 'presence' | 'brief';
export type SurfaceApprovalDecision = 'approved' | 'rejected';
export type SurfaceApprovalAskWhyCategory = RejectionReasonCategory | 'skip';

const DECISION_TOKEN = /^appr:([0-9a-f-]{36}):(approve|approved|reject|rejected)$/iu;
// `revise` is accepted as an alias of `changes`. The free text after the token
// is sliced off, never matched, so chat input cannot drive regex backtracking.
const CARD_TOKEN = /^appr:([0-9a-f-]{36}):(changes|revise|explain)(?=\s|$)/iu;

export interface SurfaceApprovalAction {
  requestId: string;
  decision: SurfaceApprovalDecision;
  callbackData: string;
}

const REPLY_LOCALES: readonly SupportedLocale[] = ['en', 'ja'];

/** Decision-card button labels double as bare-word replies in every operator locale. */
function localizedReplyWords(keys: readonly VocabularyKey[]): Set<string> {
  return new Set(
    keys.flatMap((key) => REPLY_LOCALES.map((locale) => t(key, undefined, locale).toLowerCase()))
  );
}

function normalizeDecision(value: string): SurfaceApprovalDecision | undefined {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'approve' ||
    normalized === 'approved' ||
    normalized === '1' ||
    localizedReplyWords(['decision:action_approve']).has(normalized)
  ) {
    return 'approved';
  }
  if (
    normalized === 'reject' ||
    normalized === 'rejected' ||
    normalized === '2' ||
    localizedReplyWords(['decision:action_reject', 'decision:reply_object']).has(normalized)
  ) {
    return 'rejected';
  }
  return undefined;
}

/**
 * Autonomy decision cards are pushed as top-level notifications, so they bind
 * to the surface and chat they were delivered to rather than to a thread.
 */
function replyTargetsRecord(
  record: ApprovalRequestRecord,
  surface: SurfaceApproval,
  channel: string,
  threadTs: string
): boolean {
  if (record.storageChannel === AUTONOMY_APPROVAL_CHANNEL) {
    const via = record.decisionCard?.deliveredVia;
    return Boolean(via && via.surface === surface && via.target === channel);
  }
  return record.channel === channel && record.threadTs === threadTs;
}

function loadReplyTarget(
  surface: SurfaceApproval,
  requestId: string
): ApprovalRequestRecord | null {
  return (
    loadApprovalRequest(surface, requestId) ||
    loadApprovalRequest('background-review', requestId) ||
    loadApprovalRequest(AUTONOMY_APPROVAL_CHANNEL, requestId)
  );
}

function approvalRole(
  surface: SurfaceApproval,
  storageChannel: string = surface
): 'slack_bridge' | 'surface_runtime' | 'mission_controller' {
  if (storageChannel === 'background-review') return 'mission_controller';
  return surface === 'slack' ? 'slack_bridge' : 'surface_runtime';
}

export function createSurfaceApprovalRequest(params: {
  surface: SurfaceApproval;
  channel: string;
  threadTs: string;
  correlationId: string;
  requestedBy: string;
  draft: ApprovalRequestDraft;
  sourceText?: string;
  expiresAt?: string;
  decisionCard?: DecisionCard;
}): ApprovalRequestRecord {
  return createApprovalRequest(approvalRole(params.surface), {
    channel: params.channel,
    storageChannel: params.surface,
    threadTs: params.threadTs,
    correlationId: params.correlationId,
    requestedBy: params.requestedBy,
    draft: params.draft,
    sourceText: params.sourceText,
    expiresAt: params.expiresAt,
    accountability: { finalDecision: 'human_only' },
    ...(params.decisionCard ? { decisionCard: params.decisionCard } : {}),
  });
}

/** The decision card body, shared by every text-based surface (Slack blocks included). */
export function formatDecisionCardLines(
  record: ApprovalRequestRecord,
  options: { locale?: SupportedLocale; now?: number } = {}
): string[] {
  const locale = resolveApprovalLocale(record, options.locale);
  return renderDecisionCardLines(viewDecisionCard(record, { ...options, locale }), locale);
}

/** "Ask why": the stored rationale only — never a model call. */
export function explainApprovalRequest(
  record: ApprovalRequestRecord,
  options: { locale?: SupportedLocale } = {}
): string {
  const locale = resolveApprovalLocale(record, options.locale);
  return renderDecisionCardExplanation(viewDecisionCard(record, { ...options, locale }), locale);
}

export function buildSurfaceApprovalText(
  surface: SurfaceApproval,
  record: ApprovalRequestRecord,
  intentResolution?: IntentResolutionContract,
  options: { locale?: SupportedLocale } = {}
): string {
  const locale = resolveApprovalLocale(record, options.locale);
  if (record.decisionCard) {
    return renderDecisionCardText(viewDecisionCard(record, { locale }), locale);
  }
  return [
    t('bridge:approval_heading', { surface }, locale),
    `${t('bridge:approval_title_label', undefined, locale)}: ${record.title}`,
    record.summary,
    ...(record.details
      ? [`${t('bridge:approval_details_label', undefined, locale)}: ${record.details}`]
      : []),
    `${t('bridge:approval_severity_label', undefined, locale)}: ${record.severity || 'medium'}`,
    '',
    t('bridge:approval_approve_choice', undefined, locale),
    t('bridge:approval_reject_choice', undefined, locale),
    t('bridge:approval_reply_instruction', { requestId: record.id }, locale),
    ...(intentResolution
      ? [
          '',
          `${t('bridge:contract_understanding', undefined, locale)}: ${intentResolution.normalized_intent}`,
          `${t('bridge:contract_missing_input', undefined, locale)}: ${
            intentResolution.missing_inputs.length > 0
              ? intentResolution.missing_inputs.join(', ')
              : t('bridge:contract_none', undefined, locale)
          }`,
          `${t('bridge:contract_authority', undefined, locale)}: ${renderIntentAuthorityLabel(intentResolution.authority_level, locale)}`,
          `${t('bridge:contract_next_action', undefined, locale)}: ${intentResolution.next_action.label}`,
          `${t('bridge:contract_consequence', undefined, locale)}: ${intentResolution.next_action.consequence}`,
          `${t('bridge:contract_outcome', undefined, locale)}: ${renderIntentOutcomeLabel(intentResolution.outcome_kind, locale)}`,
        ]
      : []),
  ].join('\n');
}

/** Surface-independent action payloads for native buttons/components. */
export function buildSurfaceApprovalActions(
  record: ApprovalRequestRecord
): SurfaceApprovalAction[] {
  return [
    {
      requestId: record.id,
      decision: 'approved',
      callbackData: `appr:${record.id}:approve`,
    },
    {
      requestId: record.id,
      decision: 'rejected',
      callbackData: `appr:${record.id}:reject`,
    },
  ];
}

export type DecisionCardActionKind = 'approve' | 'changes' | 'reject' | 'explain';

export interface DecisionCardAction {
  requestId: string;
  kind: DecisionCardActionKind;
  callbackData: string;
}

/**
 * The four decision-card buttons. Requests without a card keep the
 * original approve / reject pair.
 */
export function buildDecisionCardActions(record: ApprovalRequestRecord): DecisionCardAction[] {
  const kinds: DecisionCardActionKind[] = record.decisionCard
    ? ['approve', 'changes', 'reject', 'explain']
    : ['approve', 'reject'];
  return kinds.map((kind) => ({
    requestId: record.id,
    kind,
    callbackData: `appr:${record.id}:${kind}`,
  }));
}

const SURFACE_ASK_WHY_LABEL_KEYS: Record<RejectionReasonCategory, VocabularyKey> = {
  incorrect_content: 'surface:ask_why_incorrect_content',
  wrong_direction: 'surface:ask_why_wrong_direction',
  quality: 'surface:ask_why_quality',
  scope: 'surface:ask_why_scope',
  other: 'surface:ask_why_other',
};

export interface SurfaceApprovalAskWhyAction {
  requestId: string;
  category: SurfaceApprovalAskWhyCategory;
  label: string;
  callbackData: string;
}

export function normalizeSurfaceApprovalAskWhyCategory(
  value: unknown
): SurfaceApprovalAskWhyCategory | undefined {
  if (value === 'skip') return 'skip';
  return normalizeRejectionReasonCategory(value);
}

/** Build the portable ask-why vocabulary used by native surface renderers. */
export function buildSurfaceApprovalAskWhyActions(
  requestId: string,
  locale?: SupportedLocale
): SurfaceApprovalAskWhyAction[] {
  const categories: SurfaceApprovalAskWhyCategory[] = [...REJECTION_REASON_CATEGORIES, 'skip'];
  return categories.map((category) => ({
    requestId,
    category,
    label: t(
      category === 'skip' ? 'surface:ask_why_skip' : SURFACE_ASK_WHY_LABEL_KEYS[category],
      undefined,
      locale
    ),
    callbackData: `appr:${requestId}:why:${category}`,
  }));
}

function loadScopedRejectedApproval(params: {
  surface: SurfaceApproval;
  requestId: string;
  channel: string;
  threadTs: string;
  storageChannel?: string;
}): ApprovalRequestRecord | null {
  const record =
    loadApprovalRequest(params.storageChannel || params.surface, params.requestId) ||
    (params.storageChannel ? null : loadApprovalRequest('background-review', params.requestId));
  if (
    !record ||
    record.status !== 'rejected' ||
    record.channel !== params.channel ||
    record.threadTs !== params.threadTs
  ) {
    return null;
  }
  return record;
}

/** Attach a closed-vocabulary rejection reason only to the rejected request's thread. */
export function applySurfaceApprovalRejectionReason(params: {
  surface: SurfaceApproval;
  requestId: string;
  category: RejectionReasonCategory;
  channel: string;
  threadTs: string;
  annotatedBy: string;
  storageChannel?: string;
}): ApprovalRequestRecord {
  const storageChannel = params.storageChannel || params.surface;
  const record = loadScopedRejectedApproval({ ...params, storageChannel });
  if (!record) {
    throw new Error(
      '[POLICY_VIOLATION] Rejection reason must target a rejected approval in the same channel/thread'
    );
  }
  return annotateApprovalRejectionReason(approvalRole(params.surface, storageChannel), {
    channel: record.channel,
    storageChannel,
    requestId: params.requestId,
    reasonCategory: params.category,
    annotatedBy: params.annotatedBy,
  });
}

export interface SurfaceApprovalAskWhyReply {
  handled: true;
  reply: string;
  record?: ApprovalRequestRecord;
}

/** Resolve the shared ask-why follow-up for native or text-based renderers. */
export function resolveSurfaceApprovalAskWhy(params: {
  surface: SurfaceApproval;
  requestId: string;
  category: SurfaceApprovalAskWhyCategory;
  channel: string;
  threadTs: string;
  annotatedBy: string;
  storageChannel?: string;
  locale?: SupportedLocale;
}): SurfaceApprovalAskWhyReply {
  const category = normalizeSurfaceApprovalAskWhyCategory(params.category);
  const record = category
    ? loadScopedRejectedApproval({
        surface: params.surface,
        requestId: params.requestId,
        channel: params.channel,
        threadTs: params.threadTs,
        storageChannel: params.storageChannel,
      })
    : null;
  if (!category || !record) {
    return {
      handled: true,
      reply: t('surface:ask_why_target_missing', undefined, params.locale),
    };
  }
  if (category === 'skip') {
    return { handled: true, reply: t('surface:ask_why_skipped', undefined, params.locale), record };
  }
  const updated = applySurfaceApprovalRejectionReason({
    ...params,
    category,
    storageChannel: record.storageChannel,
  });
  return {
    handled: true,
    reply: t('surface:ask_why_recorded', { category }, params.locale),
    record: updated,
  };
}

/** Apply a native or text approval decision through the surface-independent API. */
export function applySurfaceApprovalDecision(params: {
  surface: SurfaceApproval;
  requestId: string;
  decision: SurfaceApprovalDecision;
  channel: string;
  threadTs: string;
  decidedBy: string;
  storageChannel?: string;
  /**
   * MO-11 S-3: how the decider was authenticated on this surface. Defaults to
   * the surface's own strength, so callers that already trust their transport
   * keep working unchanged.
   */
  authMethod?: ApprovalRecord['authMethod'];
  /** Free-text rationale, carried into the event stream. */
  note?: string;
  /** LC-10 closed vocabulary — the same set every surface uses. */
  reasonCategory?: RejectionReasonCategory;
  /** A rejection that asks the requester to revise and re-submit. */
  changeInstruction?: string;
}): ApprovalRequestRecord {
  const storageChannel = params.storageChannel || params.surface;
  const record = loadApprovalRequest(storageChannel, params.requestId);
  if (
    !record ||
    record.status !== 'pending' ||
    record.channel !== params.channel ||
    record.threadTs !== params.threadTs
  ) {
    throw new Error(
      '[POLICY_VIOLATION] Approval decision must target a pending request in the same channel/thread'
    );
  }
  return decideApprovalRequest(approvalRole(params.surface, storageChannel), {
    channel: record.channel,
    storageChannel,
    requestId: params.requestId,
    decision: params.decision,
    decidedBy: params.decidedBy,
    decidedByType: 'human',
    authenticated: true,
    authMethod: params.authMethod ?? defaultSurfaceAuthMethod(params.surface),
    payloadHash: record.accountability?.payloadHash,
    effectBinding: record.accountability?.effectBinding,
    ...(params.note ? { note: params.note } : {}),
    ...(params.reasonCategory ? { reasonCategory: params.reasonCategory } : {}),
    ...(params.changeInstruction !== undefined
      ? { changeInstruction: params.changeInstruction }
      : {}),
  });
}

/** "Request changes": recorded as a rejection carrying the instruction. */
export function applySurfaceApprovalChangeRequest(params: {
  surface: SurfaceApproval;
  requestId: string;
  channel: string;
  threadTs: string;
  decidedBy: string;
  instruction: string;
  storageChannel?: string;
  authMethod?: ApprovalRecord['authMethod'];
}): ApprovalRequestRecord {
  return applySurfaceApprovalDecision({
    surface: params.surface,
    requestId: params.requestId,
    decision: 'rejected',
    channel: params.channel,
    threadTs: params.threadTs,
    decidedBy: params.decidedBy,
    storageChannel: params.storageChannel,
    authMethod: params.authMethod,
    note: 'changes_requested',
    changeInstruction: params.instruction,
  });
}

/**
 * MO-11 S-3: only claim an authentication strength that the surface actually
 * has. `brief` is a loopback page gated by a per-launch token — possession, not
 * identity — so it is recorded as `local_token` and must never be logged as
 * `surface_session`.
 *
 * Every other surface keeps its prior behaviour of recording nothing: asserting
 * `surface_session` for all of them would be the same dishonesty in the other
 * direction (`presence` is a local server too). Callers that know their own
 * strength pass `authMethod` explicitly.
 */
function defaultSurfaceAuthMethod(surface: SurfaceApproval): ApprovalRecord['authMethod'] {
  return surface === 'brief' ? 'local_token' : undefined;
}

export interface SurfaceApprovalReply {
  handled: boolean;
  reply?: string;
  record?: ApprovalRequestRecord;
  /** The reply asks for free text; surfaces that can should force a reply to it. */
  forceReply?: boolean;
}

function resolveDecisionCardToken(params: {
  surface: SurfaceApproval;
  channel: string;
  threadTs: string;
  decidedBy: string;
  requestId: string;
  kind: 'changes' | 'explain';
  instruction?: string;
  locale: SupportedLocale;
}): SurfaceApprovalReply {
  const record = loadReplyTarget(params.surface, params.requestId);
  if (!record) {
    return {
      handled: true,
      reply: t('bridge:approval_request_not_found', undefined, params.locale),
    };
  }
  if (!replyTargetsRecord(record, params.surface, params.channel, params.threadTs)) {
    return {
      handled: true,
      reply: t('bridge:approval_request_other_thread', undefined, params.locale),
    };
  }
  if (params.kind === 'explain') {
    return {
      handled: true,
      record,
      reply: explainApprovalRequest(record, { locale: params.locale }),
    };
  }
  if (record.status !== 'pending' || !record.decisionCard) {
    return {
      handled: true,
      reply: t('bridge:approval_request_not_found', undefined, params.locale),
    };
  }
  if (isApprovalRequestExpired(record)) {
    const expired = expireApprovalRequest(approvalRole(params.surface, record.storageChannel), {
      channel: record.channel,
      storageChannel: record.storageChannel,
      requestId: record.id,
    });
    return {
      handled: true,
      record: expired,
      reply: t('bridge:approval_request_expired', undefined, params.locale),
    };
  }
  const instruction = params.instruction?.trim();
  if (!instruction) {
    return {
      handled: true,
      record,
      forceReply: true,
      reply: t(
        'bridge:decision_card_changes_prompt',
        { title: record.title, token: `appr:${record.id}:changes` },
        params.locale
      ),
    };
  }
  if (instruction.length > APPROVAL_CHANGE_INSTRUCTION_MAX) {
    return {
      handled: true,
      record,
      reply: t(
        'bridge:decision_card_changes_too_long',
        { max: APPROVAL_CHANGE_INSTRUCTION_MAX },
        params.locale
      ),
    };
  }
  const updated = applySurfaceApprovalChangeRequest({
    surface: params.surface,
    requestId: record.id,
    channel: record.channel,
    threadTs: record.threadTs,
    decidedBy: params.decidedBy,
    instruction,
    storageChannel: record.storageChannel,
  });
  return {
    handled: true,
    record: updated,
    reply: t('bridge:decision_card_changes_recorded', { title: updated.title }, params.locale),
  };
}

function resolveSurfaceApprovalRecord(params: {
  surface: SurfaceApproval;
  record: ApprovalRequestRecord;
  storageChannel: string;
  channel: string;
  threadTs: string;
  decision: SurfaceApprovalDecision;
  decidedBy: string;
  locale?: SupportedLocale;
}): SurfaceApprovalReply {
  if (params.record.status !== 'pending') {
    return {
      handled: true,
      reply: t('surface:approval_not_found_or_done', undefined, params.locale),
    };
  }
  if (!replyTargetsRecord(params.record, params.surface, params.channel, params.threadTs)) {
    return { handled: true, reply: t('surface:approval_other_thread', undefined, params.locale) };
  }
  if (isApprovalRequestExpired(params.record)) {
    const expired = expireApprovalRequest(approvalRole(params.surface, params.storageChannel), {
      channel: params.record.channel,
      storageChannel: params.storageChannel,
      requestId: params.record.id,
    });
    return {
      handled: true,
      record: expired,
      reply: t('surface:approval_expired', undefined, params.locale),
    };
  }
  const updated = applySurfaceApprovalDecision({
    surface: params.surface,
    requestId: params.record.id,
    decision: params.decision,
    channel: params.record.channel,
    threadTs: params.record.threadTs,
    decidedBy: params.decidedBy,
    storageChannel: params.storageChannel,
  });
  return {
    handled: true,
    record: updated,
    reply:
      params.decision === 'approved'
        ? t('surface:approval_approved_reply', { title: updated.title }, params.locale)
        : t('surface:approval_rejected_reply', { title: updated.title }, params.locale),
  };
}

/** Resolve a reply only against a pending request in the same channel/thread. */
export function resolveSurfaceApprovalReply(params: {
  surface: SurfaceApproval;
  channel: string;
  threadTs: string;
  text: string;
  decidedBy: string;
  locale?: SupportedLocale;
}): SurfaceApprovalReply {
  const text = params.text.trim();
  const cardToken = text.match(CARD_TOKEN);
  if (cardToken) {
    const instruction = text.slice(cardToken[0].length).trim();
    return resolveDecisionCardToken({
      surface: params.surface,
      channel: params.channel,
      threadTs: params.threadTs,
      decidedBy: params.decidedBy,
      requestId: cardToken[1].toLowerCase(),
      kind: cardToken[2].toLowerCase() === 'explain' ? 'explain' : 'changes',
      instruction: instruction || undefined,
      locale: params.locale ?? resolveLocale(),
    });
  }
  const token = text.match(DECISION_TOKEN);
  let record: ApprovalRequestRecord | null = null;
  let decision: SurfaceApprovalDecision | undefined;

  if (token) {
    decision = normalizeDecision(token[2]);
    record = loadReplyTarget(params.surface, token[1]);
    if (!record || record.status !== 'pending') {
      return {
        handled: true,
        reply: t('surface:approval_not_found_or_done', undefined, params.locale),
      };
    }
    if (!decision) {
      return {
        handled: true,
        reply: t('surface:approval_decision_unparsed', undefined, params.locale),
      };
    }
    return resolveSurfaceApprovalRecord({
      surface: params.surface,
      record,
      storageChannel: record.storageChannel,
      channel: params.channel,
      threadTs: params.threadTs,
      decision,
      decidedBy: params.decidedBy,
      locale: params.locale,
    });
  } else {
    decision = normalizeDecision(text);
    if (!decision) return { handled: false };
    const pending = listApprovalRequests({
      storageChannels: [params.surface, 'background-review', AUTONOMY_APPROVAL_CHANNEL],
      status: 'pending',
    }).filter((item) => replyTargetsRecord(item, params.surface, params.channel, params.threadTs));
    if (pending.length !== 1) {
      return {
        handled: true,
        reply:
          pending.length === 0
            ? t('surface:approval_none_pending', undefined, params.locale)
            : t('surface:approval_multiple_pending', undefined, params.locale),
      };
    }
    record = pending[0];
  }

  if (!record || !decision) {
    return {
      handled: true,
      reply: t('surface:approval_decision_unparsed', undefined, params.locale),
    };
  }
  return resolveSurfaceApprovalRecord({
    surface: params.surface,
    record,
    storageChannel: record.storageChannel,
    channel: params.channel,
    threadTs: params.threadTs,
    decision,
    decidedBy: params.decidedBy,
    locale: params.locale,
  });
}
