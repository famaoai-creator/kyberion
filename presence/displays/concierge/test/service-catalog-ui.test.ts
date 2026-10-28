import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  fireEvent,
  installFakeDom,
} from '../../../../libs/shared-ui/vanilla/fake-dom.test-support.js';
import { ServiceCatalogPane } from '../src/app/settings/sections/ServiceCatalogPane';
import { conciergeText } from '../src/lib/i18n';

const { fetchCatalog } = vi.hoisted(() => ({ fetchCatalog: vi.fn() }));
vi.mock('../src/lib/front-desk-fetch', () => ({ frontDeskFetch: fetchCatalog }));
const dom = installFakeDom();
let root: Root;
let container: ReturnType<typeof dom.document.createElement>;
const t = (key: Parameters<typeof conciergeText>[0], params?: Record<string, string | number>) =>
  conciergeText(key, 'en', params);
const entries = [
  {
    id: 'slack',
    oauth: true,
    auth_strategy: 'oauth',
    credential_suffixes: [],
    setup_command: 'slack-setup',
  },
  {
    id: 'local-tools',
    oauth: false,
    auth_strategy: 'none',
    credential_suffixes: [],
    setup_command: 'local-setup',
  },
];
const response = (services = entries) => ({ ok: true, json: async () => ({ ok: true, services }) });
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};
beforeEach(() => {
  fetchCatalog.mockReset();
  container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
});
afterEach(async () => {
  await act(async () => root.unmount());
  dom.document.body.removeChild(container);
});
afterAll(() => dom.restore());

describe('service catalog discovery', () => {
  it('shows loading, filters available methods, and starts only an explicit supported sign-in', async () => {
    let resolve!: (value: ReturnType<typeof response>) => void;
    fetchCatalog.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const connect = vi.fn();
    await act(async () =>
      root.render(createElement(ServiceCatalogPane, { t, onConnectOAuth: connect }))
    );
    expect(container.textContent).toContain(t('services.catalog_loading'));
    expect(connect).not.toHaveBeenCalled();
    await act(async () => resolve(response()));
    await flush();
    expect(container.querySelectorAll('[data-catalog-service]')).toHaveLength(2);
    const signIn = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Connect')
    )!;
    await act(async () => fireEvent(signIn, 'click'));
    expect(connect).toHaveBeenCalledWith('slack', 'slack');
    const filter = container.querySelector('select')!;
    await act(async () => {
      (filter as unknown as { value: string }).value = 'other';
      fireEvent(filter, 'change');
    });
    expect(container.querySelectorAll('[data-catalog-service]')).toHaveLength(1);
    expect(container.querySelector('[data-catalog-service="local-tools"]')).not.toBeNull();
    expect(container.querySelector('button')).toBeNull();
    const search = container.querySelector('input')!;
    await act(async () => {
      (search as unknown as { value: string }).value = 'missing';
      fireEvent(search, 'input');
    });
    expect(container.textContent).toContain(t('services.no_matches'));
  });

  it('reports failure in plain language and retries without rendering server error contents', async () => {
    fetchCatalog
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: 'private endpoint detail' }),
      })
      .mockResolvedValueOnce(response());
    await act(async () => root.render(createElement(ServiceCatalogPane, { t })));
    await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      t('services.catalog_failed')
    );
    expect(container.textContent).not.toContain('private endpoint detail');
    await act(async () => fireEvent(container.querySelector('button')!, 'click'));
    await flush();
    expect(container.querySelectorAll('[data-catalog-service]')).toHaveLength(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('rejects malformed responses instead of presenting an empty or usable catalog', async () => {
    fetchCatalog.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, services: [{ id: 'invalid' }] }),
    });
    await act(async () => root.render(createElement(ServiceCatalogPane, { t })));
    await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      t('services.catalog_failed')
    );
    expect(container.querySelector('[data-catalog-service]')).toBeNull();
  });

  it('aborts pending catalog reads when leaving the pane', async () => {
    fetchCatalog.mockImplementation(() => new Promise(() => {}));
    await act(async () => root.render(createElement(ServiceCatalogPane, { t })));
    const signal = fetchCatalog.mock.calls[0][1].signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    await act(async () => root.render(null));
    expect(signal.aborted).toBe(true);
  });
});
