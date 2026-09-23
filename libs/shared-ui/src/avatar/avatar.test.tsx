// PA-09: React `TalkingAvatar`.
//
// Static markup (renderToStaticMarkup) pins the SSR contract (the same as
// vanilla/avatar.js — the parity test covers the gallery fixtures); the
// interaction half runs react-dom/client on the fake DOM with a manual rAF
// queue, so the effect-owned controller, in-place DOM updates and the unmount
// cleanup execute for real.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, type ReactElement } from 'react';
import { getUiMessageBundle } from '@agent/core';
import {
  installFakeDom,
  type FakeDocument,
  type FakeElement,
} from '../../vanilla/fake-dom.test-support.js';
import {
  A2UIActionProvider,
  A2UIRenderer,
  KB_AVATAR_ACTIONS,
  KbI18nProvider,
  TalkingAvatar,
  type KbTalkingAvatarRuntimeController,
} from '../index.js';

const JA = getUiMessageBundle('ja');
const FRAME = 1000 / 60;
const IMAGES = {
  neutral: '/assets/avatars/kyberion-neutral.svg',
  joy: '/assets/avatars/kyberion-joy.svg',
  listening: '/assets/avatars/kyberion-listening.svg',
};

describe('React TalkingAvatar: static markup', () => {
  it('server-renders the layered avatar with the anchor variables and a localized name', () => {
    const out = renderToStaticMarkup(
      <KbI18nProvider locale={JA.locale} messages={JA.messages}>
        <TalkingAvatar
          name="kyberion"
          label="Kyberion のアバター"
          images={{ ...IMAGES, blink: '/assets/avatars/kyberion-blink.svg' }}
          state="speaking"
          show_state
          mouth={{ x: 0.5, y: 0.51, width: 0.16 }}
          size="lg"
          fallback_initials="KY"
        />
      </KbI18nProvider>
    );
    expect(out).toContain(
      '<div class="kb-talking-avatar" data-name="kyberion" data-size="lg" data-shape="circle" data-expression="neutral" data-state="speaking" data-mouth-mode="overlay" style="--kb-mouth-x:0.5;--kb-mouth-y:0.51;--kb-mouth-width:0.16;--kb-mouth-open:0">'
    );
    expect(out).toContain(
      `<div class="kb-talking-avatar__figure" role="img" aria-label="Kyberion のアバター（${JA.messages['ui:voice_state_speaking']}）">`
    );
    expect(out).toContain('<span class="kb-talking-avatar__initials" aria-hidden="true">KY</span>');
    expect(out).toContain(
      '<img class="kb-talking-avatar__image" src="/assets/avatars/kyberion-joy.svg" alt="" draggable="false" data-expression="joy" data-active="false"/>'
    );
    expect(out).toContain('<img class="kb-talking-avatar__blink"');
    expect(out).toContain(
      '<svg class="kb-talking-avatar__mouth" viewBox="0 0 100 60" aria-hidden="true" focusable="false">'
    );
    expect(out).toContain(
      'class="kb-voice-state" role="status" data-state="speaking" data-variant="dot"'
    );
  });

  it('never renders a data: image from props and renders through A2UIRenderer', () => {
    const out = renderToStaticMarkup(
      <A2UIRenderer
        components={[
          {
            id: 'av',
            type: 'ui:talking-avatar',
            props: {
              name: 'x',
              label: 'X',
              images: { neutral: 'data:image/png;base64,AAAA', mouth_open: '/open.png' },
            },
          },
        ]}
      />
    );
    expect(out).not.toContain('data:image');
    expect(out).toContain('data-mouth-mode="frames"');
    expect(out).toContain('<img class="kb-talking-avatar__mouth-frame" src="/open.png"');
  });
});

// ---------------------------------------------------------------------------
// Interaction (react-dom/client on the fake DOM)
// ---------------------------------------------------------------------------

type ClientModule = typeof import('react-dom/client');
let client: ClientModule;
let dom: ReturnType<typeof installFakeDom>;
let time = 0;
let nextId = 1;
const queue = new Map<number, (t: number) => void>();
const cancelled: number[] = [];
let reducedMotion = false;

function step(frames: number) {
  for (let i = 0; i < frames; i += 1) {
    time += FRAME;
    const due = [...queue.values()];
    queue.clear();
    for (const cb of due) cb(time);
  }
}

beforeAll(async () => {
  dom = installFakeDom({
    performance: { now: () => time },
    requestAnimationFrame: (cb: (t: number) => void) => {
      const id = nextId++;
      queue.set(id, cb);
      return id;
    },
    cancelAnimationFrame: (id: number) => {
      cancelled.push(id);
      queue.delete(id);
    },
    matchMedia: (query: string) => ({
      matches: reducedMotion && query.includes('reduced-motion'),
    }),
  });
  client = await import('react-dom/client');
});

afterAll(() => {
  dom.restore();
});

function mount(element: ReactElement) {
  const document = dom.document as FakeDocument;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const actions: Array<{ id: string; payload?: Record<string, unknown> }> = [];
  const root = client.createRoot(container as unknown as Element);
  const wrap = (child: ReactElement) => (
    <A2UIActionProvider onAction={(id, payload) => actions.push({ id, payload })}>
      {child}
    </A2UIActionProvider>
  );
  act(() => root.render(wrap(element)));
  const q = (selector: string): FakeElement => {
    const found = container.querySelector(selector);
    if (!found) throw new Error(`no element for ${selector}`);
    return found;
  };
  const controller = () => {
    const ready = actions.filter((action) => action.id === KB_AVATAR_ACTIONS.ready).at(-1);
    if (!ready) throw new Error('no avatar.ready');
    return ready.payload!.controller as KbTalkingAvatarRuntimeController;
  };
  return {
    actions,
    q,
    controller,
    rerender: (next: ReactElement) => act(() => root.render(wrap(next))),
    unmount: () => act(() => root.unmount()),
  };
}

const mouthOpen = (node: FakeElement) =>
  Number((node.style as unknown as Record<string, string>)['--kb-mouth-open']);

describe('React TalkingAvatar: controller', () => {
  it('dispatches avatar.ready and updates the DOM in place, then cleans up on unmount', () => {
    const m = mount(<TalkingAvatar name="kyberion" label="Kyberion avatar" images={IMAGES} />);
    const root = m.q('.kb-talking-avatar');
    const controller = m.controller();
    expect(m.actions[0].payload!.name).toBe('kyberion');

    controller.setLevel(1);
    step(30);
    expect(mouthOpen(root)).toBeGreaterThan(0.95);

    controller.setExpression('joy');
    expect(root.getAttribute('data-expression')).toBe('joy');
    expect(
      m.q('.kb-talking-avatar__image[data-expression="joy"]').getAttribute('data-active')
    ).toBe('true');
    controller.setState('listening');
    expect(root.getAttribute('data-state')).toBe('listening');
    expect(m.q('.kb-talking-avatar__figure').getAttribute('aria-label')).toBe(
      'Kyberion avatar, Listening'
    );
    // Still the same node: no React re-render happened.
    expect(m.q('.kb-talking-avatar')).toBe(root);

    const pendingBefore = queue.size;
    expect(pendingBefore).toBe(1);
    m.unmount();
    expect(queue.size).toBe(0);
    expect(cancelled.length).toBeGreaterThan(0);
    controller.setLevel(1);
    expect(queue.size).toBe(0);
  });

  it('re-creates the controller when the image set changes', () => {
    const m = mount(<TalkingAvatar name="a" label="A" images={{ neutral: '/n.svg' }} />);
    const first = m.controller();
    m.rerender(<TalkingAvatar name="a" label="A" images={IMAGES} />);
    const second = m.controller();
    expect(second).not.toBe(first);
    // The old controller is disposed.
    expect(first.setExpression('joy')).toBe(false);
    expect(second.setExpression('joy')).toBe(true);
    m.unmount();
  });

  it('damps the mouth under prefers-reduced-motion', () => {
    reducedMotion = true;
    try {
      const m = mount(<TalkingAvatar name="r" label="R" images={IMAGES} />);
      m.controller().setLevel(1);
      step(60);
      expect(mouthOpen(m.q('.kb-talking-avatar'))).toBeCloseTo(0.55, 2);
      m.unmount();
    } finally {
      reducedMotion = false;
    }
  });
});
