import {
  collectMissionHygieneReport,
  type PlannedMissionFinding,
} from '@agent/core/mission-hygiene';
import { loadState } from '@agent/core/mission-state';
import { withExecutionContext } from '@agent/core/authority';
import type { ConciergeViewerContext } from './viewer-context';

/**
 * CS-03 停滞ミッション伺いカード — server-side view over the mission hygiene
 * report. This module only READS: classification comes from
 * `collectMissionHygieneReport` (libs/core/mission-hygiene.ts) and the mission
 * title from mission-state.json. Starting or cancelling stays a human decision
 * routed through scripts/mission_controller.ts (see api/hygiene/[id]/route.ts);
 * nothing here mutates mission state.
 */

export interface HygieneInquiry {
  mission_id: string;
  /** Human-facing label: the agreed goal when recorded, else the mission id. */
  title: string;
  /** Reason code — translated to plain language client-side via i18n. */
  reason: PlannedMissionFinding['reason'];
  tier?: 'personal' | 'confidential' | 'public';
  tenant_slug?: string;
  age_days: number | null;
  waiting_since?: string;
}

function readMissionStateSnapshot(missionId: string) {
  try {
    return withExecutionContext('sovereign_concierge', () => loadState(missionId));
  } catch {
    // A missing/corrupt state file degrades to id-only display; the hygiene
    // report itself already proved the mission exists.
    return null;
  }
}

/** Current mission status straight from disk (used to verify a decision took effect). */
export function readMissionStatus(missionId: string): string | null {
  return readMissionStateSnapshot(missionId)?.status || null;
}

function toInquiry(finding: PlannedMissionFinding): HygieneInquiry {
  const state = readMissionStateSnapshot(finding.mission_id);
  const goal = state?.intent?.goal_summary?.trim() || state?.intent?.source_text?.trim() || '';
  const waitingSince = state?.history?.find((entry) => entry.ts)?.ts;
  const tier =
    finding.tier === 'personal' || finding.tier === 'confidential' || finding.tier === 'public'
      ? finding.tier
      : undefined;
  return {
    mission_id: finding.mission_id,
    title: goal ? goal.slice(0, 120) : finding.mission_id,
    reason: finding.reason,
    ...(tier ? { tier } : {}),
    ...(finding.tenant_slug ? { tenant_slug: finding.tenant_slug } : {}),
    age_days: finding.age_days,
    ...(waitingSince ? { waiting_since: waitingSince } : {}),
  };
}

function visibleToViewer(finding: PlannedMissionFinding, viewer: ConciergeViewerContext): boolean {
  if (!['personal', 'confidential', 'public'].includes(finding.tier)) return false;
  if (!viewer.tierAccess.includes(finding.tier as ConciergeViewerContext['tierAccess'][number])) {
    return false;
  }
  if (viewer.tenantSlugs === 'all') return true;
  return Boolean(finding.tenant_slug && viewer.tenantSlugs.includes(finding.tenant_slug));
}

/**
 * Findings the operator should decide on, oldest first (abandoned before
 * stale, matching the report's own ordering). The `recommendation` field is
 * deliberately dropped: it contains CLI command strings, which ceo-ux.md bans
 * from concierge copy.
 */
export function listHygieneInquiries(viewer?: ConciergeViewerContext): HygieneInquiry[] {
  const report = withExecutionContext('sovereign_concierge', () => collectMissionHygieneReport());
  return [...report.abandoned, ...report.stale]
    .filter((finding) => !viewer || visibleToViewer(finding, viewer))
    .map(toInquiry);
}

/** Only missions currently in the hygiene report are actionable from the UI. */
export function findHygieneInquiry(
  missionId: string,
  viewer?: ConciergeViewerContext
): HygieneInquiry | null {
  const report = withExecutionContext('sovereign_concierge', () => collectMissionHygieneReport());
  const wanted = missionId.toUpperCase();
  const finding = [...report.abandoned, ...report.stale].find(
    (entry) =>
      entry.mission_id.toUpperCase() === wanted && (!viewer || visibleToViewer(entry, viewer))
  );
  return finding ? toInquiry(finding) : null;
}
