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

async function createHarness() {
  let messageListener: MessageListener | undefined;
  let updateListener: ((tabId: number, changeInfo: any) => Promise<void>) | undefined;
  const store: Record<string, any> = {};
  const tab = { id: 42, windowId: 1, url: 'https://example.com/start', title: 'Example' };

  (globalThis as any).chrome = {
    action: { onClicked: { addListener: vi.fn() } },
    sidePanel: { open: vi.fn(async () => undefined) },
    runtime: {
      onMessage: { addListener: (listener: MessageListener) => { messageListener = listener; } },
      sendMessage: vi.fn(async () => undefined),
      getManifest: () => ({ version: '0.1.0' }),
    },
    tabs: {
      onUpdated: { addListener: (listener: typeof updateListener) => { updateListener = listener; } },
      query: vi.fn(async () => [tab]),
      sendMessage: vi.fn(async (_tabId: number, message: any) => {
        if (message.type === 'bridge:ping') return { ok: true };
        if (message.type === 'bridge:observe') return { title: tab.title, url: tab.url, origin: 'https://example.com', snapshotHash: HASH };
        return { ok: true };
      }),
    },
    scripting: { executeScript: vi.fn(async () => undefined) },
    storage: {
      session: {
        get: vi.fn(async (key: string) => ({ [key]: store[key] })),
        set: vi.fn(async (value: Record<string, any>) => Object.assign(store, value)),
      },
    },
  };

  vi.resetModules();
  await import('../tools/adf-replay-extension/background.js');
  if (!messageListener || !updateListener) throw new Error('Background listeners were not registered.');

  const send = async (message: Record<string, unknown>, sender: any = {}) => new Promise<any>((resolve) => {
    messageListener!(message, sender, resolve);
  });
  return { send, store, tab, update: updateListener! };
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
    await harness.send({ type: 'bridge:record-event', event: recordedEvent('最初の操作') }, { tab: harness.tab });
    await harness.update(harness.tab.id, { status: 'loading' });

    expect(harness.store.browserBridgeState.recording.pausedReason).toContain('再接続して続行');
    await harness.send({ type: 'bridge:connect-active-tab' });
    const resumed = await harness.send({ type: 'bridge:resume-recording' });
    await harness.send({ type: 'bridge:record-event', event: recordedEvent('次の操作') }, { tab: harness.tab });

    expect(resumed.ok).toBe(true);
    expect(harness.store.browserBridgeState.recording.actions).toHaveLength(2);
  });

  it('requires action decisions before finalizing review', async () => {
    const harness = await createHarness();
    await harness.send({ type: 'bridge:start-recording' });
    await harness.send({ type: 'bridge:record-event', event: recordedEvent('承認する操作') }, { tab: harness.tab });
    await harness.send({ type: 'bridge:record-event', event: recordedEvent('除外する操作', '@button_2_1') }, { tab: harness.tab });
    const stopped = await harness.send({ type: 'bridge:stop-recording' });
    const [first, second] = stopped.draft.actions;

    const premature = await harness.send({ type: 'bridge:finalize-review' });
    await harness.send({ type: 'bridge:review-action', actionId: first.action_id, decision: 'approved' });
    await harness.send({ type: 'bridge:review-action', actionId: second.action_id, decision: 'rejected' });
    const finalized = await harness.send({ type: 'bridge:finalize-review' });

    expect(premature.ok).toBe(false);
    expect(finalized.ok).toBe(true);
    expect(finalized.state.lastDraft.review.status).toBe('approved');
    expect(finalized.state.lastDraft.review.decisions.map((entry: any) => entry.status)).toEqual(['approved', 'rejected']);
  });

  it('records an option or toggle state without recording an input value', async () => {
    const harness = await createHarness();
    await harness.send({ type: 'bridge:start-recording' });
    const response = await harness.send({
      type: 'bridge:record-event',
      event: {
        ...recordedEvent('通知を有効にする'),
        op: 'select_ref',
        selection: { kind: 'toggle', checked: true },
      },
    }, { tab: harness.tab });

    expect(response.ok).toBe(true);
    expect(response.state.recording.actions[0].selection).toEqual({ kind: 'toggle', checked: true });
    expect(response.state.recording.actions[0]).not.toHaveProperty('value');
  });
});
