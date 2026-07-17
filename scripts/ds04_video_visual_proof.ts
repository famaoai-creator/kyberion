import * as path from 'node:path';

import {
  pathResolver,
  safeExec,
  safeExistsSync,
  safeReaddir,
  safeStat,
  writeVideoCompositionBundle,
} from '@agent/core';
import type { VideoCompositionADF } from '@agent/core';

const PROOF_ROOT = 'active/shared/tmp/ds04-video-visual-proof/client-a';

export function buildDs04ProofAdf(bundleDir: string): VideoCompositionADF {
  return {
    kind: 'video-composition-adf',
    version: '1.0.0',
    intent: 'Client A tenant branded product proof',
    title: 'Client A branded product proof',
    composition: {
      duration_sec: 3,
      fps: 24,
      width: 1280,
      height: 720,
      background_color: '#12051f',
    },
    scenes: [
      {
        scene_id: 'client-a-hook',
        role: 'feature',
        start_sec: 0,
        duration_sec: 3,
        template_ref: { template_id: 'split-highlight' },
        content: {
          headline: 'Client A: one governed visual language',
          body: 'The same scene template receives a tenant palette without changing its structure.',
          eyebrow: 'Client A palette',
          caption: 'Tokens stay stable from brief to render.',
          visual_steps: [
            { step: '01', detail: 'Brief' },
            { step: '02', detail: 'ADF' },
            { step: '03', detail: 'Render' },
          ],
          design_system_vars: {
            '--kb-bg-main': '#12051f',
            '--kb-bg-deep': '#1f0b33',
            '--kb-bg-surface': '#32104c',
            '--kb-panel-bg': 'rgba(50, 16, 76, 0.92)',
            '--kb-accent': '#e879f9',
            '--kb-accent-soft': 'rgba(232, 121, 249, 0.20)',
            '--kb-accent-strong': '#f0abfc',
            '--kb-accent-blue': '#a78bfa',
            '--kb-accent-blue-soft': '#c4b5fd',
            '--kb-text-primary': '#fff7ff',
            '--kb-text-secondary': '#f5d0fe',
            '--kb-border-subtle': 'rgba(232, 121, 249, 0.30)',
          },
        },
      },
    ],
    output: {
      format: 'mp4',
      bundle_dir: bundleDir,
    },
  };
}

function collectPngs(rootDir: string): string[] {
  if (!safeExistsSync(rootDir)) return [];
  return safeReaddir(rootDir).flatMap((entry) => {
    const candidate = path.join(rootDir, entry);
    if (safeStat(candidate).isDirectory()) return collectPngs(candidate);
    return entry.toLowerCase().endsWith('.png') ? [candidate] : [];
  });
}

export async function runDs04VideoVisualProof(): Promise<{
  bundleDir: string;
  videoPath: string;
  screenshots: string[];
}> {
  const bundleDir = pathResolver.resolve(PROOF_ROOT);
  const adf = buildDs04ProofAdf(bundleDir);
  writeVideoCompositionBundle(adf);

  const videoPath = path.join(bundleDir, 'client-a-proof.mp4');
  safeExec(
    'pnpm',
    [
      'exec',
      'hyperframes',
      'render',
      bundleDir,
      '--output',
      videoPath,
      '--format',
      'mp4',
      '--fps',
      '24',
      '--quality',
      'standard',
    ],
    { cwd: pathResolver.rootDir(), timeoutMs: 300_000 }
  );

  safeExec(
    'pnpm',
    ['exec', 'hyperframes', 'snapshot', bundleDir, '--frames=1', '--at=0', '--describe=false'],
    { cwd: pathResolver.rootDir(), timeoutMs: 120_000 }
  );

  const screenshots = collectPngs(bundleDir);
  if (!safeExistsSync(videoPath)) {
    throw new Error(`DS-04 proof render did not produce ${videoPath}`);
  }
  if (screenshots.length === 0) {
    throw new Error(`DS-04 proof snapshot did not produce a PNG under ${bundleDir}`);
  }

  return { bundleDir, videoPath, screenshots };
}

if (path.basename(process.argv[1] || '') === 'ds04_video_visual_proof.ts') {
  const result = await runDs04VideoVisualProof();
  console.log(JSON.stringify(result, null, 2));
}
