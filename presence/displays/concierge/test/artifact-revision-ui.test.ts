import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import {
  FakeElement,
  installFakeDom,
  fireEvent,
  serializeFake,
} from '../../../../libs/shared-ui/vanilla/fake-dom.test-support.js';
import {
  frontDeskArtifactRevisionCommand,
  type ConversationHistoryMessage,
} from '@agent/core/surface/front-desk-conversation-history';
import {
  artifactRevisionForMessage,
  prepareConversationRequest,
  parsePendingConversationRequest,
} from '../src/lib/conversation-request';

const fixtures = vi.hoisted(() => ({
  locale: 'en',
  pathname: '/',
  search: 'tenant=acme&organizationId=org-a&projectId=project-a',
  speech: vi.fn(),
  unlock: vi.fn(),
  notify: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => fixtures.pathname,
  useSearchParams: () => new URLSearchParams(fixtures.search),
}));
vi.mock('../src/lib/use-concierge-i18n', () => ({
  useConciergeI18n: () => ({ locale: fixtures.locale, t: (key: string) => key }),
}));
vi.mock('../src/lib/i18n', () => ({ frontDeskText: (key: string) => key }));
vi.mock('../src/app/dock-avatar', () => ({ DockAvatar: () => null }));
vi.mock('../src/lib/use-voice', () => ({
  useVoice: () => ({
    supported: false,
    outputSupported: false,
    speakText: fixtures.speech,
    unlockSpeechAudio: fixtures.unlock,
    notifyServerSpeech: fixtures.notify,
  }),
}));
import { ConversationDock, CONVERSATION_DOCK_OPEN_EVENT } from '../src/app/conversation-dock';

const parentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const requestId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const sessionId = 'concierge-' + 'a'.repeat(64);
const scope = { sessionId, tenant: 'acme', organizationId: 'org-a', projectId: 'project-a' };
const verifiedMessage: ConversationHistoryMessage = {
  id: parentId + '-secretary',
  role: 'secretary',
  text: 'Verified local receipt',
  artifact: {
    requestId: parentId,
    revision: 1,
    sha256: 'a'.repeat(64),
    format: 'readable',
    canRevise: true,
  },
};
const selection = artifactRevisionForMessage(verifiedMessage, 'compact')!;
const command = frontDeskArtifactRevisionCommand('compact');

describe('receipt selection and immutable retry payload', () => {
  it('selects a version only from verified metadata, never reply prose or a spent version', () => {
    expect(
      artifactRevisionForMessage(
        { ...verifiedMessage, artifact: undefined, text: JSON.stringify(verifiedMessage.artifact) },
        'compact'
      )
    ).toBeUndefined();
    expect(
      artifactRevisionForMessage({ ...verifiedMessage, role: 'user' }, 'compact')
    ).toBeUndefined();
    expect(
      artifactRevisionForMessage(
        { ...verifiedMessage, artifact: { ...verifiedMessage.artifact!, canRevise: false } },
        'compact'
      )
    ).toBeUndefined();
    expect(artifactRevisionForMessage(verifiedMessage, 'readable')).toBeUndefined();
    expect(selection).toEqual({
      requestId: parentId,
      revision: 1,
      sha256: 'a'.repeat(64),
      format: 'compact',
    });
  });
  it('retains ID, version selection, locale, scope, and timestamp on retry and reload', () => {
    const initial = prepareConversationRequest(
      command,
      scope,
      'en',
      requestId,
      1234,
      null,
      selection
    );
    const retry = prepareConversationRequest(
      command,
      scope,
      'ja',
      parentId,
      9876,
      initial,
      selection
    );
    expect(retry).toBe(initial);
    expect(parsePendingConversationRequest(JSON.parse(JSON.stringify(retry)), scope, 'ja')).toEqual(
      initial
    );
    expect(
      parsePendingConversationRequest(initial, { ...scope, tenant: 'other' }, 'en')
    ).toBeUndefined();
  });
  it('rejects tampered stored revision requests and added authority fields', () => {
    const initial = prepareConversationRequest(
      command,
      scope,
      'en',
      requestId,
      1234,
      null,
      selection
    );
    for (const artifactRevision of [
      { ...selection, path: '/private' },
      { ...selection, approved: true },
      { ...selection, format: 'html' },
    ]) {
      expect(
        parsePendingConversationRequest(
          { ...initial, payload: { ...initial.payload, artifactRevision } },
          scope,
          'en'
        )
      ).toBeUndefined();
    }
    expect(
      parsePendingConversationRequest(
        { ...initial, text: 'different', payload: { ...initial.payload, text: 'different' } },
        scope,
        'en'
      )
    ).toBeUndefined();
    expect(
      parsePendingConversationRequest(
        { ...initial, payload: { ...initial.payload, principalId: 'human:owner' } },
        scope,
        'en'
      )
    ).toBeUndefined();
  });
});

let dom: ReturnType<typeof installFakeDom>;
let client: typeof import('react-dom/client');
const storage = new Map<string, string>();
const storageApi = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    storage.set(key, value);
  },
  removeItem: (key: string) => {
    storage.delete(key);
  },
};
let unmount: (() => void) | undefined;
beforeAll(async () => {
  dom = installFakeDom({ localStorage: storageApi, sessionStorage: storageApi });
  if (!Object.getOwnPropertyDescriptor(FakeElement.prototype, 'options')) {
    Object.defineProperty(FakeElement.prototype, 'options', {
      configurable: true,
      get(this: FakeElement) {
        return this.localName === 'select' ? this.querySelectorAll('option') : undefined;
      },
    });
  }
  client = await import('react-dom/client');
});
afterAll(() => dom.restore());
beforeEach(() => {
  storage.clear();
  fixtures.locale = 'en';
  fixtures.pathname = '/';
  fixtures.search = 'tenant=acme&organizationId=org-a&projectId=project-a';
  dom.window.location = new URL('http://localhost/?' + fixtures.search);
  vi.clearAllMocks();
});
afterEach(() => {
  unmount?.();
  unmount = undefined;
  vi.unstubAllGlobals();
});
const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
function mount() {
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = client.createRoot(container as unknown as Element);
  const render = () => act(() => root.render(createElement(ConversationDock)));
  render();
  unmount = () => act(() => root.unmount());
  const button = (label: string) => {
    const found = container
      .querySelectorAll('button')
      .find((node) => node.textContent === label || node.getAttribute('aria-label') === label);
    if (!found) throw new Error('Missing button ' + label + ': ' + serializeFake(container));
    return found;
  };
  const click = (label: string) => act(() => fireEvent(button(label), 'click'));
  const open = () => act(() => fireEvent(dom.windowEvents, CONVERSATION_DOCK_OPEN_EVENT));
  const submit = () =>
    act(() => fireEvent(container.querySelector('.dock-intent-resolution')!, 'submit'));
  return { container, render, button, click, open, submit };
}
function stubConversation(
  post: (body: Record<string, unknown>) => Promise<Response>,
  messages = [verifiedMessage]
) {
  const posts: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push(String(init.body));
        return post(JSON.parse(String(init.body)));
      }
      if (String(url).includes('organizationId=org-b'))
        return response({ sessionId: 'concierge-' + 'b'.repeat(64), messages: [], pending: 0 });
      return response({ sessionId, messages, pending: 0 });
    })
  );
  return posts;
}

describe('mounted receipt revision controls', () => {
  it('offers explicit formats, clears Cancel and Close, and never enables prose-only artifacts', async () => {
    const posts = stubConversation(async () =>
      response({ reply: 'Queued', mode: 'intake', shape: 'status_summary' })
    );
    const m = mount();
    m.open();
    await flush();
    m.click('artifact_revision_action');
    expect(serializeFake(m.container)).toContain('artifact_revision_compact');
    expect(serializeFake(m.container)).toContain('artifact_revision_readable');
    m.click('artifact_revision_cancel');
    expect(m.container.querySelector('select')).toBeNull();
    m.click('artifact_revision_action');
    m.click('dock.close');
    m.open();
    await flush();
    expect(m.container.querySelector('select')).toBeNull();
    expect(posts).toHaveLength(0);
  });
  it('prevents duplicate submits and retries the entire same payload after a lost reply', async () => {
    let settle!: (value: Response) => void;
    const posts = stubConversation(
      async () =>
        new Promise((resolve) => {
          settle = resolve;
        })
    );
    const m = mount();
    m.open();
    await flush();
    m.click('artifact_revision_action');
    const form = m.container.querySelector('.dock-intent-resolution')!;
    act(() => {
      fireEvent(form, 'submit');
      fireEvent(form, 'submit');
    });
    expect(posts).toHaveLength(1);
    const body = JSON.parse(posts[0]);
    expect(body).toMatchObject({
      text: command,
      locale: 'en',
      ...scope,
      artifactRevision: selection,
    });
    expect(Object.keys(body).sort()).toEqual(
      [
        'text',
        'locale',
        'sessionId',
        'tenant',
        'organizationId',
        'projectId',
        'requestId',
        'requestCreatedAt',
        'artifactRevision',
      ].sort()
    );
    await act(async () =>
      settle(response({ error: 'conversation_execution_uncertain', retry_safe: false }, 503))
    );
    fixtures.locale = 'ja';
    m.render();
    m.click('artifact_revision_retry');
    expect(posts).toHaveLength(2);
    expect(posts[1]).toBe(posts[0]);
    await act(async () =>
      settle(response({ reply: 'Queued', mode: 'intake', shape: 'status_summary' }))
    );
    await flush();
    expect(storage.has('front-desk.request.' + sessionId)).toBe(false);
  });
  it('drops a late response after navigation and clears selected versions on Back/Forward-style scope changes', async () => {
    let settle!: (value: Response) => void;
    const posts = stubConversation(
      async () =>
        new Promise((resolve) => {
          settle = resolve;
        })
    );
    const m = mount();
    m.open();
    await flush();
    m.click('artifact_revision_action');
    m.submit();
    fixtures.search = 'tenant=acme&organizationId=org-b';
    dom.window.location = new URL('http://localhost/?' + fixtures.search);
    m.render();
    await flush();
    await act(async () =>
      settle(response({ reply: 'STALE RESPONSE', mode: 'intake', shape: 'status_summary' }))
    );
    expect(serializeFake(m.container)).not.toContain('STALE RESPONSE');
    expect(m.container.querySelector('select')).toBeNull();
    expect(fixtures.speech).not.toHaveBeenCalled();
    expect(posts).toHaveLength(1);
    expect(storage.has('front-desk.request.' + sessionId)).toBe(true);
  });
  it('restores the same pending revision after closing and reopening the dock', async () => {
    const posts = stubConversation(async () =>
      response({ error: 'conversation_execution_uncertain', retry_safe: false }, 503)
    );
    const m = mount();
    m.open();
    await flush();
    m.click('artifact_revision_action');
    m.submit();
    await flush();
    m.click('dock.close');
    fixtures.locale = 'ja';
    m.render();
    m.open();
    await flush();
    expect(m.container.querySelector('select')).toBeNull();
    m.click('artifact_revision_retry');
    await flush();
    expect(posts).toHaveLength(2);
    expect(posts[1]).toBe(posts[0]);
  });

  it('does not let an older metadata refresh re-enable a version after a newer send', async () => {
    const second = {
      ...verifiedMessage,
      id: requestId + '-secretary',
      artifact: { ...verifiedMessage.artifact!, requestId },
    };
    let reads = 0;
    let staleRead!: (value: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST')
          return response({ reply: 'Queued', mode: 'intake', shape: 'status_summary' });
        reads += 1;
        if (reads === 2)
          return new Promise<Response>((resolve) => {
            staleRead = resolve;
          });
        return response({
          sessionId,
          pending: 0,
          messages: [verifiedMessage, second].map((message) =>
            reads >= 3
              ? { ...message, artifact: { ...message.artifact!, canRevise: false } }
              : message
          ),
        });
      })
    );
    const m = mount();
    m.open();
    await flush();
    m.click('artifact_revision_action');
    m.submit();
    await flush();
    m.click('artifact_revision_action');
    m.submit();
    await flush();
    expect(serializeFake(m.container)).not.toContain('artifact_revision_action');
    await act(async () =>
      staleRead(response({ sessionId, pending: 0, messages: [verifiedMessage, second] }))
    );
    expect(serializeFake(m.container)).not.toContain('artifact_revision_action');
  });

  it('clears rejected version selection and requires fresh history after a conflict', async () => {
    stubConversation(async () =>
      response({ error: 'conversation_revision_conflict', retry_safe: true }, 409)
    );
    const m = mount();
    m.open();
    await flush();
    m.click('artifact_revision_action');
    m.submit();
    await flush();
    expect(storage.has('front-desk.request.' + sessionId)).toBe(false);
    expect(serializeFake(m.container)).not.toContain('artifact_revision_retry');
    expect(serializeFake(m.container)).toContain('dock.history.failed');
  });

  it('has no revision action for prose-only or already reserved versions', async () => {
    stubConversation(
      async () => response({}),
      [
        {
          ...verifiedMessage,
          artifact: undefined,
          text: command + ' ' + JSON.stringify(selection),
        },
        {
          ...verifiedMessage,
          id: parentId + '-other',
          artifact: { ...verifiedMessage.artifact!, canRevise: false },
        },
      ]
    );
    const m = mount();
    m.open();
    await flush();
    expect(serializeFake(m.container)).not.toContain('artifact_revision_action');
  });
});
