// PA-09: the lip-sync engine (lipsync.js) with an injected clock / rAF, and
// the `ui:talking-avatar` vanilla renderer + DOM controller (avatar.js via
// kyberion-ui.js) on mini-dom.
//
// Covers smoothing (fast attack, slow release), the noise gate, synthetic
// determinism, cue mapping (blendshape / viseme incl. the Azure table pinned
// against core / expression), analyser reads, reduced motion, controller DOM
// updates without a re-render, cleanup (rAF cancelled, analyser detached)
// and the image URL allow-list (no `data:`).
import { describe, expect, it, vi } from 'vitest';
import { getUiMessageBundle } from '@agent/core';
import { KB_AVATAR_ACTIONS as CORE_AVATAR_ACTIONS } from '@agent/core/a2ui-catalog';
import {
  createRmsFallbackAnimationCue,
  normalizeProviderViseme,
} from '@agent/core/realtime-media-session';
import { disposeA2UI, renderA2UI } from './kyberion-ui.js';
import {
  KB_AVATAR_ACTIONS,
  KB_AZURE_VISEME_CANONICAL,
  KB_LIPSYNC_DEFAULTS,
  KB_VISEME_OPENNESS,
  avatarImageUrl,
  createLipsync,
  createSyntheticEnvelope,
  cueFromLevel,
  talkingAvatarView,
  visemeOpenness,
  type KbTalkingAvatarRuntimeController,
} from './avatar.js';
import { MiniDocument, MiniElement } from './mini-dom.test-support.js';

const EN = getUiMessageBundle('en');
const JA = getUiMessageBundle('ja');
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const FRAME = 1000 / 60;

/** Manual clock + rAF queue: `step(n)` advances one 60 Hz frame at a time. */
function fakeFrames() {
  let time = 0;
  let nextId = 1;
  const queue = new Map<number, (t: number) => void>();
  const cancelled: number[] = [];
  return {
    now: () => time,
    raf: (cb: (t: number) => void) => {
      const id = nextId++;
      queue.set(id, cb);
      return id;
    },
    caf: (id: unknown) => {
      cancelled.push(id as number);
      queue.delete(id as number);
    },
    cancelled,
    pending: () => queue.size,
    step(frames = 1, dt = FRAME) {
      for (let i = 0; i < frames; i += 1) {
        time += dt;
        const due = [...queue.entries()];
        queue.clear();
        for (const [, cb] of due) cb(time);
      }
    },
    advance(ms: number) {
      time += ms;
    },
  };
}

function engine(options: Record<string, unknown> = {}) {
  const frames = fakeFrames();
  const values: number[] = [];
  const lipsync = createLipsync({
    now: frames.now,
    raf: frames.raf,
    caf: frames.caf,
    onMouth: (v: number) => values.push(v),
    ...options,
  });
  return { frames, values, lipsync };
}

function fakeAnalyser(amplitude: number, kind: 'float' | 'byte' = 'float') {
  const reads = { count: 0 };
  const node: Record<string, unknown> = { fftSize: 256, disconnect: vi.fn() };
  if (kind === 'float') {
    node.getFloatTimeDomainData = (array: Float32Array) => {
      reads.count += 1;
      for (let i = 0; i < array.length; i += 1)
        array[i] = amplitude * Math.sin((i / array.length) * Math.PI * 8);
    };
  } else {
    node.getByteTimeDomainData = (array: Uint8Array) => {
      reads.count += 1;
      for (let i = 0; i < array.length; i += 1)
        array[i] = Math.round(128 + 127 * amplitude * Math.sin((i / array.length) * Math.PI * 8));
    };
  }
  return { node, reads };
}

describe('lipsync engine', () => {
  it('opens fast and closes slowly, then stops its frame loop', () => {
    const { frames, lipsync } = engine();
    lipsync.setLevel(1);
    frames.step(1);
    expect(lipsync.value()).toBeCloseTo(KB_LIPSYNC_DEFAULTS.attack, 5);
    let opening = 1;
    while (lipsync.value() < 0.95) {
      frames.step(1);
      opening += 1;
    }
    lipsync.setLevel(0);
    let closing = 0;
    while (lipsync.value() > 0.05) {
      frames.step(1);
      closing += 1;
    }
    expect(opening).toBeLessThan(closing);
    frames.step(40);
    expect(lipsync.value()).toBe(0);
    expect(lipsync.running()).toBe(false);
    expect(frames.pending()).toBe(0);
  });

  it('is frame-rate independent (two 30 Hz frames ≈ four 60 Hz half-steps)', () => {
    const a = engine();
    const b = engine();
    a.lipsync.setLevel(0.8);
    b.lipsync.setLevel(0.8);
    // The first frame of a run always counts as one 60 Hz frame.
    a.frames.step(1, FRAME);
    b.frames.step(1, FRAME);
    a.frames.step(4, FRAME);
    b.frames.step(2, FRAME * 2);
    expect(a.lipsync.value()).toBeCloseTo(b.lipsync.value(), 3);
  });

  it('gates levels below the noise floor and does not spin idle', () => {
    const { frames, values, lipsync } = engine();
    lipsync.setLevel(KB_LIPSYNC_DEFAULTS.gate * 0.8);
    frames.step(10);
    expect(values).toEqual([]);
    expect(lipsync.value()).toBe(0);
    expect(lipsync.running()).toBe(false);
  });

  it('reads RMS from an attached analyser and stops reading once detached', () => {
    const { frames, lipsync } = engine();
    const { node, reads } = fakeAnalyser(0.2);
    const detach = lipsync.attachAnalyser(node);
    frames.step(60);
    // RMS of a 0.2 sine ≈ 0.1414 × gain 3.2 ≈ 0.45
    expect(lipsync.value()).toBeCloseTo(0.2 * Math.SQRT1_2 * KB_LIPSYNC_DEFAULTS.gain, 2);
    detach();
    const readsAtDetach = reads.count;
    frames.step(80);
    expect(reads.count).toBe(readsAtDetach);
    expect(lipsync.value()).toBe(0);
    expect(lipsync.running()).toBe(false);
    // The caller owns the audio graph.
    expect(node.disconnect).not.toHaveBeenCalled();
  });

  it('falls back to byte time-domain data', () => {
    const { frames, lipsync } = engine();
    lipsync.attachAnalyser(fakeAnalyser(0.3, 'byte').node);
    frames.step(60);
    expect(lipsync.value()).toBeGreaterThan(0.5);
    expect(lipsync.attachAnalyser({} as never)).toBeTypeOf('function');
  });

  it('produces the same synthetic motion for the same seed', () => {
    const run = (seed: number) => {
      const { frames, values, lipsync } = engine();
      lipsync.startSynthetic({ seed, wordsPerMinute: 160 });
      frames.step(180);
      return { values, lipsync, frames };
    };
    const a = run(3);
    const b = run(3);
    const c = run(4);
    expect(a.values).toEqual(b.values);
    expect(a.values).not.toEqual(c.values);
    expect(Math.max(...a.values)).toBeGreaterThan(0.3);
    expect(Math.min(...a.values)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...a.values)).toBeLessThanOrEqual(1);
    // It closes between syllables, i.e. it is not a flat open mouth.
    expect(a.values.some((v, i) => i > 0 && v < a.values[i - 1])).toBe(true);
    a.lipsync.stopSynthetic();
    a.frames.step(120);
    expect(a.lipsync.value()).toBe(0);
    expect(a.lipsync.running()).toBe(false);
  });

  it('pulse() opens the mouth briefly (and restarts a synthetic syllable)', () => {
    const { frames, lipsync } = engine();
    lipsync.pulse();
    frames.step(4);
    expect(lipsync.value()).toBeGreaterThan(0.5);
    frames.step(90);
    expect(lipsync.value()).toBe(0);
    const envelope = createSyntheticEnvelope({ seed: 1 });
    envelope.pulse(1000);
    expect(envelope.level(1000 + 60)).toBeGreaterThan(0.3);
  });

  it('maps blendshape and viseme cues; expression cues go to onExpression', () => {
    const expressions: string[] = [];
    const { frames, lipsync } = engine({
      onExpression: (name: string) => expressions.push(name),
      avatarId: 'kyberion',
    });
    const cue = createRmsFallbackAnimationCue({
      target_avatar_id: 'kyberion',
      at_ms: 0,
      duration_ms: 200,
      mouth_open: 0.7,
    });
    expect(lipsync.applyCue(cue)).toBe(true);
    frames.step(10);
    expect(lipsync.value()).toBeCloseTo(0.7, 2);
    frames.step(60);
    expect(lipsync.value()).toBe(0);

    const viseme = normalizeProviderViseme({
      provider_id: 'azure',
      viseme_id: 1, // AA
      target_avatar_id: 'kyberion',
      at_ms: 0,
      duration_ms: 300,
    });
    expect(lipsync.applyCue(viseme)).toBe(true);
    frames.step(12);
    expect(lipsync.value()).toBeCloseTo(KB_VISEME_OPENNESS.AA, 2);

    expect(lipsync.applyCue({ kind: 'expression', payload: { expression: 'joy' }, at_ms: 0 })).toBe(
      true
    );
    expect(expressions).toEqual(['joy']);
    expect(lipsync.applyCue({ kind: 'gaze', payload: { x: 1 } })).toBe(false);
    expect(lipsync.applyCue({ kind: 'blendshape', payload: { brow: 1 } })).toBe(false);
    expect(lipsync.applyCue({ ...cue, target_avatar_id: 'someone-else' } as never)).toBe(false);
    expect(lipsync.applyCue(null as never)).toBe(false);
  });

  it('pins the Azure viseme table against core and covers every canonical viseme', () => {
    KB_AZURE_VISEME_CANONICAL.forEach((canonical, id) => {
      const cue = normalizeProviderViseme({
        provider_id: 'azure',
        viseme_id: id,
        target_avatar_id: 'a',
        at_ms: 0,
      });
      expect(cue.payload.canonical_viseme, `azure ${id}`).toBe(canonical);
      expect(visemeOpenness(cue.payload, cue.provider_id)).toBe(KB_VISEME_OPENNESS[canonical]);
      // Without canonical_viseme the Azure id still resolves.
      expect(visemeOpenness({ provider_viseme_id: id }, 'azure')).toBe(
        KB_VISEME_OPENNESS[canonical]
      );
    });
    expect(Object.keys(KB_VISEME_OPENNESS).sort()).toEqual([...KB_AZURE_VISEME_CANONICAL].sort());
    // Other providers: silence closes, unknown ids open half-way.
    expect(visemeOpenness({ provider_viseme_id: 0 }, 'other')).toBe(0);
    expect(visemeOpenness({ provider_viseme_id: 9 }, 'other')).toBe(0.5);
    expect(visemeOpenness({}, 'other')).toBeNull();
  });

  it('cueFromLevel produces exactly the rms_fallback cue shape of core', () => {
    expect(cueFromLevel(0.4, 120, { targetAvatarId: 'kyberion', durationMs: 50 })).toEqual(
      createRmsFallbackAnimationCue({
        target_avatar_id: 'kyberion',
        at_ms: 120,
        duration_ms: 50,
        mouth_open: 0.4,
      })
    );
    expect(cueFromLevel(1.4, -5).payload.mouth_open).toBe(1);
    expect(cueFromLevel(1.4, -5).at_ms).toBe(0);
    const { lipsync } = engine({ avatarId: 'k' });
    expect(lipsync.cueFromLevel(0.2, 10)).toEqual(
      createRmsFallbackAnimationCue({ target_avatar_id: 'k', at_ms: 10, mouth_open: 0.2 })
    );
  });

  it('damps the mouth under reduced motion', () => {
    const full = engine();
    const reduced = engine({ reducedMotion: true });
    full.lipsync.setLevel(1);
    reduced.lipsync.setLevel(1);
    full.frames.step(1);
    reduced.frames.step(1);
    expect(reduced.lipsync.value()).toBeLessThan(full.lipsync.value());
    full.frames.step(60);
    reduced.frames.step(60);
    expect(full.lipsync.value()).toBeCloseTo(1, 2);
    expect(reduced.lipsync.value()).toBeCloseTo(KB_LIPSYNC_DEFAULTS.reducedScale, 2);
  });

  it('dispose() cancels the pending frame and ignores later calls', () => {
    const { frames, lipsync } = engine();
    lipsync.setLevel(1);
    expect(frames.pending()).toBe(1);
    lipsync.dispose();
    expect(frames.cancelled).toEqual([1]);
    expect(frames.pending()).toBe(0);
    lipsync.setLevel(1);
    lipsync.startSynthetic();
    expect(lipsync.applyCue(cueFromLevel(1, 0))).toBe(false);
    expect(frames.pending()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Vanilla renderer + controller
// ---------------------------------------------------------------------------

/** mini-dom elements get a CSSOM-like `style.setProperty`. */
class StyledDocument extends MiniDocument {
  override createElement(tag: string): MiniElement {
    const node = super.createElement(tag);
    const style: Record<string, unknown> = {};
    style.setProperty = (name: string, value: string) => {
      style[name] = value;
    };
    node.style = style as Record<string, string>;
    return node;
  }
}

const AVATAR = '/assets/avatars/kyberion';
const IMAGES = {
  neutral: `${AVATAR}-neutral.svg`,
  joy: `${AVATAR}-joy.svg`,
  thinking: `${AVATAR}-thinking.svg`,
  listening: `${AVATAR}-listening.svg`,
};

function mount(props: Record<string, unknown>, options: Record<string, unknown> = {}) {
  const document = new StyledDocument();
  const container = document.createElement('div');
  const frames = fakeFrames();
  const actions: Array<{ id: string; payload?: Record<string, unknown> }> = [];
  const reduced = options.reducedMotion === true;
  const win = {
    performance: { now: frames.now },
    requestAnimationFrame: frames.raf,
    cancelAnimationFrame: frames.caf,
    matchMedia: (query: string) => ({ matches: reduced && query.includes('reduced-motion') }),
  };
  const render = (p: Record<string, unknown>) =>
    renderA2UI(
      container as unknown as Element,
      [{ id: 'av', type: 'ui:talking-avatar', props: p }] as never,
      {
        document: document as unknown as Document,
        window: win as unknown as Window,
        onAction: (action: { id: string; payload?: Record<string, unknown> }) =>
          actions.push(action),
        ...(options.locale === 'ja' ? { locale: 'ja', messages: JA.messages } : {}),
      } as never
    );
  render(props);
  const q = (selector: string) => {
    const found = container.query(selector);
    if (!found) throw new Error(`no element for ${selector}`);
    return found;
  };
  const controller = async () => {
    await tick();
    const ready = actions.find((action) => action.id === KB_AVATAR_ACTIONS.ready);
    if (!ready) throw new Error('no avatar.ready');
    return ready.payload!.controller as KbTalkingAvatarRuntimeController;
  };
  return { container, frames, actions, q, render, controller };
}

const mouthOpen = (node: MiniElement) =>
  Number((node.style as Record<string, string>)['--kb-mouth-open']);

describe('ui:talking-avatar (vanilla)', () => {
  it('mirrors the core action ids', () => {
    expect({ ...KB_AVATAR_ACTIONS }).toEqual({ ...CORE_AVATAR_ACTIONS });
  });

  it('renders the layered markup with a localized accessible name', () => {
    const m = mount({
      name: 'kyberion',
      label: 'Kyberion avatar',
      images: IMAGES,
      state: 'speaking',
      show_state: true,
      mouth: { x: 0.5, y: 0.51, width: 0.16 },
      size: 'lg',
    });
    const root = m.q('.kb-talking-avatar');
    expect(root.getAttribute('data-name')).toBe('kyberion');
    expect(root.getAttribute('data-size')).toBe('lg');
    expect(root.getAttribute('data-shape')).toBe('circle');
    expect(root.getAttribute('data-state')).toBe('speaking');
    expect(root.getAttribute('data-mouth-mode')).toBe('overlay');
    expect(root.getAttribute('data-expression')).toBe('neutral');
    expect((root.style as Record<string, string>)['--kb-mouth-y']).toBe('0.51');
    expect(mouthOpen(root)).toBe(0);
    const figure = m.q('.kb-talking-avatar__figure');
    expect(figure.getAttribute('role')).toBe('img');
    expect(figure.getAttribute('aria-label')).toBe('Kyberion avatar, Speaking');
    const images = m.container.queryAll('.kb-talking-avatar__image');
    expect(images.map((img) => img.getAttribute('data-expression'))).toEqual([
      'neutral',
      'joy',
      'thinking',
      'listening',
    ]);
    expect(images.map((img) => img.getAttribute('data-active'))).toEqual([
      'true',
      'false',
      'false',
      'false',
    ]);
    expect(images.every((img) => img.getAttribute('alt') === '')).toBe(true);
    expect(m.container.queryAll('.kb-talking-avatar__mouth ellipse')).toHaveLength(3);
    expect(m.q('.kb-voice-state').getAttribute('data-state')).toBe('speaking');
    expect(m.q('.kb-voice-state').getAttribute('data-variant')).toBe('dot');

    const ja = mount(
      { name: 'k', label: 'Kyberion のアバター', images: IMAGES, state: 'listening' },
      { locale: 'ja' }
    );
    expect(ja.q('.kb-talking-avatar__figure').getAttribute('aria-label')).toBe(
      `Kyberion のアバター（${JA.messages['ui:voice_state_listening']}）`
    );
    // listening follows the state when that image exists.
    expect(ja.q('.kb-talking-avatar').getAttribute('data-expression')).toBe('listening');
    // No state → just the label.
    const plain = mount({ name: 'k', label: 'K', images: IMAGES });
    expect(plain.q('.kb-talking-avatar__figure').getAttribute('aria-label')).toBe('K');
    expect(EN.messages['ui:talking_avatar_label_state']).toBe('{label}, {state}');
  });

  it('drops data: / blob: / script URLs and never puts them in src', () => {
    expect(avatarImageUrl('data:image/png;base64,AAAA')).toBeNull();
    expect(avatarImageUrl(' DATA:image/svg+xml,<svg/>')).toBeNull();
    expect(avatarImageUrl('blob:https://x/1')).toBeNull();
    expect(avatarImageUrl('javascript:alert(1)')).toBeNull();
    expect(avatarImageUrl('//evil.example/a.png')).toBeNull();
    expect(avatarImageUrl('mailto:a@b.c')).toBeNull();
    expect(avatarImageUrl('https://cdn.example.com/a.png')).toBe('https://cdn.example.com/a.png');
    expect(avatarImageUrl('/a.png')).toBe('/a.png');
    const m = mount({
      name: 'x',
      label: 'X avatar',
      images: {
        neutral: 'data:image/png;base64,AAAA',
        joy: '/joy.svg',
        mouth_open: 'data:image/png;base64,BBBB',
        blink: 'javascript:alert(1)',
      },
    });
    const srcs = m.container.queryAll('img').map((img) => img.getAttribute('src') ?? '');
    expect(srcs).toEqual(['/joy.svg']);
    // The data: open frame was dropped, so auto mode falls back to the overlay.
    expect(m.q('.kb-talking-avatar').getAttribute('data-mouth-mode')).toBe('overlay');
    // Initials stay underneath as the no-image fallback.
    expect(m.q('.kb-talking-avatar__initials').textContent).toBe('XA');
  });

  it('picks frames mode when an open-mouth (or speaking) frame exists', () => {
    const frames = mount({
      name: 'f',
      label: 'F',
      images: { ...IMAGES, speaking: `${AVATAR}-joy.svg` },
    });
    expect(frames.q('.kb-talking-avatar').getAttribute('data-mouth-mode')).toBe('frames');
    expect(frames.q('.kb-talking-avatar__mouth-frame').getAttribute('src')).toBe(
      `${AVATAR}-joy.svg`
    );
    expect(frames.container.query('.kb-talking-avatar__mouth')).toBeNull();
    const overlay = mount({
      name: 'o',
      label: 'O',
      images: { ...IMAGES, mouth_open: '/open.svg' },
      mouth_mode: 'overlay',
    });
    expect(overlay.container.query('.kb-talking-avatar__mouth-frame')).toBeNull();
    expect(
      talkingAvatarView({ images: { neutral: '/n' }, mouth_mode: 'frames' }, (k) => k).mouthMode
    ).toBe('overlay');
  });

  it('hands out a controller that updates the DOM in place (no re-render)', async () => {
    const m = mount({
      name: 'kyberion',
      label: 'Kyberion avatar',
      images: IMAGES,
      state: 'idle',
      show_state: true,
    });
    const root = m.q('.kb-talking-avatar');
    const controller = await m.controller();
    expect(m.actions[0].payload!.name).toBe('kyberion');

    controller.setLevel(1);
    m.frames.step(30);
    expect(mouthOpen(root)).toBeGreaterThan(0.95);
    controller.setLevel(0);
    m.frames.step(90);
    expect(mouthOpen(root)).toBe(0);

    expect(controller.setExpression('joy')).toBe(true);
    expect(root.getAttribute('data-expression')).toBe('joy');
    expect(
      m.container
        .queryAll('.kb-talking-avatar__image')
        .filter((img) => img.getAttribute('data-active') === 'true')
        .map((img) => img.getAttribute('data-expression'))
    ).toEqual(['joy']);
    expect(controller.setExpression('angry' as never)).toBe(false);

    expect(controller.setState('thinking')).toBe(true);
    expect(root.getAttribute('data-state')).toBe('thinking');
    expect(m.q('.kb-talking-avatar__figure').getAttribute('aria-label')).toBe(
      `Kyberion avatar, ${EN.messages['ui:voice_state_thinking']}`
    );
    expect(m.q('.kb-voice-state').getAttribute('data-state')).toBe('thinking');
    expect(m.q('.kb-voice-state__label').textContent).toBe(EN.messages['ui:voice_state_thinking']);
    // The explicit expression wins over the state; null hands it back to the state.
    expect(root.getAttribute('data-expression')).toBe('joy');
    controller.setExpression(null);
    expect(root.getAttribute('data-expression')).toBe('thinking');
    controller.setState(null);
    expect(root.hasAttribute('data-state')).toBe(false);
    expect(m.q('.kb-talking-avatar__figure').getAttribute('aria-label')).toBe('Kyberion avatar');

    // Expression cues route to setExpression.
    expect(controller.applyCue({ kind: 'expression', payload: { expression: 'listening' } })).toBe(
      true
    );
    expect(root.getAttribute('data-expression')).toBe('listening');

    // Same node the whole time: nothing re-rendered.
    expect(m.container.query('.kb-talking-avatar')).toBe(root);
  });

  it('releases the frame loop and the analyser on re-render / disposeA2UI', async () => {
    const m = mount({ name: 'k', label: 'K', images: IMAGES });
    const controller = await m.controller();
    const { node, reads } = fakeAnalyser(0.25);
    controller.attachAnalyser(node);
    controller.startSynthetic({ seed: 2 });
    m.frames.step(5);
    expect(m.frames.pending()).toBe(1);
    const readsBefore = reads.count;
    disposeA2UI(m.container as unknown as Element);
    expect(m.frames.cancelled.length).toBe(1);
    expect(m.frames.pending()).toBe(0);
    m.frames.step(20);
    expect(reads.count).toBe(readsBefore);
    // A disposed controller ignores calls.
    controller.setLevel(1);
    expect(controller.setExpression('joy')).toBe(false);
    expect(m.frames.pending()).toBe(0);
    expect(node.disconnect).not.toHaveBeenCalled();

    // A render disposed before the ready microtask never announces itself.
    const quick = mount({ name: 'q', label: 'Q', images: IMAGES });
    quick.render({ name: 'q2', label: 'Q', images: IMAGES });
    await tick();
    expect(quick.actions.map((a) => a.payload!.name)).toEqual(['q2']);
  });

  it('keeps the mouth moving but damped under prefers-reduced-motion', async () => {
    const m = mount({ name: 'k', label: 'K', images: IMAGES }, { reducedMotion: true });
    const controller = await m.controller();
    controller.setLevel(1);
    m.frames.step(60);
    expect(mouthOpen(m.q('.kb-talking-avatar'))).toBeCloseTo(KB_LIPSYNC_DEFAULTS.reducedScale, 2);
  });
});
