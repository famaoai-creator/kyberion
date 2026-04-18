import * as path from 'node:path';
import { safeExec, safeExistsSync } from './secure-io.js';
import type { VideoCompositionRenderPlan, VideoRenderRuntimePolicy } from './video-composition-contract.js';

export interface VideoRenderBackendResult {
  executed: boolean;
  backend: 'none' | 'hyperframes_cli';
  output_path?: string;
  command?: string[];
  reason?: string;
}

export function renderVideoCompositionBundle(
  plan: VideoCompositionRenderPlan,
  policy: VideoRenderRuntimePolicy,
): VideoRenderBackendResult {
  if (!policy.render.enable_backend_rendering) {
    return {
      executed: false,
      backend: policy.render.backend,
      reason: 'backend rendering disabled by policy',
    };
  }

  if (policy.render.backend === 'none') {
    return {
      executed: false,
      backend: 'none',
      reason: 'backend set to none',
    };
  }

  if (policy.render.backend !== 'hyperframes_cli') {
    throw new Error(`Unsupported video render backend: ${policy.render.backend}`);
  }

  const outputPath = resolveOutputPath(plan);
  const command = [
    'hyperframes',
    'render',
    plan.bundle_dir,
    '--output',
    outputPath,
    '--format',
    plan.output_format,
    '--fps',
    String(plan.fps),
    '--quality',
    policy.render.quality,
  ];

  safeExec('npx', command, {
    timeoutMs: policy.render.command_timeout_ms,
    cwd: process.cwd(),
  });

  if (!safeExistsSync(outputPath)) {
    throw new Error(`Render backend completed without output artifact: ${outputPath}`);
  }

  return {
    executed: true,
    backend: 'hyperframes_cli',
    output_path: outputPath,
    command: ['npx', ...command],
  };
}

function resolveOutputPath(plan: VideoCompositionRenderPlan): string {
  if (plan.output_target_path && plan.output_target_path.trim()) {
    return path.resolve(process.cwd(), plan.output_target_path.trim());
  }
  const ext = plan.output_format;
  return path.join(plan.bundle_dir, `output.${ext}`);
}
