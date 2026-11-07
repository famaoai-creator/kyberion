import { defineCatalog } from '@agent/core/foundation/governed-catalog';
import { getRegisteredEnvText } from '@agent/core/foundation/env';
import { pathResolver } from '@agent/core/path-resolver';
import { assertSafeRepositoryPath } from '@agent/core/secure-io';
import type { VideoRenderRuntimePolicy } from '@agent/core/video/video-composition-contract';

const DEFAULT_POLICY_PATH = pathResolver.knowledge(
  'product/governance/video-render-runtime-policy.json'
);
const POLICY_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/video-render-runtime-policy.schema.json'
);

let cachedPolicyPath: string | null = null;
let cachedPolicy: VideoRenderRuntimePolicy | null = null;

function getPolicyPath(): string {
  return assertSafeRepositoryPath(
    getRegisteredEnvText('KYBERION_VIDEO_RENDER_RUNTIME_POLICY_PATH')?.trim() ||
      DEFAULT_POLICY_PATH,
    { allowMissingLeaf: true }
  );
}

const policyCatalog = defineCatalog<VideoRenderRuntimePolicy>({
  id: 'video-render-runtime-policy',
  path: getPolicyPath,
  schema: POLICY_SCHEMA_PATH,
});

export function _resetVideoRenderRuntimePolicyCacheForTests(): void {
  cachedPolicyPath = null;
  cachedPolicy = null;
  policyCatalog.reset();
}

export function getVideoRenderRuntimePolicy(): VideoRenderRuntimePolicy {
  const policyPath = getPolicyPath();
  if (cachedPolicyPath === policyPath && cachedPolicy) return cachedPolicy;
  cachedPolicyPath = policyPath;
  cachedPolicy = policyCatalog.load();
  return cachedPolicy;
}
