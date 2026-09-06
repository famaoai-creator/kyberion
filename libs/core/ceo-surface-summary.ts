/**
 * CEO surface (concierge / 秘書室) summary — ceo-ux.md の4ペイン
 * (Intent Inbox / Approval Queue / Outcome Feed / Exception Feed) +
 * デイリーブリーフィングを1つの集約に写像する。
 *
 * ceo-ux.md §3 の原則: actuator 名・ADF・実行系の内部用語を出さない。
 * 各項目は「依頼内容 → 現在の状況 → 必要な判断 → 返ってくる結果」の
 * 語彙で表現する。
 */

import {
  collectOperatorHomeSummary,
  type OperatorHomeScopeFilter,
  type OperatorHomeSummary,
} from './operator-home-summary.js';
import { listSurfaceNotificationsAcrossChannels } from './surface-ux.js';
import { t, type VocabularyKey } from './t.js';
import { nowIso } from './foundation/time.js';

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
  workforce?: OperatorHomeSummary['workforceSummary'];
  action_queue?: OperatorHomeSummary['actionQueue'];
  runway?: {
    total_usd: number;
    budget_usd?: number;
    remaining_usd?: number | null;
    over_budget: boolean;
  };
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
const NEXT_ACTION_JA_BY_KEY: Partial<Record<VocabularyKey, VocabularyKey>> = {
  'chronos:chronos_home_action_blocked': 'chronos:chronos_home_action_blocked',
  'chronos:chronos_home_action_approvals': 'chronos:chronos_home_action_approvals',
  'chronos:chronos_home_action_inbox': 'chronos:chronos_home_action_inbox',
  'operator_home:next_action.inspect_blocked': 'operator_home:next_action.inspect_blocked',
  'operator_home:next_action.review_approvals': 'operator_home:next_action.review_approvals',
  'operator_home:next_action.review_quality': 'operator_home:next_action.review_quality',
  'operator_home:next_action.acknowledge_inbox': 'operator_home:next_action.acknowledge_inbox',
  'operator_home:next_action.monitor': 'operator_home:next_action.monitor',
  'next_action:verify_missing_runtime_prerequisites':
    'next_action:verify_missing_runtime_prerequisites',
  'next_action:repair_credentials': 'next_action:repair_credentials',
  'next_action:inspect_configured_secrets': 'next_action:inspect_configured_secrets',
  'next_action:fix_write_path_scope': 'next_action:fix_write_path_scope',
  'next_action:request_required_approval': 'next_action:request_required_approval',
  'next_action:resolve_policy_block': 'next_action:resolve_policy_block',
  'next_action:resolve_mission_id': 'next_action:resolve_mission_id',
  'next_action:fix_failing_pipeline_input': 'next_action:fix_failing_pipeline_input',
  'next_action:fix_failing_input': 'next_action:fix_failing_input',
  'next_action:check_remote_dependency_retry': 'next_action:check_remote_dependency_retry',
  'next_action:inspect_failure_rerun': 'next_action:inspect_failure_rerun',
  'next_action:verify_runtime_prerequisites': 'next_action:verify_runtime_prerequisites',
  'next_action:fix_service_setup': 'next_action:fix_service_setup',
  'next_action:bootstrap_runtime': 'next_action:bootstrap_runtime',
  'home.next_action': 'home.next_action',
};

function nextActionJapanese(action: OperatorHomeSummary['nextAction']): string | undefined {
  const title = action?.title;
  if (!title?.trim()) return undefined;
  if (/[^\u0000-\u007f]/u.test(title)) return title;
  const key = action.next_action_key ? NEXT_ACTION_JA_BY_KEY[action.next_action_key] : undefined;
  // Keep newly introduced actions visible until their vocabulary key is
  // registered; the clear-state message must never hide operator work.
  if (!key) return title;
  if (key === 'home.next_action') return t(key, { value: title }, 'ja');
  return t(key, undefined, 'ja');
}
const EXCEPTION_NOTIFICATION_STATUSES = new Set(['attention', 'blocked', 'failed', 'error']);

function notificationMatchesScope(
  notification: Record<string, unknown>,
  scope?: OperatorHomeScopeFilter
): boolean {
  const scoped = Boolean(
    scope &&
    [scope.tiers, scope.tenantSlugs, scope.organizationIds, scope.projectIds].some((value) =>
      Array.isArray(value)
    )
  );
  if (!scoped) return true;
  const notificationScope = notification.scope;
  if (!notificationScope || typeof notificationScope !== 'object') return false;
  const scopedRecord = notificationScope as Record<string, unknown>;
  if (
    Array.isArray(scope?.tiers) &&
    !scope.tiers.includes(scopedRecord.tier as 'personal' | 'confidential' | 'public')
  )
    return false;
  if (
    Array.isArray(scope?.tenantSlugs) &&
    !scope.tenantSlugs.includes(String(scopedRecord.tenant_slug || ''))
  )
    return false;
  if (
    Array.isArray(scope?.organizationIds) &&
    !scope.organizationIds.includes(String(scopedRecord.organization_id || ''))
  )
    return false;
  if (
    Array.isArray(scope?.projectIds) &&
    !scope.projectIds.includes(String(scopedRecord.project_id || ''))
  )
    return false;
  return true;
}

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
    parts.push(t('home.briefing_approval', { count: home.counts.pendingApprovals }, 'ja'));
  }
  if (home.counts.activeMissions > 0) {
    parts.push(t('home.briefing_missions', { count: home.counts.activeMissions }, 'ja'));
  }
  if (unreadOutcomes > 0) {
    parts.push(t('home.briefing_outcomes', { count: unreadOutcomes }, 'ja'));
  }
  if (exceptionFeed.length > 0) {
    parts.push(t('home.briefing_exceptions', { count: exceptionFeed.length }, 'ja'));
  }
  const sentence = parts.length
    ? t('home.briefing_summary', { details: parts.join('。') }, 'ja')
    : t('home.briefing_clear', undefined, 'ja');

  return {
    generated_at: input.now || nowIso(),
    briefing: {
      sentence_ja: sentence,
      counts: {
        active_missions: home.counts.activeMissions,
        pending_approvals: home.counts.pendingApprovals,
        unread_outcomes: unreadOutcomes,
        exceptions: exceptionFeed.length,
      },
      next_action_ja: nextActionJapanese(home.nextAction),
    },
    intent_inbox: intentInbox,
    approval_queue: approvalQueue,
    outcome_feed: outcomeFeed,
    exception_feed: exceptionFeed,
    workforce: home.workforceSummary,
    action_queue: home.actionQueue,
    runway: {
      total_usd: home.costSummary.totalUsd,
      ...(home.costSummary.budgetUsd !== undefined
        ? { budget_usd: home.costSummary.budgetUsd }
        : {}),
      remaining_usd: home.costSummary.remainingUsd,
      over_budget: home.costSummary.overBudget,
    },
  };
}

export function buildCeoSurfaceSummary(
  input: {
    scope?: OperatorHomeScopeFilter;
    limit?: number;
  } = {}
): CeoSurfaceSummary {
  const home = collectOperatorHomeSummary({ limit: input.limit || 20, scope: input.scope });
  let notifications: Array<Record<string, any>> = [];
  try {
    notifications = listSurfaceNotificationsAcrossChannels().filter((notification) =>
      notificationMatchesScope(notification, input.scope)
    );
  } catch {
    notifications = [];
  }
  return composeCeoSurfaceSummary({ home, notifications });
}
