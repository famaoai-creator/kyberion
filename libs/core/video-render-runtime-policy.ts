import { logger } from './core.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { safeJsonParse } from './validators.js';
import type { VideoRenderRuntimePolicy } from './video-composition-contract.js';

const DEFAULT_POLICY_PATH = pathResolver.knowledge('public/governance/video-render-runtime-policy.json');

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
  },
};

let cachedPolicyPath: string | null = null;
let cachedPolicy: VideoRenderRuntimePolicy | null = null;

function getPolicyPath(): string {
  return process.env.KYBERION_VIDEO_RENDER_RUNTIME_POLICY_PATH?.trim() || DEFAULT_POLICY_PATH;
}

export function resetVideoRenderRuntimePolicyCache(): void {
  cachedPolicyPath = null;
  cachedPolicy = null;
}

export function getVideoRenderRuntimePolicy(): VideoRenderRuntimePolicy {
  const policyPath = getPolicyPath();
  if (cachedPolicyPath === policyPath && cachedPolicy) return cachedPolicy;

  if (!safeExistsSync(policyPath)) {
    cachedPolicyPath = policyPath;
    cachedPolicy = FALLBACK_POLICY;
    return cachedPolicy;
  }

  try {
    const raw = safeReadFile(policyPath, { encoding: 'utf8' }) as string;
    const parsed = safeJsonParse<VideoRenderRuntimePolicy>(raw, 'video render runtime policy');
    cachedPolicyPath = policyPath;
    cachedPolicy = parsed;
    return parsed;
  } catch (error: any) {
    logger.warn(`[VIDEO_RENDER_RUNTIME_POLICY] Failed to load policy at ${policyPath}: ${error.message}`);
    cachedPolicyPath = policyPath;
    cachedPolicy = FALLBACK_POLICY;
    return cachedPolicy;
  }
}
