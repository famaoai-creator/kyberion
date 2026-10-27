import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { installFakeDom } from '../../../../libs/shared-ui/vanilla/fake-dom.test-support.js';
import {
  OAuthOperationCard,
  type OAuthOperationHandle,
} from '../src/app/settings/sections/OAuthOperationCard';
import { conciergeText } from '../src/lib/i18n';
const dom = installFakeDom();
afterAll(() => dom.restore());
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const operation = (id: string): OAuthOperationHandle => ({
  operationId: id,
  serviceId: 'github',
  label: id,
  expiresAt: '2026-10-28T00:10:00Z',
});
const response = (id: string, status: string) =>
  new Response(
    JSON.stringify({ ok: true, operation: { operationId: id, serviceId: 'github', status } })
  );
async function mount(id: string) {
  const client = await import('react-dom/client');
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = client.createRoot(container as unknown as Element);
  const render = async (next: string) =>
    act(async () =>
      root.render(
        createElement(OAuthOperationCard, {
          key: next,
          operation: operation(next),
          t: (key) => conciergeText(key, 'en'),
          onDismiss: () => undefined,
        })
      )
    );
  await render(id);
  return {
    root,
    container,
    render,
    cleanup: async () => {
      await act(async () => root.unmount());
      dom.document.body.removeChild(container);
    },
  };
}
describe('connection operation progress', () => {
  it('observes callback confirmation, stops at completion, and only sends GET requests', async () => {
    vi.useFakeTimers();
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response('op-a', 'waiting'))
      .mockResolvedValueOnce(response('op-a', 'confirming'))
      .mockResolvedValueOnce(response('op-a', 'connected'));
    const ui = await mount('op-a');
    try {
      expect(ui.container.textContent).toContain('Waiting for consent');
      await act(async () => vi.advanceTimersByTimeAsync(1500));
      expect(ui.container.textContent).toContain('Confirming');
      await act(async () => vi.advanceTimersByTimeAsync(1500));
      expect(ui.container.textContent).toContain('Connected;');
      await act(async () => vi.advanceTimersByTimeAsync(30_000));
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(
        fetch.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')
      ).toBe(true);
    } finally {
      await ui.cleanup();
    }
  });
  it('ignores a superseded operation response and never treats observation failure as success', async () => {
    vi.useFakeTimers();
    let finishOld!: (value: Response) => void;
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOld = resolve;
          })
      )
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(response('op-b', 'expired'));
    const ui = await mount('op-a');
    try {
      await ui.render('op-b');
      expect(ui.container.textContent).toContain('completion has not been confirmed');
      await act(async () => finishOld(response('op-a', 'connected')));
      expect(ui.container.textContent).not.toContain('Connected;');
      await act(async () => vi.advanceTimersByTimeAsync(1500));
      expect(ui.container.textContent).toContain('expired');
      expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    } finally {
      await ui.cleanup();
    }
  });
});
