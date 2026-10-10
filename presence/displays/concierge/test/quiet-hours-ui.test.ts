import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, createElement, StrictMode } from 'react';
import {
  FakeElement,
  FakeOptionElement,
  installFakeDom,
  fireEvent,
} from '../../../../libs/shared-ui/vanilla/fake-dom.test-support.js';
import { QuietHoursPane } from '../src/app/settings/sections/QuietHoursPane';
import { conciergeText } from '../src/lib/i18n';
import { storeFrontDeskToken } from '../src/lib/front-desk-auth-token';
const saved = {
  quiet_hours: { start: '22:00', end: '07:00', timezone: 'Asia/Tokyo' },
  urgent_events: ['ops_alert', 'approval_required'],
};
const json = (preferences: unknown = saved, status = 200) =>
  new Response(JSON.stringify({ ok: true, preferences }), { status });
const invalid = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
let dom: ReturnType<typeof installFakeDom>;
let client: typeof import('react-dom/client');
let cleanup: (() => void) | undefined;
let token: string | null = null;
const originalSelected = Object.getOwnPropertyDescriptor(FakeOptionElement.prototype, 'selected')!;
beforeAll(async () => {
  dom = installFakeDom({
    sessionStorage: {
      getItem: () => token,
      setItem: (_key: string, value: string) => {
        token = value;
      },
      removeItem: () => {
        token = null;
      },
    },
  });
  // React sets only the selected option; browsers clear its siblings automatically.
  Object.defineProperty(FakeOptionElement.prototype, 'selected', {
    ...originalSelected,
    set(this: FakeOptionElement, value: boolean) {
      if (value && this.parentNode instanceof FakeElement) {
        for (const option of this.parentNode.children) {
          if (option !== this && option instanceof FakeOptionElement)
            originalSelected.set!.call(option, false);
        }
      }
      originalSelected.set!.call(this, value);
    },
  });
  client = await import('react-dom/client');
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  token = null;
  vi.unstubAllGlobals();
});
afterAll(() => {
  Object.defineProperty(FakeOptionElement.prototype, 'selected', originalSelected);
  dom.restore();
});
const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
const enabled = (el: FakeElement | undefined) => !!el && !el.hasAttribute('disabled');
function mount(
  read: () => Promise<Response> = async () => json(),
  write: (body: typeof saved) => Promise<Response> = async (body) => json(body),
  strict = false
) {
  const posts: (typeof saved)[] = [];
  const signals: AbortSignal[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('/api/notification-preferences');
      if (init?.signal) signals.push(init.signal);
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as typeof saved;
        posts.push(body);
        return write(body);
      }
      return read();
    })
  );
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = client.createRoot(container as unknown as Element);
  const pane = createElement(QuietHoursPane, { t: (key) => conciergeText(key, 'en') });
  act(() => root.render(strict ? createElement(StrictMode, null, pane) : pane));
  const unmount = () => act(() => root.unmount());
  cleanup = unmount;
  const button = (text = 'Save quiet hours') =>
    [...container.querySelectorAll('button')].find((el) => el.textContent === text);
  const field = (name: string) => {
    const result = container.querySelector(`[name="quiet.${name}"]`);
    if (!result) throw Error(`Missing ${name}`);
    return result as FakeElement & { value: string };
  };
  const select = (name: string, value: string) =>
    act(() => {
      const input = field(name);
      Object.assign(input, { value });
      fireEvent(input, 'change');
    });
  const click = async (text = 'Save quiet hours') => {
    const el = button(text);
    if (!el) throw Error(`Missing ${text}`);
    await act(async () => {
      fireEvent(el, 'click');
    });
    await flush();
  };
  return { container, posts, signals, button, field, select, click, unmount };
}
describe('quiet-hours verified read/edit/save', () => {
  it('does not permit default-off saving while the initial read is pending', async () => {
    const pending = deferred<Response>();
    const m = mount(() => pending.promise);
    expect(enabled(m.button())).toBe(false);
    expect(enabled(m.field('enabled'))).toBe(false);
    await m.click();
    expect(m.posts).toHaveLength(0);
    await act(async () => pending.resolve(json()));
    await flush();
    expect(m.field('enabled').value).toBe('on');
    expect(enabled(m.button())).toBe(true);
  });
  it.each(['network', 'http', 'malformed', 'missing-window', 'missing-events'])(
    'requires a successful explicit reload after %s load failure',
    async (mode) => {
      let count = 0;
      const m = mount(async () => {
        if (++count > 1) return json();
        if (mode === 'network') throw Error('offline');
        if (mode === 'http') return json(saved, 503);
        if (mode === 'missing-window') return json({ urgent_events: [] });
        if (mode === 'missing-events') return json({ quiet_hours: null });
        return invalid();
      });
      await flush();
      expect(enabled(m.button())).toBe(false);
      expect(m.container.querySelector('[role="alert"]')).not.toBeNull();
      await m.click();
      expect(m.posts).toHaveLength(0);
      await m.click('Reload saved quiet hours');
      expect(m.field('enabled').value).toBe('on');
      expect(m.field('timezone').value).toBe('Asia/Tokyo');
      expect(enabled(m.button())).toBe(true);
    }
  );
  it('blocks repeated saves and edits during a pending write, then clears success on an edit', async () => {
    const pending = deferred<Response>();
    const m = mount(undefined, () => pending.promise);
    await flush();
    const button = m.button()!;
    act(() => {
      fireEvent(button, 'click');
      fireEvent(button, 'click');
    });
    await flush();
    expect(m.posts).toHaveLength(1);
    expect(m.container.textContent).toContain('Saving quiet hours');
    expect(enabled(m.field('enabled'))).toBe(false);
    await act(async () => pending.resolve(json()));
    await flush();
    expect(m.field('enabled').value).toBe('on');
    expect(m.container.textContent).toContain('Quiet hours saved');
    m.select('enabled', 'off');
    expect(m.container.textContent).not.toContain('Quiet hours saved');
  });
  it.each(['negative', 'malformed', 'mismatch', 'network', 'http'])(
    'does not claim success or automatically retry after %s save response',
    async (mode) => {
      const m = mount(undefined, async () => {
        if (mode === 'network') throw Error('connection lost');
        if (mode === 'http') return json(saved, 503);
        if (mode === 'negative') return new Response('{"ok":false}', { status: 200 });
        if (mode === 'mismatch') return json({ ...saved, quiet_hours: null });
        return invalid();
      });
      await flush();
      await m.click();
      expect(m.posts).toHaveLength(1);
      expect(m.container.textContent).not.toContain('Quiet hours saved');
      expect(enabled(m.button())).toBe(false);
      expect(m.button('Reload saved quiet hours')).toBeDefined();
      await m.click();
      expect(m.posts).toHaveLength(1);
    }
  );
  it('preserves overnight and timezone values through a valid saved receipt', async () => {
    const m = mount();
    await flush();
    await m.click();
    expect(m.posts).toEqual([saved]);
    expect(m.container.textContent).toContain('Quiet hours saved');
  });
  it('preserves an existing custom urgent-event list unless a preset is deliberately chosen', async () => {
    const custom = { ...saved, urgent_events: ['mission_completed'] };
    const m = mount(async () => json(custom));
    await flush();
    expect(m.field('urgent').value).toBe('custom');
    await m.click();
    expect(m.posts[0].urgent_events).toEqual(['mission_completed']);
    m.select('urgent', 'alerts_only');
    await m.click();
    expect(m.posts[1].urgent_events).toEqual(['ops_alert']);
  });
  it('requires a fresh read when the signed-in context changes after loading', async () => {
    const m = mount();
    await flush();
    storeFrontDeskToken('synthetic-new-member');
    await m.click();
    expect(m.posts).toHaveLength(0);
    expect(enabled(m.button())).toBe(false);
    expect(m.button('Reload saved quiet hours')).toBeDefined();
  });
  it('does not accept an old read after sign-in changes', async () => {
    const pending = deferred<Response>();
    const m = mount(() => pending.promise);
    storeFrontDeskToken('synthetic-new-member');
    await act(async () => pending.resolve(json()));
    await flush();
    expect(enabled(m.button())).toBe(false);
    expect(m.container.textContent).not.toContain('Quiet hours saved');
  });
  it('aborts an unmounted read and never applies it to a new pane', async () => {
    const pending = deferred<Response>();
    const first = mount(() => pending.promise);
    first.unmount();
    cleanup = undefined;
    expect(first.signals[0]?.aborted).toBe(true);
    const next = mount(async () => json({ ...saved, quiet_hours: null }));
    await flush();
    await act(async () => pending.resolve(json()));
    await flush();
    expect(next.field('enabled').value).toBe('off');
    expect(next.posts).toHaveLength(0);
  });
});

it('keeps an explicitly rejected draft correctable without claiming a save', async () => {
  let count = 0;
  const m = mount(undefined, async (body) =>
    ++count === 1
      ? new Response(JSON.stringify({ ok: false, error: 'The time zone was rejected.' }), {
          status: 400,
        })
      : json(body)
  );
  await flush();
  await m.click();
  expect(m.container.textContent).toContain('The time zone was rejected.');
  expect(enabled(m.button())).toBe(true);
  expect(m.container.textContent).not.toContain('Quiet hours saved');
  m.select('enabled', 'off');
  await m.click();
  expect(m.posts).toHaveLength(2);
  expect(m.posts[1].quiet_hours).toBeNull();
  expect(m.container.textContent).toContain('Quiet hours saved');
});
it('does not accept a saved response after a sign-in change', async () => {
  const pending = deferred<Response>();
  const m = mount(undefined, () => pending.promise);
  await flush();
  await m.click();
  storeFrontDeskToken('synthetic-other-member');
  await act(async () => pending.resolve(json()));
  await flush();
  expect(m.container.textContent).not.toContain('Quiet hours saved');
  expect(enabled(m.button())).toBe(false);
  expect(m.posts).toHaveLength(1);
});
it('aborts an unmounted write without retrying it', async () => {
  const pending = deferred<Response>();
  const m = mount(undefined, () => pending.promise);
  await flush();
  await m.click();
  m.unmount();
  cleanup = undefined;
  expect(m.signals.at(-1)?.aborted).toBe(true);
  await act(async () => pending.resolve(json()));
  await flush();
  expect(m.posts).toHaveLength(1);
});

it('owns one reload request and bounds both read and write requests', async () => {
  const timeout = vi.spyOn(AbortSignal, 'timeout');
  try {
    let reads = 0;
    const pending = deferred<Response>();
    const m = mount(async () => (++reads === 1 ? invalid() : pending.promise));
    await flush();
    const reload = m.button('Reload saved quiet hours')!;
    act(() => {
      fireEvent(reload, 'click');
      fireEvent(reload, 'click');
    });
    await flush();
    expect(reads).toBe(2);
    expect(enabled(m.button())).toBe(false);
    await act(async () => pending.resolve(json()));
    await flush();
    await m.click();
    expect(m.posts).toHaveLength(1);
    expect(timeout.mock.calls).toEqual([[30_000], [30_000], [30_000]]);
  } finally {
    timeout.mockRestore();
  }
});

it('resets a rejected shared-control echo when reloading the same saved values', async () => {
  const m = mount();
  await flush();
  storeFrontDeskToken('synthetic-changed-session');
  m.select('urgent', 'alerts_only');
  expect(enabled(m.button())).toBe(false);
  await m.click('Reload saved quiet hours');
  expect(m.field('urgent').value).toBe('alerts_approvals');
  await m.click();
  expect(m.posts[0].urgent_events).toEqual(saved.urgent_events);
});

it('ignores the abandoned StrictMode read when a newer read owns the form', async () => {
  let reads = 0;
  const old = deferred<Response>();
  const m = mount(
    async () => (++reads === 1 ? old.promise : json({ ...saved, quiet_hours: null })),
    undefined,
    true
  );
  await flush();
  expect(reads).toBe(2);
  expect(m.signals[0].aborted).toBe(true);
  expect(m.field('enabled').value).toBe('off');
  await act(async () => old.resolve(json()));
  await flush();
  expect(m.field('enabled').value).toBe('off');
  await m.click();
  expect(m.posts[0].quiet_hours).toBeNull();
});
it.each(['read', 'write'])('recovers safely after the %s deadline expires', async (phase) => {
  const deadline = new AbortController();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
  const waitForDeadline = () =>
    new Promise<Response>((_resolve, reject) =>
      deadline.signal.addEventListener(
        'abort',
        () => reject(new DOMException('Deadline expired', 'TimeoutError')),
        { once: true }
      )
    );
  try {
    const m = phase === 'read' ? mount(waitForDeadline) : mount(undefined, waitForDeadline);
    await flush();
    if (phase === 'write') await m.click();
    await act(async () => deadline.abort());
    await flush();
    expect(enabled(m.button())).toBe(false);
    expect(m.button('Reload saved quiet hours')).toBeDefined();
    expect(m.posts).toHaveLength(phase === 'read' ? 0 : 1);
    expect(m.container.textContent).not.toContain('Quiet hours saved');
  } finally {
    timeout.mockRestore();
  }
});
