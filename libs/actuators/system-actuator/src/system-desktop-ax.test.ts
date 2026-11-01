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
});
