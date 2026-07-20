import { z } from 'zod';
import { createLogger } from './logger.js';
import { tryRepairJson } from './json-repair.js';
import {
  loadVideoMotionCatalog,
  safeCssIdentifier,
  type VideoMotionCatalog,
} from './video-motion-direction.js';
import { withReasoningPayloadScope, type ReasoningPayloadScope } from './reasoning-egress-scope.js';

/**
 * MP-02 (final piece): let the model compose the scene, within a vocabulary.
 *
 * Until now the model could pick a palette and a layout variant and supply
 * text; the arrangement itself lived in the compiler, so every story of a
 * given type looked identical. The plan called this "scaffold + stock motion
 * library" and described it as LLM scene authoring.
 *
 * What it is *not* is free-form HTML. Handing a model raw markup would give up
 * three things this system depends on: determinism (the same brief must render
 * the same frames), tenant governance (styles must resolve through the design
 * cascade, not arbitrary CSS), and safety (authored markup is an injection
 * surface in a renderer that executes scripts). Composition from a governed
 * block vocabulary keeps all three while still letting the arrangement, the
 * emphasis, and the motion differ per story — which is where the visual
 * monotony actually came from.
 *
 * Anything the model gets wrong degrades to the deterministic default rather
 * than failing a render.
 */

const logger = createLogger('video-scene-composition');

/** Blocks a scene can be built from. Each maps to a governed renderer. */
export const SCENE_BLOCK_TYPES = [
  'eyebrow',
  'headline',
  'body',
  'metrics',
  'steps',
  'quote',
  'callout',
  'image',
  'spacer',
] as const;

export type SceneBlockType = (typeof SCENE_BLOCK_TYPES)[number];

/** How a scene arranges its blocks. */
export const SCENE_LAYOUTS = [
  'stack',
  'split-left',
  'split-right',
  'center',
  'full-bleed',
] as const;

export type SceneLayout = (typeof SCENE_LAYOUTS)[number];

export const sceneBlockSchema = z.object({
  type: z.enum(SCENE_BLOCK_TYPES),
  /** Which field of the scene's content this block renders. */
  content_key: z.string().min(1),
  /** Relative visual weight; drives size and order, not raw pixel values. */
  emphasis: z.enum(['lead', 'support', 'accent']).default('support'),
  /** Column for split layouts; ignored by single-column layouts. */
  column: z.enum(['primary', 'secondary']).default('primary'),
});

export const sceneCompositionSchema = z.object({
  scene_id: z.string().min(1),
  layout: z.enum(SCENE_LAYOUTS),
  blocks: z.array(sceneBlockSchema).min(1).max(8),
  resolution: z
    .object({
      source: z.enum(['model', 'catalog-default']),
      degraded: z.boolean(),
      reason: z.string().max(240).optional(),
    })
    .optional(),
});

export type SceneBlock = z.infer<typeof sceneBlockSchema>;
export type SceneComposition = z.infer<typeof sceneCompositionSchema>;

/** A scene needs one clear focal point; more than one is none. */
const MAX_LEAD_BLOCKS = 1;
const MAX_BLOCKS = 8;

export interface SceneCompositionInput {
  scene_id: string;
  role?: string;
  /** Content keys actually available on this scene. */
  available_keys: string[];
}

/**
 * Deterministic composition, used as the default and as the fallback.
 *
 * Deliberately simple: a lead headline, supporting body, and whatever
 * structured content the scene happens to carry.
 */
export function defaultSceneComposition(input: SceneCompositionInput): SceneComposition {
  const has = (key: string) => input.available_keys.includes(key);
  const blocks: SceneBlock[] = [];

  if (has('eyebrow')) {
    blocks.push({
      type: 'eyebrow',
      content_key: 'eyebrow',
      emphasis: 'support',
      column: 'primary',
    });
  }
  blocks.push({
    type: 'headline',
    content_key: has('headline') ? 'headline' : 'title',
    emphasis: 'lead',
    column: 'primary',
  });
  if (has('body')) {
    blocks.push({ type: 'body', content_key: 'body', emphasis: 'support', column: 'primary' });
  }
  if (has('visual_steps')) {
    blocks.push({
      type: 'steps',
      content_key: 'visual_steps',
      emphasis: 'support',
      column: 'secondary',
    });
  }
  if (has('evidence_items')) {
    blocks.push({
      type: 'metrics',
      content_key: 'evidence_items',
      emphasis: 'accent',
      column: 'secondary',
    });
  }
  if (has('callout')) {
    blocks.push({ type: 'callout', content_key: 'callout', emphasis: 'accent', column: 'primary' });
  }

  return {
    scene_id: input.scene_id,
    layout: blocks.some((block) => block.column === 'secondary') ? 'split-left' : 'stack',
    blocks: blocks.slice(0, MAX_BLOCKS),
  };
}

/**
 * Clamp a (possibly model-drafted) composition into something renderable.
 *
 * Blocks referencing content the scene does not have are dropped rather than
 * rendered empty — an authored layout must not leave holes where a model
 * assumed a field existed.
 */
export function normalizeSceneComposition(
  raw: unknown,
  input: SceneCompositionInput
): SceneComposition {
  const fallback = defaultSceneComposition(input);
  if (!raw || typeof raw !== 'object') return fallback;

  const candidate = raw as Record<string, any>;
  const layout: SceneLayout = SCENE_LAYOUTS.includes(candidate.layout)
    ? candidate.layout
    : fallback.layout;

  const rawBlocks = Array.isArray(candidate.blocks) ? candidate.blocks : [];
  const blocks: SceneBlock[] = [];
  let leadCount = 0;

  for (const entry of rawBlocks) {
    if (!entry || typeof entry !== 'object') continue;
    const type = entry.type as SceneBlockType;
    if (!SCENE_BLOCK_TYPES.includes(type)) continue;
    const contentKey = String(entry.content_key ?? '').trim();
    // A block pointing at absent content would render as a hole.
    if (type !== 'spacer' && !input.available_keys.includes(contentKey)) continue;

    let emphasis: SceneBlock['emphasis'] =
      entry.emphasis === 'lead' || entry.emphasis === 'accent' ? entry.emphasis : 'support';
    if (emphasis === 'lead') {
      // One focal point per scene; extra leads demote to support.
      if (leadCount >= MAX_LEAD_BLOCKS) emphasis = 'support';
      else leadCount += 1;
    }

    blocks.push({
      type,
      content_key: contentKey || 'body',
      emphasis,
      column: entry.column === 'secondary' ? 'secondary' : 'primary',
    });
    if (blocks.length >= MAX_BLOCKS) break;
  }

  if (blocks.length === 0) return fallback;

  // A scene with no focal point reads as undifferentiated; promote the first.
  if (leadCount === 0) blocks[0] = { ...blocks[0], emphasis: 'lead' };

  // A split layout with nothing in the second column is really a stack.
  const usesSecondary = blocks.some((block) => block.column === 'secondary');
  const effectiveLayout: SceneLayout =
    (layout === 'split-left' || layout === 'split-right') && !usesSecondary ? 'stack' : layout;

  return { scene_id: input.scene_id, layout: effectiveLayout, blocks };
}

/** Emphasis maps to the type ramp, never to raw sizes. */
const EMPHASIS_TOKENS: Record<SceneBlock['emphasis'], { size: string; weight: string }> = {
  lead: { size: 'var(--kb-size-display)', weight: 'var(--kb-weight-display)' },
  support: { size: 'var(--kb-size-body)', weight: 'var(--kb-weight-body)' },
  accent: { size: 'var(--kb-size-title)', weight: 'var(--kb-weight-headline)' },
};

/**
 * CSS for a composition.
 *
 * Every value resolves through a `--kb-*` token, so a composed scene still
 * obeys the tenant's design cascade — the model chose the arrangement, not the
 * styling.
 */
export function sceneCompositionToCss(
  composition: SceneComposition,
  catalog: VideoMotionCatalog = loadVideoMotionCatalog()
): string {
  void catalog;
  const rules: string[] = [];
  const root = `.kb-composed-${safeCssIdentifier(composition.scene_id, 'scene')}`;

  const layoutRule: Record<SceneLayout, string> = {
    stack:
      'display: flex; flex-direction: column; justify-content: center; align-items: flex-start;',
    'split-left':
      'display: grid; grid-template-columns: 1fr 1fr; gap: calc(var(--kb-space-unit, 4px) * 8); align-items: center;',
    'split-right':
      'display: grid; grid-template-columns: 1fr 1fr; gap: calc(var(--kb-space-unit, 4px) * 8); align-items: center; direction: rtl;',
    center:
      'display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center;',
    'full-bleed': 'display: flex; flex-direction: column; justify-content: flex-end;',
  };

  rules.push(
    `${root} { ${layoutRule[composition.layout]} padding: var(--kb-safe-area, 5%); box-sizing: border-box; height: 100%; }`
  );

  composition.blocks.forEach((block, index) => {
    const tokens = EMPHASIS_TOKENS[block.emphasis];
    const selector = `${root} .kb-block-${index + 1}`;
    rules.push(
      `${selector} { font-size: ${tokens.size}; font-weight: ${tokens.weight}; color: var(--kb-text-primary); ${
        block.type === 'eyebrow' ? 'letter-spacing: 0.08em; opacity: 0.8;' : ''
      }${block.type === 'callout' ? 'color: var(--kb-accent);' : ''}${
        block.column === 'secondary' ? ' grid-column: 2;' : ''
      } }`
    );
  });

  return rules.join('\n');
}

export interface AuthorScenesInput {
  title: string;
  story: string;
  scenes: SceneCompositionInput[];
  /** Injectable for tests / stub environments. */
  generate?: (prompt: string) => Promise<string>;
  scope?: ReasoningPayloadScope;
}

/**
 * Ask the reasoning backend to compose the scenes.
 *
 * The model receives the block vocabulary and the content keys each scene
 * actually has, and returns an arrangement. It never returns markup or style
 * values, so a bad reply can only ever produce a differently-arranged scene —
 * not a broken or ungoverned one.
 */
export async function authorSceneCompositions(
  input: AuthorScenesInput
): Promise<SceneComposition[]> {
  const prompt = [
    'You are composing scenes for a short video. For each scene, choose a layout',
    'and arrange blocks. You are choosing arrangement and emphasis only — never',
    'colors, sizes, or markup, which come from the design system.',
    '',
    `Title: ${input.title}`,
    `Story: ${input.story.slice(0, 2000)}`,
    '',
    `Layouts: ${SCENE_LAYOUTS.join(', ')}`,
    `Block types: ${SCENE_BLOCK_TYPES.join(', ')}`,
    'Emphasis: lead (exactly one per scene — the focal point), support, accent',
    'Column: primary, secondary (secondary only matters in split layouts)',
    '',
    'Scenes and the content keys each one actually has:',
    ...input.scenes.map(
      (scene) =>
        `- ${scene.scene_id} (${scene.role ?? 'generic'}): ${scene.available_keys.join(', ')}`
    ),
    '',
    'Only reference content keys listed for that scene. Vary the arrangement to',
    'suit what each scene is saying; identical layouts throughout is the failure',
    'mode to avoid.',
    '',
    'Reply with ONLY a JSON object:',
    '{ "scenes": [{ "scene_id": string, "layout": string,',
    '  "blocks": [{ "type": string, "content_key": string, "emphasis": string, "column": string }] }] }',
  ].join('\n');

  try {
    const generate =
      input.generate ??
      (async (text: string) => {
        const { getReasoningBackend } = await import('./reasoning-backend.js');
        return String(await getReasoningBackend().prompt(text));
      });
    const reply = await withReasoningPayloadScope(
      input.scope ?? { tier: 'public', purpose: 'video scene composition' },
      () => generate(prompt)
    );
    const jsonText = reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1);
    let parsed: any;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      parsed = tryRepairJson(jsonText);
    }
    const drafted = new Map<string, unknown>();
    for (const entry of Array.isArray(parsed?.scenes) ? parsed.scenes : []) {
      if (entry && typeof entry === 'object' && entry.scene_id) {
        drafted.set(String(entry.scene_id), entry);
      }
    }
    const usableDraft = Boolean(
      parsed && typeof parsed === 'object' && Array.isArray(parsed.scenes)
    );
    return input.scenes.map((scene) => ({
      ...normalizeSceneComposition(drafted.get(scene.scene_id), scene),
      resolution: usableDraft
        ? { source: 'model' as const, degraded: false }
        : {
            source: 'catalog-default' as const,
            degraded: true,
            reason: 'model reply did not contain a valid scenes array',
          },
    }));
  } catch (error: any) {
    logger.warn(`scene composition failed, using defaults: ${error?.message || error}`);
    return input.scenes.map((scene) => ({
      ...defaultSceneComposition(scene),
      resolution: {
        source: 'catalog-default' as const,
        degraded: true,
        reason: String(error?.message || error || 'scene composition failed').slice(0, 240),
      },
    }));
  }
}
