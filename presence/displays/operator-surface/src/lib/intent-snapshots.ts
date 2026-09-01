import * as path from 'node:path';
import {
  isRecord,
  clamp,
  readJson as readFoundationJson,
  readJsonLines as readFoundationJsonLines,
} from '@agent/core/foundation';
import type { IntentDelta, IntentSnapshot } from '@agent/core/intent-delta';
import { isValidTenantSlug } from '@agent/core/entity-scope';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeReaddir,
} from '@agent/core/secure-io';

export interface IntentSnapshotRow {
  mission_id: string;
  tier: 'public' | 'confidential';
  tenant_slug?: string;
  snapshot: IntentSnapshot;
  previous_snapshot_id?: string;
  delta?: IntentDelta;
}

interface MissionLocation {
  mission_id: string;
  tier: 'public' | 'confidential';
  tenant_slug?: string;
  directory: string;
}

function readJson<T>(filePath: string): T | null {
  try {
    const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
    if (!safeExistsSync(safePath) || !safeLstat(safePath).isFile()) return null;
    return readFoundationJson<T>(safePath);
  } catch {
    return null;
  }
}

function readJsonLines<T>(filePath: string): T[] {
  try {
    const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
    if (!safeExistsSync(safePath) || !safeLstat(safePath).isFile()) return [];
    return readFoundationJsonLines<T>(safePath, { onMalformed: 'skip' });
  } catch {
    return [];
  }
}

function detectTenantSlug(state: Record<string, unknown>, directory: string): string | undefined {
  const stateTenant = state.tenant_slug;
  if (typeof stateTenant === 'string' && isValidTenantSlug(stateTenant)) return stateTenant;
  const segments = directory.split(path.sep);
  const confidentialIndex = segments.lastIndexOf('confidential');
  const candidate = confidentialIndex >= 0 ? segments[confidentialIndex + 1] : undefined;
  return candidate && isValidTenantSlug(candidate) ? candidate : undefined;
}

function listMissionLocations(tier: 'public' | 'confidential'): MissionLocation[] {
  let root: string;
  try {
    root = assertSafeRepositoryPath(pathResolver.rootResolve(`active/missions/${tier}`), {
      allowMissingLeaf: true,
    });
    if (!safeExistsSync(root) || !safeLstat(root).isDirectory()) return [];
  } catch {
    return [];
  }
  const locations: MissionLocation[] = [];
  const visit = (directory: string): void => {
    let entries: string[];
    try {
      const safeDirectory = assertSafeRepositoryPath(directory, { allowMissingLeaf: true });
      if (!safeExistsSync(safeDirectory) || !safeLstat(safeDirectory).isDirectory()) return;
      entries = safeReaddir(safeDirectory);
      directory = safeDirectory;
    } catch {
      return;
    }
    for (const entry of entries) {
      const candidate = path.join(directory, entry);
      let stat;
      try {
        stat = safeLstat(candidate);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      const statePath = path.join(candidate, 'mission-state.json');
      const state = readJson<Record<string, unknown>>(statePath);
      if (state && typeof state.mission_id === 'string' && state.mission_id.trim()) {
        locations.push({
          mission_id: state.mission_id,
          tier,
          tenant_slug: detectTenantSlug(state, candidate),
          directory: candidate,
        });
      } else {
        visit(candidate);
      }
    }
  };
  visit(root);
  return locations;
}

function isIntentSnapshot(value: unknown, missionId: string): value is IntentSnapshot {
  if (!isRecord(value)) return false;
  const intent = value.intent;
  return (
    value.mission_id === missionId &&
    typeof value.snapshot_id === 'string' &&
    typeof value.stage === 'string' &&
    typeof value.created_at === 'string' &&
    isRecord(intent) &&
    typeof intent.goal === 'string'
  );
}

function isIntentDelta(value: unknown, missionId: string): value is IntentDelta {
  return (
    isRecord(value) &&
    value.mission_id === missionId &&
    typeof value.to_snapshot === 'string' &&
    typeof value.from_snapshot === 'string' &&
    typeof value.drift_score === 'number' &&
    typeof value.drift_verdict === 'string' &&
    isRecord(value.changes)
  );
}

function missionRows(
  location: MissionLocation,
  tenantScope: string | undefined
): IntentSnapshotRow[] {
  if (
    tenantScope &&
    (location.tier !== 'public' || location.tenant_slug) &&
    location.tenant_slug !== tenantScope
  ) {
    return [];
  }
  const evidenceDir = path.join(location.directory, 'evidence');
  const snapshots = readJsonLines<unknown>(path.join(evidenceDir, 'intent-snapshots.jsonl')).filter(
    (value): value is IntentSnapshot => isIntentSnapshot(value, location.mission_id)
  );
  const deltas = readJsonLines<unknown>(path.join(evidenceDir, 'intent-deltas.jsonl')).filter(
    (value): value is IntentDelta => isIntentDelta(value, location.mission_id)
  );
  const deltaByTarget = new Map(deltas.map((delta) => [delta.to_snapshot, delta]));
  return snapshots.map((snapshot, index) => ({
    mission_id: location.mission_id,
    tier: location.tier,
    ...(location.tenant_slug ? { tenant_slug: location.tenant_slug } : {}),
    snapshot,
    ...(index > 0 ? { previous_snapshot_id: snapshots[index - 1].snapshot_id } : {}),
    ...(deltaByTarget.get(snapshot.snapshot_id)
      ? { delta: deltaByTarget.get(snapshot.snapshot_id) }
      : {}),
  }));
}

export function listIntentSnapshotRows(
  options: { tenantScope?: string; limit?: number } = {}
): IntentSnapshotRow[] {
  const limit = clamp(options.limit ?? 100, 1, 500);
  const locations = [...listMissionLocations('public'), ...listMissionLocations('confidential')];
  return locations
    .flatMap((location) => missionRows(location, options.tenantScope))
    .sort((a, b) => {
      const byTime = b.snapshot.created_at.localeCompare(a.snapshot.created_at);
      return byTime || a.mission_id.localeCompare(b.mission_id);
    })
    .slice(0, limit);
}
