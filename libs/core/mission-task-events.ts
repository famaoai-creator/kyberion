import { randomUUID } from 'node:crypto';
import { missionDir, pathResolver } from './path-resolver.js';
import { safeAppendFileSync, safeMkdir } from './secure-io.js';

export type MissionTaskEventType = 'task_issued' | 'task_submitted' | 'task_reviewed' | 'task_completed';

export interface MissionTaskEventInput {
  event_type: MissionTaskEventType;
  mission_id: string;
  task_id: string;
  agent_id?: string;
  team_role?: string;
  decision: string;
  why: string;
  policy_used: string;
  evidence?: string[];
  payload?: Record<string, unknown>;
  causation_id?: string;
  correlation_id?: string;
}

function ensureTaskEventDirs(missionId: string): { missionEventPath: string; globalEventPath: string } {
  const missionEventsDir = `${missionDir(missionId, 'public')}/coordination/events`;
  const globalEventsDir = pathResolver.shared('observability/mission-control');
  safeMkdir(missionEventsDir);
  safeMkdir(globalEventsDir);
  return {
    missionEventPath: `${missionEventsDir}/task-events.jsonl`,
    globalEventPath: `${globalEventsDir}/task-events.jsonl`,
  };
}

export function emitMissionTaskEvent(input: MissionTaskEventInput): void {
  const event = {
    ts: new Date().toISOString(),
    event_id: randomUUID(),
    ...input,
  };
  const { missionEventPath, globalEventPath } = ensureTaskEventDirs(input.mission_id);
  const line = `${JSON.stringify(event)}\n`;
  safeAppendFileSync(missionEventPath, line);
  safeAppendFileSync(globalEventPath, line);
}
