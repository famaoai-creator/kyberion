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
  voiceSupported: false,
  voiceTier: 0,
  listenOnce: vi.fn(),
  startListening: vi.fn(),
  stopListening: vi.fn(),
  resetPlayback: vi.fn(),
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
    supported: fixtures.voiceSupported,
    outputSupported: false,
    tier: fixtures.voiceTier,
    listening: false,
    speaking: false,
    sttBackends: [],
    inputDevices: [],
    listenOnce: fixtures.listenOnce,
    startListening: fixtures.startListening,
    stopListening: fixtures.stopListening,
    resetPlayback: fixtures.resetPlayback,
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
  fixtures.voiceSupported = false;
  fixtures.voiceTier = 0;
  fixtures.listenOnce.mockReset();
  fixtures.startListening.mockReset();
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
  const input = () => container.querySelector('input')! as FakeElement & { value: string };
  const type = (value: string) =>
    act(() => {
      input().value = value;
      fireEvent(input(), 'input');
    });
  const submitDraft = () =>
    act(() => fireEvent(container.querySelector('.dock-input-row')!, 'submit'));
  return { container, render, button, click, open, submit, input, type, submitDraft };
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
    expect(serializeFake(m.container)).toContain('dock.history.revision_changed');
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
function historyResponse(id = sessionId, pending = 0, messages = [verifiedMessage]) {
  return response({ sessionId: id, pending, messages });
}
const recoveredSessionId = 'concierge-' + 'c'.repeat(64);
const authCases = [
  { status: 401, body: '<html>Sign in</html>', label: 'signin' },
  { status: 401, body: '', label: 'signin' },
  { status: 403, body: '<html>Access denied</html>', label: 'forbidden' },
  { status: 403, body: '', label: 'forbidden' },
];
function expectRecovery(m: ReturnType<typeof mount>, label: string) {
  const html = serializeFake(m.container);
  expect(html).toContain('dock.history.' + label);
  expect(html).not.toContain(verifiedMessage.text);
  expect(html).not.toContain('artifact_revision_action');
  expect(html).not.toContain('artifact_revision_retry');
  expect(m.input().value).toBe('');
  expect(m.input().disabled).toBe(true);
  expect(
    m.container
      .querySelectorAll('button')
      .filter((node) => node.textContent === 'dock.history.retry')
  ).toHaveLength(1);
}

describe('mounted conversation trust recovery', () => {
  for (const stage of ['GET', 'POST', 'metadata'] as const) {
    it.each(authCases)(
      stage + ' withdraws stale state on $status with body "$body" before JSON parsing',
      async ({ status, body, label }) => {
        const denial = new Response(body, { status, headers: { 'content-type': 'text/html' } });
        const parseDenied = vi.spyOn(denial, 'json');
        let reads = 0;
        const posts: string[] = [];
        vi.stubGlobal(
          'fetch',
          vi.fn(async (_url: string, init?: RequestInit) => {
            if (init?.method === 'POST') {
              posts.push(String(init.body));
              return stage === 'POST'
                ? denial
                : response({ reply: 'Fresh result', mode: 'intake', shape: 'status_summary' });
            }
            reads += 1;
            return reads === 2 && stage !== 'POST' ? denial : historyResponse();
          })
        );
        storage.set('front-desk.draft.' + sessionId, 'Retained safe draft');
        const m = mount();
        m.open();
        await flush();
        expect(serializeFake(m.container)).toContain(verifiedMessage.text);
        const previousPlaybackResets = fixtures.resetPlayback.mock.calls.length;
        if (stage === 'GET') {
          m.click('dock.close');
          m.open();
        } else {
          m.submitDraft();
        }
        await flush();
        expectRecovery(m, label);
        expect(fixtures.resetPlayback.mock.calls.length).toBeGreaterThan(previousPlaybackResets);
        expect(parseDenied).not.toHaveBeenCalled();
        const login = m.container
          .querySelectorAll('a')
          .find((node) => node.textContent === 'dock.history.signin_action');
        if (status === 401)
          expect(login?.getAttribute('href')).toBe(
            '/login?next=' + encodeURIComponent('/?' + fixtures.search)
          );
        else expect(login).toBeUndefined();
        const postCount = posts.length;
        m.click('dock.history.retry');
        await flush();
        expect(posts).toHaveLength(postCount);
        expect(serializeFake(m.container)).toContain(verifiedMessage.text);
        expect(m.input().disabled).toBe(false);
        if (stage !== 'metadata') expect(m.input().value).toBe('Retained safe draft');
      }
    );
  }

  it('hides old receipt actions, selected revisions, and drafts throughout a delayed reopen GET', async () => {
    const pendingHistory = deferred<Response>();
    let reads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => (++reads === 1 ? historyResponse() : pendingHistory.promise))
    );
    const m = mount();
    m.open();
    await flush();
    m.type('Private retained draft');
    m.click('artifact_revision_action');
    m.click('dock.close');
    m.open();
    await flush();
    expect(serializeFake(m.container)).toContain('dock.history.loading');
    expect(serializeFake(m.container)).not.toContain(verifiedMessage.text);
    expect(serializeFake(m.container)).not.toContain('artifact_revision_action');
    expect(m.container.querySelector('select')).toBeNull();
    expect(m.input().value).toBe('');
    expect(m.input().disabled).toBe(true);
    expect(storage.get('front-desk.draft.' + sessionId)).toBe('Private retained draft');
    await act(async () => pendingHistory.resolve(historyResponse()));
    expect(m.input().value).toBe('Private retained draft');
    expect(serializeFake(m.container)).toContain('artifact_revision_action');
    expect(m.container.querySelector('select')).toBeNull();
  });

  it.each([true, false])(
    'restores a draft and immutable request only after verified recovery of the same session: %s',
    async (sameSession) => {
      const pendingHistory = deferred<Response>();
      const posts: string[] = [];
      let reads = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init?: RequestInit) => {
          if (init?.method === 'POST') {
            posts.push(String(init.body));
            return new Response('', { status: 401 });
          }
          return ++reads === 1 ? historyResponse() : pendingHistory.promise;
        })
      );
      storage.set('front-desk.draft.' + sessionId, 'Keep this exact request');
      const m = mount();
      m.open();
      await flush();
      m.submitDraft();
      await flush();
      expectRecovery(m, 'signin');
      const savedRequest = storage.get('front-desk.request.' + sessionId);
      expect(savedRequest).toBeDefined();
      fixtures.locale = 'ja';
      m.render();
      m.click('dock.history.retry');
      await flush();
      expect(m.input().value).toBe('');
      expect(m.input().disabled).toBe(true);
      expect(posts).toHaveLength(1);
      await act(async () =>
        pendingHistory.resolve(historyResponse(sameSession ? sessionId : recoveredSessionId))
      );
      expect(posts).toHaveLength(1);
      expect(storage.get('front-desk.request.' + sessionId)).toBe(savedRequest);
      if (sameSession) {
        expect(m.input().value).toBe('Keep this exact request');
        m.submitDraft();
        await flush();
        expect(posts).toHaveLength(2);
        expect(posts[1]).toBe(posts[0]);
      } else {
        expect(m.input().value).toBe('');
        expect(serializeFake(m.container)).not.toContain('Keep this exact request');
        expect(serializeFake(m.container)).not.toContain('artifact_revision_retry');
      }
    }
  );

  it.each(['intake', 'voice-hub', 'denied'] as const)(
    'discards a late %s POST after history auth loss and recovery without disturbing newer storage',
    async (lateMode) => {
      const oldPost = deferred<Response>();
      const newerPost = deferred<Response>();
      const posts: string[] = [];
      let reads = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init?: RequestInit) => {
          if (init?.method === 'POST') {
            posts.push(String(init.body));
            return posts.length === 1 ? oldPost.promise : newerPost.promise;
          }
          reads += 1;
          if (reads === 1) return historyResponse(sessionId, 1);
          if (reads === 2) return new Response('', { status: 401 });
          return historyResponse(recoveredSessionId, 0, []);
        })
      );
      storage.set('front-desk.draft.' + sessionId, 'Old pending request');
      storage.set('front-desk.draft.' + recoveredSessionId, 'New session request');
      const m = mount();
      m.open();
      await flush();
      m.submitDraft();
      expect(posts).toHaveLength(1);
      m.click('dock.history.retry');
      await flush();
      expectRecovery(m, 'signin');
      m.click('dock.history.retry');
      await flush();
      expect(m.input().value).toBe('New session request');
      m.submitDraft();
      expect(posts).toHaveLength(2);
      const newStorage = storage.get('front-desk.request.' + recoveredSessionId);
      expect(newStorage).toBeDefined();
      await act(async () =>
        oldPost.resolve(
          lateMode === 'denied'
            ? new Response('<html>Denied</html>', { status: 403 })
            : response({ reply: 'OBSOLETE POST RESULT', mode: lateMode, shape: 'status_summary' })
        )
      );
      expect(serializeFake(m.container)).not.toContain('OBSOLETE POST RESULT');
      expect(serializeFake(m.container)).not.toContain('dock.history.forbidden');
      expect(serializeFake(m.container)).toContain('New session request');
      expect(m.container.querySelector('.dock-busy')).not.toBeNull();
      expect(m.button('dock.send').disabled).toBe(true);
      expect(storage.get('front-desk.request.' + recoveredSessionId)).toBe(newStorage);
      expect(storage.get('front-desk.draft.' + recoveredSessionId)).toBe('New session request');
      expect(storage.has('front-desk.request.' + sessionId)).toBe(true);
      expect(fixtures.speech).not.toHaveBeenCalled();
      expect(fixtures.notify).not.toHaveBeenCalled();
      await act(async () =>
        newerPost.resolve(
          response({ error: 'conversation_execution_uncertain', retry_safe: false }, 503)
        )
      );
    }
  );

  it.each([401, 403])(
    'ignores an obsolete metadata %s after a newer main history verification',
    async (status) => {
      const staleMetadata = deferred<Response>();
      let reads = 0;
      let posts = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init?: RequestInit) => {
          if (init?.method === 'POST') {
            posts += 1;
            return response({ reply: 'Old success', mode: 'intake', shape: 'status_summary' });
          }
          reads += 1;
          if (reads === 1) return historyResponse();
          if (reads === 2) return staleMetadata.promise;
          return historyResponse(recoveredSessionId, 0, []);
        })
      );
      storage.set('front-desk.draft.' + sessionId, 'Old request');
      storage.set('front-desk.draft.' + recoveredSessionId, 'Verified new draft');
      const m = mount();
      m.open();
      await flush();
      m.submitDraft();
      await flush();
      m.click('dock.close');
      m.open();
      await flush();
      expect(m.input().value).toBe('Verified new draft');
      await act(async () => staleMetadata.resolve(new Response('', { status })));
      expect(m.input().value).toBe('Verified new draft');
      expect(m.input().disabled).toBe(false);
      expect(serializeFake(m.container)).not.toContain('dock.history.retry');
      expect(posts).toBe(1);
    }
  );

  it('invalidates current conversation when post-send metadata verifies a different session', async () => {
    let reads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST')
          return response({ reply: 'No longer current', mode: 'intake', shape: 'status_summary' });
        return historyResponse(++reads === 1 ? sessionId : recoveredSessionId);
      })
    );
    storage.set('front-desk.draft.' + sessionId, 'Send once');
    const m = mount();
    m.open();
    await flush();
    m.submitDraft();
    await flush();
    expectRecovery(m, 'scope_changed');
    expect(serializeFake(m.container)).not.toContain('No longer current');
  });

  it('keeps a scope-conflict draft inert rather than carrying it into a newly verified session', async () => {
    let reads = 0;
    const posts: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          posts.push(String(init.body));
          return response({ error: 'conversation_scope_changed', retry_safe: true }, 409);
        }
        return historyResponse(++reads === 1 ? sessionId : recoveredSessionId);
      })
    );
    storage.set('front-desk.draft.' + sessionId, 'Old scope draft');
    const m = mount();
    m.open();
    await flush();
    m.submitDraft();
    await flush();
    expectRecovery(m, 'scope_changed');
    m.click('dock.history.retry');
    await flush();
    expect(posts).toHaveLength(1);
    expect(m.input().value).toBe('');
    expect(serializeFake(m.container)).not.toContain('Old scope draft');
    expect(storage.get('front-desk.draft.' + sessionId)).toBe('Old scope draft');
    expect(storage.has('front-desk.request.' + sessionId)).toBe(true);
    expect(storage.has('front-desk.request.' + recoveredSessionId)).toBe(false);
  });
});

describe('mounted voice recovery boundaries', () => {
  it.each([401, 403])(
    'routes voice-hub listen_failed_%s to distinct history recovery',
    async (status) => {
      fixtures.voiceSupported = true;
      fixtures.voiceTier = 1;
      fixtures.listenOnce.mockResolvedValue({ ok: false, error: 'listen_failed_' + status });
      const posts = stubConversation(async () => response({}));
      const m = mount();
      m.open();
      await flush();
      m.click('dock.voice.mic_start');
      await flush();
      expectRecovery(m, status === 401 ? 'signin' : 'forbidden');
      expect(posts).toHaveLength(0);
      expect(fixtures.stopListening).toHaveBeenCalled();
      m.click('dock.history.retry');
      await flush();
      expect(posts).toHaveLength(0);
      expect(fixtures.listenOnce).toHaveBeenCalledTimes(1);
      expect(m.input().disabled).toBe(false);
    }
  );

  it('rejects a late voice-hub result and invalidates its speech-indicator callback after close/reopen', async () => {
    fixtures.voiceSupported = true;
    fixtures.voiceTier = 1;
    const pendingVoice = deferred<{
      ok: boolean;
      stt: { text: string };
      replyText: string;
      spoken: boolean;
    }>();
    fixtures.listenOnce.mockReturnValue(pendingVoice.promise);
    const posts = stubConversation(async () => response({}));
    const m = mount();
    m.open();
    await flush();
    m.click('dock.voice.mic_start');
    const current = fixtures.listenOnce.mock.calls[0][0] as () => boolean;
    expect(current()).toBe(true);
    m.click('dock.close');
    m.open();
    await flush();
    expect(current()).toBe(false);
    await act(async () =>
      pendingVoice.resolve({
        ok: true,
        stt: { text: 'Obsolete transcript' },
        replyText: 'Obsolete spoken reply',
        spoken: true,
      })
    );
    expect(serializeFake(m.container)).not.toContain('Obsolete');
    expect(serializeFake(m.container)).not.toContain('dock.history.unsaved');
    expect(m.input().disabled).toBe(false);
    expect(fixtures.speech).not.toHaveBeenCalled();
    expect(fixtures.notify).not.toHaveBeenCalled();
    expect(posts).toHaveLength(0);
  });

  it('ignores interim and final browser recognition callbacks from a previous verified conversation', async () => {
    fixtures.voiceSupported = true;
    const posts = stubConversation(async () => response({}));
    const m = mount();
    m.open();
    await flush();
    m.click('dock.voice.mic_start');
    const [final, interim] = fixtures.startListening.mock.calls[0] as [
      (text: string) => void,
      (text: string) => void,
    ];
    act(() => interim('Current transcript'));
    expect(m.input().value).toBe('Current transcript');
    m.click('dock.close');
    m.open();
    await flush();
    act(() => {
      interim('Obsolete interim');
      final('Obsolete final');
    });
    expect(m.input().value).toBe('');
    expect(serializeFake(m.container)).not.toContain('Obsolete');
    expect(storage.get('front-desk.draft.' + sessionId)).not.toBe('Obsolete final');
    expect(posts).toHaveLength(0);
    expect(fixtures.stopListening).toHaveBeenCalled();
  });
});

it('invalidates browser voice callbacks immediately on navigation, before React applies its reset effect', async () => {
  fixtures.voiceSupported = true;
  const posts = stubConversation(async () => response({}));
  const m = mount();
  m.open();
  await flush();
  m.click('dock.voice.mic_start');
  const [final, interim] = fixtures.startListening.mock.calls[0] as [
    (text: string) => void,
    (text: string) => void,
  ];
  fixtures.search = 'tenant=acme&organizationId=org-b';
  dom.window.location = new URL('http://localhost/?' + fixtures.search);
  act(() => {
    interim('Previous scope interim');
    final('Previous scope final');
  });
  expect(m.input().value).toBe('');
  expect(posts).toHaveLength(0);
  expect(storage.has('front-desk.draft.' + sessionId)).toBe(false);
  m.render();
  await flush();
  expect(serializeFake(m.container)).not.toContain('Previous scope');
});

it.each([false, true])(
  'reconciles a completed saved request while retaining only a newer edited draft: %s',
  async (edited) => {
    const text = 'Previously submitted request';
    const saved = prepareConversationRequest(text, scope, 'en', requestId, 1234, null);
    const draft = edited ? 'A newer draft I have not sent' : text;
    storage.set('front-desk.request.' + sessionId, JSON.stringify(saved));
    storage.set('front-desk.draft.' + sessionId, draft);
    const posts = stubConversation(
      async () => response({}),
      [
        verifiedMessage,
        {
          id: requestId + '-secretary',
          role: 'secretary',
          text: 'Confirmed completed answer',
        },
      ]
    );
    const m = mount();
    m.open();
    await flush();
    expect(serializeFake(m.container)).toContain('Confirmed completed answer');
    expect(storage.has('front-desk.request.' + sessionId)).toBe(false);
    expect(posts).toHaveLength(0);
    expect(m.input().value).toBe(edited ? draft : '');
    expect(m.button('dock.send').disabled).toBe(!edited);
    if (edited) expect(storage.get('front-desk.draft.' + sessionId)).toBe(draft);
    else {
      expect(storage.has('front-desk.draft.' + sessionId)).toBe(false);
      m.submitDraft();
      expect(posts).toHaveLength(0);
    }
  }
);

it.each(['getItem', 'removeItem'] as const)(
  'retains completion correlation when draft cleanup %s fails, then completes cleanup on GET-only retry',
  async (operation) => {
    const text = 'A submitted request whose reply was lost';
    const saved = prepareConversationRequest(text, scope, 'en', requestId, 1234, null);
    const requestKey = 'front-desk.request.' + sessionId;
    const draftKey = 'front-desk.draft.' + sessionId;
    const serializedRequest = JSON.stringify(saved);
    storage.set(requestKey, serializedRequest);
    storage.set(draftKey, text);
    const posts = stubConversation(
      async () => response({}),
      [
        {
          id: requestId + '-secretary',
          role: 'secretary',
          text: 'Recovered completed result',
        },
      ]
    );
    let failed = false;
    const failOnce = (key: string) => {
      if (key === draftKey && !failed) {
        failed = true;
        throw new Error('Simulated unavailable session storage');
      }
    };
    const interruption =
      operation === 'getItem'
        ? vi.spyOn(storageApi, 'getItem').mockImplementation((key) => {
            failOnce(key);
            return storage.get(key) ?? null;
          })
        : vi.spyOn(storageApi, 'removeItem').mockImplementation((key) => {
            failOnce(key);
            storage.delete(key);
          });
    try {
      const m = mount();
      m.open();
      await flush();
      expect(failed).toBe(true);
      expect(storage.get(requestKey)).toBe(serializedRequest);
      expect(storage.get(draftKey)).toBe(text);
      expect(serializeFake(m.container)).toContain('conversation_storage_required');
      expect(m.input().value).toBe('');
      expect(m.button('dock.send').disabled).toBe(true);
      expect(posts).toHaveLength(0);
      m.click('dock.history.retry');
      await flush();
      expect(storage.has(requestKey)).toBe(false);
      expect(storage.has(draftKey)).toBe(false);
      expect(m.input().value).toBe('');
      expect(m.button('dock.send').disabled).toBe(true);
      expect(serializeFake(m.container)).not.toContain('conversation_storage_required');
      expect(serializeFake(m.container)).toContain('Recovered completed result');
      m.submitDraft();
      expect(posts).toHaveLength(0);
    } finally {
      interruption.mockRestore();
    }
  }
);
