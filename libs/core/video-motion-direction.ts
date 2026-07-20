import { createLogger } from './logger.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { tryRepairJson } from './json-repair.js';
import type { VideoCompositionSceneRole } from './video-composition-contract.js';
import { withReasoningPayloadScope, type ReasoningPayloadScope } from './reasoning-egress-scope.js';

/**
 * MP-02: motion vocabulary as governed tokens.
 *
 * Motion used to live as literal `@keyframes` and hand-typed cubic-beziers
 * inside video-composition-compiler.ts, so every story animated identically
 * and the reasoning backend had no way to direct a scene beyond swapping a
 * palette. This module does for motion what video-visual-direction.ts (DS-04)
 * did for palette and type: a curated catalog the backend may only SELECT
 * from, normalized and clamped here so the compiler stays deterministic.
 *
 * Two rules are enforced rather than suggested, because both are what makes
 * generated video read as a slide deck when violated:
 *   - every scene gets an entrance AND at least two mid-scene layers
 *     (an entrance alone is a static slide that faded in), and
 *   - a scene uses at least three distinct eases (one curve everywhere reads
 *     as a mechanical sweep).
 */

const logger = createLogger('video-motion-direction');

export function safeCssIdentifier(value: string, fallback = 'item'): string {
  const normalized = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/^-+/, '');
  const safe = normalized || fallback;
  return /^[0-9]/u.test(safe) ? 'x-' + safe : safe;
}

export interface MotionEntrancePattern {
  name: string;
  description?: string;
  keyframes: string;
  duration_sec: number;
  offset_sec: number;
  default_ease: string;
}

export interface MotionMidscenePattern {
  name: string;
  description?: string;
  keyframes: string;
  duration_sec: number;
  stagger_sec?: number;
  default_ease: string;
  alternate?: boolean;
}

export interface VideoMotionCatalog {
  eases: Record<string, string>;
  entrance: Record<string, MotionEntrancePattern>;
  midscene: Record<string, MotionMidscenePattern>;
  role_defaults: Record<string, { entrance: string; midscene: string[] }>;
  transitions: {
    default: string;
    max_non_cut_per_video: number;
    min_duration_sec: number;
    preferred_duration_sec: number;
  };
}

export interface SceneMotion {
  scene_id: string;
  entrance: { pattern_id: string; ease: string; duration_sec: number; offset_sec: number };
  midscene: Array<{ pattern_id: string; ease: string; duration_sec: number }>;
}

export interface VideoMotionDirection {
  /** Scene motion keyed in composition order. */
  scenes: SceneMotion[];
  /** Non-cut transitions, capped by the catalog. */
  transitions: Array<{ after_scene_id: string; kind: string; duration_sec: number }>;
  /** Durable provenance so a successful render cannot hide a degraded draft. */
  resolution?: import('./video-visual-direction.js').ArtDirectionResolution;
}

/** Entrance offsets outside this band either jump-cut or feel laggy. */
const OFFSET_RANGE: [number, number] = [0.1, 0.3];
const ENTRANCE_DURATION_RANGE: [number, number] = [0.3, 1.6];
const MIDSCENE_DURATION_RANGE: [number, number] = [0.4, 8];
export const MIN_MIDSCENE_LAYERS = 2;
export const MIN_DISTINCT_EASES = 3;

const BUILT_IN_CATALOG: VideoMotionCatalog = {
  eases: {
    'smooth-out': 'cubic-bezier(0.16, 1, 0.3, 1)',
    overshoot: 'cubic-bezier(0.175, 0.885, 0.32, 1.275)',
    gentle: 'cubic-bezier(0.4, 0.0, 0.2, 1)',
    'sine-io': 'ease-in-out',
    decelerate: 'cubic-bezier(0.0, 0.0, 0.2, 1)',
    snap: 'cubic-bezier(0.22, 1, 0.36, 1)',
    linear: 'linear',
  },
  entrance: {
    'fade-rise': {
      name: 'Fade rise',
      keyframes:
        'from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); }',
      duration_sec: 0.8,
      offset_sec: 0.15,
      default_ease: 'smooth-out',
    },
  },
  midscene: {
    breathe: {
      name: 'Breathe',
      keyframes: 'from { transform: translateY(0); } to { transform: translateY(-8px); }',
      duration_sec: 4,
      default_ease: 'sine-io',
      alternate: true,
    },
    'pulse-accent': {
      name: 'Accent pulse',
      keyframes: 'from { opacity: 0.55; } to { opacity: 1; }',
      duration_sec: 2.4,
      default_ease: 'sine-io',
      alternate: true,
    },
  },
  role_defaults: {
    generic: { entrance: 'fade-rise', midscene: ['breathe', 'pulse-accent'] },
  },
  transitions: {
    default: 'cut',
    max_non_cut_per_video: 3,
    min_duration_sec: 0.3,
    preferred_duration_sec: 0.5,
  },
};

let cachedCatalog: VideoMotionCatalog | null = null;

/** Load the curated motion catalog; a missing/broken file degrades to built-ins. */
export function loadVideoMotionCatalog(): VideoMotionCatalog {
  if (cachedCatalog) return cachedCatalog;
  try {
    const catalogPath = pathResolver.knowledge(
      'public/design-patterns/media-templates/video-motion-patterns.json'
    );
    if (safeExistsSync(catalogPath)) {
      const parsed = JSON.parse(safeReadFile(catalogPath, { encoding: 'utf8' }) as string);
      const catalog = coerceCatalog(parsed);
      if (catalog) {
        cachedCatalog = catalog;
        return cachedCatalog;
      }
    }
  } catch (error: any) {
    logger.warn(`motion catalog unreadable, using built-in default: ${error?.message || error}`);
  }
  cachedCatalog = BUILT_IN_CATALOG;
  return cachedCatalog;
}

export function resetVideoMotionCatalogCache(): void {
  cachedCatalog = null;
}

/** Drop `_meta` documentation keys and reject a catalog missing either layer. */
function coerceCatalog(parsed: any): VideoMotionCatalog | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const strip = <T>(group: any): Record<string, T> => {
    const out: Record<string, T> = {};
    for (const [key, value] of Object.entries(group || {})) {
      if (key === '_meta') continue;
      out[key] = value as T;
    }
    return out;
  };
  const eases = strip<string>(parsed.eases);
  const entrance = strip<MotionEntrancePattern>(parsed.entrance);
  const midscene = strip<MotionMidscenePattern>(parsed.midscene);
  const roleDefaults = strip<{ entrance: string; midscene: string[] }>(parsed.role_defaults);
  if (Object.keys(entrance).length === 0 || Object.keys(midscene).length < MIN_MIDSCENE_LAYERS) {
    return null;
  }
  return {
    eases: Object.keys(eases).length > 0 ? eases : BUILT_IN_CATALOG.eases,
    entrance,
    midscene,
    role_defaults:
      Object.keys(roleDefaults).length > 0 ? roleDefaults : BUILT_IN_CATALOG.role_defaults,
    transitions: { ...BUILT_IN_CATALOG.transitions, ...(parsed.transitions || {}) },
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/** Read a pattern id from either a bare string or a normalized `{pattern_id}`. */
function patternIdOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (isRecord(value) && typeof value.pattern_id === 'string') {
    return value.pattern_id.trim() || undefined;
  }
  return undefined;
}

function roundTo2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Resolve an ease id to a CSS timing function, falling back to the catalog default. */
function resolveEase(catalog: VideoMotionCatalog, easeId: string | undefined): string {
  const id = String(easeId || '').trim();
  if (id && catalog.eases[id]) return id;
  return Object.keys(catalog.eases)[0];
}

/**
 * Pick additional mid-scene layers whose eases differ from the ones already
 * chosen, so the distinct-ease floor is met by construction rather than by
 * hoping the catalog order happens to vary.
 */
function fillMidsceneLayers(
  catalog: VideoMotionCatalog,
  chosen: string[],
  usedEases: Set<string>
): string[] {
  const layers = chosen.filter((id) => catalog.midscene[id]);
  const candidates = Object.keys(catalog.midscene).filter((id) => !layers.includes(id));
  // Prefer a candidate that introduces an unused ease.
  const byNovelEase = candidates.filter(
    (id) => !usedEases.has(resolveEase(catalog, catalog.midscene[id].default_ease))
  );
  const pool = [...byNovelEase, ...candidates];
  let cursor = 0;
  while (layers.length < MIN_MIDSCENE_LAYERS && cursor < pool.length) {
    const next = pool[cursor];
    cursor += 1;
    if (!layers.includes(next)) layers.push(next);
  }
  return layers;
}

export interface SceneMotionInput {
  scene_id: string;
  role?: VideoCompositionSceneRole;
  duration_sec?: number;
}

/**
 * Normalize a (possibly LLM-drafted, possibly absent) motion direction into a
 * concrete, clamped one. Unknown pattern ids fall back to the role default
 * rather than failing: a bad model reply must not block a render.
 */
export function normalizeVideoMotionDirection(
  raw: unknown,
  scenes: SceneMotionInput[],
  catalog: VideoMotionCatalog = loadVideoMotionCatalog()
): VideoMotionDirection {
  const drafted = new Map<string, any>();
  if (raw && typeof raw === 'object' && Array.isArray((raw as any).scenes)) {
    for (const entry of (raw as any).scenes) {
      if (entry && typeof entry === 'object' && entry.scene_id) {
        drafted.set(String(entry.scene_id), entry);
      }
    }
  }

  const normalizedScenes = scenes.map((scene) => {
    const roleKey = scene.role || 'generic';
    const roleDefault = catalog.role_defaults[roleKey] ||
      catalog.role_defaults.generic ||
      Object.values(catalog.role_defaults)[0] || {
        entrance: Object.keys(catalog.entrance)[0],
        midscene: Object.keys(catalog.midscene).slice(0, MIN_MIDSCENE_LAYERS),
      };
    const draft = drafted.get(scene.scene_id);

    // A draft may be a model reply (`entrance: "pop-in"`) or an
    // already-normalized direction round-tripped through the ADF
    // (`entrance: { pattern_id: "pop-in" }`). Accepting both keeps this
    // idempotent, so recompiling a stored composition preserves its motion.
    const draftedEntranceId = patternIdOf(draft?.entrance);
    const draftedEntrance = isRecord(draft?.entrance) ? draft.entrance : undefined;

    const entranceId =
      draftedEntranceId && catalog.entrance[draftedEntranceId]
        ? draftedEntranceId
        : catalog.entrance[roleDefault.entrance]
          ? roleDefault.entrance
          : Object.keys(catalog.entrance)[0];
    const entrancePattern = catalog.entrance[entranceId];
    const entranceEase = resolveEase(
      catalog,
      draft?.entrance_ease ?? draftedEntrance?.ease ?? entrancePattern.default_ease
    );

    const usedEases = new Set<string>([entranceEase]);
    const draftedMidscene = Array.isArray(draft?.midscene)
      ? draft.midscene
          .map(patternIdOf)
          .filter((id: string | undefined): id is string => Boolean(id))
      : undefined;
    const requested =
      draftedMidscene && draftedMidscene.length > 0 ? draftedMidscene : roleDefault.midscene;
    const midsceneIds = fillMidsceneLayers(catalog, requested, usedEases);

    // Each layer keeps its pattern's own curve unless that curve is already in
    // play in this scene; a collision takes the next unused one. Repairing on
    // collision (rather than after the fact) is what keeps a scene from
    // converging on one curve and reading as a single mechanical sweep.
    const midscene = midsceneIds.map((id) => {
      const pattern = catalog.midscene[id];
      const preferred = resolveEase(catalog, pattern.default_ease);
      const ease = usedEases.has(preferred)
        ? (Object.keys(catalog.eases).find((easeId) => !usedEases.has(easeId)) ?? preferred)
        : preferred;
      usedEases.add(ease);
      return {
        pattern_id: id,
        ease,
        // A looping layer must not outrun the scene it lives in.
        duration_sec: roundTo2(
          clamp(
            scene.duration_sec
              ? Math.min(pattern.duration_sec, scene.duration_sec * 2)
              : pattern.duration_sec,
            MIDSCENE_DURATION_RANGE[0],
            MIDSCENE_DURATION_RANGE[1]
          )
        ),
      };
    });

    return {
      scene_id: scene.scene_id,
      entrance: {
        pattern_id: entranceId,
        ease: entranceEase,
        duration_sec: roundTo2(
          clamp(
            Number(draft?.entrance_duration_sec) || entrancePattern.duration_sec,
            ENTRANCE_DURATION_RANGE[0],
            ENTRANCE_DURATION_RANGE[1]
          )
        ),
        offset_sec: roundTo2(
          clamp(
            Number(draft?.entrance_offset_sec) || entrancePattern.offset_sec,
            OFFSET_RANGE[0],
            OFFSET_RANGE[1]
          )
        ),
      },
      midscene,
    } satisfies SceneMotion;
  });

  const draftedTransitions =
    raw && typeof raw === 'object' && Array.isArray((raw as any).transitions)
      ? (raw as any).transitions
      : [];
  const sceneIds = new Set(scenes.map((scene) => scene.scene_id));
  const transitions = draftedTransitions
    .filter(
      (entry: any) =>
        entry && typeof entry === 'object' && sceneIds.has(String(entry.after_scene_id ?? ''))
    )
    .slice(0, catalog.transitions.max_non_cut_per_video)
    .map((entry: any) => ({
      after_scene_id: String(entry.after_scene_id),
      kind: String(entry.kind || 'crossfade'),
      duration_sec: roundTo2(
        clamp(
          Number(entry.duration_sec) || catalog.transitions.preferred_duration_sec,
          catalog.transitions.min_duration_sec,
          1.5
        )
      ),
    }));

  return { scenes: normalizedScenes, transitions };
}

/**
 * Where a scene's motion layers attach. Scene templates are the scaffold and
 * carry no animation of their own, so the compiler maps each layer onto the
 * structural selectors its templates already ship.
 */
export interface MotionSelectorMap {
  /** Element that plays the entrance. */
  entrance: string;
  /** One selector per mid-scene layer, in order. */
  layers: string[];
  /** Optional wrapper scope; omit for a standalone per-scene document. */
  scope?: string;
}

/**
 * Emit the CSS for a motion direction: one `@keyframes` per referenced pattern
 * plus a rule per scene layer. The compiler injects this instead of carrying
 * literal animation rules.
 */
export function motionDirectionToCss(
  direction: VideoMotionDirection,
  catalog: VideoMotionCatalog = loadVideoMotionCatalog(),
  selectors?: MotionSelectorMap
): string {
  const keyframeIds = new Set<string>();
  const blocks: string[] = [];

  for (const scene of direction.scenes) {
    const entrance = catalog.entrance[scene.entrance.pattern_id];
    const entranceId = safeCssIdentifier(scene.entrance.pattern_id, 'entrance');
    if (entrance && !keyframeIds.has(`kb-in-${entranceId}`)) {
      keyframeIds.add(`kb-in-${entranceId}`);
      blocks.push(`@keyframes kb-in-${entranceId} { ${entrance.keyframes} }`);
    }
    for (const layer of scene.midscene) {
      const pattern = catalog.midscene[layer.pattern_id];
      const layerId = safeCssIdentifier(layer.pattern_id, 'midscene');
      if (pattern && !keyframeIds.has(`kb-mid-${layerId}`)) {
        keyframeIds.add(`kb-mid-${layerId}`);
        blocks.push(`@keyframes kb-mid-${layerId} { ${pattern.keyframes} }`);
      }
    }
  }

  for (const scene of direction.scenes) {
    const scope = selectors
      ? selectors.scope
        ? `${selectors.scope} `
        : ''
      : `.kb-scene-${safeCssIdentifier(scene.scene_id, 'scene')} `;
    const entranceSelector = selectors?.entrance ?? '.kb-enter';
    const layerSelector = (index: number): string =>
      selectors?.layers[index] ?? `.kb-motion-${index + 1}`;

    const entrance = catalog.entrance[scene.entrance.pattern_id];
    if (entrance) {
      const entranceId = safeCssIdentifier(scene.entrance.pattern_id, 'entrance');
      blocks.push(
        `${scope}${entranceSelector} { animation: kb-in-${entranceId} ${scene.entrance.duration_sec}s ${catalog.eases[resolveEase(catalog, scene.entrance.ease)]} ${scene.entrance.offset_sec}s both; }`
      );
    }
    scene.midscene.forEach((layer, index) => {
      const pattern = catalog.midscene[layer.pattern_id];
      if (!pattern) return;
      const selector = layerSelector(index);
      if (!selector) return;
      const layerId = safeCssIdentifier(layer.pattern_id, 'midscene');
      const iteration = pattern.alternate ? 'infinite alternate' : 'both';
      blocks.push(
        `${scope}${selector} { animation: kb-mid-${layerId} ${layer.duration_sec}s ${catalog.eases[resolveEase(catalog, layer.ease)]} ${iteration}; }`
      );
      if (pattern.stagger_sec) {
        for (let child = 1; child <= 8; child += 1) {
          blocks.push(
            `${scope}${selector} > *:nth-child(${child}) { animation-delay: ${roundTo2(pattern.stagger_sec * child)}s; }`
          );
        }
      }
    });
  }

  return blocks.join('\n');
}

export interface GenerateMotionDirectionInput {
  title: string;
  story: string;
  tone?: string;
  scenes: SceneMotionInput[];
  /** Injectable for tests / stub environments. */
  generate?: (prompt: string) => Promise<string>;
  scope?: ReasoningPayloadScope;
}

/**
 * Draft a story-matched motion direction via the reasoning backend. The model
 * selects catalog ids only; anything unknown or malformed degrades to the
 * role defaults, so a render is never blocked by art direction.
 */
export async function generateVideoMotionDirection(
  input: GenerateMotionDirectionInput
): Promise<VideoMotionDirection> {
  const catalog = loadVideoMotionCatalog();
  const prompt = [
    'You are a motion designer for short-form video. Choose motion for each scene.',
    `Title: ${input.title}`,
    input.tone ? `Tone: ${input.tone}` : '',
    `Story: ${input.story.slice(0, 2000)}`,
    '',
    'Entrance patterns (pick exactly one id per scene):',
    ...Object.entries(catalog.entrance).map(
      ([id, pattern]) => `- ${id}: ${pattern.description || pattern.name}`
    ),
    '',
    'Mid-scene patterns (pick at least two ids per scene — a scene with only an entrance is a static slide):',
    ...Object.entries(catalog.midscene).map(
      ([id, pattern]) => `- ${id}: ${pattern.description || pattern.name}`
    ),
    '',
    `Scenes: ${input.scenes.map((scene) => `${scene.scene_id} (${scene.role || 'generic'}, ${scene.duration_sec ?? '?'}s)`).join(', ')}`,
    '',
    `Transitions default to hard cuts. Request at most ${catalog.transitions.max_non_cut_per_video} non-cut transitions, only where the story genuinely turns.`,
    'Reply with ONLY a JSON object:',
    '{ "scenes": [{ "scene_id": string, "entrance": string, "midscene": [string, string] }],',
    '  "transitions": [{ "after_scene_id": string, "kind": "crossfade", "duration_sec": number }] }',
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
    const rawReply = await withReasoningPayloadScope(
      input.scope ?? { tier: 'public', purpose: 'video motion direction' },
      () => generate(prompt)
    );
    const jsonText = rawReply.slice(rawReply.indexOf('{'), rawReply.lastIndexOf('}') + 1);
    let parsed: any;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      parsed = tryRepairJson(jsonText);
    }
    const usableDraft = Boolean(
      parsed && typeof parsed === 'object' && Array.isArray(parsed.scenes)
    );
    return {
      ...normalizeVideoMotionDirection(usableDraft ? parsed : null, input.scenes, catalog),
      resolution: usableDraft
        ? { source: 'model', degraded: false }
        : {
            source: 'catalog-default',
            degraded: true,
            reason: 'model reply did not contain a valid scenes array',
          },
    };
  } catch (error: any) {
    logger.warn(
      `motion direction selection failed, using role defaults: ${error?.message || error}`
    );
    return {
      ...normalizeVideoMotionDirection(null, input.scenes, catalog),
      resolution: {
        source: 'catalog-default',
        degraded: true,
        reason: String(error?.message || error || 'motion direction selection failed').slice(
          0,
          240
        ),
      },
    };
  }
}
