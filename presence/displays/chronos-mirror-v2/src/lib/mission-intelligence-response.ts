import { isRecord } from '@agent/core/foundation/primitives';
import type { IntelligencePayload } from '../components/MissionIntelligenceTypes';

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ACCESS_ROLES = new Set(['readonly', 'localadmin']);

function hasSafeTree(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(hasSafeTree);
  if (!isRecord(value)) return true;
  return Object.entries(value).every(
    ([key, nested]) => !DANGEROUS_KEYS.has(key) && hasSafeTree(nested)
  );
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function recordArray(value: unknown): value is Array<Record<string, unknown>> {
  return Array.isArray(value) && value.every(isRecord);
}

function optionalRecordArray(value: unknown): value is Array<Record<string, unknown>> | undefined {
  return value === undefined || recordArray(value);
}

function optionalRecord(value: unknown): value is Record<string, unknown> | undefined {
  return value === undefined || isRecord(value);
}

const REQUIRED_COLLECTIONS = [
  'activeMissions',
  'projects',
  'projectTracks',
  'missionSeeds',
  'distillCandidates',
  'serviceBindings',
  'recentArtifacts',
  'pendingApprovals',
  'surfaces',
  'recentEvents',
  'agentMessages',
  'a2aHandoffs',
  'controlActions',
  'ownerSummaries',
  'missionProgress',
  'browserSessions',
  'browserConversationSessions',
  'recentSurfaceOutbox',
  'runtimeLeases',
  'runtimeDoctor',
] as const;

export function parseMissionIntelligenceResponse(value: unknown): IntelligencePayload | undefined {
  if (
    !isRecord(value) ||
    !hasSafeTree(value) ||
    !nonNegativeInteger(value.revision) ||
    typeof value.accessRole !== 'string' ||
    !ACCESS_ROLES.has(value.accessRole) ||
    !REQUIRED_COLLECTIONS.every((key) => recordArray(value[key])) ||
    !isRecord(value.controlActionCatalog) ||
    !isRecord(value.controlActionAvailability) ||
    !isRecord(value.controlActionDetails) ||
    !isRecord(value.surfaceOutbox) ||
    !isRecord(value.runtimeTopology) ||
    !isRecord(value.runtime) ||
    !optionalRecord(value.company) ||
    !optionalRecordArray(value.projectManagement) ||
    !optionalRecordArray(value.gateReadiness) ||
    !optionalRecord(value.missionSeedAssessment) ||
    !optionalRecordArray(value.memoryCandidates) ||
    !optionalRecordArray(value.nextActions)
  ) {
    return undefined;
  }
  return value as IntelligencePayload;
}
