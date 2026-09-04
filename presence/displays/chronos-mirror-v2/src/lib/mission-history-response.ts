import { isRecord } from '@agent/core/foundation/primitives';

export type ClientMissionHistoryEntry = {
  missionId: string;
  status:
    | 'planned'
    | 'active'
    | 'validating'
    | 'distilling'
    | 'completed'
    | 'paused'
    | 'failed'
    | 'archived';
  tier: 'personal' | 'confidential' | 'public';
  missionType?: string;
  tenantSlug?: string;
  tenantId?: string;
  persona?: string;
  projectId?: string;
  trackId?: string;
  trackName?: string;
  updatedAt?: string;
  startedAt?: string;
  lastEvent?: string;
  intentText?: string;
  goalSummary?: string;
  successCondition?: string;
  artifactKinds: string[];
  artifactCount: number;
  correlationId?: string;
};

export type MissionHistoryResponse = {
  missions: ClientMissionHistoryEntry[];
};

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MISSION_STATUSES = new Set<ClientMissionHistoryEntry['status']>([
  'planned',
  'active',
  'validating',
  'distilling',
  'completed',
  'paused',
  'failed',
  'archived',
]);
const MISSION_TIERS = new Set<ClientMissionHistoryEntry['tier']>([
  'personal',
  'confidential',
  'public',
]);

function hasSafeKeys(value: Record<string, unknown>): boolean {
  return Object.keys(value).every((key) => !DANGEROUS_KEYS.has(key));
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function parseMissionHistoryEntry(value: unknown): ClientMissionHistoryEntry | undefined {
  if (!isRecord(value) || !hasSafeKeys(value)) return undefined;
  if (
    typeof value.missionId !== 'string' ||
    !value.missionId.trim() ||
    typeof value.status !== 'string' ||
    !MISSION_STATUSES.has(value.status as ClientMissionHistoryEntry['status']) ||
    typeof value.tier !== 'string' ||
    !MISSION_TIERS.has(value.tier as ClientMissionHistoryEntry['tier']) ||
    !Array.isArray(value.artifactKinds) ||
    value.artifactKinds.some((kind) => typeof kind !== 'string') ||
    typeof value.artifactCount !== 'number' ||
    !Number.isInteger(value.artifactCount) ||
    value.artifactCount < 0
  ) {
    return undefined;
  }

  const optionalFields = [
    'missionType',
    'tenantSlug',
    'tenantId',
    'persona',
    'projectId',
    'trackId',
    'trackName',
    'updatedAt',
    'startedAt',
    'lastEvent',
    'intentText',
    'goalSummary',
    'successCondition',
    'correlationId',
  ];
  if (optionalFields.some((field) => !optionalString(value[field]))) return undefined;

  return value as ClientMissionHistoryEntry;
}

export function parseMissionHistoryResponse(value: unknown): MissionHistoryResponse | undefined {
  if (!isRecord(value) || !hasSafeKeys(value) || !Array.isArray(value.missions)) return undefined;
  const missions = value.missions.map(parseMissionHistoryEntry);
  return missions.some((mission) => !mission)
    ? undefined
    : { missions: missions as ClientMissionHistoryEntry[] };
}
