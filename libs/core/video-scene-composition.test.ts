/**
 * MP-02: model-composed scenes, within a governed vocabulary.
 *
 * The tests are mostly about what a bad or adversarial reply cannot do:
 * reference content that is not there, produce a scene with no focal point,
 * smuggle in styling, or break a render. Composition is allowed to vary; the
 * guarantees are not.
 */
import { describe, expect, it } from 'vitest';
import {
  SCENE_BLOCK_TYPES,
  authorSceneCompositions,
  defaultSceneComposition,
  normalizeSceneComposition,
  sceneCompositionSchema,
  sceneCompositionToCss,
  type SceneCompositionInput,
} from './video-scene-composition.js';

const SCENE: SceneCompositionInput = {
  scene_id: 'feature',
  role: 'feature',
  available_keys: ['eyebrow', 'headline', 'body', 'visual_steps'],
};

describe('defaultSceneComposition', () => {
  it('always gives a scene exactly one focal point', () => {
    const composition = defaultSceneComposition(SCENE);
    expect(composition.blocks.filter((block) => block.emphasis === 'lead')).toHaveLength(1);
  });

  it('only references content the scene has', () => {
    const composition = defaultSceneComposition({
      scene_id: 'sparse',
      available_keys: ['headline'],
    });
    for (const block of composition.blocks) {
      expect(['headline', 'title']).toContain(block.content_key);
    }
  });

  it('is schema-valid and deterministic', () => {
    expect(sceneCompositionSchema.safeParse(defaultSceneComposition(SCENE)).success).toBe(true);
    expect(defaultSceneComposition(SCENE)).toEqual(defaultSceneComposition(SCENE));
  });
});

describe('normalizeSceneComposition', () => {
  it('accepts a well-formed composition', () => {
    const composition = normalizeSceneComposition(
      {
        layout: 'split-left',
        blocks: [
          { type: 'headline', content_key: 'headline', emphasis: 'lead', column: 'primary' },
          { type: 'steps', content_key: 'visual_steps', emphasis: 'support', column: 'secondary' },
        ],
      },
      SCENE
    );
    expect(composition.layout).toBe('split-left');
    expect(composition.blocks).toHaveLength(2);
  });

  it('drops blocks pointing at content the scene does not have', () => {
    // Otherwise an authored layout renders a hole where a field was assumed.
    const composition = normalizeSceneComposition(
      {
        layout: 'stack',
        blocks: [
          { type: 'headline', content_key: 'headline', emphasis: 'lead' },
          { type: 'metrics', content_key: 'nonexistent_field', emphasis: 'accent' },
        ],
      },
      SCENE
    );
    expect(composition.blocks).toHaveLength(1);
    expect(composition.blocks[0].content_key).toBe('headline');
  });

  it('demotes extra focal points so a scene has exactly one', () => {
    const composition = normalizeSceneComposition(
      {
        layout: 'stack',
        blocks: [
          { type: 'headline', content_key: 'headline', emphasis: 'lead' },
          { type: 'body', content_key: 'body', emphasis: 'lead' },
          { type: 'eyebrow', content_key: 'eyebrow', emphasis: 'lead' },
        ],
      },
      SCENE
    );
    expect(composition.blocks.filter((block) => block.emphasis === 'lead')).toHaveLength(1);
  });

  it('promotes a focal point when the draft has none', () => {
    const composition = normalizeSceneComposition(
      {
        layout: 'stack',
        blocks: [{ type: 'body', content_key: 'body', emphasis: 'support' }],
      },
      SCENE
    );
    expect(composition.blocks[0].emphasis).toBe('lead');
  });

  it('rejects unknown block types and layouts', () => {
    const composition = normalizeSceneComposition(
      {
        layout: 'diagonal-parallax',
        blocks: [
          { type: 'video-embed', content_key: 'headline' },
          { type: 'headline', content_key: 'headline', emphasis: 'lead' },
        ],
      },
      SCENE
    );
    expect(composition.blocks.every((block) => SCENE_BLOCK_TYPES.includes(block.type))).toBe(true);
    expect(composition.layout).not.toBe('diagonal-parallax');
  });

  it('collapses a split layout that never uses its second column', () => {
    const composition = normalizeSceneComposition(
      {
        layout: 'split-left',
        blocks: [
          { type: 'headline', content_key: 'headline', emphasis: 'lead', column: 'primary' },
        ],
      },
      SCENE
    );
    expect(composition.layout).toBe('stack');
  });

  it('caps block count', () => {
    const composition = normalizeSceneComposition(
      {
        layout: 'stack',
        blocks: Array.from({ length: 30 }, () => ({
          type: 'body',
          content_key: 'body',
          emphasis: 'support',
        })),
      },
      SCENE
    );
    expect(composition.blocks.length).toBeLessThanOrEqual(8);
  });

  it('falls back entirely when the draft is unusable', () => {
    for (const bad of [null, 'nonsense', { blocks: [] }, { blocks: 'no' }]) {
      const composition = normalizeSceneComposition(bad, SCENE);
      expect(sceneCompositionSchema.safeParse(composition).success).toBe(true);
      expect(composition.blocks.length).toBeGreaterThan(0);
    }
  });
});

describe('sceneCompositionToCss', () => {
  it('expresses every value through design tokens', () => {
    const css = sceneCompositionToCss(defaultSceneComposition(SCENE));
    // No literal sizes or colors: the model chose arrangement, not styling.
    expect(css).toContain('var(--kb-');
    expect(css).not.toMatch(/font-size:\s*\d+px/);
    expect(css).not.toMatch(/#[0-9a-fA-F]{6}/);
  });

  it('emits a rule per block', () => {
    const composition = defaultSceneComposition(SCENE);
    const css = sceneCompositionToCss(composition);
    for (let i = 1; i <= composition.blocks.length; i += 1) {
      expect(css).toContain(`.kb-block-${i}`);
    }
  });

  it('contains no executable content', () => {
    const css = sceneCompositionToCss(defaultSceneComposition(SCENE));
    for (const banned of ['<script', 'javascript:', 'expression(', 'Math.random']) {
      expect(css).not.toContain(banned);
    }
  });
});

describe('authorSceneCompositions', () => {
  const SCENES: SceneCompositionInput[] = [
    SCENE,
    { scene_id: 'cta', role: 'cta', available_keys: ['headline', 'callout'] },
  ];

  it('applies a well-formed model reply', async () => {
    const compositions = await authorSceneCompositions({
      title: 'T',
      story: 'S',
      scenes: SCENES,
      generate: async () =>
        JSON.stringify({
          scenes: [
            {
              scene_id: 'feature',
              layout: 'split-left',
              blocks: [
                { type: 'headline', content_key: 'headline', emphasis: 'lead', column: 'primary' },
                {
                  type: 'steps',
                  content_key: 'visual_steps',
                  emphasis: 'support',
                  column: 'secondary',
                },
              ],
            },
          ],
        }),
    });
    expect(compositions).toHaveLength(2);
    expect(compositions[0].layout).toBe('split-left');
    // The unmentioned scene still gets a valid composition.
    expect(compositions[1].blocks.length).toBeGreaterThan(0);
  });

  it('degrades to defaults when the backend fails', async () => {
    const compositions = await authorSceneCompositions({
      title: 'T',
      story: 'S',
      scenes: SCENES,
      generate: async () => {
        throw new Error('backend down');
      },
    });
    expect(compositions).toHaveLength(2);
    for (const composition of compositions) {
      expect(sceneCompositionSchema.safeParse(composition).success).toBe(true);
      expect(composition.resolution?.degraded).toBe(true);
    }
  });

  it('degrades when the reply is prose', async () => {
    const compositions = await authorSceneCompositions({
      title: 'T',
      story: 'S',
      scenes: SCENES,
      generate: async () => 'I would put the headline on the left.',
    });
    expect(compositions).toHaveLength(2);
  });

  it('cannot be made to reference another scene content key', async () => {
    const compositions = await authorSceneCompositions({
      title: 'T',
      story: 'S',
      scenes: SCENES,
      generate: async () =>
        JSON.stringify({
          scenes: [
            {
              scene_id: 'cta',
              layout: 'stack',
              // visual_steps belongs to the feature scene, not this one.
              blocks: [{ type: 'steps', content_key: 'visual_steps', emphasis: 'lead' }],
            },
          ],
        }),
    });
    const cta = compositions.find((composition) => composition.scene_id === 'cta')!;
    for (const block of cta.blocks) {
      expect(['headline', 'callout']).toContain(block.content_key);
    }
  });
});
