import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AxHandlerContext } from './system-desktop-ax.js';

// Typed views over the handler's `Record<string, unknown>` result — keeps the
// suite ratchet-clean (no `as any`) while still checking loose contract fields.
type AxResultContext = {
  data?: { available?: boolean; version?: string; snapshot_id?: string } & Record<string, unknown>;
  detail?: string;
  install?: string;
  approval_request_id?: string;
  verification?: { matched?: boolean; expected?: unknown; observed?: unknown };
};
type AxDisposition = { delivery?: string; retry?: string };
type AxRecovery = { strategy?: string; retryable?: boolean };

const availability = vi.fn(() => ({ available: true, bin: '/managed/bin/agent-desktop' }));
const runCommand = vi.fn();
const endSession = vi.fn(() => ({ ok: true, envelope: { ok: true } }));
const gcSessions = vi.fn(() => ({ ok: true, envelope: { ok: true } }));
const createApproval = vi.fn(() => ({ id: 'approval-ax-1', status: 'pending' }));
const loadApproval = vi.fn(() => ({ status: 'approved' }));

vi.mock('@agent/core/desktop-ax-bridge', () => ({
  agentDesktopAvailability: () => availability(),
  runAgentDesktopCommand: (...args: unknown[]) => runCommand(...args),
  endAgentDesktopSession: (...args: unknown[]) => endSession(...args),
  gcAgentDesktopSessions: (...args: unknown[]) => gcSessions(...args),
}));

vi.mock('@agent/core/governance', () => ({
  createApprovalRequest: (...args: unknown[]) => createApproval(...args),
  loadApprovalRequest: (...args: unknown[]) => loadApproval(...args),
}));

vi.mock('@agent/core/governance/approval-store', () => ({
  approvalUsabilityRefusal: vi.fn(() => undefined),
}));

vi.mock('@agent/core/virtual/computer-surface', () => ({
  emitComputerSurfacePatch: vi.fn(),
}));

const baseInteraction = (over: Record<string, unknown> = {}) => ({
  type: 'ax_click',
  qualified_ref: '@s8f3k2p9:e8',
  approval_request_id: 'req-1',
  ...over,
});

describe('system-desktop-ax', () => {
  beforeEach(() => {
    availability
      .mockReset()
      .mockReturnValue({ available: true, bin: '/managed/bin/agent-desktop' });
    runCommand.mockReset();
    createApproval.mockClear();
    loadApproval.mockReset().mockReturnValue({ status: 'approved' });
  });

  const ctx = (): AxHandlerContext => ({ sessionId: 'sess-1', emitPatch: vi.fn() });

  it('ax_runtime_status answers even when the runtime is absent (preflight)', async () => {
    availability.mockReturnValue({ available: false, detail: 'not installed' });
    const { handleAxInteraction } = await import('./system-desktop-ax.js');
    const result = await handleAxInteraction(
      baseInteraction({ type: 'ax_runtime_status', qualified_ref: undefined }),
      ctx()
    );
    expect(result.status).toBe('succeeded');
    expect((result.context as AxResultContext).data.available).toBe(false);
    expect((result.context as AxResultContext).install).toContain('tool:setup');
    expect(result.evidence).toMatchObject({ available: 'known', bin: 'absent' });
    expect(runCommand).not.toHaveBeenCalled();
    expect(createApproval).not.toHaveBeenCalled();
  });

  it('ax_runtime_status reports bin and version when installed', async () => {
    availability.mockReturnValue({
      available: true,
      bin: '/managed/bin/agent-desktop',
      version: '1.0.2',
    });
    const { handleAxInteraction } = await import('./system-desktop-ax.js');
    const result = await handleAxInteraction(
      baseInteraction({ type: 'ax_runtime_status', qualified_ref: undefined }),
      ctx()
    );
    expect(result.status).toBe('succeeded');
    expect((result.context as AxResultContext).data).toMatchObject({
      available: true,
      version: '1.0.2',
    });
    expect(result.evidence).toMatchObject({ bin: 'known', version: 'known' });
  });

  it('fails closed TOOL_UNAVAILABLE when the runtime is absent', async () => {
    availability.mockReturnValue({ available: false, detail: 'not installed' });
    const { handleAxInteraction } = await import('./system-desktop-ax.js');
    const result = await handleAxInteraction(baseInteraction({ type: 'ax_snapshot' }), ctx());
    expect(result.status).toBe('failed');
    expect(result.code).toBe('TOOL_UNAVAILABLE');
    expect((result.disposition as AxDisposition).delivery).toBe('not_delivered');
    expect((result.recovery as AxRecovery).strategy).toBe('install_tool_runtime');
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('refuses bare refs before spawning (fail-closed qualified_ref)', async () => {
    const { handleAxInteraction } = await import('./system-desktop-ax.js');
    const result = await handleAxInteraction(baseInteraction({ qualified_ref: '@e8' }), ctx());
    expect(result.status).toBe('failed');
    expect(result.code).toBe('INVALID_ARGS');
    expect((result.context as AxResultContext).detail).toContain('snapshot-qualified');
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('runs ax_snapshot without approval as an observation op', async () => {
    runCommand.mockReturnValue({
      ok: true,
      envelope: { ok: true, data: { snapshot_id: 's8f3k2p9', elements: [] } },
    });
    const { handleAxInteraction } = await import('./system-desktop-ax.js');
    const result = await handleAxInteraction(
      baseInteraction({ type: 'ax_snapshot', qualified_ref: undefined, application: 'Finder' }),
      ctx()
    );
    expect(result.status).toBe('succeeded');
    expect((result.context as AxResultContext).data.snapshot_id).toBe('s8f3k2p9');
    expect(runCommand).toHaveBeenCalledWith(
      ['snapshot', '--app', 'Finder', '--timeout-ms', '15000'],
      expect.objectContaining({ sessionId: 'sess-1' })
    );
    expect(createApproval).not.toHaveBeenCalled();
  });

  it('blocks a commit-class ax op until a usable approval exists', async () => {
    const { handleAxInteraction } = await import('./system-desktop-ax.js');
    const result = await handleAxInteraction(
      baseInteraction({ type: 'ax_type', text: 'x', approval_request_id: undefined }),
      ctx()
    );
    expect(result.status).toBe('blocked');
    expect((result.context as AxResultContext).approval_request_id).toBe('approval-ax-1');
    expect(createApproval).toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('rejects a stale or missing approval for commit-class ops', async () => {
    loadApproval.mockReturnValue({ status: 'denied' });
    const { handleAxInteraction } = await import('./system-desktop-ax.js');
    const result = await handleAxInteraction(
      baseInteraction({ type: 'ax_type', text: 'x' }),
      ctx()
    );
    expect(result.status).toBe('blocked');
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('runs navigation-class ax ops without approval (marks-path parity)', async () => {
    runCommand.mockReturnValue({ ok: true, envelope: { ok: true, data: {} } });
    const { handleAxInteraction } = await import('./system-desktop-ax.js');
    for (const type of [
      'ax_click',
      'ax_scroll',
      'ax_scroll_to',
      'ax_focus',
      'ax_expand',
      'ax_collapse',
    ]) {
      const result = await handleAxInteraction(
        baseInteraction({ type, direction: 'down', approval_request_id: undefined }),
        ctx()
      );
      expect(result.status).toBe('succeeded');
    }
    expect(createApproval).not.toHaveBeenCalled();
  });

  it('executes ax_click and stamps delivered_unverified by default', async () => {
    runCommand.mockReturnValue({ ok: true, envelope: { ok: true, data: { acted: true } } });
    const { handleAxInteraction } = await import('./system-desktop-ax.js');
    const result = await handleAxInteraction(baseInteraction(), ctx());
    expect(result.status).toBe('succeeded');
    expect((result.disposition as AxDisposition).delivery).toBe('delivered_unverified');
    expect((result.disposition as AxDisposition).retry).toBe('unsafe');
    expect(runCommand).toHaveBeenCalledWith(
      ['click', '@s8f3k2p9:e8', '--timeout-ms', '15000'],
      expect.objectContaining({ sessionId: 'sess-1' })
    );
  });

  it('preserves upstream delivery disposition when present', async () => {
    runCommand.mockReturnValue({
      ok: true,
      envelope: {
        ok: true,
        data: {},
        disposition: { delivery: 'delivered_verified', retry: 'unsafe' },
      },
    });
    const { handleAxInteraction } = await import('./system-desktop-ax.js');
    const result = await handleAxInteraction(baseInteraction(), ctx());
    expect((result.disposition as AxDisposition).delivery).toBe('delivered_verified');
  });

  it('propagates upstream error codes with fail-closed recovery metadata', async () => {
    runCommand.mockReturnValue({
      ok: false,
      code: 'AMBIGUOUS_TARGET',
      message: 'three plausible matches',
      disposition: { delivery: 'not_delivered', retry: 'safe' },
    });
    const { handleAxInteraction } = await import('./system-desktop-ax.js');
    const result = await handleAxInteraction(baseInteraction(), ctx());
    expect(result.status).toBe('failed');
    expect(result.code).toBe('AMBIGUOUS_TARGET');
    expect((result.disposition as AxDisposition).delivery).toBe('not_delivered');
  });

  it('keeps disposition on mutating success even when the envelope carries no data', async () => {
    runCommand.mockReturnValue({ ok: true, envelope: { ok: true } });
    const { handleAxInteraction } = await import('./system-desktop-ax.js');
    const result = await handleAxInteraction(baseInteraction(), ctx());
    expect(result.status).toBe('succeeded');
    expect(result.code).toBe('OK');
    expect((result.disposition as AxDisposition).delivery).toBe('delivered_unverified');
  });

  it('classifies upstream pre-dispatch refusals as not_delivered with non-retryable recovery', async () => {
    runCommand.mockReturnValue({
      ok: false,
      code: 'POLICY_DENIED',
      message: 'Target is not actionable',
    });
    const { handleAxInteraction } = await import('./system-desktop-ax.js');
    const result = await handleAxInteraction(baseInteraction(), ctx());
    expect((result.disposition as AxDisposition).delivery).toBe('not_delivered');
    expect((result.disposition as AxDisposition).retry).toBe('safe');
    expect((result.recovery as AxRecovery).strategy).toBe('use_physical_channel');
    expect((result.recovery as AxRecovery).retryable).toBe(false);
  });

  it('stamps tri-state evidence on ax_get / ax_is results', async () => {
    const { handleAxInteraction } = await import('./system-desktop-ax.js');
    runCommand.mockReturnValueOnce({
      ok: true,
      envelope: { ok: true, data: { property: 'value', value: 'hello' } },
    });
    const get = await handleAxInteraction(
      baseInteraction({ type: 'ax_get', property: 'value' }),
      ctx()
    );
    expect(get.evidence).toEqual({ value: 'known' });

    runCommand.mockReturnValueOnce({
      ok: true,
      envelope: { ok: true, data: { property: 'checked', applicable: false, result: null } },
    });
    const is = await handleAxInteraction(
      baseInteraction({ type: 'ax_is', property: 'checked' }),
      ctx()
    );
    expect(is.evidence).toEqual({ checked: 'absent' });

    runCommand.mockReturnValueOnce({ ok: false, code: 'STALE_REF', message: 'gone' });
    const failed = await handleAxInteraction(
      baseInteraction({ type: 'ax_get', property: 'text' }),
      ctx()
    );
    expect(failed.evidence).toEqual({ text: 'unknown' });
  });

  it('marks collection-op payload fields as known or absent', async () => {
    runCommand.mockReturnValueOnce({
      ok: true,
      envelope: {
        ok: true,
        data: { snapshot_id: 's1', ref_count: 3, complete: true },
      },
    });
    const { handleAxInteraction } = await import('./system-desktop-ax.js');
    const result = await handleAxInteraction(
      baseInteraction({ type: 'ax_snapshot', qualified_ref: undefined }),
      ctx()
    );
    expect(result.complete).toBe(true);
    expect(result.evidence).toEqual({
      snapshot_id: 'known',
      tree: 'absent',
      ref_count: 'known',
      complete: 'known',
    });
  });

  it('maps ax_list_notifications filters and skips session bootstrap', async () => {
    runCommand.mockReturnValue({ ok: true, envelope: { ok: true, data: { notifications: [] } } });
    const { handleAxInteraction } = await import('./system-desktop-ax.js');
    const result = await handleAxInteraction(
      baseInteraction({
        type: 'ax_list_notifications',
        qualified_ref: undefined,
        application: 'Slack',
        text: 'deploy',
        limit: 5,
      }),
      ctx()
    );
    expect(result.status).toBe('succeeded');
    expect(runCommand).toHaveBeenCalledWith(
      ['list-notifications', '--app', 'Slack', '--text', 'deploy', '--limit', '5'],
      expect.objectContaining({ requireSession: false })
    );
  });

  it('skips session bootstrap for ax_list_windows (session-independent)', async () => {
    runCommand.mockReturnValue({ ok: true, envelope: { ok: true, data: [] } });
    const { handleAxInteraction } = await import('./system-desktop-ax.js');
    await handleAxInteraction(
      baseInteraction({ type: 'ax_list_windows', qualified_ref: undefined }),
      ctx()
    );
    expect(runCommand).toHaveBeenCalledWith(
      ['list-windows', '--timeout-ms', '15000'],
      expect.objectContaining({ requireSession: false })
    );
  });

  it('verifies ax_set_value via a get-value readback and promotes to delivered_verified', async () => {
    runCommand
      .mockReturnValueOnce({ ok: true, envelope: { ok: true, data: {} } }) // set-value
      .mockReturnValueOnce({
        ok: true,
        envelope: { ok: true, data: { property: 'value', value: 'hello' } },
      }); // get verify read
    const { handleAxInteraction } = await import('./system-desktop-ax.js');
    const result = await handleAxInteraction(
      baseInteraction({ type: 'ax_set_value', qualified_ref: '@s9:e1', value: 'hello' }),
      ctx()
    );
    expect(result.status).toBe('succeeded');
    expect((result.disposition as AxDisposition).delivery).toBe('delivered_verified');
    expect((result.context as AxResultContext).verification.matched).toBe(true);
    expect(runCommand).toHaveBeenNthCalledWith(
      2,
      ['get', '@s9:e1', '--property', 'value'],
      expect.any(Object)
    );
  });

  it('demotes to delivery_uncertain when the readback contradicts the intent', async () => {
    runCommand
      .mockReturnValueOnce({ ok: true, envelope: { ok: true, data: {} } })
      .mockReturnValueOnce({
        ok: true,
        envelope: { ok: true, data: { property: 'checked', result: false } },
      });
    const { handleAxInteraction } = await import('./system-desktop-ax.js');
    const result = await handleAxInteraction(
      baseInteraction({ type: 'ax_check', qualified_ref: '@s9:e2' }),
      ctx()
    );
    expect((result.disposition as AxDisposition).delivery).toBe('delivery_uncertain');
    expect((result.context as AxResultContext).verification).toEqual({
      kind: 'ax_is_checked',
      expected: true,
      observed: false,
      matched: false,
    });
  });

  it('keeps upstream disposition when the verify read itself fails', async () => {
    runCommand
      .mockReturnValueOnce({ ok: true, envelope: { ok: true, data: {} } })
      .mockReturnValueOnce({ ok: false, code: 'STALE_REF', message: 'gone' });
    const { handleAxInteraction } = await import('./system-desktop-ax.js');
    const result = await handleAxInteraction(
      baseInteraction({ type: 'ax_check', qualified_ref: '@s9:e2' }),
      ctx()
    );
    expect((result.disposition as AxDisposition).delivery).toBe('delivered_unverified');
    expect((result.context as AxResultContext).verification).toBeUndefined();
  });

  it('runs ax_session_end / ax_session_gc as lifecycle ops without approval', async () => {
    const { handleAxInteraction } = await import('./system-desktop-ax.js');
    const end = await handleAxInteraction(
      baseInteraction({ type: 'ax_session_end', qualified_ref: undefined }),
      ctx()
    );
    expect(end.status).toBe('succeeded');
    expect(createApproval).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled(); // lifecycle goes through the dedicated bridge API
  });

  it('maps ax_get/ax_is property selectors', async () => {
    runCommand.mockReturnValue({ ok: true, envelope: { ok: true, data: { value: 'x' } } });
    const { handleAxInteraction } = await import('./system-desktop-ax.js');
    await handleAxInteraction(baseInteraction({ type: 'ax_is', property: 'checked' }), ctx());
    expect(runCommand).toHaveBeenCalledWith(
      ['is', '@s8f3k2p9:e8', '--property', 'checked'],
      expect.any(Object)
    );
  });

  it('maps ax_find filters to CLI args including native_id', async () => {
    runCommand.mockReturnValue({ ok: true, envelope: { ok: true, data: { matches: [] } } });
    const { handleAxInteraction } = await import('./system-desktop-ax.js');
    await handleAxInteraction(
      baseInteraction({
        type: 'ax_find',
        qualified_ref: undefined,
        role: 'AXButton',
        name: 'Save',
        native_id: 'save-button',
      }),
      ctx()
    );
    expect(runCommand).toHaveBeenCalledWith(
      [
        'find',
        '--role',
        'AXButton',
        '--name',
        'Save',
        '--native-id',
        'save-button',
        '--timeout-ms',
        '15000',
      ],
      expect.any(Object)
    );
  });

  it('runs ax_wait as an observation op with --timeout (not --timeout-ms)', async () => {
    runCommand.mockReturnValue({
      ok: true,
      envelope: { ok: true, data: { waited_ms: 120 } },
    });
    const { handleAxInteraction } = await import('./system-desktop-ax.js');
    const result = await handleAxInteraction(
      baseInteraction({ type: 'ax_wait', qualified_ref: undefined, ms: 120 }),
      ctx()
    );
    expect(result.status).toBe('succeeded');
    expect(runCommand).toHaveBeenCalledWith(
      ['wait', '120', '--timeout', '15000'],
      expect.objectContaining({ sessionId: 'sess-1' })
    );
    expect(result.evidence).toMatchObject({ waited_ms: 'known' });
    expect(createApproval).not.toHaveBeenCalled();
  });

  it('maps ax_wait element/window/event conditions and requires one', async () => {
    const { handleAxInteraction } = await import('./system-desktop-ax.js');
    const empty = await handleAxInteraction(
      baseInteraction({ type: 'ax_wait', qualified_ref: undefined }),
      ctx()
    );
    expect(empty.code).toBe('INVALID_ARGS');
    expect(runCommand).not.toHaveBeenCalled();

    runCommand.mockReturnValue({ ok: true, envelope: { ok: true, data: {} } });
    await handleAxInteraction(
      baseInteraction({
        type: 'ax_wait',
        qualified_ref: '@s8f3k2p9:e8',
        predicate: 'visible',
        window_id: 'w-9',
        timeout_ms: 5000,
      }),
      ctx()
    );
    expect(runCommand).toHaveBeenCalledWith(
      [
        'wait',
        '--element',
        '@s8f3k2p9:e8',
        '--predicate',
        'visible',
        '--window-id',
        'w-9',
        '--timeout',
        '5000',
      ],
      expect.any(Object)
    );
  });

  it('rejects an ax_wait event outside the upstream enum', async () => {
    const { handleAxInteraction } = await import('./system-desktop-ax.js');
    const result = await handleAxInteraction(
      baseInteraction({ type: 'ax_wait', qualified_ref: undefined, event: 'exploded' }),
      ctx()
    );
    expect(result.code).toBe('INVALID_ARGS');
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('runs ax_permissions session-independently as observation', async () => {
    runCommand.mockReturnValue({
      ok: true,
      envelope: {
        ok: true,
        data: { accessibility: { state: 'granted' }, automation: { state: 'unknown' } },
      },
    });
    const { handleAxInteraction } = await import('./system-desktop-ax.js');
    const result = await handleAxInteraction(
      baseInteraction({ type: 'ax_permissions', qualified_ref: undefined }),
      ctx()
    );
    expect(result.status).toBe('succeeded');
    expect(runCommand).toHaveBeenCalledWith(
      ['permissions'],
      expect.objectContaining({ requireSession: false })
    );
    expect(result.evidence).toMatchObject({
      accessibility: 'known',
      screen_recording: 'absent',
    });
  });

  it('runs window-management nav ops without approval', async () => {
    runCommand.mockReturnValue({ ok: true, envelope: { ok: true, data: {} } });
    const { handleAxInteraction } = await import('./system-desktop-ax.js');
    await handleAxInteraction(
      baseInteraction({
        type: 'ax_focus_window',
        qualified_ref: undefined,
        window_id: 'w-1',
        title: 'Documents',
      }),
      ctx()
    );
    expect(runCommand).toHaveBeenCalledWith(
      ['focus-window', '--window-id', 'w-1', '--title', 'Documents'],
      expect.any(Object)
    );
    await handleAxInteraction(
      baseInteraction({
        type: 'ax_move_window',
        qualified_ref: undefined,
        x: 10,
        y: -20,
        application: 'Finder',
      }),
      ctx()
    );
    expect(runCommand).toHaveBeenCalledWith(
      ['move-window', '--x=10', '--y=-20', '--app', 'Finder'],
      expect.any(Object)
    );
    await handleAxInteraction(
      baseInteraction({
        type: 'ax_resize_window',
        qualified_ref: undefined,
        width: 800,
        height: 600,
        window_id: 'w-1',
      }),
      ctx()
    );
    expect(runCommand).toHaveBeenCalledWith(
      ['resize-window', '--width=800', '--height=600', '--window-id', 'w-1'],
      expect.any(Object)
    );
    await handleAxInteraction(
      baseInteraction({
        type: 'ax_minimize_window',
        qualified_ref: undefined,
        application: 'Finder',
      }),
      ctx()
    );
    expect(runCommand).toHaveBeenCalledWith(['minimize', '--app', 'Finder'], expect.any(Object));
    expect(createApproval).not.toHaveBeenCalled();
  });

  it('validates ax_move_window / ax_resize_window numeric fields pre-spawn', async () => {
    const { handleAxInteraction } = await import('./system-desktop-ax.js');
    const moved = await handleAxInteraction(
      baseInteraction({ type: 'ax_move_window', qualified_ref: undefined, x: 10 }),
      ctx()
    );
    expect(moved.code).toBe('INVALID_ARGS');
    const resized = await handleAxInteraction(
      baseInteraction({
        type: 'ax_resize_window',
        qualified_ref: undefined,
        width: 0,
        height: 600,
      }),
      ctx()
    );
    expect(resized.code).toBe('INVALID_ARGS');
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('validates ax_open_system_surface against the upstream enum', async () => {
    const { handleAxInteraction } = await import('./system-desktop-ax.js');
    const bad = await handleAxInteraction(
      baseInteraction({
        type: 'ax_open_system_surface',
        qualified_ref: undefined,
        surface: 'not-a-surface',
      }),
      ctx()
    );
    expect(bad.code).toBe('INVALID_ARGS');
    runCommand.mockReturnValue({ ok: true, envelope: { ok: true, data: {} } });
    await handleAxInteraction(
      baseInteraction({
        type: 'ax_open_system_surface',
        qualified_ref: undefined,
        surface: 'spotlight',
      }),
      ctx()
    );
    expect(runCommand).toHaveBeenCalledWith(
      ['open-system-surface', '--surface', 'spotlight'],
      expect.any(Object)
    );
    expect(createApproval).not.toHaveBeenCalled();
  });

  it('gates ax_launch behind approval then builds --activate/--cdp/args/env', async () => {
    runCommand.mockReturnValue({ ok: true, envelope: { ok: true, data: {} } });
    const { handleAxInteraction } = await import('./system-desktop-ax.js');
    const result = await handleAxInteraction(
      baseInteraction({
        type: 'ax_launch',
        qualified_ref: undefined,
        application: 'Safari',
        activate: true,
        cdp: true,
        app_args: ['--private'],
        app_env: { MODE: 'test' },
      }),
      ctx()
    );
    expect(result.status).toBe('succeeded');
    expect(loadApproval).toHaveBeenCalledWith('computer', 'req-1');
    expect(runCommand).toHaveBeenCalledWith(
      [
        'launch',
        'Safari',
        '--timeout',
        '15000',
        '--arg=--private',
        '--env',
        'MODE=test',
        '--activate',
        '--cdp',
      ],
      expect.any(Object)
    );
  });

  it('gates ax_close_app behind approval and maps --force', async () => {
    runCommand.mockReturnValue({ ok: true, envelope: { ok: true, data: {} } });
    const { handleAxInteraction } = await import('./system-desktop-ax.js');
    await handleAxInteraction(
      baseInteraction({
        type: 'ax_close_app',
        qualified_ref: undefined,
        application: 'Safari',
        force: true,
      }),
      ctx()
    );
    expect(runCommand).toHaveBeenCalledWith(['close-app', 'Safari', '--force'], expect.any(Object));
    expect(loadApproval).toHaveBeenCalled();
  });

  it('blocks ax_launch without a usable approval and requires application', async () => {
    loadApproval.mockReturnValue({ status: 'pending' } as never);
    const { handleAxInteraction } = await import('./system-desktop-ax.js');
    const blocked = await handleAxInteraction(
      baseInteraction({
        type: 'ax_launch',
        qualified_ref: undefined,
        application: 'Safari',
      }),
      ctx()
    );
    expect(blocked.status).toBe('blocked');
    expect(runCommand).not.toHaveBeenCalled();
    const missing = await handleAxInteraction(
      baseInteraction({
        type: 'ax_launch',
        qualified_ref: undefined,
        application: undefined,
      }),
      ctx()
    );
    expect(missing.code).toBe('INVALID_ARGS');
  });

  it('requires an identity field for ax_dismiss_notification / ax_notification_action', async () => {
    const { handleAxInteraction } = await import('./system-desktop-ax.js');
    const noIdentity = await handleAxInteraction(
      baseInteraction({
        type: 'ax_dismiss_notification',
        qualified_ref: undefined,
        index: 2,
      }),
      ctx()
    );
    expect(noIdentity.code).toBe('INVALID_ARGS');
    const noIdentityAction = await handleAxInteraction(
      baseInteraction({
        type: 'ax_notification_action',
        qualified_ref: undefined,
        index: 1,
        action: 'Reply',
      }),
      ctx()
    );
    expect(noIdentityAction.code).toBe('INVALID_ARGS');
    expect(runCommand).not.toHaveBeenCalled();
    expect(createApproval).not.toHaveBeenCalled();

    runCommand.mockReturnValue({ ok: true, envelope: { ok: true, data: {} } });
    await handleAxInteraction(
      baseInteraction({
        type: 'ax_dismiss_notification',
        qualified_ref: undefined,
        index: 2,
        expected_app: 'Mail',
      }),
      ctx()
    );
    expect(runCommand).toHaveBeenCalledWith(
      ['dismiss-notification', '2', '--expected-app', 'Mail'],
      expect.any(Object)
    );
    await handleAxInteraction(
      baseInteraction({
        type: 'ax_notification_action',
        qualified_ref: undefined,
        index: 1,
        action: 'Reply',
        expected_title: 'Build failed',
      }),
      ctx()
    );
    expect(runCommand).toHaveBeenCalledWith(
      ['notification-action', '1', 'Reply', '--expected-title', 'Build failed'],
      expect.any(Object)
    );
    await handleAxInteraction(
      baseInteraction({
        type: 'ax_dismiss_all_notifications',
        qualified_ref: undefined,
        application: 'Slack',
      }),
      ctx()
    );
    expect(runCommand).toHaveBeenCalledWith(
      ['dismiss-all-notifications', '--app', 'Slack'],
      expect.any(Object)
    );
  });

  it('gates clipboard ops behind approval; ax_clipboard_get is a sensitive read', async () => {
    const { handleAxInteraction } = await import('./system-desktop-ax.js');
    const blocked = await handleAxInteraction(
      baseInteraction({
        type: 'ax_clipboard_get',
        qualified_ref: undefined,
        approval_request_id: undefined,
      }),
      ctx()
    );
    expect(blocked.status).toBe('blocked');
    expect(createApproval).toHaveBeenCalled();
    const draft = (createApproval.mock.calls[0]?.[1] ?? {}) as {
      draft?: { summary?: string };
      justification?: { reason?: string };
    };
    expect(draft.draft?.summary).toContain('clipboard');
    expect(draft.justification?.reason).toContain('reads expose');

    runCommand.mockReturnValue({ ok: true, envelope: { ok: true, data: {} } });
    await handleAxInteraction(
      baseInteraction({
        type: 'ax_clipboard_get',
        qualified_ref: undefined,
        format: 'text',
      }),
      ctx()
    );
    expect(runCommand).toHaveBeenCalledWith(
      ['clipboard-get', '--format', 'text'],
      expect.any(Object)
    );
    await handleAxInteraction(
      baseInteraction({ type: 'ax_clipboard_set', qualified_ref: undefined, text: 'hi' }),
      ctx()
    );
    expect(runCommand).toHaveBeenCalledWith(['clipboard-set', 'hi'], expect.any(Object));
    await handleAxInteraction(
      baseInteraction({ type: 'ax_clipboard_clear', qualified_ref: undefined }),
      ctx()
    );
    expect(runCommand).toHaveBeenCalledWith(['clipboard-clear'], expect.any(Object));
  });

  it('rejects ax_clipboard_set without a payload', async () => {
    const { handleAxInteraction } = await import('./system-desktop-ax.js');
    const result = await handleAxInteraction(
      baseInteraction({ type: 'ax_clipboard_set', qualified_ref: undefined }),
      ctx()
    );
    expect(result.code).toBe('INVALID_ARGS');
    expect(runCommand).not.toHaveBeenCalled();
    expect(createApproval).not.toHaveBeenCalled();
  });

  it('passes agent_id to the runtime env and validates its shape', async () => {
    runCommand.mockReturnValue({ ok: true, envelope: { ok: true, data: {} } });
    const { handleAxInteraction } = await import('./system-desktop-ax.js');
    await handleAxInteraction(
      baseInteraction({
        type: 'ax_snapshot',
        qualified_ref: undefined,
        agent_id: 'worker-7',
      }),
      ctx()
    );
    expect(runCommand).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ agentId: 'worker-7' })
    );
    const bad = await handleAxInteraction(
      baseInteraction({
        type: 'ax_snapshot',
        qualified_ref: undefined,
        agent_id: 'has spaces!',
      }),
      ctx()
    );
    expect(bad.code).toBe('INVALID_ARGS');
  });

  it('surfaces upstream recovery metadata when the envelope carries it', async () => {
    runCommand.mockReturnValue({
      ok: false,
      code: 'TIMEOUT',
      message: 'text did not appear',
      envelope: {
        ok: false,
        error: {
          code: 'TIMEOUT',
          recovery: {
            strategy: 'inspect_state_then_retry_original',
            retryable: true,
            requires_fresh_snapshot: true,
          },
        },
      },
    });
    const { handleAxInteraction } = await import('./system-desktop-ax.js');
    const result = await handleAxInteraction(
      baseInteraction({ type: 'ax_wait', qualified_ref: undefined, ms: 10 }),
      ctx()
    );
    expect(result.recovery as AxRecovery & { requires_fresh_observation?: boolean }).toMatchObject({
      strategy: 'inspect_state_then_retry_original',
      retryable: true,
      requires_fresh_observation: true,
    });
  });

  it('classifies WINDOW_NOT_FOUND / APP_NOT_FOUND / PERM_DENIED as pre-dispatch refusals', async () => {
    const { handleAxInteraction } = await import('./system-desktop-ax.js');
    runCommand.mockReturnValue({
      ok: false,
      code: 'WINDOW_NOT_FOUND',
      message: 'no window',
      envelope: { ok: false, error: { code: 'WINDOW_NOT_FOUND' } },
    });
    const win = await handleAxInteraction(
      baseInteraction({
        type: 'ax_focus_window',
        qualified_ref: undefined,
        window_id: 'w-x',
      }),
      ctx()
    );
    expect(win.status).toBe('failed');
    expect((win.disposition as AxDisposition).delivery).toBe('not_delivered');
    expect(win.recovery).toMatchObject({ strategy: 're_observe_then_retry', retryable: true });

    runCommand.mockReturnValue({
      ok: false,
      code: 'PERM_DENIED',
      message: 'accessibility denied',
      envelope: { ok: false, error: { code: 'PERM_DENIED' } },
    });
    const perm = await handleAxInteraction(
      baseInteraction({ type: 'ax_snapshot', qualified_ref: undefined }),
      ctx()
    );
    expect(perm.recovery).toMatchObject({ strategy: 'grant_permissions', retryable: false });
  });
});
