import type { VideoCompositionADF, VideoCompositionAssetRef } from './video-composition-contract.js';

export interface NarratedVideoBrief {
  kind: 'narrated-video-brief';
  version: string;
  intent?: string;
  title?: string;
  language?: string;
  script: {
    hook: string;
    feature: string;
    cta: string;
  };
  narration: {
    artifact_ref: string;
  };
  design_system: {
    brand_name: string;
    theme_tokens?: {
      background_color?: string;
    };
    assets?: {
      logo_path?: string;
      hero_path?: string;
    };
  };
  timing?: {
    duration_sec?: number;
    fps?: number;
  };
  output?: {
    format?: 'mp4' | 'mov' | 'webm';
    target_path?: string;
    bundle_dir?: string;
    await_completion?: boolean;
  };
}

export function compileNarratedVideoBriefToCompositionADF(brief: NarratedVideoBrief): VideoCompositionADF {
  const totalDuration = clampDuration(brief.timing?.duration_sec || 9);
  const fps = clampFps(brief.timing?.fps || 30);
  const background = brief.design_system.theme_tokens?.background_color || '#07111f';
  const format = brief.output?.format || 'mp4';
  const title = brief.title || `${brief.design_system.brand_name} Intro`;

  const hookDuration = roundTo2(totalDuration * 0.33);
  const featureDuration = roundTo2(totalDuration * 0.45);
  const outroDuration = roundTo2(Math.max(0.1, totalDuration - hookDuration - featureDuration));

  const hookAssets = buildSceneAssets(brief, 'hook');
  const featureAssets = buildSceneAssets(brief, 'feature');
  const outroAssets = buildSceneAssets(brief, 'outro');

  return {
    kind: 'video-composition-adf',
    version: '1.0.0',
    intent: brief.intent || 'narrated intro movie from brief',
    title,
    composition: {
      duration_sec: totalDuration,
      fps,
      width: 1920,
      height: 1080,
      background_color: background,
    },
    audio: {
      narration_ref: brief.narration.artifact_ref,
    },
    scenes: [
      {
        scene_id: 'hook',
        role: 'hook',
        start_sec: 0,
        duration_sec: hookDuration,
        template_ref: { template_id: 'basic-title-card' },
        content: {
          eyebrow: brief.design_system.brand_name,
          headline: brief.script.hook,
          body: `Narrated in ${brief.language || 'default language'}.`,
        },
        asset_refs: hookAssets,
      },
      {
        scene_id: 'feature',
        role: 'feature',
        start_sec: hookDuration,
        duration_sec: featureDuration,
        template_ref: { template_id: 'split-highlight' },
        content: {
          headline: 'Design-system aligned composition',
          body: brief.script.feature,
        },
        asset_refs: featureAssets,
      },
      {
        scene_id: 'outro',
        role: 'outro',
        start_sec: roundTo2(hookDuration + featureDuration),
        duration_sec: outroDuration,
        template_ref: { template_id: 'logo-outro' },
        content: {
          headline: brief.design_system.brand_name,
          body: brief.script.cta,
        },
        asset_refs: outroAssets,
      },
    ],
    output: {
      format,
      target_path: brief.output?.target_path,
      bundle_dir: brief.output?.bundle_dir,
      emit_progress_packets: true,
      await_completion: brief.output?.await_completion,
    },
  };
}

function buildSceneAssets(brief: NarratedVideoBrief, scene: 'hook' | 'feature' | 'outro'): VideoCompositionAssetRef[] {
  const assets: VideoCompositionAssetRef[] = [];
  if (brief.design_system.assets?.hero_path && scene !== 'outro') {
    assets.push({
      asset_id: `${scene}-hero`,
      path: brief.design_system.assets.hero_path,
      role: scene === 'feature' ? 'supporting' : 'background',
    });
  }
  if (brief.design_system.assets?.logo_path && scene === 'outro') {
    assets.push({
      asset_id: 'brand-logo',
      path: brief.design_system.assets.logo_path,
      role: 'logo',
    });
  }
  return assets;
}

function clampDuration(value: number): number {
  return Math.max(3, Math.min(300, value));
}

function clampFps(value: number): number {
  return Math.max(1, Math.min(60, Math.round(value)));
}

function roundTo2(value: number): number {
  return Math.round(value * 100) / 100;
}
