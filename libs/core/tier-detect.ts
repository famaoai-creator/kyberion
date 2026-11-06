import * as path from 'node:path';
import { partitionedRuntimeStateTierInPath, storageFloorTierInPath } from './storage-layout.js';
import type { TierLevel } from './types.js';

/**
 * Determine the knowledge tier of a file based on its path.
 */
export function detectTier(filePath: string): TierLevel {
  const resolved = path.resolve(filePath);
  if (
    resolved.includes('/knowledge/personal/') ||
    resolved.includes('/active/organizations/personal/') ||
    resolved.includes('/active/projects/personal/')
  )
    return 'personal';
  const stateTier = partitionedRuntimeStateTierInPath(resolved);
  if (stateTier) return stateTier;
  const floorTier = storageFloorTierInPath(resolved);
  if (floorTier) return floorTier;
  if (
    resolved.includes('/knowledge/confidential/') ||
    resolved.includes('/active/organizations/confidential/') ||
    resolved.includes('/active/projects/confidential/')
  )
    return 'confidential';
  return 'public';
}
