import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { KbI18nProvider } from '@agent/shared-ui';
import { getUiMessageBundle } from '@agent/core';
import {
  FakeElement,
  installFakeDom,
  fireEvent,
  serializeFake,
  type FakeDocument,
} from '../../../../libs/shared-ui/vanilla/fake-dom.test-support.js';
import { OperatorServiceRegistrationPanel } from '../src/app/settings/sections/OperatorServiceRegistrationPanel';
import {
  ServicesSection,
  type ServicesSectionProps,
} from '../src/app/settings/sections/ServicesSection';
import { conciergeText, type ConciergeMessageKey } from '../src/lib/i18n';
import type { OperatorServiceDescriptor } from '../src/app/settings/operator-services-api';

const SECRET = 'example-token-UI-DO-NOT-RETAIN';
const t = (key: ConciergeMessageKey, params?: Record<string, string | number>) =>
  conciergeText(key, 'en', params);
const ui = getUiMessageBundle('en');
const kit = (element: ReactElement) =>
  createElement(KbI18nProvider, { locale: ui.locale, messages: ui.messages }, element);
const descriptors: OperatorServiceDescriptor[] = [
  {
    serviceId: 'github',
    label: 'GitHub',
    secretKey: 'ACCESS_TOKEN',
    authOperation: 'github.auth.test',
    setupUrl: 'https://github.com/settings/personal-access-tokens',
    scopeNotice: 'Only grant needed repository permissions.',
    credential_present: false,
  },
  {
    serviceId: 'slack',
    label: 'Slack',
    secretKey: 'ACCESS_TOKEN',
    authOperation: 'slack.auth.test',
    setupUrl: 'https://api.slack.com/apps',
    scopeNotice: 'Only grant needed workspace permissions.',
    credential_present: false,
  },
];
type Body = Record<string, string>;
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
function mockApi(handler?: (body: Body | null, init: RequestInit) => unknown | Promise<unknown>) {
  const calls: Array<Body | null> = [];
  const requests: RequestInit[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('/api/services/operator');
      const body = init.body ? (JSON.parse(String(init.body)) as Body) : null;
      calls.push(body);
      requests.push(init);
      const result = handler ? await handler(body, init) : undefined;
      if (result instanceof Response) return result;
      if (result !== undefined) return response(result);
      if (!body) return response({ ok: true, services: descriptors });
      if (body.action === 'propose' || body.action === 'status')
        return response({
          ok: true,
          approvalId: body.approvalId || 'APR-' + body.serviceId,
          status: 'approved',
        });
      if (body.action === 'apply')
        return response({ ok: true, serviceId: body.serviceId, status: 'registered' });
      return response({
        ok: true,
        serviceId: body.serviceId,
        status: 'authenticated',
        checkedAt: '2026-10-08T12:00:00Z',
      });
    })
  );
  return { calls, requests };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let dom: ReturnType<typeof installFakeDom>;
let client: typeof import('react-dom/client');
const roots: Array<() => void> = [];
beforeAll(async () => {
  dom = installFakeDom({ sessionStorage: { getItem: () => null } });
  client = await import('react-dom/client');
});
afterEach(() => {
  for (const unmount of roots.splice(0)) unmount();
  vi.unstubAllGlobals();
});
afterAll(() => dom.restore());
function mount(element: ReactElement = createElement(OperatorServiceRegistrationPanel, { t })) {
  const document = dom.document as FakeDocument;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = client.createRoot(container as unknown as Element);
  act(() => root.render(kit(element)));
  let mounted = true;
  const unmount = () => {
    if (mounted) {
      act(() => root.unmount());
      mounted = false;
    }
  };
  roots.push(unmount);
  const q = (selector: string) => {
    const node = container.querySelector(selector);
    if (!node) throw new Error('Missing selector ' + selector);
    return node;
  };
  return { container, q, unmount, html: () => serializeFake(container) };
}
const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const getProp = (element: FakeElement, name: string) =>
  (element as unknown as Record<string, unknown>)[name];
const setValue = (element: FakeElement, value: string) => {
  (element as unknown as { value: string }).value = value;
  fireEvent(element, 'input');
};
function button(container: FakeElement, label: string) {
  const found = container.querySelectorAll('button').find((node) => node.textContent === label);
  if (!found) throw new Error('Missing button ' + label);
  return found;
}
const card = (m: ReturnType<typeof mount>, id = 'github') =>
  m.q('[data-operator-service="' + id + '"]');
const click = async (element: FakeElement) => {
  await act(async () => {
    fireEvent(element, 'click');
  });
  await flush();
};

const sectionProps = (): ServicesSectionProps => ({
  locale: 'en',
  t,
  setup: {
    service_catalog: [
      { id: 'github', label: 'GitHub', auth: 'OAuth', configured: true },
      { id: 'google', label: 'Google Workspace', auth: 'OAuth', configured: false },
    ],
    connections: [],
  } as unknown as ServicesSectionProps['setup'],
  services: ['github'],
  setServices: vi.fn(),
  busy: false,
  oauthBusyId: null,
  oauthMessage: 'legacy-oauth-message',
  onConnectOAuth: vi.fn(),
  onSaveConnections: vi.fn(),
  sectionRef: () => {},
});

describe('operator service registration rendered interactions', () => {
  it('separates metadata selections from credentials and removes unsupported OAuth actions', async () => {
    const props = sectionProps();
    const html = renderToStaticMarkup(kit(createElement(ServicesSection, props)));
    expect(html).toContain(t('settings.operator_metadata_configured'));
    expect(html).toContain(t('settings.operator_selections_description'));
    expect(html).toContain(t('settings.operator_unsupported_providers'));
    expect(html).not.toContain('data-state="connected"');
    expect(html).not.toContain('legacy-oauth-message');
    expect(html).not.toContain('secret-introduce');
    expect(html).not.toContain('>' + t('setup.connect_oauth') + '</button>');
    const api = mockApi();
    const m = mount(createElement(ServicesSection, props));
    await flush();
    await click(button(m.container, t('settings.operator_save_selections')));
    expect(props.onSaveConnections).toHaveBeenCalledTimes(1);
    expect(api.calls.filter(Boolean)).toHaveLength(0);
    expect(props.onConnectOAuth).not.toHaveBeenCalled();
  });

  it('requires prepare/review, sends the token once, clears input, then probes without claiming scopes', async () => {
    const probe = deferred<unknown>();
    const api = mockApi((body) => (body?.action === 'probe' ? probe.promise : undefined));
    const storage = { setItem: vi.fn(), getItem: vi.fn() };
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('sessionStorage', storage);
    const m = mount();
    await flush();
    expect(card(m).querySelector('input')).toBeNull();
    const prepare = button(card(m), t('settings.operator_prepare'));
    await act(async () => {
      fireEvent(prepare, 'click');
      fireEvent(prepare, 'click');
    });
    await flush();
    expect(api.calls.filter((body) => body?.action === 'propose')).toHaveLength(1);
    expect(api.calls.find((body) => body?.action === 'propose')).not.toHaveProperty('value');
    expect(card(m).textContent).toContain(t('settings.operator_review', { service: 'GitHub' }));
    const input = card(m).querySelector('input.kb-secret-field__input')!;
    expect(input.getAttribute('name')).toBeNull();
    expect(input.getAttribute('value')).toBeNull();
    expect(input.getAttribute('autoComplete')).toBe('off');
    act(() => setValue(input, SECRET));
    expect(m.html()).not.toContain(SECRET);
    const save = card(m).querySelector('.kb-secret-field__save')!;
    await act(async () => {
      fireEvent(save, 'click');
      fireEvent(save, 'click');
    });
    await flush();
    expect(getProp(input, 'value')).toBe('');
    expect(api.calls.filter((body) => body?.action === 'apply')).toEqual([
      { action: 'apply', serviceId: 'github', approvalId: 'APR-github', value: SECRET },
    ]);
    expect(api.calls.filter((body) => body?.action === 'probe')).toEqual([
      { action: 'probe', serviceId: 'github' },
    ]);
    expect(card(m).textContent).toContain(t('settings.operator_saved'));
    expect(card(m).textContent).toContain(t('settings.operator_registered_unverified'));
    expect(card(m).textContent).not.toContain(t('settings.operator_authenticated'));
    probe.resolve({
      ok: true,
      serviceId: 'github',
      status: 'authenticated',
      checkedAt: '2026-10-08T12:00:00Z',
    });
    await flush();
    expect(card(m).textContent).toContain(t('settings.operator_authenticated'));
    expect(card(m).textContent).toContain(t('settings.operator_scope_limit'));
    expect(card(m).textContent).toContain(t('settings.operator_next_step', { service: 'GitHub' }));
    expect(card(m).querySelector('a[href="/"]')?.textContent).toBe(
      t('settings.operator_open_requests')
    );
    expect(m.html()).not.toContain(SECRET);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.getItem).not.toHaveBeenCalled();
  });

  it('checks the same pending approval explicitly and keeps token entry closed until approved', async () => {
    const api = mockApi((body) =>
      body?.action === 'propose'
        ? { ok: true, approvalId: 'APR-pending', status: 'pending' }
        : undefined
    );
    const m = mount();
    await flush();
    await click(button(card(m), t('settings.operator_prepare')));
    expect(card(m).querySelector('input')).toBeNull();
    expect(card(m).textContent).toContain(t('settings.operator_pending'));
    await click(button(card(m), t('settings.operator_check_approval')));
    expect(api.calls.filter((body) => body?.action === 'status')).toEqual([
      { action: 'status', serviceId: 'github', approvalId: 'APR-pending' },
    ]);
    expect(card(m).querySelector('input.kb-secret-field__input')).not.toBeNull();
    await click(button(card(m), t('settings.operator_cancel')));
    expect(card(m).querySelector('input')).toBeNull();
    expect(api.calls.some((body) => body?.action === 'apply')).toBe(false);
  });

  it('clears typed credentials on cancel and unmount without submitting them', async () => {
    const api = mockApi();
    const m = mount();
    await flush();
    await click(button(card(m), t('settings.operator_prepare')));
    const cancelled = card(m).querySelector('input.kb-secret-field__input')!;
    act(() => setValue(cancelled, SECRET));
    await click(button(card(m), t('settings.operator_cancel')));
    expect(getProp(cancelled, 'value')).toBe('');
    await click(button(card(m), t('settings.operator_prepare')));
    const abandoned = card(m).querySelector('input.kb-secret-field__input')!;
    act(() => setValue(abandoned, SECRET));
    m.unmount();
    expect(getProp(abandoned, 'value')).toBe('');
    expect(api.calls.some((body) => body?.action === 'apply')).toBe(false);
  });

  it('clears a token on unmount after a pending approval becomes approved with the same id', async () => {
    const api = mockApi((body) =>
      body?.action === 'propose'
        ? { ok: true, approvalId: 'APR-pending', status: 'pending' }
        : undefined
    );
    const m = mount();
    await flush();
    await click(button(card(m), t('settings.operator_prepare')));
    await click(button(card(m), t('settings.operator_check_approval')));
    const input = card(m).querySelector('input.kb-secret-field__input')!;
    act(() => setValue(input, SECRET));
    m.unmount();
    expect(getProp(input, 'value')).toBe('');
    expect(api.calls.some((body) => body?.action === 'apply')).toBe(false);
  });

  it('drops a rejected pending approval and permits only an explicit new preparation', async () => {
    const api = mockApi((body) =>
      body?.action === 'propose'
        ? { ok: true, approvalId: 'APR-pending', status: 'pending' }
        : body?.action === 'status'
          ? response({ ok: false, error: 'approval_required' }, 403)
          : undefined
    );
    const m = mount();
    await flush();
    await click(button(card(m), t('settings.operator_prepare')));
    await click(button(card(m), t('settings.operator_check_approval')));
    expect(card(m).textContent).toContain(t('settings.operator_approval_required'));
    expect(card(m).querySelector('input')).toBeNull();
    expect(getProp(button(card(m), t('settings.operator_prepare')), 'disabled')).toBeFalsy();
    expect(api.calls.filter((body) => body?.action === 'propose')).toHaveLength(1);
    expect(api.calls.some((body) => body?.action === 'apply')).toBe(false);
  });

  it('discards a cancelled late proposal and never transfers approvals between service cards', async () => {
    const old = deferred<unknown>();
    let proposals = 0;
    const api = mockApi((body) =>
      body?.action === 'propose' && body.serviceId === 'github' && ++proposals === 1
        ? old.promise
        : undefined
    );
    const m = mount();
    await flush();
    await click(button(card(m), t('settings.operator_prepare')));
    await click(button(card(m, 'slack'), t('settings.operator_prepare')));
    await click(button(card(m), t('settings.operator_cancel')));
    await click(button(card(m), t('settings.operator_prepare')));
    old.resolve({ ok: true, approvalId: 'APR-obsolete', status: 'approved' });
    await flush();
    const slack = card(m, 'slack');
    act(() => setValue(slack.querySelector('input.kb-secret-field__input')!, SECRET));
    await click(slack.querySelector('.kb-secret-field__save')!);
    expect(api.calls.find((body) => body?.action === 'apply')).toEqual({
      action: 'apply',
      serviceId: 'slack',
      approvalId: 'APR-slack',
      value: SECRET,
    });
    act(() =>
      setValue(card(m).querySelector('input.kb-secret-field__input')!, 'different-test-token')
    );
    await click(card(m).querySelector('.kb-secret-field__save')!);
    expect(api.calls.filter((body) => body?.action === 'apply')[1]?.approvalId).toBe('APR-github');
    expect(api.calls.some((body) => body?.approvalId === 'APR-obsolete')).toBe(false);
  });

  it('does not allow a same-tick cancel to undo a submitted apply and does not probe after unmount', async () => {
    const applying = deferred<unknown>();
    const api = mockApi((body) => (body?.action === 'apply' ? applying.promise : undefined));
    const m = mount();
    await flush();
    await click(button(card(m), t('settings.operator_prepare')));
    const input = card(m).querySelector('input.kb-secret-field__input')!;
    act(() => setValue(input, SECRET));
    const cancel = button(card(m), t('settings.operator_cancel'));
    await act(async () => {
      fireEvent(card(m).querySelector('.kb-secret-field__save')!, 'click');
      fireEvent(cancel, 'click');
    });
    await flush();
    expect(card(m).textContent).toContain(t('settings.operator_applying'));
    expect(getProp(input, 'value')).toBe('');
    m.unmount();
    expect(
      api.requests.find((request) => String(request.body).includes('"action":"apply"'))?.signal
        ?.aborted
    ).toBe(true);
    applying.resolve({ ok: true, serviceId: 'github', status: 'registered' });
    await flush();
    expect(api.calls.some((body) => body?.action === 'probe')).toBe(false);
  });

  it('does not let a delayed clipboard paste refill the token field after submission', async () => {
    const clipboard = deferred<string>();
    const applying = deferred<unknown>();
    vi.stubGlobal('navigator', { clipboard: { readText: () => clipboard.promise } });
    const api = mockApi((body) => (body?.action === 'apply' ? applying.promise : undefined));
    const m = mount();
    await flush();
    await click(button(card(m), t('settings.operator_prepare')));
    const input = card(m).querySelector('input.kb-secret-field__input')!;
    await click(card(m).querySelector('.kb-secret-field__paste')!);
    act(() => setValue(input, SECRET));
    await click(card(m).querySelector('.kb-secret-field__save')!);
    expect(card(m).querySelector('input')).toBeNull();
    clipboard.resolve('late-clipboard-token');
    await flush();
    expect(getProp(input, 'value')).toBe('');
    expect(m.html()).not.toContain('late-clipboard-token');
    applying.resolve({ ok: true, serviceId: 'github', status: 'registered' });
    await flush();
    expect(api.calls.filter((body) => body?.action === 'apply')).toEqual([
      { action: 'apply', serviceId: 'github', approvalId: 'APR-github', value: SECRET },
    ]);
  });

  it('clears failed input and renders only fixed error copy, without a success or automatic retry', async () => {
    const api = mockApi((body) =>
      body?.action === 'apply' ? response({ ok: false, error: SECRET }, 500) : undefined
    );
    const m = mount();
    await flush();
    await click(button(card(m), t('settings.operator_prepare')));
    const input = card(m).querySelector('input.kb-secret-field__input')!;
    act(() => setValue(input, SECRET));
    await click(card(m).querySelector('.kb-secret-field__save')!);
    expect(getProp(input, 'value')).toBe('');
    expect(m.html()).not.toContain(SECRET);
    expect(card(m).textContent).toContain(t('settings.operator_unavailable'));
    expect(card(m).textContent).not.toContain(t('settings.operator_saved'));
    expect(api.calls.filter((body) => body?.action === 'apply')).toHaveLength(1);
    expect(api.calls.some((body) => body?.action === 'probe')).toBe(false);
  });

  it.each([
    'credential_missing',
    'credential_shadowed',
    'authentication_failed',
    'unavailable',
    'unsupported',
  ])('shows %s as unverified on an explicit runtime probe', async (status) => {
    mockApi((body) =>
      !body
        ? { ok: true, services: [{ ...descriptors[0], credential_present: true }] }
        : body.action === 'probe'
          ? { ok: true, serviceId: 'github', status, checkedAt: '2026-10-08T12:00:00Z' }
          : undefined
    );
    const m = mount();
    await flush();
    expect(card(m).textContent).toContain(t('settings.operator_registered_unverified'));
    expect(card(m).textContent).not.toContain(t('settings.operator_authenticated'));
    await click(button(card(m), t('settings.operator_verify')));
    expect(card(m).textContent).not.toContain(t('settings.operator_authenticated'));
    expect(card(m).textContent).toContain(
      t(
        status === 'credential_missing'
          ? 'settings.operator_not_registered'
          : 'settings.operator_registered_unverified'
      )
    );
  });

  it('starts each remount as unverified and allows credential work while metadata saving is busy', async () => {
    const api = mockApi((body) =>
      !body ? { ok: true, services: [{ ...descriptors[0], credential_present: true }] } : undefined
    );
    const props = { ...sectionProps(), busy: true };
    const first = mount(createElement(ServicesSection, props));
    await flush();
    await click(button(card(first), t('settings.operator_verify')));
    expect(card(first).textContent).toContain(t('settings.operator_authenticated'));
    first.unmount();
    const next = mount(createElement(ServicesSection, props));
    await flush();
    expect(card(next).textContent).toContain(t('settings.operator_registered_unverified'));
    expect(card(next).textContent).not.toContain(t('settings.operator_authenticated'));
    expect(
      getProp(button(card(next), t('settings.operator_prepare_replace')), 'disabled')
    ).toBeFalsy();
    expect(api.calls.filter((body) => body?.action === 'probe')).toHaveLength(1);
  });

  it('explains local-operator denial without enabling token entry or sending a mutation', async () => {
    const api = mockApi(() => response({ ok: false, error: 'local_operator_required' }, 403));
    const m = mount();
    await flush();
    expect(m.html()).toContain(t('settings.operator_local_required'));
    expect(m.container.querySelector('input')).toBeNull();
    expect(api.calls).toEqual([null]);
  });
});
