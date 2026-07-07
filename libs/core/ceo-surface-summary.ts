/**
 * CEO surface (concierge / 秘書室) summary — ceo-ux.md の4ペイン
 * (Intent Inbox / Approval Queue / Outcome Feed / Exception Feed) +
 * デイリーブリーフィングを1つの集約に写像する。
 *
 * ceo-ux.md §3 の原則: actuator 名・ADF・実行系の内部用語を出さない。
 * 各項目は「依頼内容 → 現在の状況 → 必要な判断 → 返ってくる結果」の
 * 語彙で表現する。
 */

import { collectOperatorHomeSummary, type OperatorHomeSummary } from './operator-home-summary.js';
import { listSurfaceNotificationsAcrossChannels } from './surface-ux.js';

export interface CeoIntentItem {
  mission_id: string;
  title: string;
  status_ja: string;
  attention_needed: boolean;
  updated_at?: string;
  success_condition?: string;
}

export interface CeoApprovalItem {
  id: string;
  channel: string;
  storage_channel: string;
  title: string;
  reason: string;
  requested_at: string;
  expires_at?: string;
  mission_id?: string;
}

export interface CeoOutcomeItem {
  entry_id: string;
  title: string;
  summary: string;
  artifact_paths: string[];
  mission_id?: string;
  status: string;
  updated_at: string;
}

export interface CeoExceptionItem {
  id: string;
  title: string;
  text: string;
  surface: string;
  created_at: string;
}

export interface CeoDailyBriefing {
  sentence_ja: string;
  counts: {
    active_missions: number;
    pending_approvals: number;
    unread_outcomes: number;
    exceptions: number;
  };
  next_action_ja?: string;
}

export interface CeoSurfaceSummary {
  generated_at: string;
  briefing: CeoDailyBriefing;
  intent_inbox: CeoIntentItem[];
  approval_queue: CeoApprovalItem[];
  outcome_feed: CeoOutcomeItem[];
  exception_feed: CeoExceptionItem[];
}

const MISSION_STATUS_JA: Record<string, string> = {
  planned: '準備中',
  active: '進行中',
  validating: '検証中',
  distilling: '仕上げ中',
  completed: '完了',
  paused: '一時停止',
  failed: '要対応',
  archived: '完了（保管済み）',
};

const ATTENTION_STATUSES = new Set(['paused', 'failed', 'validating']);
const EXCEPTION_NOTIFICATION_STATUSES = new Set(['attention', 'blocked', 'failed', 'error']);

function toIntentItem(mission: OperatorHomeSummary['activeMissions'][number]): CeoIntentItem {
  const status = String(mission.status || '').toLowerCase();
  return {
    mission_id: mission.missionId,
    title: mission.goalSummary || mission.missionType || mission.missionId,
    status_ja: MISSION_STATUS_JA[status] || status || '進行中',
    attention_needed: ATTENTION_STATUSES.has(status),
    updated_at: mission.updatedAt,
    success_condition: mission.successCondition,
  };
}

function toApprovalItem(
  approval: OperatorHomeSummary['pendingApprovals'][number]
): CeoApprovalItem {
  const record = approval as Record<string, any>;
  return {
    id: String(record.id || ''),
    channel: String(record.channel || 'chronos'),
    storage_channel: String(record.storageChannel || record.channel || 'chronos'),
    title: String(record.title || record.sourceText || '承認のご依頼'),
    reason: String(record.justification?.summary || record.sourceText || record.title || ''),
    requested_at: String(record.requestedAt || ''),
    expires_at: record.expiresAt ? String(record.expiresAt) : undefined,
    mission_id: record.requestedByContext?.missionId
      ? String(record.requestedByContext.missionId)
      : undefined,
  };
}

/**
 * Pure mapping — testable without touching stores. `buildCeoSurfaceSummary`
 * is the impure entry point surfaces call.
 */
export function composeCeoSurfaceSummary(input: {
  home: OperatorHomeSummary;
  notifications: Array<Record<string, any>>;
  now?: string;
}): CeoSurfaceSummary {
  const { home } = input;
  const intentInbox = home.activeMissions.map(toIntentItem);
  const approvalQueue = home.pendingApprovals.map(toApprovalItem);
  const outcomeFeed: CeoOutcomeItem[] = home.inboxEntries.map((entry) => ({
    entry_id: entry.entry_id,
    title: entry.title,
    summary: entry.summary,
    artifact_paths: entry.artifact_paths,
    mission_id: entry.mission_id,
    status: entry.status,
    updated_at: entry.updated_at,
  }));
  const exceptionFeed: CeoExceptionItem[] = input.notifications
    .filter((notification) =>
      EXCEPTION_NOTIFICATION_STATUSES.has(String(notification.status || '').toLowerCase())
    )
    .slice(0, 20)
    .map((notification, index) => ({
      id: String(notification.request_id || notification.id || `exception-${index + 1}`),
      title: String(notification.title || '要確認の事象'),
      text: String(notification.text || ''),
      surface: String(notification.surface || 'presence'),
      created_at: String(notification.created_at || ''),
    }));

  const unreadOutcomes = home.counts.unreadInbox;
  const parts: string[] = [];
  if (home.counts.pendingApprovals > 0) {
    parts.push(`ご承認待ちが${home.counts.pendingApprovals}件ございます`);
  }
  if (home.counts.activeMissions > 0) {
    parts.push(`進行中のご依頼が${home.counts.activeMissions}件ございます`);
  }
  if (unreadOutcomes > 0) {
    parts.push(`未確認の成果物が${unreadOutcomes}件届いております`);
  }
  if (exceptionFeed.length > 0) {
    parts.push(`ご確認いただきたい例外が${exceptionFeed.length}件ございます`);
  }
  const sentence =
    parts.length > 0
      ? `本日は${parts.join('。')}。`
      : '本日は特にご対応いただく案件はございません。';

  return {
    generated_at: input.now || new Date().toISOString(),
    briefing: {
      sentence_ja: sentence,
      counts: {
        active_missions: home.counts.activeMissions,
        pending_approvals: home.counts.pendingApprovals,
        unread_outcomes: unreadOutcomes,
        exceptions: exceptionFeed.length,
      },
      next_action_ja: home.nextAction?.title ? String(home.nextAction.title) : undefined,
    },
    intent_inbox: intentInbox,
    approval_queue: approvalQueue,
    outcome_feed: outcomeFeed,
    exception_feed: exceptionFeed,
  };
}

export function buildCeoSurfaceSummary(): CeoSurfaceSummary {
  const home = collectOperatorHomeSummary({ limit: 20 });
  let notifications: Array<Record<string, any>> = [];
  try {
    notifications = listSurfaceNotificationsAcrossChannels();
  } catch {
    notifications = [];
  }
  return composeCeoSurfaceSummary({ home, notifications });
}
