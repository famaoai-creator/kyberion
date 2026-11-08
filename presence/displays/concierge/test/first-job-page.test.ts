import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { safeReadFile } from '@agent/core';
import {
  FRONT_DESK_LINKED_DESTINATIONS,
  resolveFrontDeskDestination,
} from '@agent/core/front-desk-nav';

// The guide's state machine (ported from presence-studio's first-job client
// harness, Kyberion server phase 2) against a scripted member API: no real
// browser, so rendered-browser evidence is reported separately.
const api = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; init: RequestInit }>,
  handle: undefined as undefined | ((url: string, init: RequestInit) => Promise<Response>),
}));
vi.mock('../src/lib/front-desk-fetch', () => ({
  frontDeskFetch: (url: string, init: RequestInit = {}) => {
    api.calls.push({ url, init });
    return api.handle!(url, init);
  },
}));

import { FIRST_JOB_STORAGE_KEY, FirstJobGuide } from '../src/app/first-job/first-job-controller';
import FirstJobPage from '../src/app/first-job/page';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) =>
  String(safeReadFile(path.join(appDir, relative), { encoding: 'utf8' }));
const withoutComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gmu, '');

const SESSION = 'concierge-' + 'a'.repeat(64);
const REQUEST = '11111111-1111-4111-8111-111111111111';
const APPROVAL = '22222222-2222-4222-8222-222222222222';
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));
const never = () => new Promise<Response>(() => undefined);

function snapshot(tasks: unknown[] = []) {
  return {
    ok: true,
    readiness: { ready: true, status: 'diagnostic_mapping_ready' },
    scope: { tenant: 'first-job-route', tier: 'public' },
    sessionId: SESSION,
    messages: [],
    pending: 0,
    tasks,
    setup: {
      mapping: { status: 'diagnostic_mapping_ready', owner: 'none', next_action: 'none' },
      oidc: { status: 'configured', owner: 'none', next_action: 'none' },
      browser_user: { status: 'verified', owner: 'none', next_action: 'none' },
      approval_scope: { status: 'ready', owner: 'none', next_action: 'none' },
      advancement: { status: 'not_started', owner: 'none', next_action: 'none' },
    },
  };
}
const approvalsReady = (approvals: unknown[] = []) => ({
  ok: true,
  auth: { status: 'ready', login_href: '/login?next=%2Ffirst-job' },
  readiness: { ready: true, status: 'ready' },
  approvals,
  held_requests: [],
  recovery_requests: [],
});
const card = () => ({
  approval_request_id: APPROVAL,
  request_id: REQUEST,
  revision: 1,
  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  execution_deadline_at: new Date(Date.now() + 1_800_000).toISOString(),
  display_digest: 'b'.repeat(64),
  payload_hash: 'c'.repeat(64),
  effect_binding: 'first-job:' + 'd'.repeat(64),
  receipt_format: 'compact',
  tenant: 'first-job-route',
});

const storage = new Map<string, string>();
let storageThrows = false;
/** Let scripted responses (and their body reads) settle; timers stay fake. */
async function settle() {
  for (let index = 0; index < 10; index += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  storage.clear();
  storageThrows = false;
  api.calls = [];
  const listeners = () => ({ addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('window', {
    ...listeners(),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: number) => clearTimeout(id),
    crypto: { randomUUID: () => REQUEST },
    sessionStorage: {
      getItem: (key: string) => {
        if (storageThrows) throw new Error('blocked');
        return storage.get(key) ?? null;
      },
      setItem: (key: string, value: string) => {
        if (storageThrows) throw new Error('blocked');
        storage.set(key, value);
      },
    },
  });
  vi.stubGlobal('document', { ...listeners(), visibilityState: 'visible', hidden: false });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A mounted guide whose first read is ready with the given tasks and approvals. */
async function readyGuide(tasks: unknown[] = [], approvals: unknown[] = []) {
  api.handle = (url) =>
    url.startsWith('/api/first-job/approvals')
      ? json(approvalsReady(approvals))
      : json(snapshot(tasks));
  const guide = new FirstJobGuide(() => undefined);
  guide.setLocale('en');
  guide.mount();
  await settle();
  return guide;
}
const posts = () => api.calls.filter((call) => call.init.method === 'POST');

describe('初めての仕事 guide state (ported from the Studio client harness)', () => {
  it('reads first, then unlocks the start only when the approval view is ready', async () => {
    const guide = await readyGuide();
    expect(api.calls.map((call) => call.url.split('?')[0])).toEqual([
      '/api/first-job',
      '/api/first-job/approvals',
    ]);
    expect(posts()).toHaveLength(0);
    expect(guide.readinessKey()).toBe('ready');
    expect(guide.statusKey()).toBe('empty');
    expect(guide.canAct()).toBe(true);
    expect(guide.nextKey()).toBe('next_ready');
  });

  it('persists the exact request before sending it, and sends only fixed fields', async () => {
    const guide = await readyGuide();
    let storedAtSend: string | undefined;
    api.handle = (url, init) => {
      if (init.method === 'POST') {
        // Captured when the network effect starts; asserted below.
        storedAtSend = storage.get(FIRST_JOB_STORAGE_KEY);
        return json(snapshot([{ id: REQUEST, turnState: 'pending', executionStatus: 'queued' }]));
      }
      return url.startsWith('/api/first-job/approvals') ? json(approvalsReady()) : json(snapshot());
    };
    await guide.start();
    await settle();
    expect(JSON.parse(storedAtSend!).pending.body.request_id).toBe(REQUEST);
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(String(posts()[0].init.body))).toEqual({
      action: 'start',
      request_id: REQUEST,
      session_id: SESSION,
      locale: 'en',
    });
  });

  it('treats a stalled send as an unknown outcome: no replay, the pending identity kept', async () => {
    const guide = await readyGuide();
    let late: (response: Response) => void = () => undefined;
    api.handle = (url, init) =>
      init.method === 'POST'
        ? new Promise<Response>((resolve) => (late = resolve))
        : url.startsWith('/api/first-job/approvals')
          ? json(approvalsReady())
          : json(snapshot());
    void guide.start();
    // Repeated clicks while sending never create a second request.
    expect(guide.start()).toBeUndefined();
    await settle();
    expect(guide.sending).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000);
    await settle();
    // The original response arriving late cannot settle the unknown outcome.
    late(
      new Response(
        JSON.stringify(snapshot([{ id: REQUEST, artifact: { requestId: REQUEST, revision: 1 } }]))
      )
    );
    await settle();
    expect(guide.sending).toBe(false);
    expect(guide.errorKey).toBe('uncertain');
    expect(guide.pending?.body.request_id).toBe(REQUEST);
    expect(guide.pending?.retrySafe).toBe(false);
    expect(guide.retryDisabled()).toBe(true);
    // A refresh stays available and only reads.
    await guide.load();
    await settle();
    expect(posts()).toHaveLength(1);
    expect(guide.canAct()).toBe(false);
  });

  it('never re-sends a stored request on reload, and only retries a server-confirmed safe one', async () => {
    storage.set(
      FIRST_JOB_STORAGE_KEY,
      JSON.stringify({
        sessionId: SESSION,
        pending: {
          body: { action: 'start', request_id: REQUEST, session_id: SESSION, locale: 'en' },
          retrySafe: true,
        },
      })
    );
    const guide = await readyGuide();
    expect(posts()).toHaveLength(0);
    expect(guide.errorKey).toBe('retry_safe');
    expect(guide.retryDisabled()).toBe(false);
    api.handle = (url, init) =>
      init.method === 'POST'
        ? json(snapshot([{ id: REQUEST, artifact: { requestId: REQUEST, revision: 1 } }]))
        : url.startsWith('/api/first-job/approvals')
          ? json(approvalsReady())
          : json(snapshot());
    await guide.retry();
    await settle();
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(String(posts()[0].init.body)).request_id).toBe(REQUEST);
  });

  it('keeps working without storage only as far as reads go', async () => {
    storageThrows = true;
    const guide = await readyGuide();
    expect(guide.storageReady).toBe(false);
    expect(guide.errorKey).toBe('storage_required');
    expect(guide.canAct()).toBe(false);
    expect(guide.start()).toBeUndefined();
    expect(posts()).toHaveLength(0);
  });

  it('polls running work with backoff on failures, and stops when hidden', async () => {
    const guide = await readyGuide([
      { id: REQUEST, turnState: 'settled', executionStatus: 'running' },
    ]);
    expect(guide.refreshModeKey()).toBe('refresh_active');
    const reads = () => api.calls.filter((call) => call.url.startsWith('/api/first-job?')).length;
    expect(reads()).toBe(1);
    api.handle = () => Promise.reject(new Error('offline'));
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(reads()).toBe(2);
    expect(guide.networkError).toBe(true);
    expect(guide.pollFailures).toBe(1);
    // Backoff: the next poll waits 10 s, not 5 s.
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(reads()).toBe(2);
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(reads()).toBe(3);
    expect(guide.pollFailures).toBe(2);
    // A good read resets the backoff.
    api.handle = (url) =>
      url.startsWith('/api/first-job/approvals')
        ? json(approvalsReady())
        : json(snapshot([{ id: REQUEST, turnState: 'settled', executionStatus: 'running' }]));
    await guide.load();
    await settle();
    expect(guide.pollFailures).toBe(0);
    (document as { visibilityState: string }).visibilityState = 'hidden';
    expect(guide.visible()).toBe(false);
    expect(guide.refreshModeKey()).toBe('refresh_hidden');
  });

  it('decides with the exact displayed digest and reports a stalled decision as uncertain', async () => {
    const guide = await readyGuide(
      [{ id: REQUEST, turnState: 'settled', executionStatus: 'awaiting_approval' }],
      [card()]
    );
    expect(guide.approval.items).toHaveLength(1);
    api.handle = (url, init) => (init.method === 'POST' ? never() : json(approvalsReady([card()])));
    guide.approval.clickDecision(guide.approval.items[0], 'approved', guide.approval.generation);
    await settle();
    expect(posts()[0].url).toBe(`/api/first-job/approvals/${APPROVAL}/decision`);
    expect(JSON.parse(String(posts()[0].init.body))).toEqual({
      decision: 'approved',
      display_digest: 'b'.repeat(64),
      session_id: SESSION,
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await settle();
    expect(guide.approval.error).toBe('approval_uncertain');
    expect(posts()).toHaveLength(1);
  });

  it('shows a gate refusal through its vocabulary key, never the code', async () => {
    api.handle = () => json({ ok: false, error: 'first_job_access_denied', retry_safe: true }, 403);
    const guide = new FirstJobGuide(() => undefined);
    guide.mount();
    await settle();
    expect(guide.refusal).toBe('first_job_access_denied');
    expect(guide.loaded).toBe(false);
    expect(guide.statusKey()).toBe('load_failed');
  });
});

describe('初めての仕事 page (/first-job) contract', () => {
  it('is the Concierge first-job destination', () => {
    expect(FRONT_DESK_LINKED_DESTINATIONS.find((item) => item.id === 'first-job')).toMatchObject({
      surface: 'concierge',
      path: '/first-job',
    });
    expect(resolveFrontDeskDestination('first-job', { currentSurface: 'concierge' })?.href).toBe(
      '/first-job'
    );
  });

  it('renders on the server without touching browser state (no hydration mismatch)', () => {
    vi.unstubAllGlobals();
    const html = renderToStaticMarkup(createElement(FirstJobPage));
    expect(html).toContain('<h1');
    expect((html.match(/<h2/g) ?? []).length).toBe(6);
    expect((html.match(/role="status"/g) ?? []).length).toBe(1);
    expect(html).not.toContain('first_job_');
    expect(html).toContain('id="first-job-approval-panel"');
  });

  it('keeps copy in the vocabulary and uses the member transport only', () => {
    const files = [
      'src/app/first-job/page.tsx',
      'src/app/first-job/first-job-controller.ts',
      'src/app/first-job/first-job-approval-panel.ts',
    ];
    const combined = files.map(read).join('\n');
    expect(combined).not.toContain('target=');
    expect(combined).not.toContain('127.0.0.1');
    expect(combined).not.toMatch(/\b30(31|40|50)\b/);
    for (const file of files)
      expect(/[぀-ヿ一-鿿]/u.test(withoutComments(read(file))), file).toBe(false);
    expect(combined).toContain("from '../../lib/front-desk-fetch'");
    expect(combined).not.toMatch(/(?<![\w.])fetch\(/u);
    expect(read('src/app/first-job/first-job.css')).toContain('overflow-wrap: anywhere');
  });
});
