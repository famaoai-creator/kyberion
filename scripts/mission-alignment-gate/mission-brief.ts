/**
 * Canonical persisted mission-brief contract used by the alignment surfaces.
 *
 * A brief is intentionally a partial draft: all fields are optional so the
 * renderer can show an incomplete alignment without inventing content. The
 * schema still rejects unknown keys and malformed nested values before a brief
 * is hashed or used for an approval decision.
 */
import { defineCatalog } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';

export interface MissionBriefFlowStep {
  step?: string | number;
  title?: string;
  detail?: string;
  pipeline?: string;
}

export interface MissionBriefRisk {
  risk?: string;
  level?: string | number;
  mitigation?: string;
}

export interface MissionBriefRole {
  who?: string;
  role?: string;
}

export interface MissionBrief {
  missionId?: string;
  title?: string;
  intent?: string;
  persona?: string;
  tier?: 'personal' | 'confidential' | 'public' | string;
  sovereignSwitch?: 'governance-first' | 'autonomous-yolo' | string;
  victoryConditions?: string[];
  scope?: { in?: string[]; out?: string[] };
  flow?: MissionBriefFlowStep[];
  roles?: MissionBriefRole[];
  deliverables?: string[];
  risks?: MissionBriefRisk[];
  openItems?: string[];
  gate?: {
    sudoGate?: string | boolean;
    riskLevel?: string | number;
    approvalRequired?: boolean;
  };
  estimate?: { effort?: string; cost?: string };
  projectId?: string;
  projectPath?: string;
  trackId?: string;
  trackType?: string;
  lifecycleModel?: string;
}

const MISSION_BRIEF_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/mission-brief.schema.json'
);

/** Load a persisted mission brief through its schema and secure I/O boundary. */
export function loadMissionBriefAtPath(filePath: string): MissionBrief {
  return defineCatalog<MissionBrief>({
    id: 'mission-brief',
    path: filePath,
    schema: MISSION_BRIEF_SCHEMA_PATH,
  }).load();
}
