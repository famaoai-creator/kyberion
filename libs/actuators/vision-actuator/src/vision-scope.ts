import * as path from 'node:path';
import { assertVolatileId, pathResolver } from '@agent/core/path-resolver';
import { inferImagePayloadTier, type PayloadTier } from '@agent/core/image-description-bridge';
import { tenantOfPath } from '@agent/core/video-ingest';

/**
 * Tier and scope for perception ops that write derived artifacts (crops,
 * overlays, marks, redaction copies) or send pixels to a model.
 *
 * The effective tier is the strictest of the declared tier, the image's path
 * and the mission's path. Any non-public tier needs an existing mission, and
 * everything derived from the image stays inside that mission's directory.
 */

const TIER_RANK: Record<PayloadTier, number> = { public: 0, confidential: 1, personal: 2 };

export type MissionPathResolver = (missionId: string) => string | null;

export interface VisionScopeInput {
  /** Absolute path of the source image. */
  image_path: string;
  tier?: unknown;
  mission_id?: unknown;
  /** Human-readable op subject for errors, e.g. 'screen delta'. */
  subject: string;
  /** Error code prefix for malformed input, e.g. 'SCREEN_DELTA_INVALID'. */
  invalid_code: string;
}

export interface VisionScope {
  tier: PayloadTier;
  mission_id?: string;
  /** Existing mission directory; set whenever mission_id is. */
  mission_path?: string;
}

export function stricterTier(a: PayloadTier, b: PayloadTier): PayloadTier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

export function defaultMissionPathResolver(missionId: string): string | null {
  return pathResolver.findMissionPath(missionId);
}

/** Session ids key volatile state; reject anything volatile() would rewrite. */
export function requireVisionSessionId(value: unknown, invalidCode: string, op: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`[${invalidCode}] ${op} requires params.session_id`);
  }
  try {
    return assertVolatileId('session', value);
  } catch (error) {
    throw new Error(`[${invalidCode}] ${(error as Error).message}`);
  }
}

export function resolveVisionScope(
  input: VisionScopeInput,
  resolveMissionPath: MissionPathResolver = defaultMissionPathResolver
): VisionScope {
  const declared = input.tier;
  if (declared !== undefined && !(typeof declared === 'string' && declared in TIER_RANK)) {
    throw new Error(`[${input.invalid_code}] tier must be public, confidential or personal`);
  }
  let tier = stricterTier(
    (declared as PayloadTier | undefined) ?? 'public',
    inferImagePayloadTier(input.image_path)
  );
  const rawMission = typeof input.mission_id === 'string' ? input.mission_id.trim() : '';
  if (!rawMission) {
    if (tier !== 'public') {
      throw new Error(
        `[VISION_TIER_SCOPE] ${tier} ${input.subject} needs mission_id so derived files stay mission-local`
      );
    }
    return { tier };
  }
  let missionId: string;
  try {
    missionId = assertVolatileId('mission', rawMission);
  } catch (error) {
    throw new Error(`[${input.invalid_code}] ${(error as Error).message}`);
  }
  const missionPath = resolveMissionPath(missionId);
  if (!missionPath) {
    throw new Error(`[VISION_TIER_SCOPE] mission '${missionId}' does not exist`);
  }
  tier = stricterTier(tier, inferImagePayloadTier(missionPath));
  return { tier, mission_id: missionId, mission_path: missionPath };
}

/** Tenant owning a mission directory; throws when it cannot be determined. */
export type MissionTenantResolver = (missionPath: string) => string | undefined;

export const defaultMissionTenantResolver: MissionTenantResolver = (missionPath) =>
  tenantOfPath(missionPath);

/**
 * A tenant named alongside a mission must be that mission's own tenant, so a
 * caller cannot bill or route one tenant's mission pixels under another.
 * Returns the tenant to pass on (undefined when none was given).
 */
export function assertMissionTenant(
  scope: VisionScope,
  tenantSlug: unknown,
  resolveTenant: MissionTenantResolver = defaultMissionTenantResolver
): string | undefined {
  const requested = typeof tenantSlug === 'string' ? tenantSlug.trim() : '';
  if (!requested) return undefined;
  if (!scope.mission_path) return requested;
  let owner: string | undefined;
  try {
    owner = resolveTenant(scope.mission_path);
  } catch (error) {
    throw new Error(`[VISION_TIER_SCOPE] ${(error as Error).message}`);
  }
  if (owner !== requested) {
    throw new Error(
      `[VISION_TIER_SCOPE] tenant '${requested}' does not own mission '${scope.mission_id}' (${
        owner ? `tenant '${owner}'` : 'tenant-less mission'
      })`
    );
  }
  return requested;
}

/** True when target is scopeDir itself or lies below it. */
export function isInsideDir(target: string, scopeDir: string): boolean {
  const relative = path.relative(path.resolve(scopeDir), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
