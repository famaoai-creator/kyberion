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
} from './approval-store.js';
import {
  REJECTION_REASON_CATEGORIES,
  normalizeRejectionReasonCategory,
  type RejectionReasonCategory,
} from './rejection-reason.js';
import {
  renderIntentAuthorityLabel,
  renderIntentOutcomeLabel,
  type IntentResolutionContract,
} from './intent-resolution-contract.js';
import type { DecisionCard, DecisionCardTier } from './decision-card.js';
import type { SupportedLocale } from './locale-normalize.js';
import { t } from './t.js';

/** MO-11 S-2: `brief` = the mission-brief HTML review surface (report-review). */
export type SurfaceApproval = 'slack' | 'telegram' | 'discord' | 'imessage' | 'presence' | 'brief';
export type SurfaceApprovalDecision = 'approved' | 'rejected';
export type SurfaceApprovalAskWhyCategory = RejectionReasonCategory | 'skip';

const DECISION_TOKEN = /^appr:([0-9a-f-]{36}):(approve|approved|reject|rejected)$/iu;
const CARD_TOKEN = /^appr:([0-9a-f-]{36}):(changes|explain)(?:\s+([\s\S]+))?$/iu;

export interface SurfaceApprovalAction {
  requestId: string;
  decision: SurfaceApprovalDecision;
  callbackData: string;
}

function normalizeDecision(value: string): SurfaceApprovalDecision | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'approve' || normalized === 'approved' || normalized === '1') {
    return 'approved';
  }
  if (normalized === 'reject' || normalized === 'rejected' || normalized === '2') {
    return 'rejected';
  }
  return undefined;
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

const TIER_KEYS = {
  auto: 'bridge:decision_card_tier_auto',
  notify: 'bridge:decision_card_tier_notify',
  approve: 'bridge:decision_card_tier_approve',
} as const satisfies Record<DecisionCardTier, string>;

function formatDeadline(deadline: string, locale: SupportedLocale, timeZone?: string): string {
  const date = new Date(deadline);
  if (Number.isNaN(date.getTime())) return deadline;
  return date.toLocaleString(locale === 'ja' ? 'ja-JP' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...(timeZone ? { timeZone } : {}),
  });
}

/** The decision card body, shared by every text-based surface. */
export function formatDecisionCardLines(
  card: DecisionCard,
  options: { locale?: SupportedLocale; timeZone?: string } = {}
): string[] {
  const locale = options.locale ?? 'ja';
  return [
    `${t('bridge:decision_card_question_label', undefined, locale)}: ${card.question}`,
    `${t('bridge:decision_card_recommendation_label', undefined, locale)}: ${card.recommendation}`,
    `${t('bridge:decision_card_risk_label', undefined, locale)}: ${t(TIER_KEYS[card.riskTier], undefined, locale)} / ${t(
      card.reversible
        ? 'bridge:decision_card_reversible_yes'
        : 'bridge:decision_card_reversible_no',
      undefined,
      locale
    )}`,
    ...(card.riskReasons.length > 0
      ? [`${t('bridge:decision_card_reasons_label', undefined, locale)}: ${card.riskReasons[0]}`]
      : []),
    ...(card.deadline
      ? [
          `${t('bridge:decision_card_deadline_label', undefined, locale)}: ${formatDeadline(card.deadline, locale, options.timeZone)}`,
        ]
      : []),
    ...(card.evidence.length > 0
      ? [
          `${t('bridge:decision_card_evidence_label', undefined, locale)}:`,
          ...card.evidence.map((item) => `- ${item.label}: ${item.ref}`),
        ]
      : []),
  ];
}

/** "Ask why": the stored rationale only — never a model call. */
export function explainApprovalRequest(
  record: ApprovalRequestRecord,
  options: { locale?: SupportedLocale } = {}
): string {
  const locale = options.locale ?? 'ja';
  const card = record.decisionCard;
  const reasons = [
    ...(card?.riskReasons ?? []),
    ...(record.justification?.reason ? [record.justification.reason] : []),
    ...(record.justification?.impactSummary ? [record.justification.impactSummary] : []),
  ];
  const lines = [t('bridge:decision_card_explain_heading', { title: record.title }, locale)];
  if (reasons.length === 0 && !card) {
    lines.push(t('bridge:decision_card_no_rationale', undefined, locale));
    return lines.join('\n');
  }
  lines.push(...reasons.map((reason) => `- ${reason}`));
  if (card) {
    lines.push(
      `${t('bridge:decision_card_recommendation_label', undefined, locale)}: ${card.recommendation}`,
      t(
        card.reversible
          ? 'bridge:decision_card_reversible_yes'
          : 'bridge:decision_card_reversible_no',
        undefined,
        locale
      ),
      ...card.evidence.map((item) => `- ${item.label}: ${item.ref}`)
    );
  }
  return lines.join('\n');
}

export function buildSurfaceApprovalText(
  surface: SurfaceApproval,
  record: ApprovalRequestRecord,
  intentResolution?: IntentResolutionContract,
  options: { locale?: SupportedLocale; timeZone?: string } = {}
): string {
  const locale = options.locale ?? 'ja';
  if (record.decisionCard) {
    return [
      t('bridge:decision_card_heading', undefined, locale),
      record.title,
      record.summary,
      '',
      ...formatDecisionCardLines(record.decisionCard, options),
      '',
      t('bridge:approval_reply_instruction', { requestId: record.id }, locale),
    ].join('\n');
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

const SURFACE_ASK_WHY_LABELS: Record<RejectionReasonCategory, string> = {
  incorrect_content: '内容が誤り',
  wrong_direction: '方向が違う',
  quality: '品質不足',
  scope: 'スコープ過不足',
  other: 'その他',
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
  requestId: string
): SurfaceApprovalAskWhyAction[] {
  const categories: SurfaceApprovalAskWhyCategory[] = [...REJECTION_REASON_CATEGORIES, 'skip'];
  return categories.map((category) => ({
    requestId,
    category,
    label: category === 'skip' ? 'スキップ' : SURFACE_ASK_WHY_LABELS[category],
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
      reply: 'この却下要求は存在しないか、別のスレッドにあります。',
    };
  }
  if (category === 'skip') {
    return { handled: true, reply: '理由の記録をスキップしました。', record };
  }
  const updated = applySurfaceApprovalRejectionReason({
    ...params,
    category,
    storageChannel: record.storageChannel,
  });
  return {
    handled: true,
    reply: `却下理由を記録しました(${category})。次回の作業改善に反映されます。`,
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
  const record =
    loadApprovalRequest(params.surface, params.requestId) ||
    loadApprovalRequest('background-review', params.requestId);
  if (!record) {
    return { handled: true, reply: 'この承認要求は存在しないか、すでに処理済みです。' };
  }
  if (record.channel !== params.channel || record.threadTs !== params.threadTs) {
    return { handled: true, reply: 'この承認要求は別のスレッドにあります。' };
  }
  if (params.kind === 'explain') {
    return {
      handled: true,
      record,
      reply: explainApprovalRequest(record, { locale: params.locale }),
    };
  }
  if (record.status !== 'pending' || !record.decisionCard) {
    return { handled: true, reply: 'この承認要求は存在しないか、すでに処理済みです。' };
  }
  if (isApprovalRequestExpired(record)) {
    const expired = expireApprovalRequest(approvalRole(params.surface, record.storageChannel), {
      channel: record.channel,
      storageChannel: record.storageChannel,
      requestId: record.id,
    });
    return { handled: true, record: expired, reply: 'この承認要求は期限切れです。' };
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
    channel: params.channel,
    threadTs: params.threadTs,
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
}): SurfaceApprovalReply {
  if (params.record.status !== 'pending') {
    return { handled: true, reply: 'この承認要求は存在しないか、すでに処理済みです。' };
  }
  if (params.record.channel !== params.channel || params.record.threadTs !== params.threadTs) {
    return { handled: true, reply: 'この承認要求は別のスレッドにあります。' };
  }
  if (isApprovalRequestExpired(params.record)) {
    const expired = expireApprovalRequest(approvalRole(params.surface, params.storageChannel), {
      channel: params.record.channel,
      storageChannel: params.storageChannel,
      requestId: params.record.id,
    });
    return { handled: true, record: expired, reply: 'この承認要求は期限切れです。' };
  }
  const updated = applySurfaceApprovalDecision({
    surface: params.surface,
    requestId: params.record.id,
    decision: params.decision,
    channel: params.channel,
    threadTs: params.threadTs,
    decidedBy: params.decidedBy,
    storageChannel: params.storageChannel,
  });
  return {
    handled: true,
    record: updated,
    reply:
      params.decision === 'approved'
        ? `承認しました: ${updated.title}`
        : `却下しました: ${updated.title}`,
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
    return resolveDecisionCardToken({
      surface: params.surface,
      channel: params.channel,
      threadTs: params.threadTs,
      decidedBy: params.decidedBy,
      requestId: cardToken[1].toLowerCase(),
      kind: cardToken[2].toLowerCase() as 'changes' | 'explain',
      instruction: cardToken[3],
      locale: params.locale ?? 'ja',
    });
  }
  const token = text.match(DECISION_TOKEN);
  let record: ApprovalRequestRecord | null = null;
  let decision: SurfaceApprovalDecision | undefined;

  if (token) {
    decision = normalizeDecision(token[2]);
    record =
      loadApprovalRequest(params.surface, token[1]) ||
      loadApprovalRequest('background-review', token[1]);
    if (!record || record.status !== 'pending') {
      return { handled: true, reply: 'この承認要求は存在しないか、すでに処理済みです。' };
    }
    if (!decision) return { handled: true, reply: '承認操作を解釈できませんでした。' };
    return resolveSurfaceApprovalRecord({
      surface: params.surface,
      record,
      storageChannel: record.storageChannel,
      channel: params.channel,
      threadTs: params.threadTs,
      decision,
      decidedBy: params.decidedBy,
    });
  } else {
    decision = normalizeDecision(text);
    if (!decision) return { handled: false };
    const pending = listApprovalRequests({
      storageChannels: [params.surface, 'background-review'],
      status: 'pending',
    }).filter((item) => item.channel === params.channel && item.threadTs === params.threadTs);
    if (pending.length !== 1) {
      return {
        handled: true,
        reply:
          pending.length === 0
            ? 'このスレッドに処理待ちの承認要求はありません。'
            : '承認要求が複数あります。要求メッセージの appr:<id>:approve / reject を返信してください。',
      };
    }
    record = pending[0];
  }

  if (!record || !decision) return { handled: true, reply: '承認操作を解釈できませんでした。' };
  return resolveSurfaceApprovalRecord({
    surface: params.surface,
    record,
    storageChannel: record.storageChannel,
    channel: params.channel,
    threadTs: params.threadTs,
    decision,
    decidedBy: params.decidedBy,
  });
}
