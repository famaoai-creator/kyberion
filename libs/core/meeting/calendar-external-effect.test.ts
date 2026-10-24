import { externalApprovalFixture } from '../../../tests/helpers/external-approval-fixture.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ gate: vi.fn(), audit: vi.fn(), send: vi.fn() }));
vi.mock('../governance/approval-gate.js', () => ({ enforceApprovalGate: mocks.gate }));
vi.mock('../governance/audit-chain.js', () => ({ auditChain: { record: mocks.audit } }));
vi.mock('../governance/external-operation-store.js', () => ({ reserveExternalOperation: vi.fn() }));
vi.mock('../scope-envelope.js', () => ({ currentScopeEnvelope: () => undefined }));
vi.mock('./calendar-provider-bridge.js', async (original) => ({
  ...(await original<typeof import('./calendar-provider-bridge.js')>()),
  resolveCalendarProvider: () => ({
    insertEvent: mocks.send,
    updateEvent: mocks.send,
    deleteEvent: mocks.send,
  }),
}));
import {
  runCalendarExternalEffect,
  forwardCalendarExternalEffect,
} from './calendar-external-effect.js';
import {
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
} from './calendar-workflow.js';

describe('calendar exact admission forwarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.gate.mockReturnValue({
      allowed: true,
      status: 'approved',
      requestId: 'exact-fixture-approval',
    });
  });
  it('forwards the exact adapter input once without a second admission', async () => {
    const source = { title: 'meeting' };
    const request = { summary: 'meeting' };
    const execute = vi.fn(async () => ({ ok: true }));
    await runCalendarExternalEffect(source, 'create_event', { params: source }, () =>
      forwardCalendarExternalEffect(source, request, 'create_event', () =>
        runCalendarExternalEffect(request, 'create_event', { params: request }, execute)
      )
    );
    expect(mocks.gate).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('rejects reused forwarding capability', async () => {
    const source = { title: 'meeting' };
    const request = { summary: 'meeting' };
    await expect(
      runCalendarExternalEffect(source, 'create_event', { params: source }, async () => {
        forwardCalendarExternalEffect(source, request, 'create_event', () => undefined);
        forwardCalendarExternalEffect(source, request, 'create_event', () => undefined);
      })
    ).rejects.toThrow('CALENDAR_ADMISSION_MISMATCH');
  });

  it('allows layered registry/backend forwarding but never sibling reuse', async () => {
    const input = { title: 'meeting' };
    const execute = vi.fn(async () => ({ ok: true }));
    await expect(
      runCalendarExternalEffect(input, 'create_event', { params: input }, async () => {
        await runCalendarExternalEffect(input, 'create_event', { params: input }, () =>
          runCalendarExternalEffect(input, 'create_event', { params: input }, execute)
        );
        await runCalendarExternalEffect(input, 'create_event', { params: input }, execute);
      })
    ).rejects.toThrow('CALENDAR_ADMISSION_MISMATCH');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(mocks.gate).toHaveBeenCalledTimes(1);
  });
  it('rejects operation and payload mutation mismatches', async () => {
    for (const mutate of [false, true]) {
      const source = { title: 'meeting' };
      await expect(
        runCalendarExternalEffect(source, 'create_event', { params: source }, async () => {
          if (mutate) source.title = 'changed';
          forwardCalendarExternalEffect(
            source,
            {},
            mutate ? 'create_event' : 'delete_event',
            () => undefined
          );
        })
      ).rejects.toThrow('CALENDAR_ADMISSION_MISMATCH');
    }
  });
  it('cannot install admission using an unrelated object', async () => {
    mocks.gate.mockReturnValue({ allowed: false, status: 'human_required' });
    await expect(
      forwardCalendarExternalEffect({}, {}, 'create_event', () =>
        runCalendarExternalEffect({}, 'create_event', {}, async () => ({ ok: true }))
      )
    ).rejects.toThrow('EXTERNAL_APPROVAL_REQUIRED');
  });
  it('gates direct core workflow create/update/delete exports before provider effects', async () => {
    mocks.gate.mockReturnValue({ allowed: false, status: 'human_required' });
    const input = {
      summary: 'meeting',
      start: '2026-10-21T09:00:00Z',
      end: '2026-10-21T10:00:00Z',
      event_id: 'event',
    };
    await expect(createCalendarEvent(input)).rejects.toThrow('EXTERNAL_APPROVAL_REQUIRED');
    await expect(updateCalendarEvent(input)).rejects.toThrow('EXTERNAL_APPROVAL_REQUIRED');
    await expect(deleteCalendarEvent(input)).rejects.toThrow('EXTERNAL_APPROVAL_REQUIRED');
    expect(mocks.send).not.toHaveBeenCalled();
  });
});

vi.mock('../governance/approval-store.js', async (original) => ({
  ...(await original<typeof import('../governance/approval-store.js')>()),
  evaluateApprovalUsability: () => null,
  loadApprovalRequest: (_channel: string, id: string) => {
    const params = mocks.gate.mock.calls.at(-1)?.[0];
    return params ? externalApprovalFixture(params, id) : null;
  },
}));
