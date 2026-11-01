import { safeReadFile } from '@agent/core/secure-io';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateBrowserExtensionObservation } from '@agent/core/browser/browser-extension-bridge';
import { BROWSER_BRIDGE_OBSERVE_PROCEDURE_ID } from '@agent/core/browser/browser-bridge-mailbox';

type MessageListener = (message: any, sender: any, respond: (value: any) => void) => boolean;
const HASH = 'a'.repeat(64);
const SIDE_PANEL_SENDER = {
  id: 'kyberion-test',
  url: 'chrome-extension://kyberion-test/sidepanel.html',
};

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
  let connectListener: ((port: any) => void) | undefined;
  let installedListener: (() => void) | undefined;
  let alarmListener: ((alarm: { name: string }) => void) | undefined;
  let contextMenuListener: ((info: any, tab: any) => void) | undefined;
  const nativeCalls: any[] = [];
  const store: Record<string, any> = {};
  const tab = { id: 42, windowId: 1, url: 'https://example.com/start', title: 'Example' };
  const hooks = {
    native: (payload: any) => defaultNative(payload),
    nativeError: undefined as string | undefined,
    execute: (_step: any, _value: any): any => ({ status: 'done', detail: 'ok' }),
    hostAccess: true,
    piiScrubberReady: true,
    injectedFiles: [] as string[][],
    tabMessage: undefined as undefined | ((message: { type: string }) => unknown),
  };

  const chrome: any = {
    action: {
      onClicked: { addListener: vi.fn() },
      setBadgeText: vi.fn(async () => undefined),
      setBadgeBackgroundColor: vi.fn(async () => undefined),
    },
    sidePanel: { open: vi.fn(async () => undefined) },
    alarms: {
      onAlarm: {
        addListener: (listener: typeof alarmListener) => {
          alarmListener = listener;
        },
      },
      get: vi.fn(async () => undefined),
      create: vi.fn(async () => undefined),
    },
    contextMenus: {
      removeAll: vi.fn((callback?: () => void) => callback?.()),
      create: vi.fn((_props: any, callback?: () => void) => callback?.()),
      onClicked: {
        addListener: (listener: typeof contextMenuListener) => {
          contextMenuListener = listener;
        },
      },
    },
    notifications: {
      create: vi.fn(async (id: string) => id),
      clear: vi.fn(async () => true),
      onClicked: { addListener: vi.fn() },
    },
    runtime: {
      onMessage: {
        addListener: (listener: MessageListener) => {
          messageListener = listener;
        },
      },
      onConnect: {
        addListener: (listener: typeof connectListener) => {
          connectListener = listener;
        },
      },
      onInstalled: {
        addListener: (listener: typeof installedListener) => {
          installedListener = listener;
        },
      },
      sendMessage: vi.fn(async () => undefined),
      id: 'kyberion-test',
      getURL: (resource: string) => `chrome-extension://kyberion-test/${resource}`,
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
            nativeCalls.push(payload);
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
      get: vi.fn(async (tabId: number) =>
        tabId === tab.id ? { ...tab, status: 'complete' } : null
      ),
      sendMessage: vi.fn(async (_tabId: number, message: any) => {
        if (hooks.tabMessage) {
          const handled = hooks.tabMessage(message);
          if (handled !== undefined) return handled;
        }
        if (message.type === 'bridge:ping')
          return { ok: true, piiScrubberReady: hooks.piiScrubberReady };
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
    scripting: {
      executeScript: vi.fn(async (details: any) => {
        if (Array.isArray(details?.files)) hooks.injectedFiles.push(details.files);
        // Run the read-only WebMCP probe against the (stubbed) page navigator.
        if (details?.world === 'MAIN' && details.func?.name === 'probeWebMcpTools') {
          return [{ result: await details.func(...(details.args || [])) }];
        }
        return [];
      }),
    },
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
  if (
    !messageListener ||
    !updateListener ||
    !connectListener ||
    !installedListener ||
    !alarmListener ||
    !contextMenuListener
  )
    throw new Error('Background listeners were not registered.');

  // Messages default to the Side Panel (an extension page without a tab), the
  // only sender allowed to drive mailbox / send / discovery messages.
  const send = async (message: Record<string, unknown>, sender: any = SIDE_PANEL_SENDER) =>
    new Promise<any>((resolve) => {
      messageListener!(message, sender, resolve);
    });
  // A Side Panel `sidepanel` port, as chrome.runtime.connect would deliver it.
  const connectSidePanel = (sender: any = SIDE_PANEL_SENDER) => {
    const disconnectListeners: Array<() => void> = [];
    const port = {
      name: 'sidepanel',
      sender,
      posted: [] as any[],
      postMessage: vi.fn((message: any) => port.posted.push(message)),
      onMessage: { addListener: vi.fn() },
      onDisconnect: { addListener: (listener: () => void) => disconnectListeners.push(listener) },
      disconnect: () => disconnectListeners.forEach((listener) => listener()),
    };
    connectListener!(port);
    return port;
  };
  return {
    send,
    store,
    tab,
    update: updateListener!,
    hooks,
    chrome,
    nativeCalls,
    connectSidePanel,
    install: installedListener!,
    fireAlarm: (name: string) => alarmListener!({ name }),
    contextClick: (info: any, clickedTab: any = tab) => contextMenuListener!(info, clickedTab),
  };
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

  it('refreshes shared PII rules without redeclaring an existing content script', async () => {
    const harness = await createHarness();
    harness.hooks.piiScrubberReady = false;

    await harness.send({ type: 'bridge:connect-active-tab' });

    expect(harness.hooks.injectedFiles).toEqual([['pii-rules.generated.js']]);
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

  it('toggles the explicit extraction mode while recording', async () => {
    const harness = await createHarness();
    await harness.send({ type: 'bridge:start-recording' });

    const enabled = await harness.send({
      type: 'bridge:set-extraction-mode',
      enabled: true,
    });
    expect(enabled.state.extractionMode).toBe(true);

    const disabled = await harness.send({
      type: 'bridge:set-extraction-mode',
      enabled: false,
    });
    expect(disabled.state.extractionMode).toBe(false);
    expect(harness.store.browserBridgeState.notice).toContain('分析対象モードを終了しました');
  });

  it('toggles the conditional click target mode while recording', async () => {
    const harness = await createHarness();
    await harness.send({ type: 'bridge:start-recording' });

    const enabled = await harness.send({
      type: 'bridge:set-conditional-mode',
      enabled: true,
    });
    expect(enabled.state.conditionalMode).toBe(true);
    expect(enabled.state.extractionMode).toBe(false);

    const recorded = await harness.send(
      {
        type: 'bridge:record-event',
        event: {
          ...recordedEvent('承認ボタンが表示されていればクリック'),
          op: 'click_if_present',
        },
      },
      { tab: harness.tab }
    );
    expect(recorded.ok).toBe(true);
    expect(recorded.state.recording.actions[0].op).toBe('click_if_present');

    const disabled = await harness.send({
      type: 'bridge:set-conditional-mode',
      enabled: false,
    });
    expect(disabled.state.conditionalMode).toBe(false);
    expect(harness.store.browserBridgeState.notice).toContain(
      '条件付きクリック対象モードを終了しました'
    );
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

  it('keeps a captured success message as a reviewable low-risk wait step', async () => {
    const harness = await createHarness();
    await harness.send({ type: 'bridge:start-recording' });
    await harness.send(
      { type: 'bridge:record-event', event: recordedEvent('保存 を選択') },
      { tab: harness.tab }
    );
    await harness.send(
      {
        type: 'bridge:record-event',
        event: {
          op: 'wait_for_ref',
          summary: '完了表示「保存しました」を待つ',
          target: {
            ref: '@status_1x2y3z_1',
            role: 'status',
            name: '保存しました',
            snapshot_hash: HASH,
            dom_path: 'body > div > p',
          },
        },
      },
      { tab: harness.tab }
    );
    const actions = harness.store.browserBridgeState.recording.actions;
    expect(actions.map((action: { op: string }) => action.op)).toEqual([
      'click_ref',
      'wait_for_ref',
    ]);
    expect(actions[1]).toMatchObject({
      risk: 'low',
      target: { role: 'status', name: '保存しました', dom_path: 'body > div > p' },
    });
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

  it('surfaces approval_required for intent-driven procedure execution', async () => {
    const harness = await createHarness();
    harness.hooks.native = (payload: any) => {
      if (payload.type === 'prepare_procedure') {
        return {
          ok: true,
          origin: 'https://example.com',
          origins: ['https://example.com'],
          inputs: [],
          has_inputs: false,
        };
      }
      if (payload.type === 'dispatch_procedure')
        return { ok: true, status: 'approval_required', request_id: 'REQ-PROC-1' };
      return defaultNative(payload);
    };
    await harness.send({ type: 'bridge:connect-active-tab' });

    const result = await harness.send({
      type: 'bridge:execute-procedure',
      procedureId: 'example.proc',
    });

    expect(result.status).toBe('approval_required');
    expect(result.state.execution).toEqual({
      status: 'approval_required',
      requestId: 'REQ-PROC-1',
      procedureId: 'example.proc',
    });
  });

  it('sends golden evidence for a completed procedure run and shows the host verdict', async () => {
    const harness = await createHarness();
    const nativeCalls: Array<Record<string, unknown>> = [];
    harness.hooks.native = (payload) => {
      nativeCalls.push(payload);
      if (payload.type === 'prepare_procedure') {
        return {
          ok: true,
          origin: 'https://example.com',
          origins: ['https://example.com'],
          inputs: [],
          has_inputs: false,
        };
      }
      if (payload.type === 'dispatch_procedure') {
        return {
          ok: true,
          status: 'dispatched',
          lease: {
            lease_id: 'L-PROC',
            issued_at: '2026-06-23T00:00:00.000Z',
            expires_at: '2999-01-01T00:00:00.000Z',
            approved_step_hashes: [],
          },
          session: {
            mission_id: 'MSN-PROC-example.proc',
            pipeline_id: 'pipelines/browser/example.proc.json',
            recording_id: 'rec-1',
            tab_id: '42',
            origin: 'https://example.com',
          },
          compiled_steps: [
            { step_index: 0, op: 'click_ref', ref: '@button_1_1', role: 'button', name: 'Approve' },
          ],
          golden_scenario: {
            scenario_id: 'gs-1',
            success_conditions: [
              { kind: 'ref_visible', role: 'status', name_contains: 'approved' },
            ],
          },
        };
      }
      if (payload.type === 'submit_golden_evidence') {
        return {
          ok: true,
          status: 'judged',
          golden: {
            verdict: 'fail',
            conditions: [
              {
                kind: 'ref_visible',
                outcome: 'unmet',
                detail: 'visible "status approved" not found',
              },
            ],
          },
        };
      }
      return defaultNative(payload);
    };
    harness.hooks.tabMessage = (message) =>
      message.type === 'bridge:golden-evidence'
        ? {
            ok: true,
            elements: [{ role: 'alert', name: null, text: 'Session expired', visible: true }],
          }
        : undefined;
    await harness.send({ type: 'bridge:connect-active-tab' });

    await harness.send({ type: 'bridge:execute-procedure', procedureId: 'example.proc' });

    const receipt = nativeCalls.find((call) => call.type === 'submit_receipt')?.receipt as {
      receipt_id: string;
    };
    const evidence = nativeCalls.find((call) => call.type === 'submit_golden_evidence');
    expect(evidence).toMatchObject({
      procedure_id: 'example.proc',
      receipt_id: receipt.receipt_id,
      elements: [{ role: 'alert', text: 'Session expired' }],
    });
    const execution = harness.store.browserBridgeState.execution;
    expect(execution.status).toBe('verification_failed');
    expect(execution.golden).toMatchObject({ scenario_id: 'gs-1', verdict: 'fail' });
  });

  it('does not send golden evidence when the page returned none', async () => {
    const harness = await createHarness();
    const nativeCalls: Array<Record<string, unknown>> = [];
    harness.hooks.native = (payload) => {
      nativeCalls.push(payload);
      if (payload.type === 'prepare_procedure') {
        return {
          ok: true,
          origin: 'https://example.com',
          origins: ['https://example.com'],
          inputs: [],
          has_inputs: false,
        };
      }
      if (payload.type === 'dispatch_procedure') {
        return {
          ok: true,
          status: 'dispatched',
          lease: {
            lease_id: 'L-PROC',
            issued_at: '2026-06-23T00:00:00.000Z',
            expires_at: '2999-01-01T00:00:00.000Z',
            approved_step_hashes: [],
          },
          session: {
            mission_id: 'MSN-PROC-example.proc',
            pipeline_id: 'pipelines/browser/example.proc.json',
            recording_id: 'rec-1',
            tab_id: '42',
            origin: 'https://example.com',
          },
          compiled_steps: [
            { step_index: 0, op: 'click_ref', ref: '@button_1_1', role: 'button', name: 'Approve' },
          ],
          golden_scenario: {
            scenario_id: 'gs-1',
            success_conditions: [
              { kind: 'ref_visible', role: 'status', name_contains: 'approved' },
            ],
          },
        };
      }
      if (payload.type === 'submit_golden_evidence') {
        return {
          ok: true,
          status: 'judged',
          golden: {
            verdict: 'fail',
            conditions: [
              {
                kind: 'ref_visible',
                outcome: 'unmet',
                detail: 'visible "status approved" not found',
              },
            ],
          },
        };
      }
      return defaultNative(payload);
    };
    harness.hooks.tabMessage = (message) =>
      message.type === 'bridge:golden-evidence' ? { ok: false } : undefined;
    await harness.send({ type: 'bridge:connect-active-tab' });

    await harness.send({ type: 'bridge:execute-procedure', procedureId: 'example.proc' });

    expect(nativeCalls.some((call) => call.type === 'submit_golden_evidence')).toBe(false);
    const execution = harness.store.browserBridgeState.execution;
    expect(execution.status).toBe('completed');
    expect(execution.golden).toMatchObject({ scenario_id: 'gs-1', verdict: 'error' });
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

// ---------------------------------------------------------------------------
// Kyberion → extension pull mailbox (受信), page send (送信), WebMCP discovery
// ---------------------------------------------------------------------------

const RID = 'BBR-12345678-1234-4234-8234-123456789abc';
const RID2 = 'BBR-22345678-1234-4234-8234-123456789abc';

function mailboxRequest(kind: string, payload: any, overrides: Record<string, unknown> = {}) {
  return {
    request_id: RID,
    request_kind: kind,
    created_at: new Date(Date.now() - 1_000).toISOString(),
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    requested_by: { actor_id: 'agent-1', mission_id: 'MSN-BRIDGE' },
    scope: { tier: 'personal' },
    payload,
    status: 'delivered',
    ...overrides,
  };
}

function mailboxHost(
  harness: Awaited<ReturnType<typeof createHarness>>,
  requests: any[],
  approvals: any[] = []
) {
  harness.hooks.native = (payload: any) => {
    if (payload.type === 'poll_requests') return { ok: true, requests, approvals };
    if (payload.type === 'respond_request')
      return { ok: true, request_id: payload.request_id, status: payload.status };
    return defaultNative(payload);
  };
}

const flush = async (times = 5) => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

const respondCalls = (harness: Awaited<ReturnType<typeof createHarness>>) =>
  harness.nativeCalls.filter((call) => call.type === 'respond_request');
const pollCalls = (harness: Awaited<ReturnType<typeof createHarness>>) =>
  harness.nativeCalls.filter((call) => call.type === 'poll_requests');

function pageSourceHook(text = 'ページ本文 連絡先 user@example.com') {
  return (message: { type: string }) =>
    message.type === 'bridge:get-ai-page-source'
      ? {
          ok: true,
          url: 'https://example.com/start',
          origin: 'https://example.com',
          title: 'Example',
          text: (globalThis as any).__kyberionPiiScrub(text),
          truncated: false,
        }
      : undefined;
}

describe('Browser Bridge mailbox inbox (受信)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('declares only the alarms, contextMenus and notifications permissions it adds', () => {
    const manifest = JSON.parse(
      String(
        safeReadFile(path.resolve(__dirname, '../tools/adf-replay-extension/manifest.json'), {
          encoding: 'utf8',
        })
      )
    );
    expect(manifest.permissions).toEqual(
      expect.arrayContaining(['alarms', 'contextMenus', 'notifications', 'nativeMessaging'])
    );
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.optional_host_permissions).toEqual(['http://*/*', 'https://*/*']);
  });

  it('registers a handler for every inbox / send / discovery message', async () => {
    const harness = await createHarness();
    for (const type of [
      'bridge:get-inbox',
      'bridge:poll-inbox',
      'bridge:respond-request',
      'bridge:decline-request',
      'bridge:dismiss-request',
      'bridge:set-local-infer-auto',
      'bridge:send-page',
      'bridge:get-send-draft',
      'bridge:probe-webmcp',
      'bridge:submit-inspection',
    ]) {
      const response = await harness.send({ type });
      expect(response.error ?? '', type).not.toBe('Unsupported Browser Bridge message.');
    }
  });

  it('polls on the 1-minute alarm and fast-polls only while a side panel port is open', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const harness = await createHarness();
    mailboxHost(harness, []);
    await flush();
    expect(harness.chrome.alarms.create).toHaveBeenCalledWith('kyberion-bridge-mailbox', {
      periodInMinutes: 1,
    });

    // No side panel: the interval clock alone never polls.
    vi.advanceTimersByTime(30_000);
    await flush();
    expect(pollCalls(harness)).toHaveLength(0);

    harness.fireAlarm('kyberion-bridge-mailbox');
    await flush();
    expect(pollCalls(harness)).toHaveLength(1);

    const port = harness.connectSidePanel(); // connecting polls once immediately
    await flush();
    expect(pollCalls(harness)).toHaveLength(2);
    vi.advanceTimersByTime(5_000);
    await flush();
    vi.advanceTimersByTime(5_000);
    await flush();
    expect(pollCalls(harness)).toHaveLength(4);

    port.disconnect();
    vi.advanceTimersByTime(30_000);
    await flush();
    expect(pollCalls(harness)).toHaveLength(4);
  });

  it('stores the inbox, badges actionable items, and toasts new observe / approval items once', async () => {
    const harness = await createHarness();
    mailboxHost(
      harness,
      [
        mailboxRequest('observe_tab', { purpose: '在庫を確認', mode: 'text' }),
        mailboxRequest(
          'notify',
          {
            level: 'approval_pending',
            title: '送信の承認',
            body: 'b',
            approval_request_id: 'APR-1',
          },
          { request_id: RID2 }
        ),
        mailboxRequest(
          'notify',
          { level: 'info', title: '完了しました', body: 'b' },
          { request_id: 'BBR-32345678-1234-4234-8234-123456789abc' }
        ),
      ],
      [
        {
          request_id: 'APR-9',
          title: 'x',
          risk: 'high',
          requested_at: 'now',
          approve_command: 'pnpm kyberion approvals --approve APR-9',
        },
      ]
    );
    const port = harness.connectSidePanel();
    await flush();
    await harness.send({ type: 'bridge:poll-inbox' });

    expect(harness.store.browserBridgeInbox.requests).toHaveLength(3);
    expect(harness.chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: '2' });
    const toastIds = harness.chrome.notifications.create.mock.calls.map((call: any[]) => call[0]);
    expect(toastIds.sort()).toEqual([`kyberion-bbr-${RID}`, `kyberion-bbr-${RID2}`].sort());
    // The unchanged second poll neither re-toasts nor re-renders approvals.
    const changes = port.posted.filter((message) => message.type === 'bridge:inbox-changed');
    expect(changes).toHaveLength(1);
    expect(changes[0].approvalsChanged).toBe(true);
    expect(changes[0].inbox.approvals).toHaveLength(1);
    // Nothing was answered by polling.
    expect(respondCalls(harness)).toHaveLength(0);
  });

  it('never answers observe_tab without an explicit user action', async () => {
    const harness = await createHarness();
    mailboxHost(harness, [mailboxRequest('observe_tab', { purpose: '在庫を確認', mode: 'text' })]);
    harness.hooks.tabMessage = pageSourceHook();
    await harness.send({ type: 'bridge:connect-active-tab' });
    await harness.send({ type: 'bridge:poll-inbox' });
    harness.fireAlarm('kyberion-bridge-mailbox');
    harness.connectSidePanel();
    await flush();

    const silent = await harness.send({ type: 'bridge:respond-request', requestId: RID });
    expect(silent.ok).toBe(false);
    expect(respondCalls(harness)).toHaveLength(0);
    expect(harness.store.browserBridgeInbox.requests).toHaveLength(1);
  });

  it('answers an approved observe_tab with a schema-valid observation bound to the request', async () => {
    const harness = await createHarness();
    mailboxHost(harness, [
      mailboxRequest('observe_tab', {
        purpose: '在庫を確認',
        mode: 'text',
        allowed_origins: ['https://example.com'],
      }),
    ]);
    harness.hooks.tabMessage = pageSourceHook();
    await harness.send({ type: 'bridge:connect-active-tab' });
    await harness.send({ type: 'bridge:poll-inbox' });

    const response = await harness.send({
      type: 'bridge:respond-request',
      requestId: RID,
      userAction: true,
    });

    expect(response.ok).toBe(true);
    const [call] = respondCalls(harness);
    expect(call).toMatchObject({
      request_id: RID,
      status: 'completed',
      origin: 'https://example.com',
    });
    const observation = call.result.observation;
    expect(validateBrowserExtensionObservation(observation).valid).toBe(true);
    expect(observation).toMatchObject({
      procedure_id: BROWSER_BRIDGE_OBSERVE_PROCEDURE_ID,
      recording_id: RID,
      lease_id: `LEASE-${RID}`,
      origin: 'https://example.com',
      source: 'chrome-extension',
    });
    expect(JSON.stringify(observation)).not.toContain('user@example.com');
    expect(new TextEncoder().encode(JSON.stringify(call)).length).toBeLessThan(64 * 1024);
    expect(harness.store.browserBridgeInbox.requests).toHaveLength(0);
    expect(harness.chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: '' });
  });

  it('builds a structure observation without query strings', async () => {
    const harness = await createHarness();
    mailboxHost(harness, [mailboxRequest('observe_tab', { purpose: '構造', mode: 'structure' })]);
    harness.hooks.tabMessage = (message) =>
      message.type === 'bridge:inspect-page'
        ? {
            ok: true,
            inspection: {
              origin: 'https://example.com',
              title: 'Shop',
              headings: [{ level: 'h1', text: '在庫' }],
              inputs: [{ tag: 'input', type: 'text', label: '検索' }],
              buttons: [{ text: '検索する' }],
              links: [{ text: '詳細', href: 'https://example.com/item?token=abc#x' }],
              textExcerpt: '抜粋',
            },
          }
        : undefined;
    await harness.send({ type: 'bridge:connect-active-tab' });
    await harness.send({ type: 'bridge:poll-inbox' });
    await harness.send({ type: 'bridge:respond-request', requestId: RID, userAction: true });

    const observation = respondCalls(harness)[0].result.observation;
    expect(validateBrowserExtensionObservation(observation).valid).toBe(true);
    const links = observation.fields.find((field: any) => field.name === 'links');
    expect(links.text).toBe('詳細 → https://example.com/item');
  });

  it('refuses an observe_tab whose allowed_origins exclude the active tab', async () => {
    const harness = await createHarness();
    mailboxHost(harness, [
      mailboxRequest('observe_tab', {
        purpose: '在庫を確認',
        mode: 'text',
        allowed_origins: ['https://other.example'],
      }),
    ]);
    harness.hooks.tabMessage = pageSourceHook();
    await harness.send({ type: 'bridge:connect-active-tab' });
    await harness.send({ type: 'bridge:poll-inbox' });

    const response = await harness.send({
      type: 'bridge:respond-request',
      requestId: RID,
      userAction: true,
    });
    expect(response.ok).toBe(false);
    expect(response.error).toContain('https://other.example');
    expect(respondCalls(harness)).toHaveLength(0);
    expect(harness.store.browserBridgeInbox.requests).toHaveLength(1);
  });

  it('refuses observe_tab when the active tab is not the connected tab', async () => {
    const harness = await createHarness();
    mailboxHost(harness, [mailboxRequest('observe_tab', { purpose: 'x', mode: 'text' })]);
    await harness.send({ type: 'bridge:poll-inbox' });
    const response = await harness.send({
      type: 'bridge:respond-request',
      requestId: RID,
      userAction: true,
    });
    expect(response.ok).toBe(false);
    expect(respondCalls(harness)).toHaveLength(0);
  });

  it('declines a request and removes it from the inbox', async () => {
    const harness = await createHarness();
    mailboxHost(harness, [mailboxRequest('observe_tab', { purpose: 'x', mode: 'text' })]);
    await harness.send({ type: 'bridge:poll-inbox' });
    const response = await harness.send({ type: 'bridge:decline-request', requestId: RID });

    expect(response.ok).toBe(true);
    expect(respondCalls(harness)).toEqual([
      expect.objectContaining({ request_id: RID, status: 'declined' }),
    ]);
    expect(respondCalls(harness)[0].result).toBeUndefined();
    expect(harness.store.browserBridgeInbox.requests).toHaveLength(0);
  });

  it('drops expired items locally and never answers them', async () => {
    const harness = await createHarness();
    mailboxHost(harness, [
      mailboxRequest(
        'local_infer',
        { task: 'summarize', input: 'x' },
        {
          expires_at: new Date(Date.now() - 1_000).toISOString(),
        }
      ),
    ]);
    await harness.send({ type: 'bridge:poll-inbox' });
    expect(harness.store.browserBridgeInbox.requests).toHaveLength(0);

    // An item that lapses after delivery is removed on use, not answered.
    harness.store.browserBridgeInbox.requests = [
      mailboxRequest(
        'notify',
        { level: 'info', title: 't', body: 'b' },
        {
          expires_at: new Date(Date.now() - 1).toISOString(),
        }
      ),
    ];
    const ack = await harness.send({ type: 'bridge:respond-request', requestId: RID });
    const decline = await harness.send({ type: 'bridge:decline-request', requestId: RID });
    expect(ack.ok).toBe(false);
    expect(decline.ok).toBe(false);
    expect(respondCalls(harness)).toHaveLength(0);
    expect(harness.store.browserBridgeInbox.requests).toHaveLength(0);
  });

  it('keeps local_infer auto-answer off by default and validates the side-panel result', async () => {
    const harness = await createHarness();
    mailboxHost(harness, [mailboxRequest('local_infer', { task: 'summarize', input: '本文' })]);
    const initial = await harness.send({ type: 'bridge:get-inbox' });
    expect(initial.inbox.localInferAuto).toBe(false);
    await harness.send({ type: 'bridge:poll-inbox' });
    expect(respondCalls(harness)).toHaveLength(0);

    const executable = await harness.send({
      type: 'bridge:respond-request',
      requestId: RID,
      result: { provider: 'chrome-summarizer', task: 'summarize', output: 'x' },
    });
    expect(executable.ok).toBe(false);
    const wrongTask = await harness.send({
      type: 'bridge:respond-request',
      requestId: RID,
      result: { provider: 'p', task: 'classify', output: 'x', executable: false },
    });
    expect(wrongTask.ok).toBe(false);
    expect(respondCalls(harness)).toHaveLength(0);

    const ok = await harness.send({
      type: 'bridge:respond-request',
      requestId: RID,
      result: {
        provider: 'chrome-summarizer',
        task: 'summarize',
        output: '要約 user@example.com',
        truncated: false,
        executable: false,
      },
    });
    expect(ok.ok).toBe(true);
    expect(respondCalls(harness)[0].result).toEqual({
      provider: 'chrome-summarizer',
      task: 'summarize',
      output: '要約 [REDACTED:EMAIL_ADDRESS]',
      truncated: false,
      executable: false,
    });

    const toggled = await harness.send({ type: 'bridge:set-local-infer-auto', enabled: true });
    expect(toggled.inbox.localInferAuto).toBe(true);
  });

  it('reports an unavailable Built-in AI as a failed local_infer', async () => {
    const harness = await createHarness();
    mailboxHost(harness, [mailboxRequest('local_infer', { task: 'translate', input: 'hello' })]);
    await harness.send({ type: 'bridge:poll-inbox' });
    await harness.send({
      type: 'bridge:respond-request',
      requestId: RID,
      status: 'failed',
      error: 'Chrome 内蔵 AI でローカル推論を実行できませんでした: Translator API がありません',
    });
    expect(respondCalls(harness)[0]).toMatchObject({ status: 'failed' });
    expect(respondCalls(harness)[0].error).toContain('Chrome 内蔵 AI');
  });

  it('never answers an approval_pending notification, but acknowledges info', async () => {
    const harness = await createHarness();
    mailboxHost(harness, [
      mailboxRequest('notify', {
        level: 'approval_pending',
        title: '承認',
        body: 'b',
        approval_request_id: 'APR-1',
      }),
      mailboxRequest('notify', { level: 'info', title: 'i', body: 'b' }, { request_id: RID2 }),
    ]);
    await harness.send({ type: 'bridge:poll-inbox' });
    const approval = await harness.send({ type: 'bridge:respond-request', requestId: RID });
    expect(approval.ok).toBe(false);
    expect(respondCalls(harness)).toHaveLength(0);

    const dismissed = await harness.send({ type: 'bridge:dismiss-request', requestId: RID });
    expect(dismissed.ok).toBe(true);
    expect(respondCalls(harness)).toHaveLength(0);
    // A dismissed notice stays hidden on the next poll.
    await harness.send({ type: 'bridge:poll-inbox' });
    expect(harness.store.browserBridgeInbox.requests.map((r: any) => r.request_id)).toEqual([RID2]);

    const info = await harness.send({ type: 'bridge:respond-request', requestId: RID2 });
    expect(info.ok).toBe(true);
    expect(respondCalls(harness)).toEqual([
      expect.objectContaining({ request_id: RID2, status: 'completed' }),
    ]);
    expect(respondCalls(harness)[0].result).toBeUndefined();
  });
});

describe('Browser Bridge page send (送信) and context menu', () => {
  it('registers the context menu and only pre-fills the send form on click', async () => {
    const harness = await createHarness();
    harness.install();
    expect(harness.chrome.contextMenus.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Kyberion に送る', contexts: ['page', 'selection'] }),
      expect.any(Function)
    );

    harness.contextClick({
      menuItemId: 'kyberion-send-page',
      selectionText: '選択した文 user@example.com',
    });
    await flush();

    expect(harness.chrome.sidePanel.open).toHaveBeenCalledWith({ windowId: 1 });
    const draft = harness.store.browserBridgeSendDraft;
    expect(draft).toMatchObject({
      url_origin: 'https://example.com',
      selection_only: true,
      text: '選択した文 [REDACTED:EMAIL_ADDRESS]',
    });
    expect(harness.nativeCalls.some((call) => call.type === 'send_page')).toBe(false);
  });

  it('pre-fills the whole page through the scrubbed page source when nothing is selected', async () => {
    const harness = await createHarness();
    harness.hooks.tabMessage = pageSourceHook();
    harness.contextClick({ menuItemId: 'kyberion-send-page' });
    await flush(10);
    expect(harness.store.browserBridgeSendDraft).toMatchObject({
      selection_only: false,
      text: 'ページ本文 連絡先 [REDACTED:EMAIL_ADDRESS]',
    });
    expect(harness.nativeCalls.some((call) => call.type === 'send_page')).toBe(false);
  });

  it('enforces tier rules before sending and re-scrubs the text', async () => {
    const harness = await createHarness();
    const form = {
      mode: 'knowledge',
      tier: 'public',
      title: 'Example',
      urlOrigin: 'https://example.com',
      text: '本文 user@example.com',
      selectionOnly: false,
    };
    const unconfirmed = await harness.send({ type: 'bridge:send-page', form });
    expect(unconfirmed.ok).toBe(false);
    const noTenant = await harness.send({
      type: 'bridge:send-page',
      form: { ...form, tier: 'confidential' },
    });
    expect(noTenant.ok).toBe(false);
    expect(harness.nativeCalls.some((call) => call.type === 'send_page')).toBe(false);

    harness.hooks.native = (payload: any) =>
      payload.type === 'send_page'
        ? {
            ok: true,
            mode: 'knowledge',
            staged_ref: 'active/shared/staging/personal/shared/browser-bridge/x.md',
            ingest: { status: 'staged', next: 'pnpm knowledge:ingest --file x' },
            page: {},
          }
        : defaultNative(payload);
    const sent = await harness.send({
      type: 'bridge:send-page',
      form: { ...form, tier: 'personal' },
    });
    expect(sent.ok).toBe(true);
    const call = harness.nativeCalls.find((entry) => entry.type === 'send_page');
    expect(call).toMatchObject({
      mode: 'knowledge',
      tier: 'personal',
      url_origin: 'https://example.com',
      text: '本文 [REDACTED:EMAIL_ADDRESS]',
      selection_only: false,
    });
    expect(sent.sendResult.ingest.status).toBe('staged');
  });

  it('stores an intent resolution so the Intent tab can offer Pattern B', async () => {
    const harness = await createHarness();
    harness.hooks.native = (payload: any) =>
      payload.type === 'send_page'
        ? {
            ok: true,
            mode: 'intent',
            resolution: {
              outcome: 'matched',
              best: { procedure_id: 'shop.check', confidence: 0.9 },
              candidates: [],
            },
            page: {},
          }
        : defaultNative(payload);
    const sent = await harness.send({
      type: 'bridge:send-page',
      form: {
        mode: 'intent',
        tier: 'personal',
        title: 'Shop',
        urlOrigin: 'https://example.com',
        text: '在庫',
        selectionOnly: true,
        note: '在庫を確認して',
      },
    });
    expect(sent.ok).toBe(true);
    expect(harness.store.browserBridgeState.intentResolution).toMatchObject({
      intent: '在庫を確認して',
      outcome: 'matched',
      best: { procedure_id: 'shop.check' },
    });
  });
});

describe('Browser Bridge WebMCP discovery (read-only)', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubWebMcp(count: number) {
    const execute = vi.fn();
    const executeTool = vi.fn();
    const tools = Array.from({ length: count }, (_, index) => ({
      name: `tool_${index}`,
      description: `連絡 user${index}@example.com`,
      inputSchema: JSON.stringify({ type: 'object', properties: { query: {}, limit: {} } }),
      execute,
    }));
    vi.stubGlobal('navigator', {
      modelContextTesting: { listTools: vi.fn(async () => tools), executeTool },
      modelContext: { executeTool, registerTool: vi.fn(), provideContext: vi.fn() },
    });
    return { execute, executeTool };
  }

  it('lists at most 50 tools, scrubbed, without ever invoking one', async () => {
    const harness = await createHarness();
    const spies = stubWebMcp(60);
    await harness.send({ type: 'bridge:connect-active-tab' });
    const response = await harness.send({ type: 'bridge:probe-webmcp' });

    expect(response.ok).toBe(true);
    expect(response.webmcp.supported).toBe(true);
    expect(response.webmcp.truncated).toBe(true);
    expect(response.webmcp.tools).toHaveLength(50);
    expect(response.webmcp.tools[0]).toEqual({
      name: 'tool_0',
      description: '連絡 [REDACTED:EMAIL_ADDRESS]',
      input_keys: ['query', 'limit'],
    });
    expect(spies.execute).not.toHaveBeenCalled();
    expect(spies.executeTool).not.toHaveBeenCalled();
    const probeCall = harness.chrome.scripting.executeScript.mock.calls.find(
      (call: any[]) => call[0].func?.name === 'probeWebMcpTools'
    );
    expect(probeCall[0].world).toBe('MAIN');
  });

  it('does not throw on pages without the API', async () => {
    const harness = await createHarness();
    vi.stubGlobal('navigator', {});
    await harness.send({ type: 'bridge:connect-active-tab' });
    const response = await harness.send({ type: 'bridge:probe-webmcp' });
    expect(response.ok).toBe(true);
    expect(response.webmcp).toMatchObject({ supported: false, tools: [] });

    vi.stubGlobal('navigator', {
      get modelContextTesting() {
        throw new Error('blocked');
      },
    });
    const hostile = await harness.send({ type: 'bridge:probe-webmcp' });
    expect(hostile.ok).toBe(true);
    expect(hostile.webmcp.tools).toEqual([]);
  });

  it('attaches discovered tools to an observe_tab response', async () => {
    const harness = await createHarness();
    stubWebMcp(2);
    mailboxHost(harness, [mailboxRequest('observe_tab', { purpose: 'x', mode: 'text' })]);
    harness.hooks.tabMessage = pageSourceHook();
    await harness.send({ type: 'bridge:connect-active-tab' });
    await harness.send({ type: 'bridge:poll-inbox' });
    await harness.send({ type: 'bridge:respond-request', requestId: RID, userAction: true });
    expect(respondCalls(harness)[0].result.webmcp_tools).toHaveLength(2);
  });
});

describe('Browser Bridge mailbox hardening', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('times out a WebMCP listTools() that never settles', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const harness = await createHarness();
    vi.stubGlobal('navigator', {
      modelContextTesting: { listTools: () => new Promise(() => undefined) },
    });
    await harness.send({ type: 'bridge:connect-active-tab' });

    const pending = harness.send({ type: 'bridge:probe-webmcp' });
    await vi.advanceTimersByTimeAsync(1_600);
    const response = await pending;

    expect(response.ok).toBe(true);
    expect(response.webmcp).toMatchObject({ supported: true, tools: [] });
  });

  it('never lets a wedged WebMCP probe hold the inbox lock', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const harness = await createHarness();
    mailboxHost(harness, [mailboxRequest('observe_tab', { purpose: 'x', mode: 'text' })]);
    harness.hooks.tabMessage = pageSourceHook();
    await harness.send({ type: 'bridge:connect-active-tab' });
    await harness.send({ type: 'bridge:poll-inbox' });
    harness.chrome.scripting.executeScript.mockImplementation(
      async (details: { func?: { name?: string } }) =>
        details?.func?.name === 'probeWebMcpTools' ? new Promise(() => undefined) : []
    );

    const respond = harness.send({
      type: 'bridge:respond-request',
      requestId: RID,
      userAction: true,
    });
    const inbox = harness.send({ type: 'bridge:get-inbox' });
    await vi.advanceTimersByTimeAsync(3_100);

    const answered = await respond;
    expect(answered.ok).toBe(true);
    expect(respondCalls(harness)[0].status).toBe('completed');
    expect(respondCalls(harness)[0].result.webmcp_tools).toBeUndefined();
    expect((await inbox).ok).toBe(true);
  });

  it('reads only own data fields of WebMCP tools and stops walking at the cap', async () => {
    const harness = await createHarness();
    let reads = 0;
    const entries = Array.from({ length: 10_000 }, (_, index) => ({
      name: `tool_${index}`,
      inputSchema: { properties: { q: {} } },
    }));
    const list = new Proxy(entries, {
      getOwnPropertyDescriptor(target, key) {
        if (typeof key === 'string' && /^\d+$/.test(key)) reads += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) reads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const getter = vi.fn(() => 'from_getter');
    const hostile = {
      get name() {
        throw new Error('boom');
      },
    };
    const sneaky = Object.defineProperty({}, 'name', { get: getter, enumerable: true });
    vi.stubGlobal('navigator', {
      modelContextTesting: { listTools: async () => [hostile, sneaky, { name: 'safe' }] },
    });
    await harness.send({ type: 'bridge:connect-active-tab' });
    const first = await harness.send({ type: 'bridge:probe-webmcp' });
    expect(first.webmcp.tools).toEqual([{ name: 'safe', input_keys: [] }]);
    expect(getter).not.toHaveBeenCalled();

    vi.stubGlobal('navigator', { modelContextTesting: { listTools: async () => list } });
    const capped = await harness.send({ type: 'bridge:probe-webmcp' });
    expect(capped.webmcp.tools).toHaveLength(50);
    expect(capped.webmcp.truncated).toBe(true);
    expect(reads).toBeLessThanOrEqual(60);
  });

  it('accepts mailbox, send and discovery messages only from the Side Panel', async () => {
    const harness = await createHarness();
    mailboxHost(harness, [mailboxRequest('notify', { level: 'info', title: 't', body: 'b' })]);
    const contentScript = { id: 'kyberion-test', tab: harness.tab, url: harness.tab.url };
    const otherPage = { id: 'kyberion-test', url: 'chrome-extension://kyberion-test/options.html' };
    for (const sender of [contentScript, otherPage, {}]) {
      for (const type of [
        'bridge:get-inbox',
        'bridge:poll-inbox',
        'bridge:respond-request',
        'bridge:decline-request',
        'bridge:dismiss-request',
        'bridge:set-local-infer-auto',
        'bridge:send-page',
        'bridge:get-send-draft',
        'bridge:probe-webmcp',
      ]) {
        const response = await harness.send({ type, requestId: RID }, sender);
        expect(response.ok, type).toBe(false);
        expect(response.error).toContain('Side Panel');
      }
    }
    expect(harness.nativeCalls).toHaveLength(0);

    // A content script still records events and reads state as before.
    const state = await harness.send({ type: 'bridge:get-state' }, contentScript);
    expect(state.ok).toBe(true);
    // The genuine Side Panel is served.
    expect((await harness.send({ type: 'bridge:poll-inbox' })).ok).toBe(true);
  });

  it('ignores a sidepanel port that does not come from the Side Panel', async () => {
    const harness = await createHarness();
    mailboxHost(harness, []);
    const port = harness.connectSidePanel({
      id: 'kyberion-test',
      tab: harness.tab,
      url: harness.tab.url,
    });
    await flush();
    expect(pollCalls(harness)).toHaveLength(0);
    port.disconnect();
    harness.connectSidePanel();
    await flush();
    expect(pollCalls(harness)).toHaveLength(1);
  });

  it('bounds an oversized object local_infer output and marks it truncated', async () => {
    const harness = await createHarness();
    mailboxHost(harness, [mailboxRequest('local_infer', { task: 'extract', input: 'x' })]);
    await harness.send({ type: 'bridge:poll-inbox' });

    const response = await harness.send({
      type: 'bridge:respond-request',
      requestId: RID,
      result: {
        provider: 'chrome-prompt',
        task: 'extract',
        output: {
          body: 'あ'.repeat(40_000),
          items: Array.from({ length: 150 }, (_, index) => `item ${index} ${'y'.repeat(400)}`),
        },
        truncated: false,
        executable: false,
      },
    });

    expect(response.ok).toBe(true);
    const [call] = respondCalls(harness);
    expect(call.status).toBe('completed');
    expect(call.result.truncated).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(call)).length).toBeLessThan(64 * 1024);
  });

  it('answers failed when an object local_infer output cannot fit', async () => {
    const harness = await createHarness();
    mailboxHost(harness, [mailboxRequest('local_infer', { task: 'extract', input: 'x' })]);
    await harness.send({ type: 'bridge:poll-inbox' });
    // Keys are never trimmed, so 64 x 64 long keys cannot be bounded.
    const key = (index: number) => `${index}`.padEnd(120, 'k');
    const output = Object.fromEntries(
      Array.from({ length: 64 }, (_, outer) => [
        key(outer),
        Object.fromEntries(Array.from({ length: 64 }, (_, inner) => [key(inner), ''])),
      ])
    );

    const response = await harness.send({
      type: 'bridge:respond-request',
      requestId: RID,
      result: { provider: 'chrome-prompt', task: 'extract', output, executable: false },
    });

    expect(response.ok).toBe(true);
    const [call] = respondCalls(harness);
    expect(call.status).toBe('failed');
    expect(call.error).toContain('大きすぎる');
    expect(harness.store.browserBridgeInbox.requests).toHaveLength(0);
  });

  it('drops local_infer output nested past the scrub depth instead of passing it through', async () => {
    const harness = await createHarness();
    mailboxHost(harness, [mailboxRequest('local_infer', { task: 'extract', input: 'x' })]);
    await harness.send({ type: 'bridge:poll-inbox' });
    let deep: Record<string, unknown> = { mail: 'user@example.com' };
    for (let level = 0; level < 9; level++) deep = { next: deep };

    await harness.send({
      type: 'bridge:respond-request',
      requestId: RID,
      result: {
        provider: 'chrome-prompt',
        task: 'extract',
        output: { 'user@example.com': deep },
        executable: false,
      },
    });

    const [call] = respondCalls(harness);
    expect(call.status).toBe('completed');
    expect(JSON.stringify(call.result)).not.toContain('user@example.com');
  });

  it('aborts observe_tab when the extracted document is from another origin', async () => {
    const harness = await createHarness();
    mailboxHost(harness, [mailboxRequest('observe_tab', { purpose: 'x', mode: 'text' })]);
    await harness.send({ type: 'bridge:connect-active-tab' });
    await harness.send({ type: 'bridge:poll-inbox' });
    const source = pageSourceHook();
    for (const origin of ['https://evil.example', undefined]) {
      harness.hooks.tabMessage = (message) => {
        const response = source(message) as Record<string, unknown> | undefined;
        return response ? { ...response, origin } : undefined;
      };
      const response = await harness.send({
        type: 'bridge:respond-request',
        requestId: RID,
        userAction: true,
      });
      expect(response.ok).toBe(false);
      expect(response.error).toContain('接続先が変わった');
    }
    expect(respondCalls(harness)).toHaveLength(0);
    expect(harness.store.browserBridgeInbox.requests).toHaveLength(1);
  });
});

describe('Browser Bridge observe_tab page stalls', () => {
  afterEach(() => vi.useRealTimers());

  const never = () => new Promise<never>(() => undefined);

  it('does not block concurrent polls or declines while the page is stalled', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const harness = await createHarness();
    mailboxHost(harness, [
      mailboxRequest('observe_tab', { purpose: 'x', mode: 'text' }),
      mailboxRequest('notify', { level: 'info', title: 'i', body: 'b' }, { request_id: RID2 }),
    ]);
    await harness.send({ type: 'bridge:connect-active-tab' });
    await harness.send({ type: 'bridge:poll-inbox' });
    // An open alert() in the page: the content script never answers.
    harness.hooks.tabMessage = (message: { type: string }) =>
      message.type === 'bridge:ping' ? never() : undefined;

    let settled = false;
    const respond = harness.send({
      type: 'bridge:respond-request',
      requestId: RID,
      userAction: true,
    });
    void respond.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);

    expect((await harness.send({ type: 'bridge:poll-inbox' })).ok).toBe(true);
    const declined = await harness.send({ type: 'bridge:decline-request', requestId: RID2 });
    expect(declined.ok).toBe(true);
    expect(respondCalls(harness)).toEqual([
      expect.objectContaining({ request_id: RID2, status: 'declined' }),
    ]);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(10_100);
    expect((await respond).ok).toBe(false);
  });

  it('fails an observe_tab with a timeout error and sends nothing when extraction stalls', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const harness = await createHarness();
    mailboxHost(harness, [mailboxRequest('observe_tab', { purpose: 'x', mode: 'text' })]);
    await harness.send({ type: 'bridge:connect-active-tab' });
    await harness.send({ type: 'bridge:poll-inbox' });
    harness.hooks.tabMessage = (message: { type: string }) =>
      message.type === 'bridge:get-ai-page-source' ? never() : undefined;

    const respond = harness.send({
      type: 'bridge:respond-request',
      requestId: RID,
      userAction: true,
    });
    await vi.advanceTimersByTimeAsync(10_100);
    const response = await respond;

    expect(response.ok).toBe(false);
    expect(response.error).toContain('ページの応答がない');
    expect(respondCalls(harness)).toHaveLength(0);
    expect(harness.store.browserBridgeInbox.requests).toHaveLength(1);
  });

  it('does not answer an observe_tab that was declined while its page was read', async () => {
    const harness = await createHarness();
    mailboxHost(harness, [mailboxRequest('observe_tab', { purpose: 'x', mode: 'text' })]);
    await harness.send({ type: 'bridge:connect-active-tab' });
    await harness.send({ type: 'bridge:poll-inbox' });
    let release: (value: unknown) => void = () => undefined;
    const source = pageSourceHook();
    harness.hooks.tabMessage = (message: { type: string }) =>
      message.type === 'bridge:get-ai-page-source'
        ? new Promise((resolve) => {
            release = () => resolve(source(message));
          })
        : undefined;

    const respond = harness.send({
      type: 'bridge:respond-request',
      requestId: RID,
      userAction: true,
    });
    await flush();
    expect((await harness.send({ type: 'bridge:decline-request', requestId: RID })).ok).toBe(true);
    release(undefined);
    const response = await respond;

    expect(response.ok).toBe(false);
    expect(respondCalls(harness)).toEqual([
      expect.objectContaining({ request_id: RID, status: 'declined' }),
    ]);
  });
});

describe('Browser Bridge page inspection hand-off (Native Messaging only)', () => {
  function inspectHook() {
    return (message: { type: string }) =>
      message.type === 'bridge:inspect-page'
        ? {
            ok: true,
            inspection: {
              mode: 'extension',
              url: 'https://example.com/start?token=secret#frag',
              origin: 'https://example.com',
              title: 'Example',
              headings: [{ level: 'h1', text: 'Hello user@example.com' }],
              inputs: [{ tag: 'input', type: 'email', name: 'mail', value: 'leak@example.com' }],
              buttons: [{ text: 'Send' }],
              links: [{ text: 'Next', href: 'https://example.com/next?session=abc' }],
              textExcerpt: 'Body',
            },
          }
        : undefined;
  }

  it('re-inspects the connected tab and sends a scrubbed submit_inspection to the native host', async () => {
    const harness = await createHarness();
    harness.hooks.tabMessage = inspectHook();
    harness.hooks.native = (payload: { type: string }) =>
      payload.type === 'submit_inspection'
        ? {
            ok: true,
            ticket_id: 'BIH-1',
            scope: { tier: 'personal' },
            counts: { headings: 1, inputs: 1, buttons: 1, links: 1 },
            truncated: false,
          }
        : defaultNative(payload);
    await harness.send({ type: 'bridge:connect-active-tab' });
    const sent = await harness.send({ type: 'bridge:submit-inspection', pairingCode: 'abc-234' });

    expect(sent.ok).toBe(true);
    expect(sent.submitResult).toMatchObject({ ticket_id: 'BIH-1', scope: { tier: 'personal' } });
    const call = harness.nativeCalls.find((entry) => entry.type === 'submit_inspection');
    expect(call.pairing_code).toBe('ABC234');
    expect(call.inspection).toMatchObject({
      url: 'https://example.com/start',
      origin: 'https://example.com',
      headings: [{ level: 'h1', text: 'Hello [REDACTED:EMAIL_ADDRESS]' }],
      links: [{ text: 'Next', href: 'https://example.com/next' }],
    });
    expect(call.inspection.inputs[0]).not.toHaveProperty('value');
  });

  it('explains when no CLI is waiting', async () => {
    const harness = await createHarness();
    harness.hooks.tabMessage = inspectHook();
    harness.hooks.native = (payload: { type: string }) =>
      payload.type === 'submit_inspection'
        ? { ok: false, code: 'no_waiting_cli', error: 'none' }
        : defaultNative(payload);
    await harness.send({ type: 'bridge:connect-active-tab' });
    const sent = await harness.send({ type: 'bridge:submit-inspection', pairingCode: 'abc-234' });
    expect(sent.ok).toBe(false);
    expect(sent.error).toContain('pnpm kyberion browser inspect --mode extension');
  });

  it('refuses submit-inspection from a content script', async () => {
    const harness = await createHarness();
    harness.hooks.tabMessage = inspectHook();
    await harness.send({ type: 'bridge:connect-active-tab' });
    const sent = await harness.send(
      { type: 'bridge:submit-inspection', pairingCode: 'ABC234' },
      { tab: harness.tab }
    );
    expect(sent.ok).toBe(false);
    expect(harness.nativeCalls.some((entry) => entry.type === 'submit_inspection')).toBe(false);
  });

  it('requires a pairing code and a connected tab before calling the host', async () => {
    const harness = await createHarness();
    harness.hooks.tabMessage = inspectHook();
    const unconnected = await harness.send({
      type: 'bridge:submit-inspection',
      pairingCode: 'ABC234',
    });
    expect(unconnected.ok).toBe(false);
    await harness.send({ type: 'bridge:connect-active-tab' });
    const noCode = await harness.send({ type: 'bridge:submit-inspection' });
    expect(noCode.ok).toBe(false);
    expect(noCode.error).toContain('ペアリングコード');
    expect(harness.nativeCalls.some((entry) => entry.type === 'submit_inspection')).toBe(false);
  });

  it('explains a pairing mismatch from the host', async () => {
    const harness = await createHarness();
    harness.hooks.tabMessage = inspectHook();
    harness.hooks.native = (payload: { type: string }) =>
      payload.type === 'submit_inspection'
        ? { ok: false, code: 'pairing_mismatch', error: 'x' }
        : defaultNative(payload);
    await harness.send({ type: 'bridge:connect-active-tab' });
    const sent = await harness.send({ type: 'bridge:submit-inspection', pairingCode: 'ABC234' });
    expect(sent.ok).toBe(false);
    expect(sent.error).toContain('一致しません');
  });

  it('has no loopback HTTP hand-off left in the side panel', () => {
    const read = (file: string) =>
      String(
        safeReadFile(path.resolve(__dirname, '../tools/adf-replay-extension', file), {
          encoding: 'utf8',
        })
      );
    const panel = read('sidepanel.js');
    expect(panel).not.toMatch(/fetch\(\s*`http:\/\/127\.0\.0\.1/);
    expect(panel).not.toContain('inspectCliPort');
    expect(read('sidepanel.html')).not.toContain('inspect-port-input');
    expect(read('background.js')).not.toMatch(/https?:\/\/(127\.0\.0\.1|localhost)/);
  });
});
