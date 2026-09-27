import {
  createApprovalRequest,
  decideApprovalRequest,
  expireApprovalRequest,
  isApprovalRequestExpired,
  listApprovalRequests,
  loadApprovalRequest,
  annotateApprovalRejectionReason,
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
import type { SupportedLocale } from './locale-normalize.js';
import { t, type VocabularyKey } from './t.js';
import {
  AUTONOMY_APPROVAL_CHANNEL,
  renderDecisionCardExplanation,
  renderDecisionCardText,
  viewDecisionCard,
} from './approval-decision-card.js';

/** MO-11 S-2: `brief` = the mission-brief HTML review surface (report-review). */
export type SurfaceApproval = 'slack' | 'telegram' | 'discord' | 'imessage' | 'presence' | 'brief';
export type SurfaceApprovalDecision = 'approved' | 'rejected';
export type SurfaceApprovalAskWhyCategory = RejectionReasonCategory | 'skip';

// `revise` carries the operator's instructions after a space; `explain` asks
// the agent why the card reached them and decides nothing. The head is matched
// by a fixed-shape regex and the free text is sliced off afterwards, so chat
// input can never drive regex backtracking.
const DECISION_TOKEN_HEAD =
  /^appr:([0-9a-f-]{36}):(approve|approved|reject|rejected|revise|explain)(?=$|\s)/iu;

/** Split `appr:<id>:<verb>[ <free text>]` into its parts in linear time. */
export function parseDecisionToken(
  text: string
): { requestId: string; verb: string; trailing?: string } | null {
  const head = DECISION_TOKEN_HEAD.exec(text);
  if (!head) return null;
  const trailing = text.slice(head[0].length).trim();
  return {
    requestId: head[1],
    verb: head[2].toLowerCase(),
    ...(trailing ? { trailing } : {}),
  };
}

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
  });
}

export function buildSurfaceApprovalText(
  surface: SurfaceApproval,
  record: ApprovalRequestRecord,
  intentResolution?: IntentResolutionContract,
  options: { locale?: SupportedLocale } = {}
): string {
  const locale = options.locale ?? 'ja';
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

function resolveSurfaceApprovalRecord(params: {
  surface: SurfaceApproval;
  record: ApprovalRequestRecord;
  storageChannel: string;
  channel: string;
  threadTs: string;
  decision: SurfaceApprovalDecision;
  decidedBy: string;
  note?: string;
  revise?: boolean;
}): SurfaceApprovalReply {
  if (params.record.status !== 'pending') {
    return { handled: true, reply: 'この承認要求は存在しないか、すでに処理済みです。' };
  }
  if (!replyTargetsRecord(params.record, params.surface, params.channel, params.threadTs)) {
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
    channel: params.record.channel,
    threadTs: params.record.threadTs,
    decidedBy: params.decidedBy,
    storageChannel: params.storageChannel,
    ...(params.note ? { note: params.note } : {}),
  });
  if (params.revise) {
    return {
      handled: true,
      record: updated,
      reply: t('decision:revise_recorded', { title: updated.title }),
    };
  }
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
}): SurfaceApprovalReply {
  const text = params.text.trim();
  const token = parseDecisionToken(text);
  let record: ApprovalRequestRecord | null = null;
  let decision: SurfaceApprovalDecision | undefined;

  if (token) {
    const { verb, trailing } = token;
    record = loadReplyTarget(params.surface, token.requestId);
    if (verb === 'explain') {
      if (!record || !replyTargetsRecord(record, params.surface, params.channel, params.threadTs)) {
        return { handled: true, reply: t('decision:explain_not_found') };
      }
      return {
        handled: true,
        record,
        reply: renderDecisionCardExplanation(viewDecisionCard(record)),
      };
    }
    if (!record || record.status !== 'pending') {
      return { handled: true, reply: 'この承認要求は存在しないか、すでに処理済みです。' };
    }
    if (verb === 'revise') {
      if (!trailing) {
        return {
          handled: true,
          reply: t('decision:revise_needs_text', { requestId: record.id }),
        };
      }
      // A change request settles this card as rejected; the instructions ride
      // on the decision note so the agent redoes the work instead of retrying.
      return resolveSurfaceApprovalRecord({
        surface: params.surface,
        record,
        storageChannel: record.storageChannel,
        channel: params.channel,
        threadTs: params.threadTs,
        decision: 'rejected',
        decidedBy: params.decidedBy,
        note: `revise: ${trailing}`,
        revise: true,
      });
    }
    decision = normalizeDecision(verb);
    if (!decision) return { handled: true, reply: '承認操作を解釈できませんでした。' };
    return resolveSurfaceApprovalRecord({
      surface: params.surface,
      record,
      storageChannel: record.storageChannel,
      channel: params.channel,
      threadTs: params.threadTs,
      decision,
      decidedBy: params.decidedBy,
      ...(trailing ? { note: trailing } : {}),
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
