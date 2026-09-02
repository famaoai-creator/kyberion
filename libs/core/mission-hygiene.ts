import * as path from 'node:path';
import { logger } from './core.js';
import { pathResolver } from './path-resolver.js';
import { loadStateAtPath } from './mission-state.js';
import type { MissionState } from './mission-types.js';
import { nowIso } from './foundation/time.js';
import { assertSafeRepositoryPath, safeExistsSync, safeReaddir } from './secure-io.js';
import {
  loadMissionNextTaskRecordsAtPath,
  type MissionNextTaskRecord,
} from './mission-next-task-reader.js';
import { sendOpsAlert } from './ops-alert.js';
import { notifyOperator } from './operator-notifications.js';
import { loadOrganizationProfile } from './organization-profile.js';
import {
  enqueueOrganizationLearningCandidate,
  type OrganizationTier,
} from './organization-operating-model.js';

/**
 * Mission hygiene — handling for missions that never actually started.
 *
 * `planned` is the legitimate initial state (mission-status.ts allows only
 * planned → active, which happens on explicit start or first gate pass), so
 * created-but-never-started missions accumulate silently. This module makes
 * that population VISIBLE and ACTIONABLE without auto-mutating anything:
 * deterministic classification of why each planned mission is stuck, a
 * per-mission recommended command, and an operator notification for the
 * stale tail and queues a governed organization-learning candidate. Cancelling
 * or starting stays a human decision via mission_controller (bounded-loop
 * philosophy: detect → recommend → escalate, never silently repair).
 */

export type PlannedMissionReason =
  | 'design_missing' // no NEXT_TASKS.json (or empty) — nothing to execute yet
  | 'ready_not_started' // tasks exist but nothing was ever dispatched
  | 'awaiting_gate' // gates defined but none passed (activation never ran)
  | 'active_stale'
  | 'distilling_stale';

export interface PlannedMissionFinding {
  mission_id: string;
  tier: string;
  organization_id?: string;
  tenant_slug?: string;
  age_days: number | null;
  reason: PlannedMissionReason;
  task_count: number;
  recommendation: string;
  lifecycle_status?: string;
}

export interface MissionHygieneReport {
  generated_at: string;
  planned_total: number;
  stale: PlannedMissionFinding[];
  abandoned: PlannedMissionFinding[];
  active_stale?: PlannedMissionFinding[];
  distilling_stale?: PlannedMissionFinding[];
  thresholds: { stale_days: number; abandoned_days: number };
}

function readMissionTaskRecords(filePath: string): MissionNextTaskRecord[] {
  try {
    const safePath = safeMissionPath(filePath);
    if (!safePath || !safeExistsSync(safePath)) return [];
    return loadMissionNextTaskRecordsAtPath(safePath, path.basename(path.dirname(safePath))) || [];
  } catch {
    return [];
  }
}

function safeMissionPath(filePath: string): string | null {
  try {
    return assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  } catch {
    return null;
  }
}

function safePathExists(filePath: string): boolean {
  const safePath = safeMissionPath(filePath);
  return safePath !== null && safeExistsSync(safePath);
}

function listMissionDirs(): Array<{ missionPath: string; tier: string }> {
  const roots: Array<{ dir: string; tier: string }> = [
    { dir: pathResolver.rootResolve('active/missions'), tier: 'legacy' },
    { dir: pathResolver.rootResolve('active/missions/public'), tier: 'public' },
    { dir: pathResolver.rootResolve('active/missions/confidential'), tier: 'confidential' },
    { dir: pathResolver.rootResolve('active/missions/personal'), tier: 'personal' },
  ];
  const found: Array<{ missionPath: string; tier: string }> = [];
  for (const root of roots) {
    const safeRoot = safeMissionPath(root.dir);
    if (!safeRoot || !safeExistsSync(safeRoot)) continue;
    let entries: string[] = [];
    try {
      entries = safeReaddir(safeRoot);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (['public', 'confidential', 'personal', 'ephemeral'].includes(entry)) continue;
      const missionPath = safeMissionPath(path.join(safeRoot, entry));
      const statePath = missionPath
        ? safeMissionPath(path.join(missionPath, 'mission-state.json'))
        : null;
      if (missionPath && statePath && safeExistsSync(statePath)) {
        found.push({ missionPath, tier: root.tier });
      }
    }
  }
  return found;
}

function missionAgeDays(history: Array<{ ts?: string }> | undefined): number | null {
  const first = history?.find((entry) => entry.ts)?.ts;
  if (!first) return null;
  const created = Date.parse(first);
  if (Number.isNaN(created)) return null;
  return Math.floor((Date.now() - created) / (24 * 60 * 60 * 1000));
}

function scopedMissionFields(
  state: Pick<MissionState, 'organization_id' | 'tenant_slug' | 'context'>
): Pick<PlannedMissionFinding, 'organization_id' | 'tenant_slug'> {
  const context =
    state.context && typeof state.context === 'object'
      ? (state.context as Record<string, unknown>)
      : {};
  const organizationId =
    typeof state.organization_id === 'string' && state.organization_id.trim()
      ? state.organization_id.trim()
      : typeof context.organization_id === 'string' && context.organization_id.trim()
        ? context.organization_id.trim()
        : undefined;
  const tenantSlug =
    typeof state.tenant_slug === 'string' && state.tenant_slug.trim()
      ? state.tenant_slug.trim()
      : typeof context.tenant_slug === 'string' && context.tenant_slug.trim()
        ? context.tenant_slug.trim()
        : undefined;
  return {
    ...(organizationId ? { organization_id: organizationId } : {}),
    ...(tenantSlug ? { tenant_slug: tenantSlug } : {}),
  };
}

function classifyPlanned(missionPath: string): {
  reason: PlannedMissionReason;
  task_count: number;
  recommendation: string;
} {
  const tasks = readMissionTaskRecords(path.join(missionPath, 'NEXT_TASKS.json'));
  if (tasks.length === 0) {
    return {
      reason: 'design_missing',
      task_count: 0,
      recommendation:
        'タスク未展開。続けるなら process 設計から: pnpm mission-controller start <ID> / 不要なら: pnpm mission-controller cancel <ID>',
    };
  }
  const dispatched =
    safePathExists(path.join(missionPath, 'coordination', 'tickets', 'dispatch-manifest.json')) ||
    safePathExists(path.join(missionPath, 'evidence', 'workitem-dispatch-manifest.json'));
  if (!dispatched) {
    return {
      reason: 'ready_not_started',
      task_count: tasks.length,
      recommendation:
        'タスクは準備済みで未着手。開始: pnpm mission-controller dispatch-workitems <ID> --mode subagent',
    };
  }
  return {
    reason: 'awaiting_gate',
    task_count: tasks.length,
    recommendation:
      'ディスパッチ済みだが activation gate 未通過。gate 実行または planned→active の確認を',
  };
}

export function collectMissionHygieneReport(
  options: { staleDays?: number; abandonedDays?: number } = {}
): MissionHygieneReport {
  const staleDays = options.staleDays ?? 2;
  const abandonedDays = options.abandonedDays ?? 14;
  const stale: PlannedMissionFinding[] = [];
  const abandoned: PlannedMissionFinding[] = [];
  const activeStale: PlannedMissionFinding[] = [];
  const distillingStale: PlannedMissionFinding[] = [];
  let plannedTotal = 0;

  for (const { missionPath, tier } of listMissionDirs()) {
    const statePath = safeMissionPath(path.join(missionPath, 'mission-state.json'));
    const state = statePath ? loadStateAtPath(statePath) : null;
    if (!state?.mission_id) continue;
    const status = state.status;
    if (status === 'active' || status === 'distilling') {
      const ageDays = missionAgeDays(state.history);
      if (ageDays !== null && ageDays >= staleDays) {
        const tasks = readMissionTaskRecords(path.join(missionPath, 'NEXT_TASKS.json'));
        const distilling = status === 'distilling';
        const finding: PlannedMissionFinding = {
          mission_id: state.mission_id,
          tier,
          ...scopedMissionFields(state),
          age_days: ageDays,
          reason: distilling ? 'distilling_stale' : 'active_stale',
          task_count: tasks.length,
          lifecycle_status: status,
          recommendation: distilling
            ? `distilling が ${staleDays}日以上継続。レビュー/finish を確認: pnpm mission-controller finish ${state.mission_id}`
            : `active が ${staleDays}日以上継続。checkpoint と残タスクを確認: pnpm mission-controller status ${state.mission_id}`,
        };
        (distilling ? distillingStale : activeStale).push(finding);
      }
      continue;
    }
    if (status !== 'planned') continue;
    plannedTotal += 1;
    const ageDays = missionAgeDays(state.history);
    const classified = classifyPlanned(missionPath);
    const finding: PlannedMissionFinding = {
      mission_id: state.mission_id,
      tier,
      ...scopedMissionFields(state),
      age_days: ageDays,
      ...classified,
    };
    if (ageDays === null || ageDays >= abandonedDays) abandoned.push(finding);
    else if (ageDays >= staleDays) stale.push(finding);
  }

  const byAge = (a: PlannedMissionFinding, b: PlannedMissionFinding) =>
    (b.age_days ?? Number.MAX_SAFE_INTEGER) - (a.age_days ?? Number.MAX_SAFE_INTEGER);
  return {
    generated_at: nowIso(),
    planned_total: plannedTotal,
    stale: stale.sort(byAge),
    abandoned: abandoned.sort(byAge),
    active_stale: activeStale.sort(byAge),
    distilling_stale: distillingStale.sort(byAge),
    thresholds: { stale_days: staleDays, abandoned_days: abandonedDays },
  };
}

function learningTier(tier: string): OrganizationTier {
  return tier === 'confidential' || tier === 'public' || tier === 'personal' ? tier : 'personal';
}

function enqueueMissionHygieneLearning(actionable: PlannedMissionFinding[]): void {
  const profileOrganizationId = loadOrganizationProfile()?.organization_id;
  const defaultOrganizationId = profileOrganizationId || 'default';
  const groups = new Map<
    string,
    {
      organizationId: string;
      tier: OrganizationTier;
      tenantSlug?: string;
      findings: PlannedMissionFinding[];
    }
  >();

  for (const finding of actionable) {
    const tier = learningTier(finding.tier);
    const tenantSlug = finding.tenant_slug?.trim() || undefined;
    // A confidential candidate without a tenant scope cannot be safely
    // placed. Keep the detection visible in the operator alert, but do not
    // downgrade it into a lower-tier organization record.
    if (tier === 'confidential' && !tenantSlug) {
      logger.warn(
        `[mission-hygiene] skipped learning enqueue for ${finding.mission_id}: confidential tenant scope is missing`
      );
      continue;
    }
    const organizationId = finding.organization_id || defaultOrganizationId;
    const key = `${organizationId}:${tier}:${tenantSlug || 'shared'}`;
    const group = groups.get(key);
    if (group) group.findings.push(finding);
    else
      groups.set(key, {
        organizationId,
        tier,
        ...(tenantSlug ? { tenantSlug } : {}),
        findings: [finding],
      });
  }

  const generatedAt = nowIso();
  const day = generatedAt.slice(0, 10);
  for (const group of groups.values()) {
    const scope = group.tenantSlug || 'shared';
    const learningId = `mission-hygiene-${day}-${group.tier}-${scope}`.replace(
      /[^A-Za-z0-9._-]/g,
      '-'
    );
    try {
      enqueueOrganizationLearningCandidate({
        learningId,
        organizationId: group.organizationId,
        sourceType: 'routine_exception',
        sourceRef: `mission-hygiene:${day}:${group.organizationId}:${group.tier}:${scope}`,
        title: `Mission hygiene requires review (${group.findings.length})`,
        summary: `${group.findings.length} stale or abandoned mission(s) exceeded the hygiene threshold. Decide whether to resume, cancel, or archive them.`,
        evidenceRefs: group.findings
          .slice(0, 100)
          .map((finding) => `mission:${finding.mission_id}`),
        targetKind: 'sop_candidate',
        tier: group.tier,
        ...(group.tenantSlug ? { tenantSlug: group.tenantSlug } : {}),
        metadata: {
          generated_at: generatedAt,
          findings: group.findings.length,
          reasons: [...new Set(group.findings.map((finding) => finding.reason))],
        },
      });
    } catch (error) {
      logger.warn(
        `[mission-hygiene] learning enqueue failed for ${group.organizationId}/${group.tier}/${scope}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

/**
 * Escalate the stale tail to the operator: one deduped ops alert plus an
 * inbox question listing the oldest offenders with their per-mission
 * remediation command. Never mutates mission state.
 */
export async function notifyMissionHygiene(report: MissionHygieneReport): Promise<boolean> {
  const actionable = [
    ...report.abandoned,
    ...report.stale,
    ...(report.active_stale || []),
    ...(report.distilling_stale || []),
  ];
  if (actionable.length === 0) return false;
  enqueueMissionHygieneLearning(actionable);
  const top = actionable.slice(0, 10);
  const lines = top.map(
    (finding) =>
      `- ${finding.mission_id} (${finding.age_days ?? '?'}日, ${finding.reason}): ${finding.recommendation.replaceAll('<ID>', finding.mission_id)}`
  );
  const notificationDay = nowIso().slice(0, 10);
  sendOpsAlert({
    severity:
      report.abandoned.length > 0 || (report.distilling_stale || []).length > 0
        ? 'warning'
        : 'info',
    title: `ミッション衛生の要対応が ${actionable.length} 件あります (planned ${report.planned_total} 件)`,
    context: {
      planned_total: report.planned_total,
      stale: report.stale.length,
      abandoned: report.abandoned.length,
      active_stale: report.active_stale?.length || 0,
      distilling_stale: report.distilling_stale?.length || 0,
      top: top.map((finding) => finding.mission_id),
    },
    recommendation: lines.join('\n'),
    dedupe_key: `mission-hygiene:${notificationDay}`,
  });
  try {
    await notifyOperator('question', {
      title: `未開始ミッション ${actionable.length} 件の扱いを決めてください`,
      body: [
        `planned のまま止まっているミッションがあります(${report.thresholds.stale_days}日以上)。`,
        '開始するか、不要なら cancel してください:',
        ...lines,
      ].join('\n'),
      correlation_id: `mission-hygiene:${notificationDay}`,
    });
  } catch (err) {
    logger.warn(
      `[mission-hygiene] operator notification failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return true;
}

/** One-line summary for doctor/baseline surfaces. */
export function formatMissionHygieneLine(report: MissionHygieneReport): string {
  if (
    report.planned_total === 0 &&
    (report.active_stale?.length || 0) === 0 &&
    (report.distilling_stale?.length || 0) === 0
  )
    return 'Mission hygiene: no stale missions waiting';
  return `Mission hygiene: ${report.planned_total} planned (stale>${report.thresholds.stale_days}d: ${report.stale.length}, active: ${report.active_stale?.length || 0}, distilling: ${report.distilling_stale?.length || 0}, abandoned>${report.thresholds.abandoned_days}d: ${report.abandoned.length}) — pnpm mission-controller hygiene`;
}
