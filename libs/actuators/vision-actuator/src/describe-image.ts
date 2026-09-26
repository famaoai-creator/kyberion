import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { assertSafeRepositoryPath } from '@agent/core/secure-io';
import {
  describeImage as coreDescribeImage,
  type DescribeImageOptions,
  type PayloadTier,
} from '@agent/core/image-description-bridge';
import {
  createRedactedImageCopy,
  type RedactedImageCopy,
} from '@agent/core/screen-frame-redaction';
import {
  assertMissionTenant,
  resolveVisionScope,
  type MissionPathResolver,
  type MissionTenantResolver,
} from './vision-scope.js';

type ImageDescriptionRequest = Parameters<typeof coreDescribeImage>[0];
type ImageDescriptionResult = Awaited<ReturnType<typeof coreDescribeImage>>;

/**
 * vision:describe_image. The reasoning_vision provider sends the image off
 * the machine, so it only ever receives a screen-redacted copy, made inside
 * the mission for non-public images, under the image's effective tier and
 * the caller's tenant.
 */

export interface DescribeImageParams {
  path: string;
  kind?: ImageDescriptionRequest['kind'];
  tier?: PayloadTier;
  mission_id?: string;
  tenant_slug?: string;
}

export interface DescribeImageOpDeps {
  describe?: (
    request: ImageDescriptionRequest,
    options: DescribeImageOptions
  ) => Promise<ImageDescriptionResult>;
  redactCopy?: (inputPath: string, options: { work_dir?: string }) => Promise<RedactedImageCopy>;
  resolveMissionPath?: MissionPathResolver;
  resolveMissionTenant?: MissionTenantResolver;
}

export async function handleDescribeImage(
  params: DescribeImageParams,
  deps: DescribeImageOpDeps = {}
) {
  const logicalPath = String(params?.path || '');
  if (!logicalPath) throw new Error('describe_image requires params.path');
  const imagePath = assertSafeRepositoryPath(pathResolver.rootResolve(logicalPath), {
    allowMissingLeaf: true,
  });
  const scope = resolveVisionScope(
    {
      image_path: imagePath,
      tier: params.tier,
      mission_id: params.mission_id,
      subject: 'image description',
      invalid_code: 'VISION_DESCRIBE_INVALID',
    },
    deps.resolveMissionPath
  );
  const workDir = scope.mission_path
    ? path.join(scope.mission_path, 'tmp', 'vision-describe')
    : undefined;
  const redactCopy = deps.redactCopy ?? createRedactedImageCopy;
  const tenantSlug = assertMissionTenant(scope, params.tenant_slug, deps.resolveMissionTenant);
  const result = await (deps.describe ?? coreDescribeImage)(
    { path: logicalPath, kind: params.kind },
    {
      tier: scope.tier,
      ...(tenantSlug ? { tenant_slug: tenantSlug } : {}),
      prepare_egress_image: (absolutePath) =>
        redactCopy(absolutePath, workDir ? { work_dir: workDir } : {}),
    }
  );
  return {
    status: result.status,
    path: logicalPath,
    description: result.description,
    provider: result.provider,
  };
}
