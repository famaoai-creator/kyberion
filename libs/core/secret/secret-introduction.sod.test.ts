import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Separation of duties on: the local low-risk policy auto-approval
 * (`policy:secret-introduction-local-low-risk`) stands in for a person only
 * for an interactive, additive change by a non-agent requester. An agent
 * requester, a non-interactive value, or a rotation over an existing value go
 * to human approval. With the setting off, nothing changes.
 */
const fixture = vi.hoisted(() => ({ existing: null as string | null }));

vi.mock('../customer-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../customer-resolver.js')>();
  const { customerRootWithSodOverlay } =
    await import('../governance/__tests__/sod-overlay-state.js');
  return { ...actual, customerRoot: customerRootWithSodOverlay(actual.customerRoot) };
});
vi.mock('./secret-bridge.js', () => ({
  storeSecret: vi.fn(async () => undefined),
  fetchSecretSync: vi.fn(() => null),
}));
vi.mock('./secret-guard.js', () => ({
  getSecret: vi.fn(() => fixture.existing),
  storeConnectionDocument: vi.fn(() => ({ path: 'x', changedKeys: [] })),
}));
vi.mock('../ledger.js', () => ({ ledger: { record: vi.fn() } }));

import {
  approvalEventLogicalPath,
  approvalRequestLogicalPath,
  loadApprovalRequest,
} from '../governance/approval-store.js';
import {
  clearSeparationOfDuties,
  setSeparationOfDuties,
  useSeparationOfDutiesOverlay,
} from '../governance/__tests__/sod-overlay.js';
import { pathResolver } from '../path-resolver.js';
import { safeRmSync } from '../secure-io.js';
import {
  proposeSecretIntroduction,
  SECRET_INTRODUCTION_AUTO_APPROVER,
  type ProposeSecretIntroductionInput,
} from './secret-introduction.js';

const CHANNEL = `secret-sod-${process.pid}`;
const created: string[] = [];

/** The CLI's call for `pnpm kyberion secret introduce gemini API_KEY` at a TTY, by the owner. */
function propose(overrides: Partial<ProposeSecretIntroductionInput> = {}) {
  const result = proposeSecretIntroduction({
    serviceId: 'gemini',
    secretKey: 'API_KEY',
    reason: 'sod test',
    autoApproveLocal: true,
    channel: CHANNEL,
    requestedBy: 'user:owner',
    requestedByContext: { surface: 'terminal', actorId: 'user:owner', actorRole: 'sovereign' },
    valueSource: 'interactive',
    ...overrides,
  });
  created.push(result.approvalId);
  return result;
}

describe('secret introduction auto-approval under separation of duties', () => {
  beforeEach(() => {
    fixture.existing = null;
    useSeparationOfDutiesOverlay(
      pathResolver.sharedTmp(`secret-intro-sod-${process.pid}-${Math.random()}.json`)
    );
  });

  afterEach(() => {
    clearSeparationOfDuties();
    for (const id of created.splice(0)) {
      safeRmSync(approvalRequestLogicalPath(CHANNEL, id), { force: true });
    }
    safeRmSync(approvalEventLogicalPath(CHANNEL), { force: true });
  });

  it('with SoD on, still auto-approves a low-risk interactive set by the owner', () => {
    setSeparationOfDuties(true);
    const result = propose();
    expect(result).toMatchObject({
      status: 'approved',
      autoApproved: true,
      autoApproveWithheld: [],
    });
    expect(loadApprovalRequest(CHANNEL, result.approvalId)?.decidedBy).toBe(
      SECRET_INTRODUCTION_AUTO_APPROVER
    );
  });

  it('with SoD on, an agent requester goes to human approval', () => {
    setSeparationOfDuties(true);
    const result = propose({
      requestedBy: 'agent:claude-code',
      requestedByContext: {
        surface: 'terminal',
        actorId: 'agent:claude-code',
        actorRole: 'sovereign',
      },
    });
    expect(result).toMatchObject({
      status: 'pending',
      autoApproved: false,
      autoApproveWithheld: ['agent_requester'],
    });
    // The detected principal counts even when --requested-by names someone else.
    const masked = propose({
      requestedBy: 'user:owner',
      requestedByContext: { surface: 'terminal', actorId: 'agent:planner', actorRole: 'sovereign' },
    });
    expect(masked).toMatchObject({ status: 'pending', autoApproveWithheld: ['agent_requester'] });
  });

  it('with SoD on, a non-interactive value source (--from-file, unstated) goes to human approval', () => {
    setSeparationOfDuties(true);
    expect(propose({ valueSource: 'non_interactive' })).toMatchObject({
      status: 'pending',
      autoApproved: false,
      autoApproveWithheld: ['non_interactive_value'],
    });
    expect(propose({ valueSource: undefined })).toMatchObject({
      status: 'pending',
      autoApproveWithheld: ['non_interactive_value'],
    });
  });

  it('with SoD on, rotating over an existing value goes to human approval', () => {
    setSeparationOfDuties(true);
    fixture.existing = 'present';
    expect(propose({ mutation: 'rotate' })).toMatchObject({
      status: 'pending',
      autoApproved: false,
      autoApproveWithheld: ['rotate_existing_value'],
    });
    // A rotation with nothing to overwrite is additive.
    fixture.existing = null;
    expect(propose({ mutation: 'rotate' })).toMatchObject({ status: 'approved' });
  });

  it('with SoD off, all three cases still auto-approve (unchanged)', () => {
    setSeparationOfDuties(false);
    fixture.existing = 'present';
    const result = propose({
      requestedBy: 'agent:claude-code',
      requestedByContext: {
        surface: 'terminal',
        actorId: 'agent:claude-code',
        actorRole: 'sovereign',
      },
      valueSource: 'non_interactive',
      mutation: 'rotate',
    });
    expect(result).toMatchObject({
      status: 'approved',
      autoApproved: true,
      autoApproveWithheld: [],
    });
  });
});
