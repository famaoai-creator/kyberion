import { describe, expect, it, vi } from 'vitest';
import {
  createSettingsNavigation,
  resolveSettingsTarget,
  visibleSettingsSection,
} from './settings-navigation';

function harness(initial = 'http://localhost/settings?tenant=alpha') {
  let url = new URL(initial);
  const callbacks = new Map<string, Set<() => void>>();
  const current = vi.fn();
  let nextFrame = 0;
  const frames = new Map<number, () => void>();
  let resize: (() => void) | null = null;
  const disconnect = vi.fn();
  const flushFrames = () => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((cb) => cb());
  };
  const state = { next: 'preserved' };
  const history: string[] = [url.href];
  const elements = new Map<string, ReturnType<typeof element>>();
  function element(top = 0) {
    const attrs = new Map<string, string>();
    return {
      top,
      details: null as null | { open: boolean; parentElement: null },
      getClientRects: () => [1],
      getBoundingClientRect() {
        return { top: this.top };
      },
      closest() {
        return this.details;
      },
      scrollIntoView: vi.fn(),
      focus: vi.fn(),
      hasAttribute: (name: string) => attrs.has(name),
      setAttribute: (name: string, value: string) => attrs.set(name, value),
    };
  }
  elements.set('setup-profile', element(-300));
  elements.set('settings-display', element(0));
  elements.set('setup-services', element(800));
  elements.set('setup-governance', element(900));
  const view = {
    ResizeObserver: class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe = vi.fn();
      disconnect() {
        disconnect();
        resize = null;
      }
    },
    location: {
      get href() {
        return url.href;
      },
      get pathname() {
        return url.pathname;
      },
      get search() {
        return url.search;
      },
      get hash() {
        return url.hash;
      },
    },
    history: {
      state,
      pushState: vi.fn((received, _title, href) => {
        expect(received).toBe(state);
        url = new URL(href, url);
        history.push(url.href);
      }),
    },
    innerHeight: 800,
    scrollTo: vi.fn(),
    requestAnimationFrame: vi.fn((cb: () => void) => {
      const id = ++nextFrame;
      frames.set(id, cb);
      return id;
    }),
    cancelAnimationFrame: vi.fn((id: number) => frames.delete(id)),
    addEventListener(name: string, cb: () => void) {
      if (!callbacks.has(name)) callbacks.set(name, new Set());
      callbacks.get(name)!.add(cb);
    },
    removeEventListener(name: string, cb: () => void) {
      callbacks.get(name)?.delete(cb);
    },
  };
  const doc = { body: {}, getElementById: (id: string) => elements.get(id) ?? null };
  const mount = () =>
    createSettingsNavigation(view as unknown as Window, doc as unknown as Document, {}, current);
  const replay = (href: string, event = 'popstate') => {
    url = new URL(href, url);
    callbacks.get(event)?.forEach((cb) => cb());
  };
  return {
    view,
    elements,
    current,
    mount,
    replay,
    history,
    callbacks,
    flushFrames,
    frames,
    resize: () => resize?.(),
    disconnect,
  };
}

describe('settings browser navigation', () => {
  it.each(['wheel', 'touchstart', 'pointerdown', 'keydown'])(
    'restores late asynchronous layout shifts but stops after %s control',
    (event) => {
      const h = harness('http://localhost/settings?tenant=alpha#setup-services');
      const nav = h.mount();
      const target = h.elements.get('setup-services')!;
      expect(target.scrollIntoView).toHaveBeenCalledOnce();
      target.top += 200;
      h.resize();
      expect(target.scrollIntoView).toHaveBeenCalledTimes(2);
      h.callbacks.get(event)?.forEach((cb) => cb());
      h.resize();
      expect(target.scrollIntoView).toHaveBeenCalledTimes(2);
      expect(h.disconnect).toHaveBeenCalledOnce();
      nav.dispose();
    }
  );
  it('rearms layout tracking for history targets and disconnects it on empty-hash history and disposal', () => {
    const h = harness();
    const nav = h.mount();
    h.replay('/settings?tenant=alpha#setup-services');
    h.resize();
    expect(h.elements.get('setup-services')!.scrollIntoView).toHaveBeenCalledTimes(2);
    h.replay('/settings?tenant=alpha');
    h.resize();
    expect(h.elements.get('setup-services')!.scrollIntoView).toHaveBeenCalledTimes(2);
    nav.navigate('#settings-display');
    nav.dispose();
    h.resize();
    expect(h.disconnect).toHaveBeenCalledTimes(2);
  });

  it('coalesces scroll frames, recomputes all positions repeatedly, and cancels after disposal', () => {
    const h = harness();
    const nav = h.mount();
    expect(h.current).toHaveBeenLastCalledWith('display');
    h.elements.get('setup-services')!.top = 10;
    h.callbacks.get('scroll')?.forEach((cb) => cb());
    h.callbacks.get('scroll')?.forEach((cb) => cb());
    expect(h.frames.size).toBe(1);
    h.flushFrames();
    expect(h.current).toHaveBeenLastCalledWith('services');
    h.elements.get('setup-services')!.top = 800;
    h.callbacks.get('scroll')?.forEach((cb) => cb());
    h.flushFrames();
    expect(h.current).toHaveBeenLastCalledWith('display');
    h.callbacks.get('scroll')?.forEach((cb) => cb());
    nav.dispose();
    expect(h.frames.size).toBe(0);
    expect(h.view.cancelAnimationFrame).toHaveBeenCalledOnce();
  });

  it('resolves only known section and legacy subsection anchors', () => {
    expect(resolveSettingsTarget('#settings-display')).toEqual({
      id: 'settings-display',
      section: 'display',
    });
    expect(resolveSettingsTarget('#setup-governance')?.section).toBe('advanced');
    expect(resolveSettingsTarget('#%E0%A4%A')).toBeNull();
    expect(resolveSettingsTarget('#unknown')).toBeNull();
    expect(resolveSettingsTarget('https://example.com')).toBeNull();
  });
  it('selects current viewport positions including nested Display rather than observer callback subsets', () => {
    expect(
      visibleSettingsSection(
        [
          { section: 'profile', top: -500 },
          { section: 'display', top: 0 },
          { section: 'services', top: 700 },
        ],
        120
      )
    ).toBe('display');
    expect(
      visibleSettingsSection(
        [
          { section: 'services', top: -100 },
          { section: 'display', top: -600 },
        ],
        120
      )
    ).toBe('services');
  });
  it('restores an initial deep link only after targets are mounted without pushing history or taking focus', () => {
    const h = harness('http://localhost/settings?tenant=alpha#settings-display');
    h.mount();
    expect(h.elements.get('settings-display')!.scrollIntoView).toHaveBeenCalledOnce();
    expect(h.current).toHaveBeenLastCalledWith('display');
    expect(h.elements.get('settings-display')!.focus).not.toHaveBeenCalled();
    expect(h.view.history.pushState).not.toHaveBeenCalled();
  });
  it('preserves query and Next state, avoids duplicate history, and replays Back Forward', () => {
    const h = harness();
    const nav = h.mount();
    nav.navigate('#settings-display');
    nav.navigate('#setup-services');
    nav.navigate('#setup-services');
    expect(h.history).toEqual([
      'http://localhost/settings?tenant=alpha',
      'http://localhost/settings?tenant=alpha#settings-display',
      'http://localhost/settings?tenant=alpha#setup-services',
    ]);
    expect(h.elements.get('setup-services')!.focus).toHaveBeenCalledWith({ preventScroll: true });
    h.replay(h.history[1]);
    expect(h.current).toHaveBeenLastCalledWith('display');
    h.replay(h.history[2]);
    expect(h.current).toHaveBeenLastCalledWith('services');
    h.replay(h.history[0]);
    expect(h.view.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'auto' });
    expect(h.view.history.pushState).toHaveBeenCalledTimes(2);
    nav.dispose();
    expect([...h.callbacks.values()].every((set) => set.size === 0)).toBe(true);
  });
  it('reveals legacy advanced subsections and ignores malformed or unknown links', () => {
    const h = harness();
    const target = h.elements.get('setup-governance')!;
    target.details = { open: false, parentElement: null };
    const nav = h.mount();
    nav.navigate('#setup-governance');
    expect(target.details.open).toBe(true);
    expect(h.current).toHaveBeenLastCalledWith('advanced');
    const count = h.view.history.pushState.mock.calls.length;
    nav.navigate('#bad');
    h.replay('/settings#%E0%A4%A', 'hashchange');
    expect(h.view.history.pushState).toHaveBeenCalledTimes(count);
  });
  it('does not add history during passive viewport updates or duplicate hash and popstate replay', () => {
    const h = harness();
    h.mount();
    h.callbacks.get('scroll')?.forEach((cb) => cb());
    h.flushFrames();
    expect(h.current).toHaveBeenLastCalledWith('display');
    h.replay('/settings?tenant=alpha#settings-display');
    h.replay('/settings?tenant=alpha#settings-display', 'hashchange');
    expect(h.elements.get('settings-display')!.scrollIntoView).toHaveBeenCalledOnce();
    expect(h.view.history.pushState).not.toHaveBeenCalled();
  });
});
