import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from '@agent/core/secure-io';
import {
  describeScreenDelta,
  type DescribeScreenDeltaInput,
  type DirtyTileDescriberDeps,
  type ScreenDeltaResult,
  type TileGrid,
} from '@agent/core/dirty-tile-describer';
import { inferImagePayloadTier, type PayloadTier } from '@agent/core/image-description-bridge';

/**
 * vision:describe_screen_delta — dirty-tile description of a screenshot.
 *
 * Tile crops are what reaches the vision model, and the model channel judges
 * their tier by where they live. The effective tier is the strictest of the
 * declared tier, the screenshot's path and the mission's path; any non-public
 * tier crops into the mission directory, so a confidential screen is never
 * cropped into the public shared tmp.
 */

export interface DescribeScreenDeltaParams {
  path: string;
  session_id: string;
  grid?: number | TileGrid;
  tile_px?: number;
  max_describe_per_call?: number;
  tier?: PayloadTier;
  tenant_slug?: string;
  mission_id?: string;
}

export interface DescribeScreenDeltaOpDeps {
  describeDelta?: (
    input: DescribeScreenDeltaInput,
    deps: DirtyTileDescriberDeps
  ) => Promise<ScreenDeltaResult>;
  describer?: Omit<DirtyTileDescriberDeps, 'work_dir'>;
  resolveMissionPath?: (missionId: string) => string;
}

const TIER_RANK: Record<PayloadTier, number> = { public: 0, confidential: 1, personal: 2 };

function stricter(a: PayloadTier, b: PayloadTier): PayloadTier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

export async function handleDescribeScreenDelta(
  params: DescribeScreenDeltaParams,
  deps: DescribeScreenDeltaOpDeps = {}
) {
  const logicalPath = String(params?.path || '').trim();
  if (!logicalPath) {
    throw new Error('[SCREEN_DELTA_INVALID] describe_screen_delta requires params.path');
  }
  const sessionId = String(params.session_id || '').trim();
  if (!sessionId) {
    throw new Error('[SCREEN_DELTA_INVALID] describe_screen_delta requires params.session_id');
  }
  const declared = params.tier;
  if (declared !== undefined && !(declared in TIER_RANK)) {
    throw new Error('[SCREEN_DELTA_INVALID] tier must be public, confidential or personal');
  }
  const imagePath = assertSafeRepositoryPath(pathResolver.rootResolve(logicalPath), {
    allowMissingLeaf: true,
  });
  if (!safeExistsSync(imagePath) || !safeLstat(imagePath).isFile()) {
    throw new Error(`[VISION_RESOURCE_FILE] image path must be a regular file: ${logicalPath}`);
  }

  let tier = stricter(declared ?? 'public', inferImagePayloadTier(imagePath));
  const missionId = String(params.mission_id || '').trim();
  let workDir: string | undefined;
  if (missionId) {
    const missionPath = (
      deps.resolveMissionPath ?? ((id: string) => pathResolver.volatile('mission', id))
    )(missionId);
    tier = stricter(tier, inferImagePayloadTier(missionPath));
    workDir = path.join(missionPath, 'tmp', 'vision-tiles');
  } else if (tier !== 'public') {
    throw new Error(
      `[VISION_TIER_SCOPE] ${tier} screen delta needs mission_id so tile crops stay mission-local`
    );
  }

  const input: DescribeScreenDeltaInput = {
    path: imagePath,
    session_id: sessionId,
    tier,
    ...(params.grid !== undefined ? { grid: params.grid } : {}),
    ...(params.tile_px !== undefined ? { tile_px: params.tile_px } : {}),
    ...(params.max_describe_per_call !== undefined
      ? { max_describe_per_call: params.max_describe_per_call }
      : {}),
    ...(params.tenant_slug ? { tenant_slug: params.tenant_slug } : {}),
  };
  const result = await (deps.describeDelta ?? describeScreenDelta)(input, {
    ...(deps.describer ?? {}),
    ...(workDir ? { work_dir: workDir } : {}),
  });
  return { status: 'succeeded' as const, path: logicalPath, tier, ...result };
}
