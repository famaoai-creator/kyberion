import { describe, expect, it, vi } from 'vitest';
import {
  clampPluginViewFrameHeight,
  createPluginViewFrameBroker,
  isPlainFrameData,
  parsePluginViewFrames,
  PLUGIN_VIEW_FRAME_MAX_MESSAGE_BYTES,
  type PluginViewFrameBrokerOptions,
  type PluginViewFrameReply,
} from './plugin-view-frame-broker';

const PROTOCOL = 'kyberion.plugin-view/1';
const frameWindow = { name: 'frame' };

function setup(overrides: Partial<PluginViewFrameBrokerOptions> = {}) {
  const replies: PluginViewFrameReply[] = [];
  const clock = { now: 1_000_000 };
  const confirm = vi.fn(async () => true);
  const submit = vi.fn(async () => ({ status: 'approval_required' }));
  const onResize = vi.fn();
  const broker = createPluginViewFrameBroker({
    pluginId: 'plugin-a',
    viewId: 'status_frame',
    capabilities: ['action.request'],
    actions: [{ id: 'probe_env' }],
    locale: 'ja',
    frameWindow: () => frameWindow,
    post: (message) => replies.push(message),
    confirm,
    submit,
    onResize,
    now: () => clock.now,
    ...overrides,
  });
  return { broker, replies, clock, confirm, submit, onResize };
}

function request(requestId = 'r1', extra: Record<string, unknown> = {}) {
  return {
    source: frameWindow,
    data: {
      protocol: PROTOCOL,
      type: 'action.request',
      requestId,
      actionId: 'probe_env',
      params: {},
      ...extra,
    },
  };
}

describe('plugin view frame broker (PH-02)', () => {
  it('answers ready with the locale only', () => {
    const { broker, replies } = setup();
    expect(
      broker.handleMessage({ source: frameWindow, data: { protocol: PROTOCOL, type: 'ready' } })
    ).toEqual({ handled: true, kind: 'ready' });
    expect(replies).toEqual([{ protocol: PROTOCOL, type: 'init', locale: 'ja' }]);
  });

  it('drops messages from any window other than its own frame', () => {
    const { broker, confirm } = setup();
    expect(broker.handleMessage({ ...request(), source: { name: 'other' } })).toEqual({
      handled: false,
      reason: 'source',
    });
    expect(broker.handleMessage({ ...request(), source: null })).toMatchObject({
      reason: 'source',
    });
    const unloaded = setup({ frameWindow: () => null });
    expect(unloaded.broker.handleMessage({ ...request(), source: null })).toMatchObject({
      reason: 'source',
    });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('drops oversize, non-plain and malformed messages', () => {
    const { broker, confirm } = setup();
    const big = 'x'.repeat(PLUGIN_VIEW_FRAME_MAX_MESSAGE_BYTES);
    expect(broker.handleMessage(request('r1', { params: { big } }))).toMatchObject({
      reason: 'oversize',
    });
    expect(broker.handleMessage(request('r1', { params: { when: new Date(0) } }))).toMatchObject({
      reason: 'not_plain_data',
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(broker.handleMessage(request('r1', { params: cyclic }))).toMatchObject({
      reason: 'not_plain_data',
    });
    expect(broker.handleMessage(request('r1', { extra: true }))).toMatchObject({ reason: 'shape' });
    expect(broker.handleMessage(request('r1', { protocol: 'other/1' }))).toMatchObject({
      reason: 'shape',
    });
    expect(broker.handleMessage(request('bad id'))).toMatchObject({ reason: 'shape' });
    expect(broker.handleMessage(request('r1', { params: [] }))).toMatchObject({ reason: 'shape' });
    expect(
      broker.handleMessage({ source: frameWindow, data: { protocol: PROTOCOL, type: 'navigate' } })
    ).toMatchObject({ reason: 'shape' });
    expect(broker.handleMessage({ source: frameWindow, data: 'hello' })).toMatchObject({
      reason: 'shape',
    });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('refuses action requests without the capability or for undeclared actions', () => {
    const noCapability = setup({ capabilities: [] });
    expect(noCapability.broker.handleMessage(request())).toEqual({
      handled: false,
      reason: 'capability',
    });
    const { broker, confirm } = setup();
    expect(broker.handleMessage(request('r1', { actionId: 'write_probe' }))).toEqual({
      handled: false,
      reason: 'undeclared_action',
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(noCapability.confirm).not.toHaveBeenCalled();
  });

  it('confirms before submitting and replies with the outcome status', async () => {
    const { broker, replies, confirm, submit } = setup();
    const result = broker.handleMessage(request('r1', { params: { mode: 'quick' } }));
    expect(result).toMatchObject({ handled: true, kind: 'action.request' });
    await (result as { done: Promise<void> }).done;
    const expectedRequest = {
      pluginId: 'plugin-a',
      viewId: 'status_frame',
      actionId: 'probe_env',
      params: { mode: 'quick' },
    };
    expect(confirm).toHaveBeenCalledWith(expectedRequest);
    expect(submit).toHaveBeenCalledWith(expectedRequest);
    expect(replies).toEqual([
      { protocol: PROTOCOL, type: 'action.result', requestId: 'r1', status: 'approval_required' },
    ]);
  });

  it('never submits a declined request', async () => {
    const { broker, replies, submit } = setup({ confirm: async () => false });
    await (broker.handleMessage(request()) as { done: Promise<void> }).done;
    expect(submit).not.toHaveBeenCalled();
    expect(replies).toEqual([
      { protocol: PROTOCOL, type: 'action.result', requestId: 'r1', status: 'declined' },
    ]);
  });

  it('allows one request in flight and at most 10 per minute', async () => {
    let release: (allowed: boolean) => void = () => undefined;
    const { broker, replies, clock } = setup({
      confirm: () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    });
    const first = broker.handleMessage(request('r1')) as { done: Promise<void> };
    expect(broker.handleMessage(request('r2'))).toMatchObject({
      rejected: 'PLUGIN_VIEW_FRAME_BUSY',
    });
    release(false);
    await first.done;

    for (let index = 2; index <= 10; index += 1) {
      const next = broker.handleMessage(request(`r${index}`)) as { done: Promise<void> };
      release(false);
      await next.done;
    }
    expect(broker.handleMessage(request('r11'))).toMatchObject({
      rejected: 'PLUGIN_VIEW_FRAME_RATE_LIMITED',
    });
    expect(replies.at(-1)).toMatchObject({
      requestId: 'r11',
      status: 'rejected',
      errorCode: 'PLUGIN_VIEW_FRAME_RATE_LIMITED',
    });
    clock.now += 60_000;
    const later = broker.handleMessage(request('r12'));
    expect(later).toMatchObject({ handled: true, kind: 'action.request' });
    expect(later).not.toHaveProperty('rejected');
  });

  it('clamps resize heights to 120-2000 px', () => {
    const { broker, onResize } = setup();
    const resize = (height: unknown) =>
      broker.handleMessage({
        source: frameWindow,
        data: { protocol: PROTOCOL, type: 'resize', height },
      });
    resize(10);
    resize(640.4);
    resize(1e9);
    expect(resize(Number.NaN)).toMatchObject({ reason: 'not_plain_data' });
    expect(resize('600')).toMatchObject({ reason: 'shape' });
    expect(onResize.mock.calls).toEqual([[120], [640], [2000]]);
    expect(clampPluginViewFrameHeight(-5)).toBe(120);
  });

  it('accepts only plain JSON-like data', () => {
    expect(isPlainFrameData({ a: [1, 'x', null, { b: true }] })).toBe(true);
    expect(isPlainFrameData(Object.create(null))).toBe(true);
    expect(isPlainFrameData(new Map())).toBe(false);
    expect(isPlainFrameData({ f: () => 1 })).toBe(false);
    expect(isPlainFrameData({ n: Infinity })).toBe(false);
    let deep: Record<string, unknown> = {};
    for (let index = 0; index < 20; index += 1) deep = { deep };
    expect(isPlainFrameData(deep)).toBe(false);
  });

  it('ignores every message once the frame has navigated (second load)', async () => {
    let release: (allowed: boolean) => void = () => undefined;
    const { broker, replies, submit, onResize } = setup({
      confirm: () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    });
    expect(broker.frameLoaded()).toBe(true);
    const pending = broker.handleMessage(request('r1')) as { done: Promise<void> };
    expect(pending).toMatchObject({ handled: true, kind: 'action.request' });

    // Same window object, new (unreviewed) document.
    expect(broker.frameLoaded()).toBe(false);
    expect(broker.invalidated).toBe(true);
    const ready = { source: frameWindow, data: { protocol: PROTOCOL, type: 'ready' } };
    expect(broker.handleMessage(ready)).toEqual({ handled: false, reason: 'invalidated' });
    expect(broker.handleMessage(request('r2'))).toEqual({ handled: false, reason: 'invalidated' });
    expect(
      broker.handleMessage({
        source: frameWindow,
        data: { protocol: PROTOCOL, type: 'resize', height: 500 },
      })
    ).toMatchObject({ reason: 'invalidated' });
    // An allow given before the navigation is void; nothing is posted to the new document.
    release(true);
    await pending.done;
    expect(submit).not.toHaveBeenCalled();
    expect(onResize).not.toHaveBeenCalled();
    expect(replies).toEqual([]);
    expect(broker.frameLoaded()).toBe(false);
  });

  it('can be invalidated explicitly', () => {
    const { broker, replies } = setup();
    broker.invalidate();
    expect(
      broker.handleMessage({ source: frameWindow, data: { protocol: PROTOCOL, type: 'ready' } })
    ).toEqual({ handled: false, reason: 'invalidated' });
    expect(replies).toEqual([]);
  });

  it('rejects huge strings before serializing them', () => {
    const { broker, confirm } = setup();
    const huge = 'x'.repeat(PLUGIN_VIEW_FRAME_MAX_MESSAGE_BYTES * 64);
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      expect(broker.handleMessage(request('r1', { params: { huge } }))).toEqual({
        handled: false,
        reason: 'oversize',
      });
      expect(broker.handleMessage(request('r1', { params: { [huge]: 1 } }))).toMatchObject({
        reason: 'oversize',
      });
      expect(stringify).not.toHaveBeenCalled();
    } finally {
      stringify.mockRestore();
    }
    expect(confirm).not.toHaveBeenCalled();
  });

  it('re-sends init on a locale change without resetting the rate limit', async () => {
    const { broker, replies } = setup({ confirm: async () => false });
    broker.setLocale('en');
    expect(replies).toEqual([]);
    broker.handleMessage({ source: frameWindow, data: { protocol: PROTOCOL, type: 'ready' } });
    broker.setLocale('ja');
    expect(replies).toEqual([
      { protocol: PROTOCOL, type: 'init', locale: 'en' },
      { protocol: PROTOCOL, type: 'init', locale: 'ja' },
    ]);
    for (let index = 1; index <= 10; index += 1) {
      await (broker.handleMessage(request(`r${index}`)) as { done: Promise<void> }).done;
    }
    broker.setLocale('en');
    expect(replies.at(-1)).toEqual({ protocol: PROTOCOL, type: 'init', locale: 'en' });
    expect(broker.handleMessage(request('r11'))).toMatchObject({
      rejected: 'PLUGIN_VIEW_FRAME_RATE_LIMITED',
    });
  });

  it('parses iframe views with same-origin frame URLs only', () => {
    const view = {
      plugin_id: 'plugin-a',
      view_id: 'status_frame',
      title: 'Status',
      isolation: 'sandboxed-iframe',
      capabilities: ['action.request', 7],
      actions: [{ id: 'probe_env', authority: 'agent', op: 'x:y' }, { id: 'bad' }],
      frame_url: '/api/headless/a2ui/plugin-views/frame?plugin_id=plugin-a&view_id=status_frame',
    };
    expect(
      parsePluginViewFrames({
        data: {
          views: [
            view,
            { ...view, view_id: 'remote', frame_url: 'https://evil.example/frame' },
            { ...view, isolation: 'in-process-a2ui' },
          ],
        },
      })
    ).toEqual([
      {
        pluginId: 'plugin-a',
        viewId: 'status_frame',
        title: 'Status',
        frameUrl: view.frame_url,
        capabilities: ['action.request'],
        actions: [{ id: 'probe_env', authority: 'agent' }],
      },
    ]);
    expect(parsePluginViewFrames(null)).toEqual([]);
  });
});
