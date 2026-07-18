import {
  createApprovalRequest,
  decideApprovalRequest,
  expireApprovalRequest,
  isApprovalRequestExpired,
  listApprovalRequests,
  loadApprovalRequest,
  annotateApprovalRejectionReason,
  type ApprovalRequestDraft,
  type ApprovalRequestRecord,
} from './approval-store.js';
import {
  REJECTION_REASON_CATEGORIES,
  normalizeRejectionReasonCategory,
  type RejectionReasonCategory,
} from './rejection-reason.js';

export type SurfaceApproval = 'slack' | 'telegram' | 'discord' | 'imessage' | 'presence';
export type SurfaceApprovalDecision = 'approved' | 'rejected';
export type SurfaceApprovalAskWhyCategory = RejectionReasonCategory | 'skip';

const DECISION_TOKEN = /^appr:([0-9a-f-]{36}):(approve|approved|reject|rejected)$/iu;

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
  record: ApprovalRequestRecord
): string {
  return [
    `承認が必要です [${surface}]`,
    `タイトル: ${record.title}`,
    record.summary,
    ...(record.details ? [`詳細: ${record.details}`] : []),
    `重要度: ${record.severity || 'medium'}`,
    '',
    '1: 承認する',
    '2: 却下する',
    `返信: appr:${record.id}:approve または appr:${record.id}:reject`,
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
    payloadHash: record.accountability?.payloadHash,
    effectBinding: record.accountability?.effectBinding,
  });
}

export interface SurfaceApprovalReply {
  handled: boolean;
  reply?: string;
  record?: ApprovalRequestRecord;
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
}): SurfaceApprovalReply {
  const text = params.text.trim();
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
