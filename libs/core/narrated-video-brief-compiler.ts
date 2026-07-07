import type { VideoStoryboard } from './video-content-brief-contract.js';
import { resolveCreativeDesign } from './creative-design-resolver.js';
import type {
  VideoCompositionADF,
  VideoCompositionAssetRef,
  VideoCompositionSceneRole,
} from './video-composition-contract.js';
import { resolveDefaultVideoBackgroundColor } from './video-design-system.js';

export interface NarratedVideoBrief {
  kind: 'narrated-video-brief';
  version: string;
  intent?: string;
  title?: string;
  language?: string;
  storyboard?: VideoStoryboard;
  script: {
    hook: string;
    feature: string;
    cta: string;
  };
  narration: {
    artifact_ref: string;
  };
  /** Optional BGM track muxed alongside (or instead of) narration (E2E-02 MV). */
  music?: {
    artifact_ref?: string;
  };
  design_system: {
    brand_name: string;
    /** VDS-07 / E2E-02: direct tenant selection via creative-design-resolver. */
    tenant_slug?: string;
    theme_tokens?: {
      background_color?: string;
      css_vars?: Record<string, string>;
      layout_variant?: string;
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
    detached_background?: boolean;
  };
}

/**
 * VDS-07 (E2E-02): when the brief names a tenant, fill theme tokens from the
 * single creative-design resolver. Explicit brief values always win.
 */
function applyTenantDesignToNarratedBrief(brief: NarratedVideoBrief): NarratedVideoBrief {
  const tenantSlug = brief.design_system.tenant_slug;
  if (!tenantSlug) return brief;
  const resolved = resolveCreativeDesign({ surface: 'video', tenantSlug });
  if (resolved.source !== 'tenant-override' || resolved.projection.surface !== 'video') {
    return brief;
  }
  const tenantVars = resolved.projection.css_vars;
  const explicit = brief.design_system.theme_tokens;
  return {
    ...brief,
    design_system: {
      ...brief.design_system,
      theme_tokens: {
        ...explicit,
        background_color: explicit?.background_color || tenantVars['--kb-bg-main'],
        css_vars: { ...tenantVars, ...(explicit?.css_vars || {}) },
      },
    },
  };
}

export function compileNarratedVideoBriefToCompositionADF(
  input: NarratedVideoBrief
): VideoCompositionADF {
  const brief = applyTenantDesignToNarratedBrief(input);
  const storyboard = brief.storyboard;
  const totalDuration = clampDuration(
    brief.timing?.duration_sec || (storyboard ? sumStoryboardDuration(storyboard) : 9)
  );
  const fps = clampFps(brief.timing?.fps || 30);
  const background =
    brief.design_system.theme_tokens?.background_color ||
    storyboard?.design_system_ref?.background_color ||
    resolveDefaultVideoBackgroundColor();
  const format = brief.output?.format || 'mp4';
  const title = brief.title || `${brief.design_system.brand_name} Intro`;
  const compositionFormat = storyboard?.format || resolveDefaultCompositionFormat();

  const scenes = storyboard?.beats?.length
    ? buildStoryboardScenes(brief, storyboard)
    : buildLegacyScenes(brief, totalDuration);

  return {
    kind: 'video-composition-adf',
    version: '1.0.0',
    intent: brief.intent || 'narrated intro movie from brief',
    title,
    composition: {
      duration_sec: totalDuration,
      fps,
      width: compositionFormat.width,
      height: compositionFormat.height,
      aspect_ratio: compositionFormat.aspect_ratio,
      background_color: background,
    },
    audio: {
      narration_ref: brief.narration.artifact_ref,
      ...(brief.music?.artifact_ref ? { music_ref: brief.music.artifact_ref } : {}),
    },
    scenes,
    output: {
      format,
      target_path: brief.output?.target_path,
      bundle_dir: brief.output?.bundle_dir,
      emit_progress_packets: true,
      await_completion: brief.output?.await_completion,
      detached_background: brief.output?.detached_background,
    },
  };
}

function buildStoryboardScenes(
  brief: NarratedVideoBrief,
  storyboard: VideoStoryboard
): VideoCompositionADF['scenes'] {
  return storyboard.beats.map((beat, index) => {
    const role = normalizeSceneRole(beat.role || beat.semantic);
    const templateId = selectTemplateId(
      storyboard.presentation_mode,
      role,
      beat.semantic,
      index,
      storyboard.beats.length
    );
    const layoutVariant = resolveSceneLayoutVariant(
      storyboard.presentation_mode,
      role,
      beat.semantic,
      index,
      storyboard.beats.length,
      beat.layout_variant
    );
    return {
      scene_id: beat.beat_id,
      role,
      start_sec: beat.start_sec,
      duration_sec: beat.duration_sec,
      template_ref: { template_id: templateId },
      content: buildStoryboardSceneContent(brief, storyboard, beat, index, layoutVariant),
      asset_refs: buildStoryboardAssetRefs(brief, beat, role),
    };
  });
}

function buildStoryboardSceneContent(
  brief: NarratedVideoBrief,
  storyboard: VideoStoryboard,
  beat: VideoStoryboard['beats'][number],
  index: number,
  layoutVariant: string
): Record<string, unknown> {
  const presentationMode = storyboard.presentation_mode || 'howto';
  const content: Record<string, unknown> = {
    eyebrow: brief.design_system.brand_name,
    headline: beat.title,
    body: beat.message || beat.visual_intent || brief.script.feature,
    caption: beat.caption_intent,
    visual_direction: beat.visual_direction,
    motion_intent: beat.motion_intent,
    semantic: beat.semantic,
    role: beat.role,
    beat_index: index + 1,
    presentation_mode: presentationMode,
    layout_variant: layoutVariant,
    layout_family:
      typeof beat.design_token_hints?.layout_family === 'string'
        ? beat.design_token_hints.layout_family
        : undefined,
    design_system_vars:
      storyboard.design_system_ref?.css_vars || brief.design_system.theme_tokens?.css_vars || {},
  };
  if (beat.semantic === 'process' || beat.semantic === 'steps' || beat.semantic === 'demo') {
    content.visual_steps = deriveProcessSteps(storyboard);
  }
  if (beat.semantic === 'proof' || beat.semantic === 'artifact' || beat.semantic === 'evidence') {
    content.evidence_items = storyboard.desired_takeaway
      ? [storyboard.desired_takeaway, ...(storyboard.promise ? [storyboard.promise] : [])]
      : [brief.script.feature];
  }
  if (presentationMode === 'promo') {
    content.value_points = [
      beat.message || beat.visual_intent || brief.script.hook,
      brief.storyboard?.promise || brief.script.feature,
      brief.storyboard?.desired_takeaway || brief.script.cta,
    ].filter(Boolean);
    content.social_proof = brief.storyboard?.promise
      ? [
          brief.storyboard.promise,
          ...(brief.storyboard.desired_takeaway ? [brief.storyboard.desired_takeaway] : []),
        ]
      : [];
  }
  if (presentationMode === 'vtuber') {
    content.stage_notes = [
      beat.visual_direction,
      beat.motion_intent,
      brief.storyboard?.promise || brief.script.hook,
    ].filter(Boolean);
    content.chat_messages = [
      { speaker: 'chat', text: brief.storyboard?.objective || brief.script.feature },
      { speaker: 'kyberion', text: beat.message || beat.visual_intent || brief.script.cta },
    ];
  }
  if (beat.semantic === 'cta' || beat.semantic === 'validation' || beat.role === 'outro') {
    content.callout = brief.script.cta;
  }
  return content;
}

function buildStoryboardAssetRefs(
  brief: NarratedVideoBrief,
  beat: VideoStoryboard['beats'][number],
  role: VideoCompositionSceneRole
): VideoCompositionAssetRef[] {
  const assets: VideoCompositionAssetRef[] = [];
  const hero = brief.design_system.assets?.hero_path;
  const logo = brief.design_system.assets?.logo_path;
  const isVtuber = brief.storyboard?.presentation_mode === 'vtuber';

  if (hero) {
    const isVtuberStage =
      isVtuber &&
      beat.role !== 'cta' &&
      beat.role !== 'outro' &&
      beat.semantic !== 'cta' &&
      beat.semantic !== 'validation';
    if (
      role === 'feature' ||
      beat.semantic === 'demo' ||
      beat.semantic === 'process' ||
      isVtuberStage
    ) {
      assets.push({
        asset_id: `${beat.beat_id}-hero`,
        path: hero,
        role: 'supporting',
      });
    }
  }
  if (logo && (role === 'cta' || role === 'outro' || beat.semantic === 'validation')) {
    assets.push({
      asset_id: `${beat.beat_id}-logo`,
      path: logo,
      role: 'logo',
    });
  }
  for (const assetPath of beat.asset_refs || []) {
    assets.push({
      asset_id: `${beat.beat_id}-${assets.length + 1}`,
      path: assetPath,
      role: 'supporting',
    });
  }
  return assets;
}

function buildLegacyScenes(
  brief: NarratedVideoBrief,
  totalDuration: number
): VideoCompositionADF['scenes'] {
  const hookDuration = roundTo2(totalDuration * 0.33);
  const featureDuration = roundTo2(totalDuration * 0.45);
  const outroDuration = roundTo2(Math.max(0.1, totalDuration - hookDuration - featureDuration));
  return [
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
        layout_variant: brief.design_system.theme_tokens?.layout_variant || 'split-left',
        design_system_vars: brief.design_system.theme_tokens?.css_vars || {},
      },
      asset_refs: buildSceneAssets(brief, 'hook'),
    },
    {
      scene_id: 'feature',
      role: 'feature',
      start_sec: hookDuration,
      duration_sec: featureDuration,
      template_ref: { template_id: 'split-highlight' },
      content: {
        headline: 'From brief to scene plan',
        body: brief.script.feature,
        layout_variant: brief.design_system.theme_tokens?.layout_variant || 'split-left',
        design_system_vars: brief.design_system.theme_tokens?.css_vars || {},
      },
      asset_refs: buildSceneAssets(brief, 'feature'),
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
        layout_variant: brief.design_system.theme_tokens?.layout_variant || 'split-right',
        design_system_vars: brief.design_system.theme_tokens?.css_vars || {},
      },
      asset_refs: buildSceneAssets(brief, 'outro'),
    },
  ];
}

function deriveProcessSteps(storyboard: VideoStoryboard): Array<{ step: string; detail: string }> {
  return storyboard.beats.map((beat, index) => ({
    step: String(index + 1).padStart(2, '0'),
    detail: beat.title,
  }));
}

function normalizeSceneRole(role?: string): VideoCompositionSceneRole {
  if (
    role === 'hook' ||
    role === 'feature' ||
    role === 'proof' ||
    role === 'cta' ||
    role === 'outro' ||
    role === 'generic'
  ) {
    return role;
  }
  if (role === 'validation') return 'cta';
  if (role === 'process' || role === 'demo' || role === 'context') return 'feature';
  return 'generic';
}

function selectTemplateId(
  presentationMode: VideoStoryboard['presentation_mode'] | undefined,
  role: VideoCompositionSceneRole,
  semantic?: string,
  index?: number,
  total?: number
): string {
  if (presentationMode === 'promo') {
    if (
      role === 'outro' ||
      semantic === 'cta' ||
      semantic === 'validation' ||
      (typeof index === 'number' && typeof total === 'number' && index === total - 1)
    ) {
      return 'logo-outro';
    }
    if (semantic === 'process' || semantic === 'steps' || semantic === 'demo') {
      return 'howto-guide';
    }
    if (semantic === 'proof' || semantic === 'evidence' || semantic === 'artifact') {
      return 'split-highlight';
    }
    if (role === 'hook') {
      return 'basic-title-card';
    }
    if (role === 'feature') {
      return 'promo-spot';
    }
    return 'promo-spot';
  }
  if (presentationMode === 'vtuber') {
    if (
      role === 'outro' ||
      semantic === 'cta' ||
      semantic === 'validation' ||
      (typeof index === 'number' && typeof total === 'number' && index === total - 1)
    ) {
      return 'logo-outro';
    }
    return 'vtuber-stage';
  }
  if (semantic === 'process' || semantic === 'steps' || semantic === 'demo') {
    return 'howto-guide';
  }
  if (
    role === 'outro' ||
    semantic === 'validation' ||
    semantic === 'cta' ||
    (typeof index === 'number' && typeof total === 'number' && index === total - 1)
  ) {
    return 'logo-outro';
  }
  if (
    semantic === 'proof' ||
    semantic === 'evidence' ||
    semantic === 'artifact' ||
    semantic === 'process' ||
    semantic === 'steps' ||
    semantic === 'demo' ||
    role === 'feature'
  ) {
    return 'split-highlight';
  }
  return 'basic-title-card';
}

function buildSceneAssets(
  brief: NarratedVideoBrief,
  scene: 'hook' | 'feature' | 'outro'
): VideoCompositionAssetRef[] {
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

function resolveSceneLayoutVariant(
  presentationMode: VideoStoryboard['presentation_mode'] | undefined,
  role: VideoCompositionSceneRole,
  semantic?: string,
  index?: number,
  total?: number,
  fallback?: string
): string {
  if (typeof fallback === 'string' && fallback.trim()) {
    return fallback;
  }
  if (presentationMode === 'vtuber') {
    if (role === 'hook' || semantic === 'hook') return 'focus-center';
    if (semantic === 'demo' || semantic === 'process' || semantic === 'steps')
      return 'fullscreen-demo';
    if (
      role === 'outro' ||
      semantic === 'cta' ||
      semantic === 'validation' ||
      (typeof index === 'number' && typeof total === 'number' && index === total - 1)
    ) {
      return 'split-right';
    }
    return 'split-left';
  }
  if (presentationMode === 'promo') {
    if (
      role === 'outro' ||
      semantic === 'cta' ||
      semantic === 'validation' ||
      (typeof index === 'number' && typeof total === 'number' && index === total - 1)
    ) {
      return 'split-right';
    }
    if (semantic === 'proof' || semantic === 'evidence' || semantic === 'artifact')
      return 'fullscreen-demo';
    return 'split-left';
  }
  return fallback || 'split-left';
}

function resolveDefaultCompositionFormat(): {
  width: number;
  height: number;
  aspect_ratio: string;
} {
  return {
    width: 1920,
    height: 1080,
    aspect_ratio: '16:9',
  };
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

function sumStoryboardDuration(storyboard: VideoStoryboard): number {
  return roundTo2(storyboard.beats.reduce((sum, beat) => sum + beat.duration_sec, 0));
}
