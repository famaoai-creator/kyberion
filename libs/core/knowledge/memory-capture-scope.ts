/**
 * D8 capture scope for mission-derived memory candidates.
 *
 * A candidate's tier and entity scope are written when it is captured, from
 * the mission's own persisted state — never from a caller-supplied hint and
 * never inferred later at promotion or ingest. A mission without a tenant has
 * no scope envelope to give; a non-public candidate captured from it is then
 * rejected at registration (`MEMORY_SCOPE_REQUIRED`).
 */
import * as path from 'node:path';
import { findMissionPath } from '../path-resolver.js';
import { loadMissionStateForInference } from '../mission/mission-state-reader.js';
import type { MemoryScopeEnvelope } from './memory-scope.js';
import type { StorageDataTier } from '../storage-layout.js';

export interface MissionMemoryCaptureScope {
  /** The mission's tier; `confidential` when the state is unreadable (fail closed). */
  tier: StorageDataTier;
  /** Tenant scope of a non-public tenant mission; absent otherwise. */
  scope?: MemoryScopeEnvelope;
}

export function missionMemoryCaptureScope(missionId: string): MissionMemoryCaptureScope {
  const missionDir = findMissionPath(missionId);
  const state = missionDir
    ? loadMissionStateForInference(path.join(missionDir, 'mission-state.json'))
    : null;
  const tier = state?.tier ?? 'confidential';
  if (!state?.tenant_slug || tier === 'public') return { tier };
  return {
    tier,
    scope: {
      tier,
      tenant_slug: state.tenant_slug,
      mission_id: missionId,
      ...(state.organization_id ? { organization_id: state.organization_id } : {}),
    },
  };
}
