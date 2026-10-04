import {
  isCtaLikeSemantic,
  isHookSemantic,
  isProcessLikeSemantic,
  isProofLikeSemantic,
} from './video-content-brief-contract.js';
import type { VideoStoryboard } from './video-content-brief-contract.js';
import { clamp } from '../foundation/text.js';
import { createLogger } from '../logger.js';

const logger = createLogger('narrated-video-brief-compiler');
import { resolveCreativeDesign } from '../creative-design-resolver.js';
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
  const format = brief.output?.format || 'mp4';
  const title = brief.title || `${brief.design_system.brand_name} Intro`;

  // When callers omit a storyboard, synthesize a deterministic promo board
  // from script.hook/feature/cta so scene headlines actually change. The
  // previous buildLegacyScenes path hard-coded English filler such as
  // "From brief to scene plan", which made product intros look stuck.
  const effectiveStoryboard =
    storyboard?.beats?.length && storyboard.beats.length > 0
      ? storyboard
      : synthesizeStoryboardFromScript(brief, totalDuration);
  if (!storyboard?.beats?.length) {
    logger.info(
      'no storyboard on narrated brief — synthesized a deterministic hook/feature/cta board from script'
    );
  }
  const compositionFormat = effectiveStoryboard.format || resolveDefaultCompositionFormat();
  const backgroundColor =
    brief.design_system.theme_tokens?.background_color ||
    effectiveStoryboard.design_system_ref?.background_color ||
    resolveDefaultVideoBackgroundColor();
  const scenes = buildStoryboardScenes(brief, effectiveStoryboard);

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
      background_color: backgroundColor,
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
  const headline = beat.title;
  const content: Record<string, unknown> = {
    eyebrow: brief.design_system.brand_name,
    headline,
    body: resolveDistinctSceneBody(brief, beat, headline),
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
  if (isProcessLikeSemantic(beat.semantic)) {
    content.visual_steps = deriveProcessSteps(storyboard, beat);
  }
  if (isProofLikeSemantic(beat.semantic)) {
    content.evidence_items = storyboard.desired_takeaway
      ? [storyboard.desired_takeaway, ...(storyboard.promise ? [storyboard.promise] : [])]
      : [brief.script.feature];
  }
  if (presentationMode === 'promo') {
    content.value_points = [
      sceneHeadline(brief.script.hook, 28),
      sceneHeadline(brief.script.feature, 28),
      sceneHeadline(brief.script.cta, 28),
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
  if (isCtaLikeSemantic(beat.semantic) || beat.role === 'outro') {
    content.callout = brief.script.cta;
  }
  return content;
}

/** Prefer supporting copy that is not a duplicate of the on-screen headline. */
function resolveDistinctSceneBody(
  brief: NarratedVideoBrief,
  beat: VideoStoryboard['beats'][number],
  headline: string
): string {
  const candidates = [
    beat.message,
    beat.visual_intent,
    beat.caption_intent,
    isHookSemantic(beat.semantic) ? brief.script.feature : undefined,
    beat.semantic === 'cta' || beat.role === 'outro' ? brief.script.feature : undefined,
    beat.semantic === 'process' || beat.semantic === 'steps' || beat.role === 'feature'
      ? brief.script.feature
      : undefined,
    brief.intent,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  const normalizedHeadline = normalizeSceneCopy(headline);
  for (const candidate of candidates) {
    const normalized = normalizeSceneCopy(candidate);
    if (!normalized || normalized === normalizedHeadline) continue;
    if (
      normalizedHeadline &&
      normalized.startsWith(normalizedHeadline) &&
      normalized.length > normalizedHeadline.length + 2
    ) {
      // Keep longer supporting sentence that starts with the short title.
      return candidate;
    }
    if (normalizedHeadline && normalizedHeadline.startsWith(normalized)) continue;
    return candidate;
  }
  return brief.design_system.brand_name;
}

function normalizeSceneCopy(value: string): string {
  return String(value || '')
    .trim()
    .replace(/[。．.!！？?\s]/g, '')
    .toLowerCase();
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

/**
 * Deterministic fallback board used when a narrated brief has no storyboard.
 * Beat titles/messages come from script.hook/feature/cta so each scene's
 * on-screen headline changes with the narration beat.
 */
export function synthesizeStoryboardFromScript(
  brief: NarratedVideoBrief,
  totalDuration: number
): VideoStoryboard {
  const duration = clampDuration(totalDuration);
  // Narration reads the script beats in order, so time each beat by its share
  // of the script (with a floor so short beats stay on screen long enough).
  const [hookShare, featureShare] = scriptBeatShares([
    brief.script.hook,
    brief.script.feature,
    brief.script.cta,
  ]);
  const hookDuration = roundTo2(duration * hookShare);
  const featureDuration = roundTo2(duration * featureShare);
  const outroDuration = roundTo2(Math.max(0.1, duration - hookDuration - featureDuration));
  const format = resolveDefaultCompositionFormat();
  return {
    kind: 'video-storyboard',
    version: '1.0.0',
    title: brief.title || `${brief.design_system.brand_name} Intro`,
    presentation_mode: 'promo',
    content_type: 'promo',
    promise: brief.script.feature,
    desired_takeaway: brief.script.cta,
    format,
    design_system_ref: {
      system_id: 'synthesized-from-script',
      brand_name: brief.design_system.brand_name,
      background_color: brief.design_system.theme_tokens?.background_color,
      layout_family: brief.design_system.theme_tokens?.layout_variant,
      css_vars: brief.design_system.theme_tokens?.css_vars,
      logo_path: brief.design_system.assets?.logo_path,
      hero_path: brief.design_system.assets?.hero_path,
    },
    beats: [
      {
        beat_id: 'hook',
        // Locale-neutral structural titles; JA/other copy comes from brief.script / storyboard.
        title: sceneHeadline(brief.script.hook, 28),
        start_sec: 0,
        duration_sec: hookDuration,
        role: 'hook',
        semantic: 'hook',
        message: brief.script.hook,
        visual_direction: 'Open on the product claim',
        visual_intent: brief.script.hook,
        caption_intent: 'Intent before execution',
        layout_variant: brief.design_system.theme_tokens?.layout_variant || 'focus-center',
      },
      {
        beat_id: 'feature',
        title: 'Intent → Contract → Execute',
        start_sec: hookDuration,
        duration_sec: featureDuration,
        role: 'feature',
        semantic: 'process',
        message: brief.script.feature,
        visual_direction: 'Show the governed operating loop',
        visual_intent: brief.script.feature,
        caption_intent: 'Align, execute, verify',
        layout_variant: brief.design_system.theme_tokens?.layout_variant || 'split-left',
      },
      {
        beat_id: 'cta',
        title: sceneHeadline(brief.script.cta, 28),
        start_sec: roundTo2(hookDuration + featureDuration),
        duration_sec: outroDuration,
        role: 'outro',
        semantic: 'cta',
        message: brief.script.cta,
        visual_direction: 'Close on the call to action',
        visual_intent: brief.script.cta,
        caption_intent: 'Start a mission',
        layout_variant: 'split-right',
      },
    ],
  };
}

const MIN_BEAT_SHARE = 0.18;

/** Per-beat duration shares proportional to script length, floored at MIN_BEAT_SHARE. */
export function scriptBeatShares(beats: string[]): number[] {
  const lengths = beats.map((text) => Math.max(1, String(text || '').trim().length));
  const total = lengths.reduce((sum, value) => sum + value, 0);
  const floored = lengths.map((value) => Math.max(MIN_BEAT_SHARE, value / total));
  const norm = floored.reduce((sum, value) => sum + value, 0);
  return floored.map((value) => value / norm);
}

/**
 * Keep on-screen headlines readable while preserving the full script as body.
 * Prefers the whole first sentence (the renderer wraps it on phrase boundaries),
 * then whole clauses; truncates with an ellipsis only as a last resort so
 * headlines never end mid-word.
 */
export function sceneHeadline(text: string, maxLen = 56): string {
  const trimmed = String(text || '').trim();
  if (!trimmed) return 'Kyberion';
  const sentence = trimmed.split(/[。．.!！？?\n]/)[0]?.trim() || trimmed;
  if (sentence.length <= Math.ceil(maxLen * 1.6)) return sentence;
  const clauses = sentence
    .split(/[、，,]/)
    .map((clause) => clause.trim())
    .filter(Boolean);
  let headline = '';
  for (const clause of clauses) {
    const next = headline ? `${headline}、${clause}` : clause;
    if (next.length > maxLen) break;
    headline = next;
  }
  if (headline.length >= Math.ceil(maxLen * 0.4)) return headline;
  return `${sentence.slice(0, Math.max(1, maxLen - 1))}…`;
}

/** Split a sentence into short step labels on clause boundaries. */
function scriptClauses(text: string | undefined): string[] {
  return String(text || '')
    .split(/[、，,。．!！？?\n]/)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length >= 2);
}

function deriveProcessSteps(
  storyboard: VideoStoryboard,
  beat?: VideoStoryboard['beats'][number]
): Array<{ step: string; detail: string }> {
  // Steps describe this beat's process; reusing other beats' titles repeated
  // the hook/CTA copy inside the feature scene.
  const clauses = scriptClauses(beat?.message || beat?.visual_intent).slice(0, 4);
  if (clauses.length >= 2) {
    return clauses.map((clause, index) => ({
      step: String(index + 1).padStart(2, '0'),
      detail: sceneHeadline(clause, 24),
    }));
  }
  const shortLabels = ['合意', '実行', '検証', '公開'];
  return storyboard.beats.slice(0, 4).map((storyBeat, index) => ({
    step: String(index + 1).padStart(2, '0'),
    detail: sceneHeadline(storyBeat.title || shortLabels[index] || `Beat ${index + 1}`, 18),
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
      isCtaLikeSemantic(semantic) ||
      (typeof index === 'number' && typeof total === 'number' && index === total - 1)
    ) {
      return 'logo-outro';
    }
    if (isProcessLikeSemantic(semantic)) {
      return 'howto-guide';
    }
    if (isProofLikeSemantic(semantic)) {
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
      isCtaLikeSemantic(semantic) ||
      (typeof index === 'number' && typeof total === 'number' && index === total - 1)
    ) {
      return 'logo-outro';
    }
    return 'vtuber-stage';
  }
  if (isProcessLikeSemantic(semantic)) {
    return 'howto-guide';
  }
  if (
    role === 'outro' ||
    isCtaLikeSemantic(semantic) ||
    (typeof index === 'number' && typeof total === 'number' && index === total - 1)
  ) {
    return 'logo-outro';
  }
  if (isProofLikeSemantic(semantic) || isProcessLikeSemantic(semantic) || role === 'feature') {
    return 'split-highlight';
  }
  return 'basic-title-card';
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
    if (role === 'hook' || isHookSemantic(semantic)) return 'focus-center';
    if (isProcessLikeSemantic(semantic)) return 'fullscreen-demo';
    if (
      role === 'outro' ||
      isCtaLikeSemantic(semantic) ||
      (typeof index === 'number' && typeof total === 'number' && index === total - 1)
    ) {
      return 'split-right';
    }
    return 'split-left';
  }
  if (presentationMode === 'promo') {
    if (
      role === 'outro' ||
      isCtaLikeSemantic(semantic) ||
      (typeof index === 'number' && typeof total === 'number' && index === total - 1)
    ) {
      return 'split-right';
    }
    if (isProofLikeSemantic(semantic)) return 'fullscreen-demo';
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
  return clamp(value, 3, 300);
}

function clampFps(value: number): number {
  return clamp(Math.round(value), 1, 60);
}

function roundTo2(value: number): number {
  return Math.round(value * 100) / 100;
}

function sumStoryboardDuration(storyboard: VideoStoryboard): number {
  return roundTo2(storyboard.beats.reduce((sum, beat) => sum + beat.duration_sec, 0));
}
