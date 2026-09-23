// PA-09: the secretary's talking avatar in the conversation dock header —
// image source (adopted personal set vs default Kyberion set), lip-sync
// hand-off to use-voice (`attachLipsync`) and state through the controller.
// Same react-dom/client-on-fake-DOM harness as settings-ui.test.ts.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactElement } from 'react';
import { KbI18nProvider } from '@agent/shared-ui';
import { getUiMessageBundle } from '@agent/core';
import {
  installFakeDom,
  serializeFake,
  type FakeDocument,
} from '../../../../libs/shared-ui/vanilla/fake-dom.test-support.js';
import {
  DOCK_AGENT_AVATAR,
  DockAvatar,
  adoptedDockAvatar,
  dockAvatarState,
} from '../src/app/dock-avatar';

const ui = getUiMessageBundle('en');
let dom: ReturnType<typeof installFakeDom>;
let client: typeof import('react-dom/client');

beforeAll(async () => {
  dom = installFakeDom();
  client = await import('react-dom/client');
});
afterAll(() => dom.restore());
afterEach(() => vi.unstubAllGlobals());

function mount(element: ReactElement) {
  const document = dom.document as FakeDocument;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = client.createRoot(container as unknown as Element);
  const wrap = (el: ReactElement) =>
    createElement(KbI18nProvider, { locale: ui.locale, messages: ui.messages }, el);
  act(() => root.render(wrap(element)));
  return {
    container,
    rerender: (next: ReactElement) => act(() => root.render(wrap(next))),
    unmount: () => act(() => root.unmount()),
  };
}
const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

function stubAvatarFetch(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        })
    )
  );
}

describe('dock avatar helpers', () => {
  it('maps voice state with speaking > listening > thinking', () => {
    expect(dockAvatarState({ speaking: true, listening: true, busy: true })).toBe('speaking');
    expect(dockAvatarState({ speaking: false, listening: true, busy: true })).toBe('listening');
    expect(dockAvatarState({ speaking: false, listening: false, busy: true })).toBe('thinking');
    expect(dockAvatarState({ speaking: false, listening: false, busy: false })).toBeNull();
  });

  it('uses only an adopted set with same-origin frame URLs', () => {
    const wire = {
      images: { neutral: '/api/me/avatar/neutral', joy: 'https://evil.example/x.png' },
      mouth: { x: 0.5, y: 0.6, width: 0.2 },
      generated_at: 'g1',
    };
    expect(adoptedDockAvatar({ avatar: { ...wire, adopted: false } })).toBeNull();
    expect(adoptedDockAvatar({ avatar: null })).toBeNull();
    expect(adoptedDockAvatar({ avatar: { ...wire, adopted: true } })).toEqual({
      images: { neutral: '/api/me/avatar/neutral?v=g1' },
      mouth: { x: 0.5, y: 0.6, width: 0.2 },
    });
  });
});

describe('DockAvatar', () => {
  it('falls back to the default secretary set and hands its controller to use-voice', async () => {
    stubAvatarFetch(403, { ok: false });
    const attachLipsync = vi.fn();
    const props = { busy: false, label: 'Secretary avatar', personalLabel: 'Your avatar' };
    const voice = { attachLipsync, listening: false, speaking: false };
    const m = mount(createElement(DockAvatar, { ...props, voice }));
    await flush();
    const html = serializeFake(m.container);
    expect(html).toContain(DOCK_AGENT_AVATAR.images.neutral);
    expect(html).toContain('data-avatar-source=agent');
    expect(html).toContain('aria-label=Secretary avatar');
    const controller = attachLipsync.mock.calls.at(-1)![0];
    expect(typeof controller.startSynthetic).toBe('function');
    expect(typeof controller.attachAnalyser).toBe('function');

    // State goes through the controller in place (no data-state until then).
    m.rerender(createElement(DockAvatar, { ...props, busy: true, voice }));
    expect(serializeFake(m.container)).toContain('data-state=thinking');
    m.rerender(createElement(DockAvatar, { ...props, voice: { ...voice, speaking: true } }));
    expect(serializeFake(m.container)).toContain('data-state=speaking');
    m.rerender(createElement(DockAvatar, { ...props, voice }));
    expect(serializeFake(m.container)).not.toContain('data-state=');

    m.unmount();
    expect(attachLipsync).toHaveBeenLastCalledWith(null);
  });

  it('shows the adopted personal set to the owner', async () => {
    stubAvatarFetch(200, {
      ok: true,
      avatar: {
        images: { neutral: '/api/me/avatar/neutral', speaking: '/api/me/avatar/speaking' },
        mouth: { x: 0.5, y: 0.7, width: 0.2 },
        generated_at: 'g2',
        adopted: true,
      },
    });
    const attachLipsync = vi.fn();
    const m = mount(
      createElement(DockAvatar, {
        busy: false,
        label: 'Secretary avatar',
        personalLabel: 'Your avatar',
        voice: { attachLipsync, listening: false, speaking: false },
      })
    );
    await flush();
    const html = serializeFake(m.container);
    expect(html).toContain('/api/me/avatar/neutral?v=g2');
    expect(html).toContain('data-avatar-source=personal');
    expect(html).toContain('aria-label=Your avatar');
    // The personal set's speaking frame drives the mouth in frames mode.
    expect(html).toContain('data-mouth-mode=frames');
    // A fresh controller replaced the default one when the images changed.
    expect(attachLipsync.mock.calls.filter(([c]) => c).length).toBeGreaterThanOrEqual(2);
    m.unmount();
  });
});
