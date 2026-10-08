import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import {
  FakeElement,
  installFakeDom,
  fireEvent,
} from '../../../../libs/shared-ui/vanilla/fake-dom.test-support.js';
import IngestPage from '../src/app/ingest/page';

const setup = {
  ok: true,
  setup: {
    surface_roles: [],
    active_surfaces: [],
    reasoning_mode: 'stub',
    model_tiers: {},
    profile: {
      name: 'Test',
      language: 'en',
      interaction_style: 'Minimalist',
      primary_domain: 'test',
      vision: 'test',
      agent_id: 'test',
      tenant_slug: 'alpha',
      onboarding_complete: true,
      avatar_registered: false,
      voice_profiles: [],
    },
    service_catalog: [],
    diagnostics: [],
    capabilities: [],
    tenant: {
      active_slug: 'alpha',
      runtime_bound: true,
      catalog: ['alpha', 'beta'].map((tenant_slug) => ({
        tenant_slug,
        tenant_id: tenant_slug,
        display_name: tenant_slug,
        status: 'active',
        assigned_role: 'owner',
      })),
    },
    agent_management: { configured: null, durable_identities: [] },
  },
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const verdict = (dry_run = true, outcome = 'would_commit', tenant = 'alpha') =>
  json({
    ok: true,
    summary: { dry_run, outcome, tenant, file_name: 'report.txt' },
    message: 'Server result',
  });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
let dom: ReturnType<typeof installFakeDom>;
let client: typeof import('react-dom/client');
let unmount: (() => void) | undefined;
const originalOptions = Object.getOwnPropertyDescriptor(FakeElement.prototype, 'options');
beforeAll(async () => {
  dom = installFakeDom();
  Object.defineProperty(FakeElement.prototype, 'options', {
    configurable: true,
    get(this: FakeElement) {
      return this.localName === 'select'
        ? this.children.filter((child) => child.localName === 'option')
        : undefined;
    },
  });
  client = await import('react-dom/client');
});
afterEach(() => {
  unmount?.();
  unmount = undefined;
  vi.unstubAllGlobals();
});
afterAll(() => {
  if (originalOptions) Object.defineProperty(FakeElement.prototype, 'options', originalOptions);
  else Reflect.deleteProperty(FakeElement.prototype, 'options');
  dom.restore();
});
const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
function mount(
  respond: (body: FormData) => Promise<Response> = async () => verdict(),
  load: () => Promise<Response> = async () => json(setup)
) {
  const posts: FormData[] = [];
  vi.stubGlobal('navigator', { language: 'en' });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/setup') return load();
      if (url !== '/api/ingest') throw new Error('Unexpected endpoint');
      const body = init?.body as FormData;
      posts.push(body);
      return respond(body);
    })
  );
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = client.createRoot(container as unknown as Element);
  act(() => root.render(createElement(IngestPage)));
  unmount = () => act(() => root.unmount());
  const q = (selector: string) => {
    const el = container.querySelector(selector);
    if (!el) throw new Error('Missing ' + selector);
    return el;
  };
  const button = (text: string) =>
    [...container.querySelectorAll('button')].find((el) => el.textContent === text);
  const choose = (file = new File(['synthetic fixture'], 'report.txt', { type: 'text/plain' })) =>
    act(() => {
      const input = q('input[type="file"]');
      Object.assign(input, { files: [file] });
      fireEvent(input, 'change');
    });
  const select = (index: number, value: string) =>
    act(() => {
      const input = container.querySelectorAll('select')[index];
      Object.assign(input, { value });
      fireEvent(input, 'change');
    });
  const click = async (text: string) => {
    const el = button(text);
    if (!el) throw new Error('Missing button ' + text);
    await act(async () => {
      fireEvent(el, 'click');
    });
    await flush();
  };
  return { container, q, button, choose, select, click, posts };
}

describe('document preview confirmation', () => {
  it.each(['tenant', 'format', 'file'])('invalidates a preview when %s changes', async (change) => {
    const m = mount();
    await flush();
    m.choose();
    await m.click('Check the document');
    expect(m.button('Looks good — file it')).toBeDefined();
    if (change === 'tenant') m.select(0, 'beta');
    else if (change === 'format') m.select(1, 'text');
    else m.choose(new File(['different content'], 'report.txt'));
    expect(m.button('Looks good — file it')).toBeUndefined();
    expect(m.posts).toHaveLength(1);
  });
});

const enabled = (element: FakeElement | undefined) =>
  element && !(element as unknown as { disabled: boolean }).disabled;

it('confirms the exact reviewed selection, clears a committed file, and returns to preview', async () => {
  const m = mount(async (body) =>
    verdict(
      body.has('dry_run'),
      body.has('dry_run') ? 'would_commit' : 'committed',
      String(body.get('tenant'))
    )
  );
  await flush();
  const file = new File(['original bytes'], 'report.txt');
  m.choose(file);
  m.select(0, 'beta');
  m.select(1, 'text');
  await m.click('Check the document');
  await m.click('Looks good — file it');
  expect(m.posts).toHaveLength(2);
  expect(m.posts[0].get('file')).toBe(file);
  expect(m.posts[1].get('file')).toBe(file);
  expect(m.posts[1].get('tenant')).toBe('beta');
  expect(m.posts[1].get('format')).toBe('text');
  expect(m.posts[1].has('dry_run')).toBe(false);
  expect(enabled(m.button('Check the document'))).toBe(false);
  expect(m.container.textContent).toContain('Filed');
});

it('blocks same-turn repeated requests and all edits including drops while pending', async () => {
  const request = deferred<Response>();
  const m = mount(async () => request.promise);
  await flush();
  m.choose();
  const check = m.button('Check the document')!;
  act(() => {
    fireEvent(check, 'click');
    fireEvent(check, 'click');
  });
  await flush();
  expect(m.posts).toHaveLength(1);
  expect(enabled(m.button('Choose a file'))).toBe(false);
  for (const select of m.container.querySelectorAll('select')) expect(enabled(select)).toBe(false);
  m.choose(new File(['new'], 'new.txt'));
  m.select(0, 'beta');
  m.select(1, 'pdf');
  act(() =>
    fireEvent(m.q('.ingest-dropzone'), 'drop', {
      dataTransfer: { files: [new File(['drop'], 'dropped.txt')] },
    })
  );
  await act(async () => request.resolve(verdict()));
  await flush();
  expect(m.container.textContent).not.toContain('dropped.txt');
  expect(m.container.textContent).not.toContain('new.txt');
  expect(m.button('Looks good — file it')).toBeDefined();
});

it.each([400, 422])(
  'keeps useful validation guidance and selection after %s rejection',
  async (status) => {
    const m = mount(async () =>
      json({ ok: false, error: 'Choose a supported document type.' }, status)
    );
    await flush();
    m.choose();
    await m.click('Check the document');
    expect(m.container.textContent).toContain('Choose a supported document type.');
    expect(m.container.textContent).toContain('check the document again');
    expect(m.button('Looks good — file it')).toBeUndefined();
    expect(enabled(m.button('Check the document'))).toBe(true);
  }
);

it.each(['network', 'timeout', 'html', 'wrong-tenant', 'wrong-phase', 'server'])(
  'keeps %s commit uncertainty through later previews without another commit',
  async (kind) => {
    let post = 0;
    const m = mount(async (body) => {
      ++post;
      if (post === 1) return verdict();
      if (post > 2) return verdict(true, post === 3 ? 'would_commit' : 'duplicate');
      expect(body.has('dry_run')).toBe(false);
      if (kind === 'network') throw new TypeError('connection lost');
      if (kind === 'timeout') throw new DOMException('request deadline', 'TimeoutError');
      if (kind === 'html') return new Response('<html>not JSON</html>');
      if (kind === 'wrong-tenant') return verdict(false, 'committed', 'beta');
      if (kind === 'wrong-phase') return verdict(true, 'would_commit');
      return json({ ok: false, error: 'internal stack should not be rendered' }, 502);
    });
    await flush();
    m.choose();
    await m.click('Check the document');
    await m.click('Looks good — file it');
    expect(m.container.textContent).toContain('could not confirm');
    expect(m.container.textContent).not.toContain('internal stack');
    expect(m.button('Looks good — file it')).toBeUndefined();
    expect(m.button('File the document')).toBeUndefined();
    expect(enabled(m.q('input[type="checkbox"]'))).toBe(false);
    await m.click('Check the document');
    expect(m.container.textContent).toContain('could not confirm');
    expect(m.button('Looks good — file it')).toBeUndefined();
    await m.click('Check the document');
    expect(m.container.textContent).toContain('does not confirm');
    expect(m.container.textContent).toContain('Matching content');
    expect(m.posts.filter((body) => !body.has('dry_run'))).toHaveLength(1);
  }
);

it.each([401, 403])(
  'classifies an HTML %s response and reloads access without replay',
  async (status) => {
    const m = mount(async () => new Response('<html>denied</html>', { status }));
    await flush();
    m.choose();
    await m.click('Check the document');
    expect(m.container.textContent).toContain(status === 401 ? 'Sign in' : 'administrator');
    expect(Boolean(m.container.querySelector('a[href="/signin"]'))).toBe(status === 401);
    expect(enabled(m.button('Check the document'))).toBe(false);
    await m.click('Reload the form');
    expect(m.posts).toHaveLength(1);
    expect(enabled(m.button('Check the document'))).toBe(true);
  }
);

it('discards a late committed response after unmount rather than affecting a new page', async () => {
  const request = deferred<Response>();
  const m = mount(async (body) => (body.has('dry_run') ? verdict() : request.promise));
  await flush();
  m.choose();
  await m.click('Check the document');
  await m.click('Looks good — file it');
  unmount?.();
  unmount = undefined;
  const fresh = mount();
  await flush();
  fresh.choose(new File(['new'], 'new.txt'));
  await act(async () => request.resolve(verdict(false, 'committed')));
  await flush();
  expect(fresh.container.textContent).toContain('new.txt');
  expect(fresh.container.textContent).not.toContain('Filed');
  expect(fresh.posts).toHaveLength(0);
});

it('offers retry after setup failure without starting an upload', async () => {
  let loads = 0;
  const m = mount(undefined, async () =>
    ++loads === 1 ? new Response('', { status: 503 }) : json(setup)
  );
  await flush();
  expect(m.container.textContent).toContain('Could not load');
  await m.click('Reload the form');
  expect(loads).toBe(2);
  expect(m.posts).toHaveLength(0);
});

it.each(['preview', 'commit'])(
  'invalidates %s on back/forward cache restore and fences late responses',
  async (phase) => {
    const request = deferred<Response>();
    let count = 0;
    const m = mount(async () =>
      ++count === 1 && phase === 'commit' ? verdict() : request.promise
    );
    await flush();
    m.choose();
    await m.click('Check the document');
    if (phase === 'commit') await m.click('Looks good — file it');
    act(() => fireEvent(dom.windowEvents, 'pagehide', { persisted: true }));
    expect(enabled(m.button('Check the document'))).toBe(false);
    act(() => fireEvent(dom.windowEvents, 'pageshow', { persisted: true }));
    await flush();
    await act(async () =>
      request.resolve(
        verdict(phase === 'preview', phase === 'preview' ? 'would_commit' : 'committed')
      )
    );
    await flush();
    expect(m.button('Looks good — file it')).toBeUndefined();
    expect(m.container.textContent).not.toContain('Filed');
    if (phase === 'commit') expect(m.container.textContent).toContain('could not confirm');
    expect(m.posts).toHaveLength(phase === 'commit' ? 2 : 1);
  }
);
it('does not treat the first catalog entry as a usable active destination when the catalog is empty', async () => {
  const empty = {
    ...setup,
    setup: { ...setup.setup, tenant: { ...setup.setup.tenant, catalog: [] } },
  };
  const m = mount(undefined, async () => json(empty));
  await flush();
  m.choose();
  expect(m.container.textContent).toContain('No available destination');
  expect(m.button('Reload the form')).toBeDefined();
  expect(enabled(m.button('Check the document'))).toBe(false);
  expect(m.posts).toHaveLength(0);
});
it('fences a late response body after navigation as well as a late network response', async () => {
  const body = deferred<unknown>();
  const response = verdict();
  vi.spyOn(response, 'json').mockReturnValue(body.promise);
  const m = mount(async () => response);
  await flush();
  m.choose();
  await m.click('Check the document');
  act(() => fireEvent(dom.windowEvents, 'pagehide', { persisted: true }));
  act(() => fireEvent(dom.windowEvents, 'pageshow', { persisted: true }));
  await flush();
  await act(async () =>
    body.resolve({
      ok: true,
      summary: { dry_run: true, outcome: 'would_commit', tenant: 'alpha', file_name: 'report.txt' },
      message: 'late',
    })
  );
  await flush();
  expect(m.button('Looks good — file it')).toBeUndefined();
  expect(m.posts).toHaveLength(1);
});

it.each([400, 422, 401, 403])(
  'keeps commit-phase %s rejection distinct from uncertain execution',
  async (status) => {
    let count = 0;
    const m = mount(async () =>
      ++count === 1 ? verdict() : json({ ok: false, error: 'Check the selected input.' }, status)
    );
    await flush();
    m.choose();
    await m.click('Check the document');
    await m.click('Looks good — file it');
    expect(m.button('Looks good — file it')).toBeUndefined();
    expect(m.container.textContent).not.toContain('could not confirm whether');
    if (status === 400 || status === 422) {
      expect(m.container.textContent).toContain('Check the selected input.');
      expect(enabled(m.button('Check the document'))).toBe(true);
    } else {
      expect(enabled(m.button('Check the document'))).toBe(false);
      await m.click('Reload the form');
    }
    expect(m.posts).toHaveLength(2);
  }
);
it('bounds a multipart request with a timeout signal', async () => {
  const timeout = vi.spyOn(AbortSignal, 'timeout');
  try {
    const m = mount();
    await flush();
    m.choose();
    await m.click('Check the document');
    expect(timeout).toHaveBeenCalledWith(75_000);
    const call = vi.mocked(fetch).mock.calls.find(([url]) => url === '/api/ingest');
    expect(call?.[1]?.signal).toBeInstanceOf(AbortSignal);
  } finally {
    timeout.mockRestore();
  }
});
