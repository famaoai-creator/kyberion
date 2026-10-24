import { externalApprovalFixture } from '../../../../tests/helpers/external-approval-fixture.js';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
const mocks = vi.hoisted(() => ({
  gate: vi.fn(),
  audit: vi.fn(),
  reserve: vi.fn(),
  scope: vi.fn(),
  send: vi.fn(),
  exec: vi.fn(),
  retry: vi.fn(async (body: () => unknown) => body()),
}));
vi.mock('@agent/core/governance/approval-gate', () => ({ enforceApprovalGate: mocks.gate }));
vi.mock('@agent/core/governance/audit-chain', () => ({ auditChain: { record: mocks.audit } }));
vi.mock('@agent/core/governance/external-operation-store', () => ({
  reserveExternalOperation: mocks.reserve,
}));
vi.mock('../../../core/scope-envelope.js', () => ({ currentScopeEnvelope: mocks.scope }));
vi.mock('@agent/core/pipeline/op-preflight-defaults', () => ({
  ensureDefaultOpPreflight: vi.fn(),
}));
vi.mock('@agent/core/meeting/calendar-provider-bridge', async (original) => ({
  ...(await original<typeof import('@agent/core/meeting/calendar-provider-bridge')>()),
  resolveCalendarProvider: () => ({
    insertEvent: mocks.send,
    updateEvent: mocks.send,
    deleteEvent: mocks.send,
  }),
}));
vi.mock('@agent/core/secure-io', async (original) => ({
  ...(await original<typeof import('@agent/core/secure-io')>()),
  safeExec: mocks.exec,
}));
vi.mock('@agent/core/async-utils', async (original) => ({
  ...(await original<typeof import('@agent/core/async-utils')>()),
  retry: mocks.retry,
}));
vi.mock('@agent/core/trace', async (original) => ({
  ...(await original<typeof import('@agent/core/trace')>()),
  persistTrace: vi.fn(),
}));
import { resetOpPreflight, registerOpPreflightListener } from '@agent/core/pipeline/op-preflight';
import { CalendarBackendRegistry, type CalendarBackendAdapter } from './calendar-backend.js';
import {
  createEvent,
  updateEvent,
  deleteEvent,
  scheduleInFirstSlot,
  handleAction,
} from './index.js';
import { GwsCalendarBackend } from './backends/gws-backend.js';
import { JxaCalendarBackend } from './backends/jxa-backend.js';

describe('calendar external effect boundary', () => {
  const adapter: CalendarBackendAdapter = {
    id: 'fixture',
    isAvailable: () => true,
    unavailableMessage: () => 'unavailable',
    listCalendars: vi.fn(async () => []),
    listEvents: vi.fn(async () => []),
    queryFreeBusy: vi.fn(async () => []),
    createEvent: vi.fn(async () => ({ status: 'success', title: 'review' })),
    updateEvent: vi.fn(async () => ({ status: 'success', title: 'review' })),
    deleteEvent: vi.fn(async () => ({ status: 'success', event_id: 'event', calendar_id: 'work' })),
    findSlots: vi.fn(async () => ({
      slots: [{ start: '2026-10-21T09:00:00Z', end: '2026-10-21T10:00:00Z', timezone: 'UTC' }],
    })),
  };
  const registry = new CalendarBackendRegistry([adapter]);
  const params = {
    backend: 'fixture',
    calendar_id: 'work',
    title: 'review',
    start_date: '2026-10-21T09:00:00Z',
    end_date: '2026-10-21T10:00:00Z',
    event_id: 'event',
  };
  const authority = () => ({
    agentId: 'calendar-owner',
    tenantSlug: 'acme',
    invocationId: randomUUID(),
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.gate.mockReturnValue({ allowed: false, status: 'human_required' });
    mocks.scope.mockReturnValue(undefined);
  });
  afterEach(() => resetOpPreflight());

  it('blocks all direct mutations and composite scheduling without authority', async () => {
    for (const execute of [createEvent, updateEvent, deleteEvent]) {
      await expect(execute(params, registry)).rejects.toThrow('EXTERNAL_APPROVAL_REQUIRED');
    }
    await expect(
      scheduleInFirstSlot({ ...params, duration_minutes: 60 }, registry)
    ).rejects.toThrow('EXTERNAL_APPROVAL_REQUIRED');
    expect(adapter.createEvent).not.toHaveBeenCalled();
    expect(adapter.updateEvent).not.toHaveBeenCalled();
    expect(adapter.deleteEvent).not.toHaveBeenCalled();
  });

  it('gates direct built-in GWS and JXA backend mutations', async () => {
    const gws = new GwsCalendarBackend();
    for (const send of [
      () => gws.createEvent(params),
      () => gws.updateEvent(params),
      () => gws.deleteEvent(params),
      () => new JxaCalendarBackend().createEvent(params),
    ]) {
      await expect(send()).rejects.toThrow('EXTERNAL_APPROVAL_REQUIRED');
    }
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.exec).not.toHaveBeenCalled();
  });

  it('gates custom mutation methods returned directly by registry get and resolve', async () => {
    for (const backend of [registry.get('fixture'), registry.resolve('fixture')]) {
      for (const send of [
        () => backend.createEvent(params),
        () => backend.updateEvent!(params),
        () => backend.deleteEvent!(params),
      ]) {
        await expect(send()).rejects.toThrow('EXTERNAL_APPROVAL_REQUIRED');
      }
    }
    expect(adapter.createEvent).not.toHaveBeenCalled();
    expect(adapter.updateEvent).not.toHaveBeenCalled();
    expect(adapter.deleteEvent).not.toHaveBeenCalled();
  });

  it('forwards one admitted GWS action through the real workflow without another gate', async () => {
    mocks.gate.mockReturnValue({
      allowed: true,
      status: 'approved',
      requestId: 'exact-fixture-approval',
    });
    mocks.send.mockResolvedValue({
      id: 'event',
      summary: 'review',
      start: { dateTime: params.start_date },
      end: { dateTime: params.end_date },
    });
    const gws = new GwsCalendarBackend();
    vi.spyOn(gws, 'isAvailable').mockReturnValue(true);
    await createEvent({ ...params, backend: 'gws' }, new CalendarBackendRegistry([gws]), {
      externalAuthority: authority,
    });
    expect(mocks.gate).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it('never retries a JXA mutation', async () => {
    mocks.gate.mockReturnValue({
      allowed: true,
      status: 'approved',
      requestId: 'exact-fixture-approval',
    });
    mocks.exec.mockResolvedValueOnce(JSON.stringify({ status: 'success', title: 'review' }));
    await new JxaCalendarBackend().createEvent(params);
    expect(mocks.retry).toHaveBeenCalledWith(expect.any(Function), { maxRetries: 0 });
    expect(mocks.exec).toHaveBeenCalledTimes(1);
  });

  it('admits trusted authority and binds selected backend/actual effect', async () => {
    mocks.gate.mockReturnValue({
      allowed: true,
      status: 'approved',
      requestId: 'exact-fixture-approval',
    });
    await createEvent(params, registry, { externalAuthority: authority });
    expect(adapter.createEvent).toHaveBeenCalledTimes(1);
    expect(mocks.gate).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: 'calendar:create_event', agentId: 'calendar-owner' })
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ outcome: 'succeeded' }) })
    );
  });

  it('admits composite scheduling only once for its concrete selected slot', async () => {
    mocks.gate.mockReturnValue({
      allowed: true,
      status: 'approved',
      requestId: 'exact-fixture-approval',
    });
    await expect(
      scheduleInFirstSlot({ ...params, duration_minutes: 60 }, registry, {
        externalAuthority: authority,
      })
    ).resolves.toMatchObject({ event: { status: 'success' } });
    expect(adapter.createEvent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        start_date: '2026-10-21T09:00:00Z',
        end_date: '2026-10-21T10:00:00Z',
      })
    );
    expect(mocks.gate).toHaveBeenCalledTimes(1);
    expect(mocks.reserve).toHaveBeenCalledTimes(1);
  });

  it('keeps preflight denial ahead of authority and budget consumption', async () => {
    registerOpPreflightListener({
      id: 'calendar-block',
      run: () => ({ decision: 'block', reason: 'fixture policy denied' }),
    });
    const resolve = vi.fn(authority);
    await expect(createEvent(params, registry, { externalAuthority: resolve })).rejects.toThrow(
      'OP_PREFLIGHT_BLOCK'
    );
    expect(resolve).not.toHaveBeenCalled();
    expect(mocks.gate).not.toHaveBeenCalled();
    expect(adapter.createEvent).not.toHaveBeenCalled();
  });

  it('never delegates deletion to a charter', async () => {
    const trusted = {
      ...authority(),
      charter: { scope: { kind: 'organization' as const, tenant_slug: 'acme' }, action: {} },
    };
    await expect(
      deleteEvent(params, registry, {
        externalAuthority: () => trusted as ReturnType<typeof authority>,
      })
    ).rejects.toThrow('EXTERNAL_APPROVAL_REQUIRED');
    expect(mocks.gate.mock.calls[0][0].charter).toBeUndefined();
  });

  it('keeps reads automatic and validates malformed mutation before consuming admission', async () => {
    await handleAction({ op: 'list_events', params: { backend: 'fixture' } }, registry);
    await expect(createEvent({ backend: 'fixture' }, registry)).rejects.toThrow(
      'missing required fields'
    );
    expect(mocks.gate).not.toHaveBeenCalled();
  });

  it('rejects tenant mismatch before approval and execution', async () => {
    mocks.scope.mockReturnValue({ identity: { tenant_slug: 'other' } });
    await expect(createEvent(params, registry, { externalAuthority: authority })).rejects.toThrow(
      'EXTERNAL_SCOPE_MISMATCH'
    );
    expect(mocks.gate).not.toHaveBeenCalled();
    expect(adapter.createEvent).not.toHaveBeenCalled();
  });

  it('records ambiguous transport failure without replay or backend fallback', async () => {
    mocks.gate.mockReturnValue({
      allowed: true,
      status: 'approved',
      requestId: 'exact-fixture-approval',
    });
    vi.mocked(adapter.createEvent).mockRejectedValueOnce(new Error('lost response after create'));
    await expect(createEvent(params, registry, { externalAuthority: authority })).rejects.toThrow(
      'lost response after create'
    );
    expect(adapter.createEvent).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ outcome: 'unknown' }) })
    );
  });

  it.each([
    ['error', 'failed'],
    ['queued', 'unknown'],
  ])('classifies provider status %s as %s', async (status, outcome) => {
    mocks.gate.mockReturnValue({
      allowed: true,
      status: 'approved',
      requestId: 'exact-fixture-approval',
    });
    vi.mocked(adapter.updateEvent!).mockResolvedValueOnce({ status, title: 'review' });
    await updateEvent(params, registry, { externalAuthority: authority });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ outcome }) })
    );
  });
});

vi.mock('@agent/core/governance/approval-store', async (original) => ({
  ...(await original<typeof import('@agent/core/governance/approval-store')>()),
  evaluateApprovalUsability: () => null,
  loadApprovalRequest: (_channel: string, id: string) => {
    const params = mocks.gate.mock.calls.at(-1)?.[0];
    return params ? externalApprovalFixture(params, id) : null;
  },
}));
