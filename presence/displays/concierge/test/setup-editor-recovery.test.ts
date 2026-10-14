import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import {
  fireEvent,
  installFakeDom,
} from '../../../../libs/shared-ui/vanilla/fake-dom.test-support.js';
import FirstRunSetupPage from '../src/app/setup/first-run/page';
import { ManagementEditor } from '../src/app/management/ManagementEditor';
import type { ManagementData } from '../src/app/management/management-client';

vi.mock('../src/lib/use-concierge-i18n', () => ({
  useConciergeI18n: () => ({ locale: 'en', t: (key: string) => key }),
}));
vi.mock('../src/lib/i18n', () => ({ frontDeskText: (key: string) => key }));
vi.mock('../src/app/setup/sso-settings-form', () => ({ SsoSettingsForm: () => null }));
let dom: ReturnType<typeof installFakeDom>;
let client: typeof import('react-dom/client');
let unmount: (() => void) | undefined;
beforeAll(async () => {
  dom = installFakeDom();
  client = await import('react-dom/client');
});
afterEach(() => {
  unmount?.();
  unmount = undefined;
  vi.unstubAllGlobals();
});
afterAll(() => dom.restore());
async function mount(element: ReactNode = createElement(FirstRunSetupPage)) {
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = client.createRoot(container as unknown as Element);
  unmount = () => act(() => root.unmount());
  await act(async () => root.render(element));
  return container;
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
describe('first-run status recovery', () => {
  it.each([
    () => Promise.reject(new Error('offline')),
    () => Promise.resolve(json({ ok: false }, 503)),
    () => Promise.resolve(json({ ok: true, state: 'claimed' }, 429)),
    () => Promise.resolve(json({ state: 'claimed' })),
    () => Promise.resolve(json({ ok: true, state: 'unknown' })),
    () => Promise.resolve(new Response('invalid JSON')),
  ])('offers retry without claiming setup or losing the fragment code', async (failure) => {
    const location = { hash: '#code=fixture-code' };
    dom.window.location = location;
    const replace = vi.fn(() => {
      location.hash = '';
    });
    dom.window.history = { replaceState: replace };
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(failure)
        .mockResolvedValueOnce(json({ ok: true, state: 'unclaimed' }))
    );
    const view = await mount();
    expect(view.textContent).toContain('first_run_unavailable');
    expect(view.textContent).not.toContain('first_run_claimed');
    await act(async () => fireEvent(view.querySelector('button')!, 'click'));
    expect((view.querySelector('input')! as unknown as { value: string }).value).toBe(
      'fixture-code'
    );
    expect(replace).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('announces loading and aborts its status request on unmount', async () => {
    let resolve!: (value: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((yes) => {
            resolve = yes;
          })
      )
    );
    const view = await mount();
    expect(view.textContent).toContain('first_run_loading');
    expect(view.querySelector('[role="status"]')).not.toBeNull();
    const signal = vi.mocked(fetch).mock.calls[0][1]!.signal!;
    unmount!();
    unmount = undefined;
    expect(signal.aborted).toBe(true);
    await act(async () => resolve(json({ ok: true, state: 'claimed' })));
    expect(view.textContent).toBe('');
  });
  it('shows the sign-in path only after a confirmed claimed response', async () => {
    dom.window.location = { hash: '' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ok: true, state: 'claimed' })));
    const view = await mount();
    expect(view.textContent).toContain('first_run_claimed');
    expect(view.querySelector('a')!.getAttribute('href')).toBe('/login');
  });
  it('announces a pending retry and cancels it when leaving setup', async () => {
    let resolve!: (value: Response) => void;
    dom.window.location = { hash: '' };
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(json({ ok: false }, 503))
        .mockImplementationOnce(
          () =>
            new Promise<Response>((yes) => {
              resolve = yes;
            })
        )
    );
    const view = await mount();
    await act(async () => fireEvent(view.querySelector('button')!, 'click'));
    expect(view.textContent).toContain('first_run_loading');
    expect(view.querySelector('button')).toBeNull();
    const signal = vi.mocked(fetch).mock.calls[1][1]!.signal!;
    unmount!();
    unmount = undefined;
    expect(signal.aborted).toBe(true);
    await act(async () => resolve(json({ ok: true, state: 'unclaimed' })));
    expect(view.textContent).toBe('');
  });
});
describe('management editor keyboard entry', () => {
  it.each([
    'organization.create',
    'organization.update',
    'project.create',
    'project.update',
  ] as const)('focuses the name field when opening %s', async (operation) => {
    const view = await mount(
      createElement(ManagementEditor, {
        draft: { operation, name: 'Fixture', description: '' },
        verifying: false,
        data: {} as ManagementData,
        pending: null,
        busy: false,
        notice: null,
        scope: { tenant: 'fixture', organizationId: '', projectId: '' },
        setDraft: vi.fn(),
        review: vi.fn(),
        commit: vi.fn(),
        cancel: vi.fn(),
      })
    );
    expect(dom.document.activeElement).toBe(view.querySelector('input'));
    expect((view.querySelector('input')! as unknown as { value: string }).value).toBe('Fixture');
  });
});
