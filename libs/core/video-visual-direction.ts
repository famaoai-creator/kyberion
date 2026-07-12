import { createLogger } from './logger.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { tryRepairJson } from './json-repair.js';

// DS-04 / agy short-video quality: scene layout and visual composition used
// to be a single hardcoded dark-navy dashboard skin baked into
// video-composition-compiler.ts — every story rendered identically, with
// English demo placeholders leaking into real videos. A visual direction is
// now drafted per story by the reasoning backend (LLM zone), validated and
// clamped here (compiler zone stays deterministic), and applied through the
// existing --kb-* CSS token indirection.

const logger = createLogger('video-visual-direction');

export interface VideoVisualDirection {
  mood: string;
  palette: {
    bg: string;
    panel: string;
    accent: string;
    accent_text: string;
    text: string;
    subtext: string;
  };
  typography: {
    headline_px: number;
    body_px: number;
  };
  per_scene?: Array<{ scene_id: string; layout_variant: string }>;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

export const DEFAULT_VISUAL_DIRECTION: VideoVisualDirection = {
  mood: 'calm-tech',
  palette: {
    bg: '#0B1020',
    panel: '#0b1224',
    accent: '#60a5fa',
    accent_text: '#bfdbfe',
    text: '#f8fafc',
    subtext: '#94a3b8',
  },
  typography: { headline_px: 68, body_px: 23 },
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Validate an LLM-drafted direction. Anything malformed degrades to the
 * historical default (never fails a render); typography is clamped to
 * legible ranges, portrait frames get a larger floor so 9:16 shorts stop
 * rendering desktop-scale type.
 */
export function normalizeVideoVisualDirection(
  raw: unknown,
  frame: { width: number; height: number }
): VideoVisualDirection {
  const portrait = frame.height > frame.width;
  const fallback: VideoVisualDirection = {
    ...DEFAULT_VISUAL_DIRECTION,
    typography: portrait ? { headline_px: 96, body_px: 34 } : DEFAULT_VISUAL_DIRECTION.typography,
  };
  if (!raw || typeof raw !== 'object') return fallback;
  const candidate = raw as Record<string, any>;
  const palette = candidate.palette ?? {};
  const colors: Record<string, string> = {};
  for (const key of ['bg', 'panel', 'accent', 'accent_text', 'text', 'subtext'] as const) {
    const value = String(palette[key] ?? '').trim();
    if (!HEX.test(value)) return fallback;
    colors[key] = value;
  }
  const headlineRange: [number, number] = portrait ? [72, 132] : [48, 96];
  const bodyRange: [number, number] = portrait ? [28, 48] : [18, 34];
  const typography = candidate.typography ?? {};
  const headline = Number(typography.headline_px);
  const body = Number(typography.body_px);
  const perScene = Array.isArray(candidate.per_scene)
    ? candidate.per_scene
        .filter((entry: any) => entry && typeof entry === 'object' && entry.scene_id)
        .map((entry: any) => ({
          scene_id: String(entry.scene_id),
          layout_variant: String(entry.layout_variant || 'default'),
        }))
    : undefined;
  return {
    mood: String(candidate.mood || fallback.mood).slice(0, 60),
    palette: colors as VideoVisualDirection['palette'],
    typography: {
      headline_px: Number.isFinite(headline)
        ? clamp(headline, headlineRange[0], headlineRange[1])
        : fallback.typography.headline_px,
      body_px: Number.isFinite(body)
        ? clamp(body, bodyRange[0], bodyRange[1])
        : fallback.typography.body_px,
    },
    ...(perScene && perScene.length > 0 ? { per_scene: perScene } : {}),
  };
}

/** Map a direction onto the compiler's existing --kb-* token indirection. */
export function visualDirectionToCssVars(direction: VideoVisualDirection): string {
  const p = direction.palette;
  return [
    ':root {',
    `  --kb-bg-main: ${p.bg};`,
    `  --kb-bg-deep: ${p.bg};`,
    `  --kb-bg-surface: ${p.panel};`,
    `  --kb-bg-ink: ${p.panel};`,
    `  --kb-accent-blue: ${p.accent};`,
    `  --kb-accent-blue-soft: ${p.accent}29;`,
    `  --kb-accent-blue-text: ${p.accent_text};`,
    `  --kb-accent-blue-muted: ${p.accent_text};`,
    `  --kb-text-primary: ${p.text};`,
    `  --kb-text-secondary: ${p.subtext};`,
    `  --kb-text-muted: ${p.subtext};`,
    `  --bg: ${p.bg};`,
    `  --panel: ${p.panel};`,
    `  --text: ${p.text};`,
    `  --subtext: ${p.subtext};`,
    `  --headline-size: ${direction.typography.headline_px}px;`,
    `  --body-size: ${direction.typography.body_px}px;`,
    '}',
  ].join('\n');
}

export interface VideoVisualPattern {
  name: string;
  description?: string;
  mood: string;
  palette: VideoVisualDirection['palette'];
  typography: {
    portrait: { headline_px: number; body_px: number };
    landscape: { headline_px: number; body_px: number };
  };
}

let cachedPatternCatalog: Record<string, VideoVisualPattern> | null = null;

/**
 * Curated pattern pack (pptx themes.json counterpart for video). The LLM
 * only SELECTS an id from this governed catalog — it never invents colors,
 * so a bad model reply can only ever land on another curated pattern or the
 * default, not on an ungoverned palette.
 */
export function loadVideoVisualPatternCatalog(): Record<string, VideoVisualPattern> {
  if (cachedPatternCatalog) return cachedPatternCatalog;
  try {
    const catalogPath = pathResolver.knowledge(
      'public/design-patterns/media-templates/video-visual-patterns.json'
    );
    if (safeExistsSync(catalogPath)) {
      const parsed = JSON.parse(safeReadFile(catalogPath, { encoding: 'utf8' }) as string);
      if (parsed?.patterns && typeof parsed.patterns === 'object') {
        cachedPatternCatalog = parsed.patterns as Record<string, VideoVisualPattern>;
        return cachedPatternCatalog;
      }
    }
  } catch (error: any) {
    logger.warn(`pattern catalog unreadable, using built-in default: ${error?.message || error}`);
  }
  cachedPatternCatalog = {
    'calm-tech': {
      name: 'Calm Tech',
      mood: DEFAULT_VISUAL_DIRECTION.mood,
      palette: DEFAULT_VISUAL_DIRECTION.palette,
      typography: {
        portrait: { headline_px: 96, body_px: 34 },
        landscape: { headline_px: 68, body_px: 23 },
      },
    },
  };
  return cachedPatternCatalog;
}

export function resetVideoVisualPatternCatalogCache(): void {
  cachedPatternCatalog = null;
}

/** Resolve a curated pattern into a concrete direction for the given frame. */
export function patternToVisualDirection(
  patternId: string,
  pattern: VideoVisualPattern,
  frame: { width: number; height: number }
): VideoVisualDirection {
  const portrait = frame.height > frame.width;
  const typography = portrait ? pattern.typography.portrait : pattern.typography.landscape;
  return normalizeVideoVisualDirection(
    { mood: pattern.mood || patternId, palette: pattern.palette, typography },
    frame
  );
}

export interface GenerateVisualDirectionInput {
  title: string;
  story: string;
  tone?: string;
  audience?: string;
  frame: { width: number; height: number };
  scene_ids?: string[];
  /** Injectable for tests / stub environments. */
  generate?: (prompt: string) => Promise<string>;
}

/**
 * Draft a story-matched visual direction via the reasoning backend.
 * Failure or malformed output degrades to the deterministic default —
 * a render is never blocked by art direction.
 */
export async function generateVideoVisualDirection(
  input: GenerateVisualDirectionInput
): Promise<VideoVisualDirection> {
  const portrait = input.frame.height > input.frame.width;
  const catalog = loadVideoVisualPatternCatalog();
  const entries = Object.entries(catalog);
  const defaultEntry = entries[0];
  const prompt = [
    'You are an art director for short-form video. Choose the visual pattern',
    `that best fits this ${portrait ? 'vertical 9:16 short' : 'landscape'} video story.`,
    `Title: ${input.title}`,
    input.tone ? `Tone: ${input.tone}` : '',
    input.audience ? `Audience: ${input.audience}` : '',
    `Story: ${input.story.slice(0, 2000)}`,
    '',
    'Available patterns (pick exactly one id):',
    ...entries.map(
      ([id, pattern]) =>
        `- ${id} (${pattern.name})${pattern.description ? `: ${pattern.description}` : ''}`
    ),
    '',
    input.scene_ids?.length
      ? `Optionally assign per-scene layouts for scene ids: ${input.scene_ids.join(', ')}`
      : '',
    'Reply with ONLY a JSON object:',
    '{ "pattern_id": string, "reason": string,',
    '  "per_scene": [{ "scene_id": string, "layout_variant": "default" | "howto-guide" | "split-highlight" | "quote-card" }] }',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const generate =
      input.generate ??
      (async (p: string) => {
        const { getReasoningBackend } = await import('./reasoning-backend.js');
        return String(await getReasoningBackend().prompt(p));
      });
    const raw = await generate(prompt);
    const jsonText = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
    let parsed: any;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      parsed = tryRepairJson(jsonText);
    }
    const chosenId = String(parsed?.pattern_id ?? '').trim();
    const chosen = catalog[chosenId] ? ([chosenId, catalog[chosenId]] as const) : defaultEntry;
    if (!catalog[chosenId]) {
      logger.warn(`pattern "${chosenId}" not in catalog — using ${chosen[0]}`);
    }
    const direction = patternToVisualDirection(chosen[0], chosen[1], input.frame);
    const perScene = Array.isArray(parsed?.per_scene)
      ? parsed.per_scene
          .filter((entry: any) => entry && typeof entry === 'object' && entry.scene_id)
          .map((entry: any) => ({
            scene_id: String(entry.scene_id),
            layout_variant: String(entry.layout_variant || 'default'),
          }))
      : [];
    return perScene.length > 0 ? { ...direction, per_scene: perScene } : direction;
  } catch (error: any) {
    logger.warn(`visual direction selection failed, using default: ${error?.message || error}`);
    return patternToVisualDirection(defaultEntry[0], defaultEntry[1], input.frame);
  }
}
