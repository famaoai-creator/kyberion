import { logger } from './core.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath } from './secure-io.js';
import type { VideoRenderRuntimePolicy } from './video-composition-contract.js';

const DEFAULT_POLICY_PATH = pathResolver.knowledge(
  'product/governance/video-render-runtime-policy.json'
);
const POLICY_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/video-render-runtime-policy.schema.json'
);

const FALLBACK_POLICY: VideoRenderRuntimePolicy = {
  version: 'fallback',
  queue: {
    concurrency: 1,
    cancellation: 'queued_or_running',
  },
  progress: {
    throttle_ms: 250,
    min_percent_delta: 2,
    emit_heartbeat: true,
  },
  bundle: {
    default_bundle_root: 'active/shared/tmp/video-composition',
    copy_declared_assets: false,
  },
  render: {
    allowed_output_formats: ['mp4', 'mov', 'webm'],
    enable_backend_rendering: false,
    backend: 'none',
    quality: 'standard',
    command_timeout_ms: 300000,
  },
};

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
  fallback: FALLBACK_POLICY,
  fallbackOnInvalid: true,
  onFallback: (error) => {
    if (!/missing:/u.test(String(error))) {
      logger.warn(
        `[VIDEO_RENDER_RUNTIME_POLICY] Failed to load policy at ${getPolicyPath()}: ${String(error)}`
      );
    }
  },
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
