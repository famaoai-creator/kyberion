import { loadVideoMotionCatalog, MIN_MIDSCENE_LAYERS } from './video-motion-direction.js';
import { resolveCreativeDesign } from './creative-design-resolver.js';
import type { VideoCompositionADF } from './video-composition-contract.js';
import type { VideoCompositionRenderPlan } from './video-composition-contract.js';

/**
 * MP-02: structural and determinism lint for a composition bundle.
 *
 * The renderer seeks each frame rather than playing, so anything that reads a
 * clock, rolls a die, or schedules its own callbacks produces a different
 * frame on every run — the render stops being reproducible and a regression
 * becomes untestable. Those constructs are errors, not style preferences.
 *
 * The structural checks catch what makes generated video look wrong rather
 * than break: scene windows that do not tile leave black gaps, and a scene
 * with no mid-scene motion is a static slide.
 */

export type VideoLintSeverity = 'error' | 'warning';

export interface VideoLintFinding {
  rule: string;
  severity: VideoLintSeverity;
  message: string;
  scene_id?: string;
}

export interface VideoLintReport {
  ok: boolean;
  error_count: number;
  warning_count: number;
  findings: VideoLintFinding[];
}

/**
 * Constructs that break frame-accurate seeking. `video.play()` is included
 * because the framework owns playback — a scene that starts its own media
 * desynchronizes from the timeline.
 */
const BANNED_CONSTRUCTS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bMath\s*\.\s*random\s*\(/, label: 'Math.random()' },
  { pattern: /\bDate\s*\.\s*now\s*\(/, label: 'Date.now()' },
  { pattern: /\bnew\s+Date\s*\(\s*\)/, label: 'new Date()' },
  { pattern: /\bsetTimeout\s*\(/, label: 'setTimeout()' },
  { pattern: /\bsetInterval\s*\(/, label: 'setInterval()' },
  { pattern: /\brequestAnimationFrame\s*\(/, label: 'requestAnimationFrame()' },
  { pattern: /\brepeat\s*:\s*-1\b/, label: 'repeat: -1' },
  { pattern: /\.play\s*\(\s*\)/, label: '.play()' },
];

/** Scene windows must tile end-to-end; this is the tolerance for float noise. */
const TILING_TOLERANCE_SEC = 0.011;

export interface LintCompositionInput {
  adf: VideoCompositionADF;
  /** Compiled plan, when available — enables per-scene HTML checks. */
  plan?: VideoCompositionRenderPlan;
  /** Scene HTML keyed by scene_id. Supplied by the actuator after compile. */
  sceneHtml?: Record<string, string>;
  /** Tenant whose constraints (minimum legible sizes) apply. */
  tenantSlug?: string;
}

export function lintVideoComposition(input: LintCompositionInput): VideoLintReport {
  const findings: VideoLintFinding[] = [];
  const { adf } = input;
  const scenes = adf.scenes.slice().sort((a, b) => a.start_sec - b.start_sec);

  if (scenes.length === 0) {
    findings.push({
      rule: 'scenes/non-empty',
      severity: 'error',
      message: 'composition has no scenes',
    });
  }

  // --- scene window tiling -------------------------------------------------
  let cursor = 0;
  for (const scene of scenes) {
    const gap = scene.start_sec - cursor;
    if (gap > TILING_TOLERANCE_SEC) {
      findings.push({
        rule: 'scenes/no-gap',
        severity: 'error',
        scene_id: scene.scene_id,
        message: `scene starts ${gap.toFixed(2)}s after the previous scene ends — the frame goes blank in between`,
      });
    } else if (gap < -TILING_TOLERANCE_SEC) {
      findings.push({
        rule: 'scenes/no-overlap',
        severity: 'error',
        scene_id: scene.scene_id,
        message: `scene overlaps the previous one by ${Math.abs(gap).toFixed(2)}s`,
      });
    }
    if (scene.duration_sec <= 0) {
      findings.push({
        rule: 'scenes/positive-duration',
        severity: 'error',
        scene_id: scene.scene_id,
        message: 'scene has a non-positive duration',
      });
    }
    cursor = Math.round((scene.start_sec + scene.duration_sec) * 100) / 100;
  }

  if (cursor > adf.composition.duration_sec + TILING_TOLERANCE_SEC) {
    findings.push({
      rule: 'scenes/within-duration',
      severity: 'error',
      message: `scene timings end at ${cursor}s, past the composition duration of ${adf.composition.duration_sec}s`,
    });
  } else if (cursor < adf.composition.duration_sec - TILING_TOLERANCE_SEC) {
    findings.push({
      rule: 'scenes/fills-duration',
      severity: 'warning',
      message: `scenes end at ${cursor}s but the composition runs ${adf.composition.duration_sec}s — the tail renders blank`,
    });
  }

  // --- motion layering -----------------------------------------------------
  const motion = adf.composition.motion_direction;
  if (motion) {
    const catalog = loadVideoMotionCatalog();
    for (const scene of scenes) {
      const sceneMotion = motion.scenes?.find((entry) => entry.scene_id === scene.scene_id);
      if (!sceneMotion) {
        findings.push({
          rule: 'motion/scene-covered',
          severity: 'warning',
          scene_id: scene.scene_id,
          message: 'scene has no motion direction — it will fall back to the role default',
        });
        continue;
      }
      if ((sceneMotion.midscene?.length ?? 0) < MIN_MIDSCENE_LAYERS) {
        findings.push({
          rule: 'motion/no-static-slides',
          severity: 'error',
          scene_id: scene.scene_id,
          message: `scene has ${sceneMotion.midscene?.length ?? 0} mid-scene motion layers; ${MIN_MIDSCENE_LAYERS} are required or it renders as a static slide`,
        });
      }
      const eases = new Set(
        [sceneMotion.entrance?.ease, ...(sceneMotion.midscene ?? []).map((l) => l.ease)].filter(
          Boolean
        )
      );
      if (eases.size < 2) {
        findings.push({
          rule: 'motion/ease-variety',
          severity: 'warning',
          scene_id: scene.scene_id,
          message: 'every layer in this scene uses the same easing curve',
        });
      }
    }
    const nonCut = motion.transitions?.length ?? 0;
    if (nonCut > catalog.transitions.max_non_cut_per_video) {
      findings.push({
        rule: 'motion/transition-budget',
        severity: 'warning',
        message: `${nonCut} non-cut transitions exceed the budget of ${catalog.transitions.max_non_cut_per_video} — hard cuts should carry the video`,
      });
    }
  }

  // --- scene compositions --------------------------------------------------
  const compositions = adf.composition.scene_compositions;
  if (compositions?.length) {
    const sceneIds = new Set(scenes.map((scene) => scene.scene_id));
    for (const composition of compositions) {
      if (!sceneIds.has(composition.scene_id)) {
        findings.push({
          rule: 'composition/unknown-scene',
          severity: 'warning',
          message: `composition targets "${composition.scene_id}", which is not a scene in this composition`,
        });
        continue;
      }
      const leads = composition.blocks.filter((block) => block.emphasis === 'lead').length;
      if (leads !== 1) {
        findings.push({
          rule: 'composition/single-focal-point',
          severity: 'warning',
          scene_id: composition.scene_id,
          message: `scene has ${leads} lead blocks; exactly one focal point reads as designed, more reads as none`,
        });
      }
    }
    // All scenes arranged identically is the monotony this workstream exists
    // to remove, so it is worth saying out loud.
    const layouts = new Set(compositions.map((composition) => composition.layout));
    if (compositions.length >= 3 && layouts.size === 1) {
      findings.push({
        rule: 'composition/layout-variety',
        severity: 'warning',
        message: `every scene uses the "${[...layouts][0]}" layout — the video will read as one repeated slide`,
      });
    }
  }

  // --- per-scene HTML ------------------------------------------------------
  const constraints = resolveVideoConstraints(input.tenantSlug);
  for (const [sceneId, html] of Object.entries(input.sceneHtml ?? {})) {
    for (const banned of BANNED_CONSTRUCTS) {
      if (banned.pattern.test(html)) {
        findings.push({
          rule: 'determinism/no-clock-or-random',
          severity: 'error',
          scene_id: sceneId,
          message: `${banned.label} makes the render non-reproducible under frame seeking`,
        });
      }
    }
    for (const finding of lintSceneTypography(sceneId, html, constraints)) {
      findings.push(finding);
    }
  }

  const errorCount = findings.filter((finding) => finding.severity === 'error').length;
  return {
    ok: errorCount === 0,
    error_count: errorCount,
    warning_count: findings.length - errorCount,
    findings,
  };
}

function resolveVideoConstraints(tenantSlug?: string): {
  headlinePx: number;
  bodyPx: number;
} {
  try {
    const resolved = resolveCreativeDesign({ surface: 'video', tenantSlug });
    return {
      headlinePx: resolved.constraints.video_min_headline_px,
      bodyPx: resolved.constraints.video_min_body_px,
    };
  } catch {
    return { headlinePx: 60, bodyPx: 20 };
  }
}

/**
 * Flag literal font sizes below the legibility floor. Only absolute px values
 * are checked — `var(--kb-size-*)` references already resolve through the
 * design cascade, which clamps them.
 */
function lintSceneTypography(
  sceneId: string,
  html: string,
  constraints: { headlinePx: number; bodyPx: number }
): VideoLintFinding[] {
  const findings: VideoLintFinding[] = [];
  const declarations = [...html.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)];
  for (const declaration of declarations) {
    const size = Number(declaration[1]);
    if (Number.isFinite(size) && size < constraints.bodyPx) {
      findings.push({
        rule: 'typography/min-size',
        severity: 'warning',
        scene_id: sceneId,
        message: `font-size ${size}px is below the ${constraints.bodyPx}px legibility floor for video`,
      });
    }
  }
  return findings;
}

/** Render a report as operator-facing lines, most severe first. */
export function formatVideoLintReport(report: VideoLintReport): string {
  if (report.findings.length === 0) return 'video composition lint: no findings';
  return report.findings
    .slice()
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1))
    .map(
      (finding) =>
        `[${finding.severity}] ${finding.rule}${finding.scene_id ? ` (${finding.scene_id})` : ''}: ${finding.message}`
    )
    .join('\n');
}
