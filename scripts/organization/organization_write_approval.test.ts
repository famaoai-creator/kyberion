import { beforeEach, describe, expect, it, vi } from 'vitest';

const load = vi.hoisted(() => vi.fn());
const create = vi.hoisted(() => vi.fn());
const usable = vi.hoisted(() => vi.fn());
const order = vi.hoisted(() => [] as string[]);
const consumed = vi.hoisted(() => vi.fn());
vi.mock('@agent/core/governance/approval-store', async (importOriginal) => ({
  computeApprovalPayloadHash: (
    (await importOriginal()) as typeof import('@agent/core/governance/approval-store')
  ).computeApprovalPayloadHash,
  loadApprovalRequest: load,
  createApprovalRequest: create,
  // Single use and separation of duties are covered by approval-separation-of-duties.test.ts.
  assertApprovalUsable: usable,
}));
// The record lock and the already-used refusal are covered by approval-revocation tests;
// here the order inside the lock: verify, consume, then write.
vi.mock('@agent/core/governance/approval-revocation', () => ({
  consumeApprovalWithin: (
    _role: string,
    params: unknown,
    run: (consume: () => unknown) => unknown
  ) =>
    run(() => {
      order.push('consume');
      consumed(params);
      return {};
    }),
}));
vi.mock('@agent/core/governance/cli-operator-principal', () => ({
  resolveCliApprovalRequester: () => ({
    requestedBy: 'agent:claude-code',
    actorId: 'agent:claude-code',
  }),
}));

import {
  canonicalWriteArgs,
  organizationWritePayloadHash,
  requestOrganizationWriteApproval,
  runWithOrganizationWriteApproval,
  verifyOrganizationWriteApproval,
} from './organization_write_approval.js';

const scope = {
  command: 'operation add',
  organizationId: 'demo-hq',
  tier: 'confidential',
  tenantSlug: 'calendar-demo',
};
const parsed = {
  command: 'operation add',
  organizationId: 'demo-hq',
  tier: 'confidential',
  tenantSlug: 'calendar-demo',
  operationId: 'month-close',
  name: '月次締め',
  apply: true,
  requestApproval: true,
  unknownFlags: [],
  options: [],
};

function approved(overrides: Record<string, unknown> = {}) {
  return {
    id: 'APR-1',
    status: 'approved',
    decidedByType: 'human',
    authenticated: true,
    decidedAuthMethod: 'terminal_attested',
    accountability: {
      finalDecision: 'human_only',
      effectBinding: 'organization:write:calendar-demo:demo-hq:operation add',
      payloadHash: organizationWritePayloadHash(scope, parsed),
    },
    scope: { organization_id: 'demo-hq', tier: 'confidential', tenant_slug: 'calendar-demo' },
    ...overrides,
  };
}

beforeEach(() => {
  load.mockReset();
  create.mockReset();
  usable.mockReset();
  consumed.mockReset();
  order.length = 0;
});

describe('organization write approval', () => {
  it('approves the arguments, not the flow flags or their order', () => {
    const retry = { ...parsed, requestApproval: undefined, approvalRequestId: 'APR-1' };
    expect(canonicalWriteArgs(retry)).toEqual(canonicalWriteArgs(parsed));
    expect(Object.keys(canonicalWriteArgs(parsed))).not.toContain('apply');
    expect(organizationWritePayloadHash(scope, retry)).toBe(
      organizationWritePayloadHash(scope, parsed)
    );
  });

  it('opens a human-only request bound to the exact write and scope', () => {
    create.mockReturnValue({ id: 'APR-1' });
    expect(requestOrganizationWriteApproval({ scope, parsed })).toMatchObject({
      request_id: 'APR-1',
    });
    const record = create.mock.calls[0][1];
    expect(record.accountability).toMatchObject({
      finalDecision: 'human_only',
      effectBinding: 'organization:write:calendar-demo:demo-hq:operation add',
      payloadHash: organizationWritePayloadHash(scope, parsed),
    });
    expect(record.scope).toEqual({
      tier: 'confidential',
      tenant_slug: 'calendar-demo',
      organization_id: 'demo-hq',
    });
  });

  it('accepts a terminal-attested (A2) human approval for the exact write and checks single use', () => {
    load.mockReturnValue(approved());
    expect(() =>
      verifyOrganizationWriteApproval('APR-1', scope, { ...parsed, approvalRequestId: 'APR-1' })
    ).not.toThrow();
    expect(usable).toHaveBeenCalledWith(expect.objectContaining({ id: 'APR-1' }), {
      consumer: 'organization_write',
    });
  });

  it.each([
    ['still pending', { status: 'pending' }],
    ['decided by an agent', { decidedByType: 'agent' }],
    ['below terminal attestation', { decidedAuthMethod: 'manual' }],
    ['not human-only', { accountability: { ...approved().accountability, finalDecision: 'any' } }],
    [
      'another tenant',
      { scope: { organization_id: 'demo-hq', tier: 'confidential', tenant_slug: 'other' } },
    ],
    [
      'another command',
      {
        accountability: {
          ...approved().accountability,
          effectBinding: 'organization:write:calendar-demo:demo-hq:operation run record',
        },
      },
    ],
  ])('refuses an approval %s', (_label, overrides) => {
    load.mockReturnValue(approved(overrides));
    expect(() => verifyOrganizationWriteApproval('APR-1', scope, parsed)).toThrow(
      /ORGANIZATION_WRITE_APPROVAL_INVALID/
    );
    expect(usable).not.toHaveBeenCalled();
  });

  it('refuses when the command arguments were changed after approval', () => {
    load.mockReturnValue(approved());
    expect(() =>
      verifyOrganizationWriteApproval('APR-1', scope, { ...parsed, name: 'something else' })
    ).toThrow(/arguments differ/);
  });

  it('refuses a missing request', () => {
    load.mockReturnValue(null);
    expect(() => verifyOrganizationWriteApproval('APR-X', scope, parsed)).toThrow(
      /no such approval/
    );
  });

  it('names the agent that asked, not a generic CLI', () => {
    create.mockReturnValue({ id: 'APR-1' });
    requestOrganizationWriteApproval({ scope, parsed });
    expect(create.mock.calls[0][1]).toMatchObject({ requestedBy: 'agent:claude-code' });
  });

  it('verifies, marks the approval used, then writes — in that order', () => {
    load.mockReturnValue(approved());
    const result = runWithOrganizationWriteApproval(
      'APR-1',
      scope,
      parsed,
      'pnpm organization operation add',
      () => {
        order.push('write');
        return 'written';
      }
    );
    expect(result).toBe('written');
    expect(order).toEqual(['consume', 'write']);
    expect(consumed).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'APR-1', consumer: 'organization_write' })
    );
  });

  it('never writes when the approval does not match', () => {
    load.mockReturnValue(approved({ status: 'pending' }));
    const write = vi.fn();
    expect(() => runWithOrganizationWriteApproval('APR-1', scope, parsed, 'x', write)).toThrow(
      /ORGANIZATION_WRITE_APPROVAL_INVALID/
    );
    expect(write).not.toHaveBeenCalled();
    expect(consumed).not.toHaveBeenCalled();
  });

  it('leaves the approval used when the write fails (it can never be replayed)', () => {
    load.mockReturnValue(approved());
    expect(() =>
      runWithOrganizationWriteApproval('APR-1', scope, parsed, 'x', () => {
        throw new Error('disk full');
      })
    ).toThrow(/disk full/);
    expect(consumed).toHaveBeenCalledTimes(1);
  });
});
