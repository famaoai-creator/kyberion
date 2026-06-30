import type { NarratedVideoBrief } from './narrated-video-brief-compiler.js';
import type { VideoCompositionSceneRole } from './video-composition-contract.js';
import {
  composeWebDesignSystem,
  DEFAULT_CHRONOS_WEB_DESIGN_SYSTEM_PACK,
  DEFAULT_CHRONOS_WEB_THEME_PACK,
} from './web-design-system.js';

export type VideoPresentationMode = 'howto' | 'promo' | 'vtuber';

export interface VideoContentBrief {
  kind: 'video-content-brief';
  version: string;
  title?: string;
  audience: string;
  objective: string;
  distribution_channel: string;
  content_type: string;
  presentation_mode?: VideoPresentationMode;
  promise: string;
  desired_takeaway: string;
  constraints: string[];
  proof_points: string[];
  content_requirements?: string[];
  format?: {
    width?: number;
    height?: number;
    aspect_ratio?: string;
  };
  fixed_inputs?: {
    customer?: string;
    use_case?: string;
    message?: string;
  };
  tone?: string;
  language?: string;
  duration_sec?: number;
  design_system_ref: {
    system_id: string;
    brand_name?: string;
    theme?: string;
    background_color?: string;
    layout_family?: string;
    motion_profile?: string;
    logo_path?: string;
    hero_path?: string;
    fps?: number;
    css_vars?: Record<string, string>;
  };
}

export interface VideoStoryboardBeat {
  beat_id: string;
  title: string;
  start_sec: number;
  duration_sec: number;
  role?: VideoCompositionSceneRole;
  semantic?: string;
  message?: string;
  vo_cue?: string;
  visual_direction: string;
  visual_intent?: string;
  motion_intent?: string;
  caption_intent?: string;
  asset_refs?: string[];
  asset_requirements?: string[];
  design_token_hints?: Record<string, unknown>;
  layout_variant?: string;
}

export interface VideoStoryboard {
  kind: 'video-storyboard';
  version: string;
  title?: string;
  audience?: string;
  objective?: string;
  content_type?: string;
  presentation_mode?: VideoPresentationMode;
  promise?: string;
  desired_takeaway?: string;
  format: {
    width: number;
    height: number;
    aspect_ratio?: string;
  };
  audio_direction?: string;
  design_system_ref?: VideoContentBrief['design_system_ref'];
  beats: VideoStoryboardBeat[];
}

export interface VideoStoryboardToNarratedBriefOptions {
  title?: string;
  language?: string;
  narration_artifact_ref: string;
  brand_name?: string;
  theme_background_color?: string;
  logo_path?: string;
  hero_path?: string;
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

type BeatPlanEntry = {
  id: string;
  title: (brief: VideoContentBrief) => string;
  role: VideoCompositionSceneRole;
  semantic: string;
  weight: number;
  message: (brief: VideoContentBrief) => string;
  visualDirection: (brief: VideoContentBrief) => string;
  visualIntent: (brief: VideoContentBrief) => string;
  captionIntent: (brief: VideoContentBrief) => string;
  assetRequirements: (brief: VideoContentBrief) => string[];
  voCue: (brief: VideoContentBrief) => string;
  designTokenHints: (brief: VideoContentBrief) => Record<string, unknown>;
};

export function compileVideoContentBriefToStoryboard(brief: VideoContentBrief): VideoStoryboard {
  const presentationMode = normalizePresentationMode(brief.presentation_mode, brief.content_type);
  const beatPlan = getBeatPlan(presentationMode, brief.content_type);
  const durationSec = clampDuration(brief.duration_sec || inferDuration(presentationMode, brief.content_type, beatPlan.length));
  const durations = distributeDurations(durationSec, beatPlan.map((entry) => entry.weight));
  const brandName = brief.design_system_ref.brand_name || 'Kyberion';
  const modeDefaults = getModeDefaults(presentationMode);
  const background = brief.design_system_ref.background_color || modeDefaults.background_color;
  const layoutFamily = brief.design_system_ref.layout_family || modeDefaults.layout_family;
  const motionProfile = brief.design_system_ref.motion_profile || modeDefaults.motion_profile;
  const format = resolveStoryboardFormat(brief.format);

  let startSec = 0;
  const beats = beatPlan.map((entry, index) => {
    const duration = index === beatPlan.length - 1
      ? roundTo2(Math.max(0.1, durationSec - startSec))
      : durations[index];
    const designTokenHints = entry.designTokenHints(brief);
    const layoutVariant = typeof designTokenHints.layout_variant === 'string'
      ? designTokenHints.layout_variant
      : inferLayoutVariant(presentationMode, entry.role, entry.semantic, index, beatPlan.length);
    const beat: VideoStoryboardBeat = {
      beat_id: entry.id,
      title: entry.title(brief),
      start_sec: roundTo2(startSec),
      duration_sec: duration,
      role: entry.role,
      semantic: entry.semantic,
      message: entry.message(brief),
      vo_cue: entry.voCue(brief),
      visual_direction: entry.visualDirection(brief),
      visual_intent: entry.visualIntent(brief),
      motion_intent: motionProfile,
      caption_intent: entry.captionIntent(brief),
      asset_refs: resolveAssetRefs(brief, entry),
      asset_requirements: entry.assetRequirements(brief),
      design_token_hints: designTokenHints,
      layout_variant: layoutVariant,
    };
    startSec += duration;
    return beat;
  });

  return {
    kind: 'video-storyboard',
    version: '1.0.0',
    title: brief.title || `${brandName} ${capitalize(brief.content_type)} Storyboard`,
    audience: brief.audience,
    objective: brief.objective,
    content_type: brief.content_type,
    presentation_mode: presentationMode,
    promise: brief.promise,
    desired_takeaway: brief.desired_takeaway,
    format,
    audio_direction: brief.tone
      ? `${brief.tone} narration for ${brief.audience}`
      : `${presentationMode} narration for ${brief.audience}`,
    design_system_ref: {
      ...brief.design_system_ref,
      background_color: background,
      layout_family: layoutFamily,
      motion_profile: motionProfile,
      css_vars: buildVideoDesignCssVars(background, layoutFamily, motionProfile, brief.design_system_ref),
    },
    beats,
  };
}

export function compileVideoStoryboardToNarratedVideoBrief(
  storyboard: VideoStoryboard,
  options: VideoStoryboardToNarratedBriefOptions,
): NarratedVideoBrief {
  const title = options.title || storyboard.title || 'Narrated Video';
  const hookBeat = storyboard.beats[0];
  const ctaBeat = storyboard.beats[storyboard.beats.length - 1];
  const middleBeats = storyboard.beats.slice(1, -1);
  const presentationMode = storyboard.presentation_mode || normalizePresentationMode(undefined, storyboard.content_type);
  const hookText = hookBeat?.message || hookBeat?.visual_intent || hookBeat?.title || storyboard.promise || storyboard.objective || 'Start here.';
  const featureText = middleBeats.length > 0
    ? middleBeats.map((beat) => beat.message || beat.visual_intent || beat.title).join(' ')
    : storyboard.beats.map((beat) => beat.message || beat.visual_intent || beat.title).join(' ');
  const ctaText = ctaBeat?.message || storyboard.desired_takeaway || 'Continue with the next step.';
  const brandName = options.brand_name || storyboard.design_system_ref?.brand_name || 'Kyberion';
  const backgroundColor = options.theme_background_color || storyboard.design_system_ref?.background_color || '#07111f';
  const fps = clampFps(options.timing?.fps || storyboard.design_system_ref?.fps || 30);
  const durationSec = clampDuration(options.timing?.duration_sec || sumStoryboardDuration(storyboard));

  return {
    kind: 'narrated-video-brief',
    version: '1.0.0',
    intent: `${presentationMode} narrated video`,
    title,
    language: options.language || 'ja',
    storyboard,
    script: {
      hook: hookText,
      feature: featureText,
      cta: ctaText,
    },
    narration: {
      artifact_ref: options.narration_artifact_ref,
    },
    design_system: {
      brand_name: brandName,
      theme_tokens: {
        background_color: backgroundColor,
      },
      assets: {
        logo_path: options.logo_path || storyboard.design_system_ref?.logo_path,
        hero_path: options.hero_path || storyboard.design_system_ref?.hero_path,
      },
    },
    timing: {
      duration_sec: durationSec,
      fps,
    },
    output: {
      format: options.output?.format || 'mp4',
      target_path: options.output?.target_path,
      bundle_dir: options.output?.bundle_dir,
      await_completion: options.output?.await_completion,
      detached_background: options.output?.detached_background,
    },
  };
}

function getBeatPlan(presentationMode: VideoPresentationMode, contentType: string): BeatPlanEntry[] {
  if (presentationMode === 'promo') {
    return [
      createBeatEntry('hook', 'Hook', 'hook', 'hook', 1, (brief) => brief.promise, (brief) => `Promise a sharper outcome for ${brief.audience}.`, () => 'Lead with the value spike.', (brief) => brief.promise, () => ['headline', 'offer'], () => ({ layout_family: 'promo-spot', motion_profile: 'value-punch', beat_energy: 'high', typography_scale: 'expressive', overlay_density: 'compact', camera_distance: 'tight' })),
      createBeatEntry('value', 'Value', 'feature', 'value', 2, (brief) => brief.fixed_inputs?.message || brief.objective, () => 'Show the concrete value and immediate benefit.', () => 'Present the transformation clearly.', (brief) => brief.objective, () => ['value-points', 'benefit'], () => ({ layout_family: 'promo-spot', motion_profile: 'energetic', beat_energy: 'high', typography_scale: 'expressive', overlay_density: 'dense', camera_distance: 'tight' })),
      createBeatEntry('proof', 'Proof', 'proof', 'proof', 1, (brief) => brief.proof_points.join(' / '), () => 'Back the promise with proof and evidence.', () => 'Surface proof points quickly.', (brief) => brief.desired_takeaway, () => ['evidence', 'social-proof'], () => ({ layout_family: 'promo-spot', motion_profile: 'artifact-reveal', beat_energy: 'medium', typography_scale: 'balanced', overlay_density: 'medium', camera_distance: 'medium' })),
      createBeatEntry('cta', 'CTA', 'cta', 'cta', 1, (brief) => brief.desired_takeaway, () => 'End with a strong call to action.', () => 'Ask for the next step explicitly.', (brief) => brief.desired_takeaway, () => ['cta', 'offer'], () => ({ layout_family: 'promo-spot', motion_profile: 'minimal', beat_energy: 'low', typography_scale: 'balanced', overlay_density: 'compact', camera_distance: 'medium' })),
    ];
  }
  if (presentationMode === 'vtuber') {
    return [
      createBeatEntry('hook', 'Hook', 'hook', 'hook', 1, (brief) => brief.promise, (brief) => `Open with a live persona cue for ${brief.audience}.`, () => 'Start with the avatar and the on-air premise.', (brief) => brief.promise, () => ['avatar', 'live-badge'], () => ({ layout_family: 'vtuber-stage', motion_profile: 'on-air', beat_energy: 'high', typography_scale: 'expressive', overlay_density: 'medium', camera_distance: 'medium-close' })),
      createBeatEntry('persona', 'Persona', 'feature', 'persona', 2, (brief) => brief.fixed_inputs?.message || brief.objective, () => 'Introduce the character, voice, and show context.', () => 'Make the presenter feel present.', (brief) => brief.objective, () => ['persona', 'stage'], () => ({ layout_family: 'vtuber-stage', motion_profile: 'conversational', beat_energy: 'medium', typography_scale: 'balanced', overlay_density: 'medium', camera_distance: 'medium' })),
      createBeatEntry('demo', 'Demo', 'feature', 'demo', 2, (brief) => brief.content_requirements?.join(' / ') || brief.promise, () => 'Demonstrate the move or workflow live.', () => 'Show the act of doing, not just talking.', (brief) => brief.promise, () => ['screen', 'chat', 'process'], () => ({ layout_family: 'vtuber-stage', motion_profile: 'guided-step', beat_energy: 'high', typography_scale: 'balanced', overlay_density: 'dense', camera_distance: 'wide-stage' })),
      createBeatEntry('cta', 'CTA', 'cta', 'cta', 1, (brief) => brief.desired_takeaway, () => 'Close with a community or next-action cue.', () => 'End on a clean audience-facing prompt.', (brief) => brief.desired_takeaway, () => ['community', 'call-to-action'], () => ({ layout_family: 'vtuber-stage', motion_profile: 'minimal', beat_energy: 'low', typography_scale: 'balanced', overlay_density: 'compact', camera_distance: 'medium' })),
    ];
  }
  const normalized = contentType.toLowerCase();
  if (normalized.includes('decision')) {
    return [
      createBeatEntry('problem', 'Problem framing', 'hook', 'problem', 1, (brief) => brief.promise, (brief) => `Frame the problem ${brief.audience} needs to solve.`, () => 'Guide the viewer to the decision context.', (brief) => brief.objective, () => ['decision-context'], () => ({ layout_family: 'decision', motion_profile: 'measured', beat_energy: 'medium' })),
      createBeatEntry('evidence', 'Evidence', 'proof', 'proof', 2, (brief) => brief.proof_points.join(' / '), () => 'Show evidence and constraints.', () => 'Use artifact-backed proof.', (brief) => brief.promise, () => ['evidence', 'artifact'], () => ({ layout_family: 'evidence', motion_profile: 'guided', beat_energy: 'medium' })),
      createBeatEntry('recommendation', 'Recommendation', 'cta', 'decision', 2, (brief) => brief.desired_takeaway, () => 'Recommend the next step.', () => 'Lead to a clear recommendation.', (brief) => brief.desired_takeaway, () => ['recommendation'], () => ({ layout_family: 'decision', motion_profile: 'guided-step', beat_energy: 'low' })),
    ];
  }
  if (normalized.includes('product-walkthrough')) {
    return [
      createBeatEntry('hook', 'Promise', 'hook', 'hook', 1, (brief) => brief.promise, (brief) => `Promise a practical walkthrough for ${brief.audience}.`, () => 'Open with the product value.', (brief) => brief.promise, () => ['headline'], () => ({ layout_family: 'product', motion_profile: 'guided-step', beat_energy: 'high' })),
      createBeatEntry('context', 'Context', 'feature', 'context', 2, (brief) => brief.fixed_inputs?.use_case || brief.objective, () => 'Set the use case and constraints.', () => 'Show the operating context.', (brief) => brief.objective, () => ['context', 'use-case'], () => ({ layout_family: 'context', motion_profile: 'guided', beat_energy: 'medium' })),
      createBeatEntry('demo', 'Demo', 'feature', 'demo', 2, (brief) => brief.fixed_inputs?.message || brief.promise, () => 'Demonstrate the working flow.', () => 'Show the actual sequence.', (brief) => brief.promise, () => ['demo', 'process'], () => ({ layout_family: 'process-flow', motion_profile: 'guided-step', beat_energy: 'high' })),
      createBeatEntry('proof', 'Proof', 'proof', 'proof', 1, (brief) => brief.proof_points.join(' / '), () => 'Anchor the walkthrough in proof.', () => 'Surface evidence and output.', (brief) => brief.desired_takeaway, () => ['artifact', 'evidence'], () => ({ layout_family: 'evidence', motion_profile: 'calm', beat_energy: 'medium' })),
      createBeatEntry('cta', 'CTA', 'cta', 'cta', 1, (brief) => brief.desired_takeaway, () => 'Close with a decisive action.', () => 'End on a clear next step.', (brief) => brief.desired_takeaway, () => ['next-action'], () => ({ layout_family: 'cta', motion_profile: 'minimal', beat_energy: 'low' })),
    ];
  }
  if (normalized.includes('docs-demo') || presentationMode === 'howto') {
    return [
      createBeatEntry('promise', 'Promise', 'hook', 'promise', 1, (brief) => brief.promise, () => 'Set the expected outcome of the demo.', () => 'Introduce the demonstration intent.', (brief) => brief.promise, () => ['promise'], () => ({ layout_family: 'howto-guide', motion_profile: 'guided', beat_energy: 'medium', typography_scale: 'balanced', overlay_density: 'medium', camera_distance: 'wide' })),
      createBeatEntry('steps', 'Steps', 'feature', 'process', 2, (brief) => brief.content_requirements?.join(' / ') || brief.objective, () => 'Walk through the steps that matter.', () => 'Show the ordered process.', (brief) => brief.objective, () => ['steps', 'procedure'], () => ({ layout_family: 'howto-guide', motion_profile: 'guided-step', beat_energy: 'high', typography_scale: 'balanced', overlay_density: 'medium', camera_distance: 'wide' })),
      createBeatEntry('artifact', 'Artifact', 'proof', 'proof', 1, (brief) => brief.proof_points.join(' / '), () => 'Surface the generated artifacts.', () => 'Highlight what gets produced.', (brief) => brief.promise, () => ['artifact', 'output'], () => ({ layout_family: 'evidence', motion_profile: 'measured', beat_energy: 'medium', typography_scale: 'balanced', overlay_density: 'compact', camera_distance: 'medium' })),
      createBeatEntry('validation', 'Validation', 'cta', 'validation', 1, (brief) => brief.desired_takeaway, () => 'Validate the output and finish cleanly.', () => 'Close with verification.', (brief) => brief.desired_takeaway, () => ['validation'], () => ({ layout_family: 'validation', motion_profile: 'minimal', beat_energy: 'low', typography_scale: 'balanced', overlay_density: 'compact', camera_distance: 'medium' })),
    ];
  }
  return [
    createBeatEntry('hook', 'Hook', 'hook', 'hook', 1, (brief) => brief.promise, (brief) => `State the value proposition for ${brief.audience}.`, () => 'Lead with the core promise.', (brief) => brief.promise, () => ['headline'], () => ({ layout_family: 'intro', motion_profile: 'guided', beat_energy: 'high', typography_scale: 'balanced', overlay_density: 'medium', camera_distance: 'medium' })),
    createBeatEntry('process', 'Process', 'feature', 'process', 2, (brief) => brief.content_requirements?.join(' / ') || brief.objective, () => 'Show the operational sequence.', () => 'Explain the process in order.', (brief) => brief.objective, () => ['process', 'steps'], () => ({ layout_family: 'process-flow', motion_profile: 'guided-step', beat_energy: 'high', typography_scale: 'balanced', overlay_density: 'medium', camera_distance: 'wide' })),
    createBeatEntry('proof', 'Proof', 'proof', 'proof', 1, (brief) => brief.proof_points.join(' / '), () => 'Back the message with proof.', () => 'Show the evidence and outputs.', (brief) => brief.promise, () => ['artifact', 'evidence'], () => ({ layout_family: 'evidence', motion_profile: 'calm', beat_energy: 'medium', typography_scale: 'balanced', overlay_density: 'compact', camera_distance: 'medium' })),
    createBeatEntry('cta', 'CTA', 'cta', 'cta', 1, (brief) => brief.desired_takeaway, () => 'Close with the requested action.', () => 'Make the next action explicit.', (brief) => brief.desired_takeaway, () => ['next-action'], () => ({ layout_family: 'cta', motion_profile: 'minimal', beat_energy: 'low', typography_scale: 'balanced', overlay_density: 'compact', camera_distance: 'medium' })),
  ];
}

function normalizePresentationMode(value: VideoPresentationMode | undefined, contentType?: string): VideoPresentationMode {
  const normalized = (value || contentType || 'howto').toLowerCase();
  if (normalized.includes('promo')) return 'promo';
  if (normalized.includes('vtuber')) return 'vtuber';
  return 'howto';
}

function getModeDefaults(mode: VideoPresentationMode): { layout_family: string; motion_profile: string; background_color: string } {
  if (mode === 'promo') {
    return {
      layout_family: 'promo-spot',
      motion_profile: 'energetic',
      background_color: '#08101e',
    };
  }
  if (mode === 'vtuber') {
    return {
      layout_family: 'vtuber-stage',
      motion_profile: 'on-air',
      background_color: '#090814',
    };
  }
  return {
    layout_family: 'process-flow',
    motion_profile: 'guided-step',
    background_color: '#07111f',
  };
}

function buildVideoDesignCssVars(
  backgroundColor: string,
  layoutFamily: string,
  motionProfile: string,
  designSystemRef: VideoContentBrief['design_system_ref'],
): Record<string, string> {
  const baseVars = composeWebDesignSystem(DEFAULT_CHRONOS_WEB_THEME_PACK, DEFAULT_CHRONOS_WEB_DESIGN_SYSTEM_PACK).css_vars;
  const palette = derivePalette(backgroundColor, layoutFamily);
  return {
    ...baseVars,
    '--kb-bg-main': backgroundColor,
    '--kb-panel-bg': palette.panelBg,
    '--kb-accent': palette.accent,
    '--kb-warning': palette.warning,
    '--kb-text-primary': palette.textPrimary,
    '--kb-text-secondary': palette.textSecondary,
    '--kb-font-sans': designSystemRef.brand_name ? '"Inter", -apple-system, BlinkMacSystemFont, sans-serif' : '"Inter", -apple-system, BlinkMacSystemFont, sans-serif',
    '--kb-panel-radius': layoutFamily === 'vtuber-stage' ? '32px' : '24px',
    '--kb-surface-radius': layoutFamily === 'vtuber-stage' ? '30px' : '24px',
    '--kb-section-gap': layoutFamily === 'vtuber-stage' ? '28px' : '24px',
    '--kb-content-gap': motionProfile === 'guided-step' ? '18px' : '16px',
    '--kb-glow-cyan': `0 0 24px ${palette.glow}`,
    ...designSystemRef.css_vars,
  };
}

function derivePalette(backgroundColor: string, layoutFamily: string): {
  panelBg: string;
  accent: string;
  warning: string;
  textPrimary: string;
  textSecondary: string;
  glow: string;
} {
  if (layoutFamily === 'promo-spot') {
    return {
      panelBg: 'rgba(15, 23, 42, 0.9)',
      accent: '#f59e0b',
      warning: '#fb7185',
      textPrimary: '#f8fafc',
      textSecondary: 'rgba(248, 250, 252, 0.72)',
      glow: 'rgba(245, 158, 11, 0.42)',
    };
  }
  if (layoutFamily === 'vtuber-stage') {
    return {
      panelBg: 'rgba(15, 23, 42, 0.92)',
      accent: '#60a5fa',
      warning: '#22c55e',
      textPrimary: '#f8fafc',
      textSecondary: 'rgba(226, 232, 240, 0.78)',
      glow: 'rgba(96, 165, 250, 0.44)',
    };
  }
  return {
    panelBg: 'rgba(15, 23, 42, 0.86)',
    accent: '#3b82f6',
    warning: '#94a3b8',
    textPrimary: '#f8fafc',
    textSecondary: 'rgba(148, 163, 184, 0.86)',
    glow: 'rgba(59, 130, 246, 0.34)',
  };
}

function resolveStoryboardFormat(format?: VideoContentBrief['format']): { width: number; height: number; aspect_ratio: string } {
  const width = clampDimension(format?.width || 1920);
  const height = clampDimension(format?.height || 1080);
  const aspectRatio = normalizeAspectRatio(format?.aspect_ratio || `${width}:${height}`) || `${width}:${height}`;
  return { width, height, aspect_ratio: aspectRatio };
}

function inferLayoutVariant(
  presentationMode: VideoPresentationMode,
  role: VideoCompositionSceneRole,
  semantic: string,
  index: number,
  total: number,
): string {
  if (presentationMode === 'vtuber') {
    if (role === 'hook' || semantic === 'hook') return 'focus-center';
    if (semantic === 'demo' || semantic === 'process' || semantic === 'steps') return 'fullscreen-demo';
    if (role === 'outro' || semantic === 'cta' || semantic === 'validation' || index === total - 1) return 'split-right';
    return 'split-left';
  }
  if (presentationMode === 'promo') {
    if (role === 'outro' || semantic === 'cta' || semantic === 'validation' || index === total - 1) return 'split-right';
    if (semantic === 'proof' || semantic === 'evidence' || semantic === 'artifact') return 'fullscreen-demo';
    return 'split-left';
  }
  if (semantic === 'process' || semantic === 'steps' || semantic === 'demo') return 'split-left';
  if (role === 'outro' || semantic === 'cta' || semantic === 'validation') return 'split-right';
  return 'split-left';
}

function createBeatEntry(
  id: string,
  title: string,
  role: VideoCompositionSceneRole,
  semantic: string,
  weight: number,
  message: (brief: VideoContentBrief) => string,
  visualDirection: (brief: VideoContentBrief) => string,
  visualIntent: (brief: VideoContentBrief) => string,
  captionIntent: (brief: VideoContentBrief) => string,
  assetRequirements: (brief: VideoContentBrief) => string[],
  designTokenHints: (brief: VideoContentBrief) => Record<string, unknown>,
): BeatPlanEntry {
  return {
    id,
    title: (brief) => `${title}${brief.title ? `: ${brief.title}` : ''}`,
    role,
    semantic,
    weight,
    message,
    visualDirection,
    visualIntent,
    captionIntent,
    assetRequirements,
    voCue: (brief) => message(brief),
    designTokenHints,
  };
}

function resolveAssetRefs(brief: VideoContentBrief, entry: BeatPlanEntry): string[] {
  const refs = new Set<string>();
  if (brief.design_system_ref.hero_path && (entry.role === 'feature' || entry.semantic === 'demo' || entry.semantic === 'process')) {
    refs.add(brief.design_system_ref.hero_path);
  }
  if (brief.design_system_ref.logo_path && (entry.role === 'cta' || entry.semantic === 'validation' || entry.semantic === 'decision')) {
    refs.add(brief.design_system_ref.logo_path);
  }
  return Array.from(refs);
}

function distributeDurations(total: number, weights: number[]): number[] {
  const totalWeight = weights.reduce((sum, value) => sum + value, 0) || 1;
  const durations = weights.map((weight) => roundTo2((total * weight) / totalWeight));
  const roundedTotal = roundTo2(durations.reduce((sum, value) => sum + value, 0));
  if (durations.length > 0) {
    durations[durations.length - 1] = roundTo2(Math.max(0.1, durations[durations.length - 1] + (total - roundedTotal)));
  }
  return durations;
}

function inferDuration(presentationMode: VideoPresentationMode, contentType: string, beatCount: number): number {
  if (presentationMode === 'promo') return 12;
  if (presentationMode === 'vtuber') return 15;
  if (presentationMode === 'howto' && contentType.toLowerCase().includes('docs-demo')) return 12;
  if (contentType.toLowerCase().includes('decision')) return 12;
  if (contentType.toLowerCase().includes('product-walkthrough')) return 15;
  if (contentType.toLowerCase().includes('docs-demo')) return 12;
  return Math.max(9, beatCount * 2.5);
}

function sumStoryboardDuration(storyboard: VideoStoryboard): number {
  return roundTo2(storyboard.beats.reduce((sum, beat) => sum + beat.duration_sec, 0));
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

function capitalize(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function clampDimension(value: number): number {
  return Math.max(320, Math.min(7680, Math.round(value)));
}

function normalizeAspectRatio(value: string): string | undefined {
  const normalized = String(value || '').trim();
  if (!normalized) return undefined;
  if (/^\d+:\d+$/.test(normalized)) return normalized;
  const match = normalized.match(/^(\d+(?:\.\d+)?)[xX](\d+(?:\.\d+)?)$/);
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined;
  return `${Math.round(width)}:${Math.round(height)}`;
}
