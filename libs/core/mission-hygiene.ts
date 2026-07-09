import * as path from 'node:path';
import { logger } from './core.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReaddir, safeReadFile } from './secure-io.js';
import { sendOpsAlert } from './ops-alert.js';
import { notifyOperator } from './operator-notifications.js';

/**
 * Mission hygiene — handling for missions that never actually started.
 *
 * `planned` is the legitimate initial state (mission-status.ts allows only
 * planned → active, which happens on explicit start or first gate pass), so
 * created-but-never-started missions accumulate silently. This module makes
 * that population VISIBLE and ACTIONABLE without auto-mutating anything:
 * deterministic classification of why each planned mission is stuck, a
 * per-mission recommended command, and an operator notification for the
 * stale tail. Cancelling/starting stays a human decision via
 * mission_controller (bounded-loop philosophy: detect → recommend →
 * escalate, never silently repair).
 */

export type PlannedMissionReason =
  | 'design_missing' // no NEXT_TASKS.json (or empty) — nothing to execute yet
  | 'ready_not_started' // tasks exist but nothing was ever dispatched
  | 'awaiting_gate'; // gates defined but none passed (activation never ran)

export interface PlannedMissionFinding {
  mission_id: string;
  tier: string;
  age_days: number | null;
  reason: PlannedMissionReason;
  task_count: number;
  recommendation: string;
}

export interface MissionHygieneReport {
  generated_at: string;
  planned_total: number;
  stale: PlannedMissionFinding[];
  abandoned: PlannedMissionFinding[];
  thresholds: { stale_days: number; abandoned_days: number };
}

function readJson<T>(filePath: string): T | null {
  try {
    if (!safeExistsSync(filePath)) return null;
    return JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as T;
  } catch {
    return null;
  }
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
    if (!safeExistsSync(root.dir)) continue;
    let entries: string[] = [];
    try {
      entries = safeReaddir(root.dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (['public', 'confidential', 'personal', 'ephemeral'].includes(entry)) continue;
      const missionPath = path.join(root.dir, entry);
      if (safeExistsSync(path.join(missionPath, 'mission-state.json'))) {
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

function classifyPlanned(missionPath: string): {
  reason: PlannedMissionReason;
  task_count: number;
  recommendation: string;
} {
  const tasks =
    readJson<Array<Record<string, unknown>>>(path.join(missionPath, 'NEXT_TASKS.json')) || [];
  if (tasks.length === 0) {
    return {
      reason: 'design_missing',
      task_count: 0,
      recommendation:
        'タスク未展開。続けるなら process 設計から: pnpm mission-controller start <ID> / 不要なら: pnpm mission-controller cancel <ID>',
    };
  }
  const dispatched =
    safeExistsSync(path.join(missionPath, 'coordination', 'tickets', 'dispatch-manifest.json')) ||
    safeExistsSync(path.join(missionPath, 'evidence', 'workitem-dispatch-manifest.json'));
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
  let plannedTotal = 0;

  for (const { missionPath, tier } of listMissionDirs()) {
    const state = readJson<{
      mission_id?: string;
      status?: string;
      history?: Array<{ ts?: string }>;
    }>(path.join(missionPath, 'mission-state.json'));
    if (!state?.mission_id || state.status !== 'planned') continue;
    plannedTotal += 1;
    const ageDays = missionAgeDays(state.history);
    const classified = classifyPlanned(missionPath);
    const finding: PlannedMissionFinding = {
      mission_id: state.mission_id,
      tier,
      age_days: ageDays,
      ...classified,
    };
    if (ageDays === null || ageDays >= abandonedDays) abandoned.push(finding);
    else if (ageDays >= staleDays) stale.push(finding);
  }

  const byAge = (a: PlannedMissionFinding, b: PlannedMissionFinding) =>
    (b.age_days ?? Number.MAX_SAFE_INTEGER) - (a.age_days ?? Number.MAX_SAFE_INTEGER);
  return {
    generated_at: new Date().toISOString(),
    planned_total: plannedTotal,
    stale: stale.sort(byAge),
    abandoned: abandoned.sort(byAge),
    thresholds: { stale_days: staleDays, abandoned_days: abandonedDays },
  };
}

/**
 * Escalate the stale tail to the operator: one deduped ops alert plus an
 * inbox question listing the oldest offenders with their per-mission
 * remediation command. Never mutates mission state.
 */
export async function notifyMissionHygiene(report: MissionHygieneReport): Promise<boolean> {
  const actionable = [...report.abandoned, ...report.stale];
  if (actionable.length === 0) return false;
  const top = actionable.slice(0, 10);
  const lines = top.map(
    (finding) =>
      `- ${finding.mission_id} (${finding.age_days ?? '?'}日, ${finding.reason}): ${finding.recommendation.replaceAll('<ID>', finding.mission_id)}`
  );
  sendOpsAlert({
    severity: report.abandoned.length > 0 ? 'warning' : 'info',
    title: `未開始ミッションが滞留しています (planned ${report.planned_total} 件中、要対応 ${actionable.length} 件)`,
    context: {
      planned_total: report.planned_total,
      stale: report.stale.length,
      abandoned: report.abandoned.length,
      top: top.map((finding) => finding.mission_id),
    },
    recommendation: lines.join('\n'),
    dedupe_key: `mission-hygiene:${new Date().toISOString().slice(0, 10)}`,
  });
  try {
    await notifyOperator('question', {
      title: `未開始ミッション ${actionable.length} 件の扱いを決めてください`,
      body: [
        `planned のまま止まっているミッションがあります(${report.thresholds.stale_days}日以上)。`,
        '開始するか、不要なら cancel してください:',
        ...lines,
      ].join('\n'),
      correlation_id: `mission-hygiene:${new Date().toISOString().slice(0, 10)}`,
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
  if (report.planned_total === 0) return 'Mission hygiene: no planned missions waiting';
  return `Mission hygiene: ${report.planned_total} planned (stale>${report.thresholds.stale_days}d: ${report.stale.length}, abandoned>${report.thresholds.abandoned_days}d: ${report.abandoned.length}) — pnpm mission-controller hygiene`;
}
