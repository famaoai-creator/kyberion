/**
 * scripts/refactor/mission-read-model.ts
 * Query/read models for mission listings and status views.
 */

import * as path from 'node:path';
import { findMissionPath, safeExistsSync, safeLstat, safeReaddir } from '@agent/core';
import { getActiveMissionSearchDirs, loadState } from './mission-state.js';
import type { MissionState } from './mission-types.js';

export interface MissionSummary {
  id: string;
  status: string;
  tier: string;
  persona: string;
  checkpoints: number;
  lastEvent: string;
}

export interface MissionStatusView {
  state: MissionState;
  missionPath: string | null;
  nextAction: string;
  recentHistory: MissionState['history'];
}

export function listMissionSummaries(filterStatus?: string): MissionSummary[] {
  const missions: MissionSummary[] = [];

  for (const dir of getActiveMissionSearchDirs()) {
    try {
      const entries = requireDirEntries(dir);
      for (const missionId of entries) {
        const state = loadState(missionId);
        if (!state) continue;
        if (filterStatus && state.status !== filterStatus) continue;
        const lastHist = state.history[state.history.length - 1];
        missions.push({
          id: state.mission_id,
          status: state.status,
          tier: state.tier,
          persona: state.assigned_persona,
          checkpoints: state.git.checkpoints.length,
          lastEvent: lastHist ? `${lastHist.event} (${lastHist.ts.slice(0, 16)})` : '-',
        });
      }
    } catch (_) {}
  }

  return missions;
}

export function buildMissionStatusView(id: string): MissionStatusView | null {
  const upperId = id.toUpperCase();
  const state = loadState(upperId);
  if (!state) return null;

  const nextActions: Record<string, string> = {
    planned: 'start',
    active: 'checkpoint / verify / delegate',
    validating: 'distill',
    distilling: 'distill',
    completed: 'finish [--seal]',
    paused: 'start (resume)',
    failed: 'start (retry)',
    archived: '(terminal — no further actions)',
  };

  return {
    state,
    missionPath: findMissionPath(upperId),
    nextAction: nextActions[state.status] || '-',
    recentHistory: state.history.slice(-5),
  };
}

function requireDirEntries(dir: string): string[] {
  if (!safeExistsSync(dir) || !safeLstat(dir).isDirectory()) return [];
  return safeReaddir(dir).filter((entry) => {
    try {
      return safeLstat(path.join(dir, entry)).isDirectory();
    } catch (_) {
      return false;
    }
  });
}
