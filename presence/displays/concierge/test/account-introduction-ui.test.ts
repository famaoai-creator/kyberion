import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import {
  FakeElement,
  installFakeDom,
  fireEvent,
} from '../../../../libs/shared-ui/vanilla/fake-dom.test-support.js';
import { AccountIntroductionPanel } from '../src/app/settings/sections/AccountIntroductionPanel';
import type { SettingsTranslate } from '../src/app/settings/sections/form-scope';
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/front-desk-fetch', () => ({ frontDeskFetch: fetchMock }));
const t: SettingsTranslate = (key) => key;
let dom: ReturnType<typeof installFakeDom>;
let client: typeof import('react-dom/client');
const roots: Array<() => void> = [];
beforeAll(async () => {
  dom = installFakeDom();
  client = await import('react-dom/client');
});
afterEach(() => {
  for (const unmount of roots.splice(0)) act(unmount);
  vi.resetAllMocks();
});
afterAll(() => dom.restore());
function mount() {
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = client.createRoot(container as unknown as Element);
  const render = (bindingId: string) =>
    act(() => root.render(createElement(AccountIntroductionPanel, { bindingId, t })));
  render('first');
  roots.push(() => root.unmount());
  return { container, render };
}
const reply = (value: unknown) => new Response(JSON.stringify({ ok: true, ...(value as object) }));
const preview = (binding_id: string) => ({
  binding_id,
  service_id: 'github',
  secret_refs: ['GITHUB_TOKEN'],
  statement: 'reviewed account',
  digest: 'hash',
  expected_generation: null,
});
async function click(container: FakeElement, label: string) {
  const button = container.querySelectorAll('button').find((node) => node.textContent === label);
  expect(button).toBeTruthy();
  await act(async () => {
    fireEvent(button!, 'click');
  });
}
describe('account collector lifecycle', () => {
  it('does not collect values before status confirms approval', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(preview('first')))
      .mockResolvedValueOnce(reply({ approval_id: 'id', approval_url: '/?approvalId=id' }))
      .mockResolvedValueOnce(reply({ can_apply: false }))
      .mockResolvedValueOnce(reply({ can_apply: true }));
    const { container } = mount();
    expect(container.querySelector('input')).toBeNull();
    await click(container, 'settings.account_preview');
    await click(container, 'settings.secret_propose');
    expect(container.querySelector('input')).toBeNull();
    await click(container, 'settings.account_refresh');
    expect(container.querySelector('input')).toBeNull();
    await click(container, 'settings.account_refresh');
    expect(container.querySelector('input')).not.toBeNull();
    expect(fetchMock.mock.calls.every(([, init]) => !String(init.body).includes('material'))).toBe(
      true
    );
  });
  it('ignores an old response and aborts its transport when the binding changes', async () => {
    let release!: (value: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        })
    );
    const { container, render } = mount();
    await click(container, 'settings.account_preview');
    const signal = fetchMock.mock.calls[0]![1].signal as AbortSignal;
    render('second');
    expect(signal.aborted).toBe(true);
    await act(async () => {
      release(reply(preview('first')));
    });
    expect(container.textContent).not.toContain('reviewed account');
    expect(container.querySelector('input')).toBeNull();
  });
  it('clears the collector on an uncertain apply and never retries the submitted material', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(preview('first')))
      .mockResolvedValueOnce(reply({ approval_id: 'id', approval_url: '/?approvalId=id' }))
      .mockResolvedValueOnce(reply({ can_apply: true }))
      .mockRejectedValueOnce(new Error('transport failed'));
    const { container } = mount();
    await click(container, 'settings.account_preview');
    await click(container, 'settings.secret_propose');
    await click(container, 'settings.account_refresh');
    const input = container.querySelector('input')!;
    await act(async () => {
      (input as unknown as { value: string }).value = 'synthetic-token';
      fireEvent(input, 'input');
    });
    await act(async () => {
      fireEvent(container.querySelector('form')!, 'submit');
    });
    expect(container.querySelector('input')).toBeNull();
    expect(container.textContent).toContain('settings.account_recovery');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(JSON.parse(fetchMock.mock.calls[3]![1].body)).toEqual({
      action: 'apply',
      binding_id: 'first',
      approval_id: 'id',
      material: { GITHUB_TOKEN: 'synthetic-token' },
    });
    await click(container, 'settings.account_close');
    expect(container.querySelector('input')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
  it('blocks duplicate clicks before React has painted the busy state', async () => {
    fetchMock.mockImplementationOnce(() => new Promise(() => {}));
    const { container } = mount();
    const button = container.querySelector('button')!;
    await act(async () => {
      fireEvent(button, 'click');
      fireEvent(button, 'click');
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
