import { isRecord } from '@agent/core/foundation/primitives';

export type ClientMissionProposalResponse = {
  status: 'ok';
  response: string;
};

export type ClientMissionApprovalResponse = {
  status: 'ok';
  response: string;
  mission: { missionId: string };
};

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function hasSafeTree(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(hasSafeTree);
  if (!isRecord(value)) return true;
  return Object.entries(value).every(
    ([key, nested]) => !DANGEROUS_KEYS.has(key) && hasSafeTree(nested)
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim());
}

export function parseMissionProposalResponse(
  value: unknown
): ClientMissionProposalResponse | undefined {
  if (
    !isRecord(value) ||
    !hasSafeTree(value) ||
    value.status !== 'ok' ||
    !isNonEmptyString(value.response)
  ) {
    return undefined;
  }
  return { status: 'ok', response: value.response };
}

export function parseMissionApprovalResponse(
  value: unknown
): ClientMissionApprovalResponse | undefined {
  if (
    !isRecord(value) ||
    !hasSafeTree(value) ||
    value.status !== 'ok' ||
    !isNonEmptyString(value.response) ||
    !isRecord(value.mission) ||
    !isNonEmptyString(value.mission.missionId)
  ) {
    return undefined;
  }
  return {
    status: 'ok',
    response: value.response,
    mission: { missionId: value.mission.missionId },
  };
}
