/**
 * MP-02: motion is a governed vocabulary, not literals in the compiler.
 *
 * The invariants under test are the ones that decide whether output reads as
 * video or as a slideshow: every scene animates beyond its entrance, curves
 * vary within a scene, and a malformed model reply degrades instead of
 * blocking a render.
 */
import { describe, expect, it } from 'vitest';
import {
  MIN_DISTINCT_EASES,
  MIN_MIDSCENE_LAYERS,
  generateVideoMotionDirection,
  loadVideoMotionCatalog,
  motionDirectionToCss,
  normalizeVideoMotionDirection,
  type SceneMotionInput,
} from './video-motion-direction.js';

const SCENES: SceneMotionInput[] = [
  { scene_id: 'hook', role: 'hook', duration_sec: 3 },
  { scene_id: 'feature', role: 'feature', duration_sec: 5 },
  { scene_id: 'cta', role: 'cta', duration_sec: 2.5 },
];

function easesUsed(scene: { entrance: { ease: string }; midscene: Array<{ ease: string }> }) {
  return new Set([scene.entrance.ease, ...scene.midscene.map((layer) => layer.ease)]);
}

describe('motion catalog', () => {
  it('loads the curated catalog with both motion layers', () => {
    const catalog = loadVideoMotionCatalog();
    expect(Object.keys(catalog.entrance).length).toBeGreaterThanOrEqual(8);
    expect(Object.keys(catalog.midscene).length).toBeGreaterThanOrEqual(8);
    expect(Object.keys(catalog.eases).length).toBeGreaterThanOrEqual(MIN_DISTINCT_EASES);
  });

  it('does not expose _meta documentation keys as patterns', () => {
    const catalog = loadVideoMotionCatalog();
    expect(catalog.entrance._meta).toBeUndefined();
    expect(catalog.midscene._meta).toBeUndefined();
    expect(catalog.eases._meta).toBeUndefined();
  });
});

describe('normalizeVideoMotionDirection', () => {
  it('gives every scene an entrance and at least two mid-scene layers by default', () => {
    const direction = normalizeVideoMotionDirection(null, SCENES);
    expect(direction.scenes).toHaveLength(3);
    for (const scene of direction.scenes) {
      expect(scene.entrance.pattern_id).toBeTruthy();
      expect(scene.midscene.length).toBeGreaterThanOrEqual(MIN_MIDSCENE_LAYERS);
    }
  });

  it('meets the distinct-ease floor in every scene', () => {
    const direction = normalizeVideoMotionDirection(null, SCENES);
    for (const scene of direction.scenes) {
      expect(easesUsed(scene).size).toBeGreaterThanOrEqual(MIN_DISTINCT_EASES);
    }
  });

  it('honors a valid drafted selection', () => {
    const direction = normalizeVideoMotionDirection(
      {
        scenes: [{ scene_id: 'hook', entrance: 'wipe-reveal', midscene: ['ken-burns', 'drift'] }],
      },
      SCENES
    );
    const hook = direction.scenes.find((scene) => scene.scene_id === 'hook');
    expect(hook?.entrance.pattern_id).toBe('wipe-reveal');
    expect(hook?.midscene.map((layer) => layer.pattern_id)).toEqual(['ken-burns', 'drift']);
  });

  it('falls back to the role default when the draft names unknown patterns', () => {
    const direction = normalizeVideoMotionDirection(
      { scenes: [{ scene_id: 'hook', entrance: 'does-not-exist', midscene: ['nope'] }] },
      SCENES
    );
    const catalog = loadVideoMotionCatalog();
    const hook = direction.scenes.find((scene) => scene.scene_id === 'hook');
    expect(catalog.entrance[hook!.entrance.pattern_id]).toBeDefined();
    expect(hook!.midscene.length).toBeGreaterThanOrEqual(MIN_MIDSCENE_LAYERS);
    for (const layer of hook!.midscene) {
      expect(catalog.midscene[layer.pattern_id]).toBeDefined();
    }
  });

  it('clamps entrance offset into the no-jump-cut band', () => {
    const direction = normalizeVideoMotionDirection(
      {
        scenes: SCENES.map((scene) => ({
          scene_id: scene.scene_id,
          entrance_offset_sec: 4,
          entrance_duration_sec: 90,
        })),
      },
      SCENES
    );
    for (const scene of direction.scenes) {
      expect(scene.entrance.offset_sec).toBeLessThanOrEqual(0.3);
      expect(scene.entrance.offset_sec).toBeGreaterThanOrEqual(0.1);
      expect(scene.entrance.duration_sec).toBeLessThanOrEqual(1.6);
    }
  });

  it('caps non-cut transitions at the catalog limit', () => {
    const catalog = loadVideoMotionCatalog();
    const direction = normalizeVideoMotionDirection(
      {
        scenes: [],
        transitions: SCENES.flatMap((scene) =>
          Array.from({ length: 3 }, () => ({
            after_scene_id: scene.scene_id,
            kind: 'crossfade',
            duration_sec: 0.5,
          }))
        ),
      },
      SCENES
    );
    expect(direction.transitions.length).toBeLessThanOrEqual(
      catalog.transitions.max_non_cut_per_video
    );
  });

  it('drops transitions that reference unknown scenes', () => {
    const direction = normalizeVideoMotionDirection(
      { scenes: [], transitions: [{ after_scene_id: 'ghost', kind: 'crossfade' }] },
      SCENES
    );
    expect(direction.transitions).toHaveLength(0);
  });

  it('is deterministic for the same input', () => {
    expect(normalizeVideoMotionDirection(null, SCENES)).toEqual(
      normalizeVideoMotionDirection(null, SCENES)
    );
  });

  // A normalized direction is stored on the ADF and re-read when a stored
  // composition is recompiled; if normalize only understood the model's draft
  // shape, that round trip would silently drop the art direction.
  it('is idempotent over an already-normalized direction', () => {
    const once = normalizeVideoMotionDirection(
      { scenes: [{ scene_id: 'hook', entrance: 'wipe-reveal', midscene: ['ken-burns', 'drift'] }] },
      SCENES
    );
    expect(normalizeVideoMotionDirection(once, SCENES)).toEqual(once);
  });
});

describe('motionDirectionToCss', () => {
  it('emits keyframes and per-scene layer classes', () => {
    const direction = normalizeVideoMotionDirection(null, SCENES);
    const css = motionDirectionToCss(direction);
    expect(css).toContain('@keyframes kb-in-');
    expect(css).toContain('@keyframes kb-mid-');
    expect(css).toContain('.kb-scene-hook .kb-enter');
    expect(css).toContain('.kb-scene-hook .kb-motion-1');
    expect(css).toContain('.kb-scene-hook .kb-motion-2');
  });

  it('emits each keyframe block only once across scenes', () => {
    const direction = normalizeVideoMotionDirection(null, SCENES);
    const css = motionDirectionToCss(direction);
    const blocks = [...css.matchAll(/@keyframes (\S+)/g)].map((match) => match[1]);
    expect(new Set(blocks).size).toBe(blocks.length);
  });

  it('contains no non-deterministic constructs', () => {
    const css = motionDirectionToCss(normalizeVideoMotionDirection(null, SCENES));
    for (const banned of ['Math.random', 'Date.now', 'setTimeout', 'requestAnimationFrame']) {
      expect(css).not.toContain(banned);
    }
  });
});

describe('generateVideoMotionDirection', () => {
  it('applies a well-formed model selection', async () => {
    const direction = await generateVideoMotionDirection({
      title: 'T',
      story: 'S',
      scenes: SCENES,
      generate: async () =>
        JSON.stringify({
          scenes: [{ scene_id: 'feature', entrance: 'pop-in', midscene: ['bar-fill', 'drift'] }],
        }),
    });
    const feature = direction.scenes.find((scene) => scene.scene_id === 'feature');
    expect(feature?.entrance.pattern_id).toBe('pop-in');
  });

  it('degrades to role defaults when the backend fails', async () => {
    const direction = await generateVideoMotionDirection({
      title: 'T',
      story: 'S',
      scenes: SCENES,
      generate: async () => {
        throw new Error('backend unavailable');
      },
    });
    expect(direction.scenes).toHaveLength(3);
    for (const scene of direction.scenes) {
      expect(scene.midscene.length).toBeGreaterThanOrEqual(MIN_MIDSCENE_LAYERS);
    }
    expect(direction.resolution?.degraded).toBe(true);
  });

  it('degrades when the backend returns prose instead of JSON', async () => {
    const direction = await generateVideoMotionDirection({
      title: 'T',
      story: 'S',
      scenes: SCENES,
      generate: async () => 'I think a gentle fade would work nicely here.',
    });
    expect(direction.scenes).toHaveLength(3);
  });
});
