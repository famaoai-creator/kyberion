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
import type { PayloadTier } from '@agent/core/image-description-bridge';
import {
  requireVisionSessionId,
  resolveVisionScope,
  type MissionPathResolver,
} from './vision-scope.js';

/**
 * vision:describe_screen_delta — dirty-tile description of a screenshot.
 *
 * Tile crops are what reaches the vision model, and the model channel judges
 * their tier by where they live. The effective tier is the strictest of the
 * declared tier, the screenshot's path and the mission's path; any non-public
 * tier crops into (and keeps its tile memory in) an existing mission's
 * directory, so a confidential screen is never cropped into the public shared
 * tmp and its descriptions are never reused by a public call.
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
  describer?: Omit<DirtyTileDescriberDeps, 'work_dir' | 'state_dir'>;
  resolveMissionPath?: MissionPathResolver;
}

export async function handleDescribeScreenDelta(
  params: DescribeScreenDeltaParams,
  deps: DescribeScreenDeltaOpDeps = {}
) {
  const logicalPath = String(params?.path || '').trim();
  if (!logicalPath) {
    throw new Error('[SCREEN_DELTA_INVALID] describe_screen_delta requires params.path');
  }
  const sessionId = requireVisionSessionId(
    params.session_id,
    'SCREEN_DELTA_INVALID',
    'describe_screen_delta'
  );
  const imagePath = assertSafeRepositoryPath(pathResolver.rootResolve(logicalPath), {
    allowMissingLeaf: true,
  });
  if (!safeExistsSync(imagePath) || !safeLstat(imagePath).isFile()) {
    throw new Error(`[VISION_RESOURCE_FILE] image path must be a regular file: ${logicalPath}`);
  }

  const scope = resolveVisionScope(
    {
      image_path: imagePath,
      tier: params.tier,
      mission_id: params.mission_id,
      subject: 'screen delta',
      invalid_code: 'SCREEN_DELTA_INVALID',
    },
    deps.resolveMissionPath
  );
  const tier = scope.tier;
  const scopeDirs = scope.mission_path
    ? {
        work_dir: path.join(scope.mission_path, 'tmp', 'vision-tiles'),
        state_dir: path.join(scope.mission_path, 'tmp', 'vision-state'),
      }
    : {};

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
    ...scopeDirs,
  });
  return { status: 'succeeded' as const, path: logicalPath, tier, ...result };
}
