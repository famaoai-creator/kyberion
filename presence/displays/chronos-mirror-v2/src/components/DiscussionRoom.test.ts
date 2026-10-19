import { act, createElement } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  FakeElement,
  fireEvent,
  installFakeDom,
} from '../../../../../libs/shared-ui/vanilla/fake-dom.test-support.js';
import { DiscussionRoom } from './DiscussionRoom';
import { DISCUSSION_PENDING_PREFIX } from '../lib/discussion-create-recovery';
import { discussionDraftContext, initialDiscussionDraft } from '../lib/discussion-launcher-draft';
import {
  dt,
  createDiscussion,
  fetchDiscussionReadiness,
  fetchDiscussionRequestContext,
} from '../lib/discussion-client';

vi.mock('../lib/hooks', () => ({ useChronosLocale: () => 'en' }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
  usePathname: () => '/',
}));
vi.mock('../lib/discussion-client', async (original) => ({
  ...(await original<typeof import('../lib/discussion-client')>()),
  fetchDiscussionRooms: vi.fn(async () => ({
    ok: true,
    data: {
      accessRole: 'localadmin',
      rooms: [
        {
          id: 'old-room',
          title: 'Previous result',
          status: 'concluded',
          message_count: 0,
          consensus: 1,
          work_item_count: 0,
        },
      ],
    },
  })),
  createDiscussion: vi.fn(),
  fetchDiscussionRequestContext: vi.fn(async () => ({
    ok: true,
    status: 200,
    data: { ok: true, routing: { tenant: 'one', scope_digest: 'a'.repeat(64) } },
  })),
  fetchDiscussionReadiness: vi.fn(async () => ({ ok: false, status: 403, data: null })),
  fetchDiscussionRequest: vi.fn(async () => ({ ok: false, status: 404, data: null })),
  fetchMissionOptions: vi.fn(async () => [
    { missionId: 'MSN-ONE', title: 'One', status: 'active' },
  ]),
  useDiscussionStream: () => ({
    room: null,
    connection: 'ended',
    error: 'Saved result unavailable',
    setRoom: vi.fn(),
  }),
}));

let dom: ReturnType<typeof installFakeDom>;
let client: typeof import('react-dom/client');
let root: ReturnType<(typeof import('react-dom/client'))['createRoot']> | undefined;
let container: FakeElement;
const stored = new Map<string, string>();
const storage = {
  get length() {
    return stored.size;
  },
  key: (i: number) => [...stored.keys()][i] ?? null,
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: vi.fn((key: string, value: string) => {
    stored.set(key, value);
  }),
  removeItem: (key: string) => {
    stored.delete(key);
  },
};
function location(url: string) {
  dom.window.location = new URL(url, 'http://localhost');
}
beforeAll(async () => {
  dom = installFakeDom({
    localStorage: storage,
    crypto: globalThis.crypto,
    history: { pushState: (_state: unknown, _unused: string, url: string) => location(url) },
  });
  Object.defineProperty(FakeElement.prototype, 'options', {
    configurable: true,
    get(this: FakeElement) {
      return this.localName === 'select' ? this.children : undefined;
    },
  });
  client = await import('react-dom/client');
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  stored.clear();
  vi.clearAllMocks();
});
afterAll(() => dom.restore());
async function mount(url = '/?section=discussion&mission=MSN-ONE') {
  location(url);
  container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  root = client.createRoot(container as unknown as Element);
  await act(async () => {
    root!.render(createElement(DiscussionRoom));
  });
}
const q = (selector: string) => {
  const el = container.querySelector(selector);
  if (!el) throw new Error(selector);
  return el;
};
const button = (text: string) => {
  const el = container.querySelectorAll('button').find((el) => el.textContent.includes(text));
  if (!el) throw new Error(text);
  return el;
};
const click = async (el: FakeElement) => {
  await act(async () => {
    fireEvent(el, 'click');
  });
};
const value = (el: FakeElement) => (el as unknown as { value: string }).value;

describe('Discussion launcher navigation', () => {
  it('keeps an edited draft when opening a previous result and returning', async () => {
    await mount();
    await click(q('.dr-examples button'));
    const draft = value(q('textarea'));
    expect(draft.length).toBeGreaterThan(0);
    await click(button('Previous result'));
    expect(container.textContent).toContain('Saved result unavailable');
    await click(button(dt('back', 'en')));
    expect(value(q('textarea'))).toBe(draft);
    expect(value(q('select'))).toBe('MSN-ONE');
    expect(storage.setItem).not.toHaveBeenCalled();
    expect((dom.window.location as URL).href).not.toContain(encodeURIComponent(draft));
  });
});

const select = async (el: FakeElement, next: string) => {
  await act(async () => {
    (el as unknown as { value: string }).value = next;
    fireEvent(el, 'change');
  });
};
async function navigate(url: string, popstate = false) {
  await act(async () => {
    location(url);
    if (popstate) fireEvent(dom.windowEvents, 'popstate');
    root!.render(createElement(DiscussionRoom));
  });
}

describe('Discussion draft boundaries', () => {
  it('retains provider, format, tempo and an edited mission through repeated Back/Forward', async () => {
    await mount();
    await click(q('.dr-examples button'));
    const draft = value(q('textarea'));
    await click(button(dt('modePanel', 'en')));
    await click(button(dt('tempoSlow', 'en')));
    await select(q('.dr-field--inline select'), 'codex');
    await select(q('.dr-mission-field select'), '');
    await click(button('Previous result'));
    for (let i = 0; i < 2; i++) {
      await navigate('/?section=discussion&mission=MSN-ONE', true);
      expect(value(q('textarea'))).toBe(draft);
      expect(value(q('.dr-field--inline select'))).toBe('codex');
      expect(value(q('.dr-mission-field select'))).toBe('');
      expect(button(dt('modePanel', 'en')).getAttribute('aria-checked')).toBe('true');
      expect(button(dt('tempoSlow', 'en')).getAttribute('aria-checked')).toBe('true');
      await navigate('/?section=discussion&mission=MSN-ONE&room=old-room', true);
    }
    expect(createDiscussion).not.toHaveBeenCalled();
  });
  it('rechecks provider readiness instead of carrying a previous report across navigation', async () => {
    await mount();
    await select(q('.dr-field--inline select'), 'codex');
    expect(fetchDiscussionReadiness).toHaveBeenCalledTimes(1);
    await click(button('Previous result'));
    await click(button(dt('back', 'en')));
    expect(value(q('.dr-field--inline select'))).toBe('codex');
    expect(fetchDiscussionReadiness).toHaveBeenCalledTimes(2);
    expect(createDiscussion).not.toHaveBeenCalled();
  });
  it.each(['tenant', 'organization_id', 'project_id', 'mission', 'mission_id', 'goal'])(
    'clears the whole draft on router context change: %s',
    async (key) => {
      const initial = '/?section=discussion&goal=original-secret&mission=MSN-ONE';
      await mount(initial);
      await click(q('.dr-examples button'));
      await click(button(dt('tempoSlow', 'en')));
      const url = new URL(initial, 'http://localhost');
      url.searchParams.set(key, 'changed');
      await navigate(url.href);
      expect(value(q('textarea'))).toBe('');
      expect(value(q('.dr-mission-field select'))).toBe('');
      expect(button(dt('tempoNormal', 'en')).getAttribute('aria-checked')).toBe('true');
      expect(container.textContent).toContain(dt('draftContextChanged', 'en'));
      await navigate(initial, true);
      expect(value(q('textarea'))).toBe('');
      expect(createDiscussion).not.toHaveBeenCalled();
    }
  );
  it('blocks a stale submit when the URL changed before the router render', async () => {
    await mount();
    await click(q('.dr-examples button'));
    expect(value(q('textarea')).length).toBeGreaterThan(0);
    location('/?section=discussion&tenant=other');
    await act(async () => {
      fireEvent(q('form'), 'submit');
    });
    expect(createDiscussion).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(fetchDiscussionRequestContext).not.toHaveBeenCalled();
  });
  it('does not clear an unknown receipt when restoring or discarding a draft', async () => {
    const key = DISCUSSION_PENDING_PREFIX + '11111111-1111-4111-8111-111111111111';
    stored.set(
      key,
      JSON.stringify({
        version: 1,
        request_id: '11111111-1111-4111-8111-111111111111',
        routing: { tenant: 'one', scope_digest: 'a'.repeat(64) },
      })
    );
    await mount();
    await click(q('.dr-examples button'));
    await click(button('Previous result'));
    await click(button(dt('back', 'en')));
    expect(stored.has(key)).toBe(true);
    expect((q('button[type="submit"]') as unknown as { disabled: boolean }).disabled).toBe(true);
    await navigate('/?section=discussion&tenant=two');
    await click(q('.dr-examples button'));
    expect(value(q('textarea')).length).toBeGreaterThan(0);
    expect(stored.has(key)).toBe(true);
    expect((q('button[type="submit"]') as unknown as { disabled: boolean }).disabled).toBe(true);
    await act(async () => {
      fireEvent(q('form'), 'submit');
    });
    expect(fetchDiscussionRequestContext).not.toHaveBeenCalled();
    expect(createDiscussion).not.toHaveBeenCalled();
  });
  it('does not persist the draft after the Discussion view unmounts', async () => {
    await mount('/?section=discussion');
    await click(q('.dr-examples button'));
    act(() => root!.unmount());
    root = undefined;
    await mount('/?section=discussion');
    expect(value(q('textarea'))).toBe('');
    expect(storage.setItem).not.toHaveBeenCalled();
  });
  it('seeds only 2000 characters but fingerprints the entire linked request', () => {
    const a = new URLSearchParams({ goal: 'x'.repeat(2000) + 'one' });
    const b = new URLSearchParams({ goal: 'x'.repeat(2000) + 'two' });
    expect(initialDiscussionDraft(a).goal).toHaveLength(2000);
    expect(discussionDraftContext(a)).not.toBe(discussionDraftContext(b));
    a.set('room', 'room');
    a.set('discussion_readonly', '1');
    expect(discussionDraftContext(a)).toBe(
      discussionDraftContext(new URLSearchParams({ goal: 'x'.repeat(2000) + 'one' }))
    );
  });
});
