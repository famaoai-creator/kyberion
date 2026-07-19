import { beforeEach, describe, expect, it, vi } from 'vitest';

type MessageListener = (message: any, sender: any, respond: (value: any) => void) => boolean;
const HASH = 'a'.repeat(64);

function recordedEvent(summary: string, ref = '@button_1_1') {
  return {
    op: 'click_ref',
    summary,
    target: { ref, role: 'button', name: 'Continue', snapshot_hash: HASH },
  };
}

function defaultNative(payload: any) {
  if (payload.type === 'request_execution') {
    return {
      ok: true,
      status: 'authorized',
      lease: {
        lease_id: 'L1',
        issued_at: '2026-06-23T00:00:00.000Z',
        expires_at: '2999-01-01T00:00:00.000Z',
        approved_step_hashes: [],
      },
    };
  }
  if (payload.type === 'submit_receipt')
    return { ok: true, status: 'recorded', receipt_id: payload.receipt.receipt_id };
  if (payload.type === 'preflight')
    return { ok: true, status: 'ready_for_review', approval_required: false };
  return { ok: true };
}

async function createHarness() {
  let messageListener: MessageListener | undefined;
  let updateListener: ((tabId: number, changeInfo: any, tab?: any) => Promise<void>) | undefined;
  const store: Record<string, any> = {};
  const tab = { id: 42, windowId: 1, url: 'https://example.com/start', title: 'Example' };
  const hooks = {
    native: (payload: any) => defaultNative(payload),
    nativeError: undefined as string | undefined,
    execute: (_step: any, _value: any): any => ({ status: 'done', detail: 'ok' }),
    hostAccess: true,
  };

  const chrome: any = {
    action: { onClicked: { addListener: vi.fn() } },
    sidePanel: { open: vi.fn(async () => undefined) },
    runtime: {
      onMessage: {
        addListener: (listener: MessageListener) => {
          messageListener = listener;
        },
      },
      sendMessage: vi.fn(async () => undefined),
      getManifest: () => ({ version: '0.1.0' }),
      lastError: undefined,
      connectNative: vi.fn(() => {
        const messageListeners: Array<(response: any) => void> = [];
        const disconnectListeners: Array<() => void> = [];
        const port = {
          onMessage: {
            addListener: (listener: (response: any) => void) => messageListeners.push(listener),
          },
          onDisconnect: {
            addListener: (listener: () => void) => disconnectListeners.push(listener),
          },
          postMessage: (payload: any) => {
            Promise.resolve(hooks.native(payload)).then((response) => {
              if (hooks.nativeError) {
                chrome.runtime.lastError = { message: hooks.nativeError };
                disconnectListeners.forEach((listener) => listener());
                chrome.runtime.lastError = undefined;
                return;
              }
              messageListeners.forEach((listener) => listener(response));
            });
          },
          disconnect: vi.fn(() => undefined),
        };
        return port;
      }),
    },
    tabs: {
      onUpdated: {
        addListener: (listener: typeof updateListener) => {
          updateListener = listener;
        },
      },
      query: vi.fn(async () => [tab]),
      sendMessage: vi.fn(async (_tabId: number, message: any) => {
        if (message.type === 'bridge:ping') return { ok: true };
        if (message.type === 'bridge:observe')
          return {
            title: tab.title,
            url: tab.url,
            origin: 'https://example.com',
            snapshotHash: HASH,
          };
        if (message.type === 'bridge:execute-step')
          return hooks.execute(message.step, message.value);
        return { ok: true };
      }),
    },
    scripting: { executeScript: vi.fn(async () => undefined) },
    permissions: {
      contains: vi.fn(async () => hooks.hostAccess),
      request: vi.fn(async () => true),
    },
    storage: {
      // Clone on get/set like real chrome.storage (structured clone), so each
      // concurrent reader gets its own copy — this is what makes the
      // lost-update race observable without the state lock.
      session: {
        get: vi.fn(async (key: string) => ({
          [key]: store[key] === undefined ? undefined : structuredClone(store[key]),
        })),
        set: vi.fn(async (value: Record<string, any>) => {
          for (const k of Object.keys(value)) store[k] = structuredClone(value[k]);
        }),
      },
    },
  };
  (globalThis as any).chrome = chrome;

  vi.resetModules();
  await import('../tools/adf-replay-extension/background.js');
  if (!messageListener || !updateListener)
    throw new Error('Background listeners were not registered.');

  const send = async (message: Record<string, unknown>, sender: any = {}) =>
    new Promise<any>((resolve) => {
      messageListener!(message, sender, resolve);
    });
  return { send, store, tab, update: updateListener!, hooks };
}

function submitEvent(summary: string, ref = '@form_1_1') {
  return {
    op: 'submit_form',
    summary,
    target: { ref, role: 'form', name: 'Checkout', snapshot_hash: HASH },
  };
}

async function approveAllAndFinalize(
  harness: Awaited<ReturnType<typeof createHarness>>,
  events: any[]
) {
  await harness.send({ type: 'bridge:start-recording' });
  for (const event of events) {
    await harness.send({ type: 'bridge:record-event', event }, { tab: harness.tab });
  }
  const stopped = await harness.send({ type: 'bridge:stop-recording' });
  for (const action of stopped.draft.actions) {
    await harness.send({
      type: 'bridge:review-action',
      actionId: action.action_id,
      decision: 'approved',
    });
  }
  await harness.send({ type: 'bridge:finalize-review' });
  return stopped.draft;
}

describe('Browser Bridge extension state transitions', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('disconnects a connected tab when no recording is active', async () => {
    const harness = await createHarness();
    await harness.send({ type: 'bridge:connect-active-tab' });
    const response = await harness.send({ type: 'bridge:disconnect' });

    expect(response.ok).toBe(true);
    expect(response.state.connected).toBeNull();
  });

  it('pauses on navigation and resumes recording after reconnecting to the same origin', async () => {
    const harness = await createHarness();
    await harness.send({ type: 'bridge:start-recording' });
    await harness.send(
      { type: 'bridge:record-event', event: recordedEvent('最初の操作') },
      { tab: harness.tab }
    );
    await harness.update(harness.tab.id, { status: 'loading' });

    expect(harness.store.browserBridgeState.recording.pausedReason).toContain('ページ遷移');
    await harness.send({ type: 'bridge:connect-active-tab' });
    const resumed = await harness.send({ type: 'bridge:resume-recording' });
    await harness.send(
      { type: 'bridge:record-event', event: recordedEvent('次の操作') },
      { tab: harness.tab }
    );

    expect(resumed.ok).toBe(true);
    expect(harness.store.browserBridgeState.recording.actions).toHaveLength(2);
  });

  it('auto-resumes recording after a same-origin navigation completes', async () => {
    const harness = await createHarness();
    await harness.send({ type: 'bridge:start-recording' });
    await harness.update(harness.tab.id, { status: 'loading' });
    expect(harness.store.browserBridgeState.recording.pausedReason).toBeTruthy();

    await harness.update(
      harness.tab.id,
      { status: 'complete' },
      { url: 'https://example.com/next', title: 'Next' }
    );
    expect(harness.store.browserBridgeState.recording.pausedReason).toBeNull();
    expect(harness.store.browserBridgeState.notice).toContain('自動再開');
  });

  it('continues across a cross-origin navigation by recording a navigate handoff (segmented recording)', async () => {
    const harness = await createHarness();
    await harness.send({ type: 'bridge:start-recording' });
    await harness.update(harness.tab.id, { status: 'loading' });
    await harness.update(
      harness.tab.id,
      { status: 'complete' },
      { url: 'https://app.example.com/next', title: 'Sub' }
    );

    const rec = harness.store.browserBridgeState.recording;
    // Recording continues (not stuck paused) and the origin transition is captured.
    expect(rec.pausedReason).toBeNull();
    expect(rec.origin).toBe('https://app.example.com');
    expect(rec.origins).toContain('https://app.example.com');
    const handoff = rec.actions.find((a) => a.op === 'navigate');
    expect(handoff).toBeTruthy();
    expect(handoff.navigation).toEqual({
      from_origin: 'https://example.com',
      to_origin: 'https://app.example.com',
    });
    expect(harness.store.browserBridgeState.notice).toContain('handoff');
  });

  it('does not auto-resume when host access has not been granted', async () => {
    const harness = await createHarness();
    harness.hooks.hostAccess = false;
    await harness.send({ type: 'bridge:start-recording' });
    await harness.update(harness.tab.id, { status: 'loading' });
    await harness.update(
      harness.tab.id,
      { status: 'complete' },
      { url: 'https://example.com/next', title: 'Next' }
    );

    expect(harness.store.browserBridgeState.recording.pausedReason).toBeTruthy();
  });

  it('keeps every step when a burst of record-events arrives concurrently', async () => {
    const harness = await createHarness();
    await harness.send({ type: 'bridge:start-recording' });
    // Fire without awaiting between sends, mimicking input+change+click bursts.
    await Promise.all(
      Array.from({ length: 6 }, (_unused, i) =>
        harness.send(
          { type: 'bridge:record-event', event: recordedEvent(`操作${i}`, `@button_${i}_1`) },
          { tab: harness.tab }
        )
      )
    );
    expect(harness.store.browserBridgeState.recording.actions).toHaveLength(6);
  });

  it('requires action decisions before finalizing review', async () => {
    const harness = await createHarness();
    await harness.send({ type: 'bridge:start-recording' });
    await harness.send(
      { type: 'bridge:record-event', event: recordedEvent('承認する操作') },
      { tab: harness.tab }
    );
    await harness.send(
      { type: 'bridge:record-event', event: recordedEvent('除外する操作', '@button_2_1') },
      { tab: harness.tab }
    );
    const stopped = await harness.send({ type: 'bridge:stop-recording' });
    const [first, second] = stopped.draft.actions;

    const premature = await harness.send({ type: 'bridge:finalize-review' });
    await harness.send({
      type: 'bridge:review-action',
      actionId: first.action_id,
      decision: 'approved',
    });
    await harness.send({
      type: 'bridge:review-action',
      actionId: second.action_id,
      decision: 'rejected',
    });
    const finalized = await harness.send({ type: 'bridge:finalize-review' });

    expect(premature.ok).toBe(false);
    expect(finalized.ok).toBe(true);
    expect(finalized.state.lastDraft.review.status).toBe('approved');
    expect(finalized.state.lastDraft.review.decisions.map((entry: any) => entry.status)).toEqual([
      'approved',
      'rejected',
    ]);
  });

  it('records an option or toggle state without recording an input value', async () => {
    const harness = await createHarness();
    await harness.send({ type: 'bridge:start-recording' });
    const response = await harness.send(
      {
        type: 'bridge:record-event',
        event: {
          ...recordedEvent('通知を有効にする'),
          op: 'select_ref',
          selection: { kind: 'toggle', checked: true },
        },
      },
      { tab: harness.tab }
    );

    expect(response.ok).toBe(true);
    expect(response.state.recording.actions[0].selection).toEqual({
      kind: 'toggle',
      checked: true,
    });
    expect(response.state.recording.actions[0]).not.toHaveProperty('value');
  });

  it('executes approved low-risk steps with a lease and produces a completed receipt', async () => {
    const harness = await createHarness();
    await approveAllAndFinalize(harness, [recordedEvent('続行を選択')]);
    const result = await harness.send({ type: 'bridge:request-execution', values: {} });

    expect(result.status).toBe('completed');
    expect(result.receipt.kind).toBe('browser-extension-receipt.v1');
    expect(result.receipt.status).toBe('completed');
    expect(harness.store.browserBridgeState.execution.results[0].status).toBe('done');
    expect(harness.store.browserBridgeState.execution.receiptAck.status).toBe('recorded');
  });

  it('stops execution and cancels when the live target is ambiguous', async () => {
    const harness = await createHarness();
    harness.hooks.execute = () => ({ status: 'ambiguous', detail: '対象が変化しました' });
    await approveAllAndFinalize(harness, [recordedEvent('続行を選択')]);
    const result = await harness.send({ type: 'bridge:request-execution', values: {} });

    expect(result.status).toBe('cancelled');
    expect(result.receipt.status).toBe('cancelled');
  });

  it('blocks a high-risk step the lease did not approve', async () => {
    const harness = await createHarness();
    // Default native lease has empty approved_step_hashes, so submit_form is unauthorized.
    await approveAllAndFinalize(harness, [submitEvent('フォームを送信')]);
    const result = await harness.send({ type: 'bridge:request-execution', values: {} });

    expect(result.status).toBe('blocked');
    expect(harness.store.browserBridgeState.execution.results[0].status).toBe('blocked');
  });

  it('surfaces approval_required without executing when the bridge demands approval', async () => {
    const harness = await createHarness();
    harness.hooks.native = (payload: any) =>
      payload.type === 'request_execution'
        ? { ok: true, status: 'approval_required', request_id: 'REQ-1' }
        : defaultNative(payload);
    await approveAllAndFinalize(harness, [submitEvent('フォームを送信')]);
    const result = await harness.send({ type: 'bridge:request-execution', values: {} });

    expect(result.status).toBe('approval_required');
    expect(harness.store.browserBridgeState.execution.status).toBe('approval_required');
    expect(harness.store.browserBridgeState.execution.requestId).toBe('REQ-1');
  });

  it('reports a friendly error when the native host is not installed', async () => {
    const harness = await createHarness();
    harness.hooks.nativeError = 'Specified native messaging host not found.';
    await approveAllAndFinalize(harness, [recordedEvent('続行を選択')]);
    const result = await harness.send({ type: 'bridge:request-execution', values: {} });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('com.kyberion.browser_bridge');
  });
});
