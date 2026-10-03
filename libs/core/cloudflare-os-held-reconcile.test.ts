import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeAppendFileSync, safeMkdir, safeRmSync } from './secure-io.js';
import { auditChain } from './governance/audit-chain.js';
import { CloudflareOsControlPlane } from './cloudflare-os-control-plane.js';
import { setControlPlaneRuntimeRootForTests } from './cloudflare-os-journal.js';
import {
  cancelApprovalRequest,
  decideApprovalRequest,
  drainPendingSteeringApprovalExecutions,
  expireApprovalRequest,
} from './governance/approval-store.js';

// The process that decided the approval request died (or its bridge failed)
// before the decision reached the control plane.
vi.mock('./governance/held-effect-bridge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./governance/held-effect-bridge.js')>()),
  settleHeldEffectDecision: async () => {
    throw new Error('bridge down');
  },
}));

let root: string;
let counter = 0;

beforeEach(() => {
  counter += 1;
  root = pathResolver.shared(`tmp/held-reconcile-${process.pid}-${counter}`);
  safeMkdir(root, { recursive: true });
  setControlPlaneRuntimeRootForTests(root);
  vi.spyOn(auditChain, 'record').mockImplementation(() => ({}) as never);
});

afterEach(() => {
  setControlPlaneRuntimeRootForTests(undefined);
  vi.restoreAllMocks();
  safeRmSync(root, { recursive: true, force: true });
});

const submitLinked = (cp: CloudflareOsControlPlane, op = 'demo:x') =>
  cp.submitHeldAction({
    missionId: 'mission-r',
    tenantSlug: 'tenant-a',
    submittedBy: 'agent:x',
    op,
    params: { n: 1 },
    apply: async () => 'ok',
    steeringApproval: {
      surface: 'cli',
      channel: 'ops',
      threadTs: `thread-${op}`,
      correlationId: `corr-${op}`,
      requestedBy: 'agent:x',
      title: 't',
      summary: 's',
    },
  });
const linkOf = (record: { approvalRequest?: { storageChannel: string; requestId: string } }) => ({
  channel: record.approvalRequest!.storageChannel,
  storageChannel: record.approvalRequest!.storageChannel,
  requestId: record.approvalRequest!.requestId,
});

describe('a held action whose approval was decided elsewhere', () => {
  it('picks up an approval the bridge never delivered, and can then apply once', async () => {
    const cp = new CloudflareOsControlPlane();
    let runs = 0;
    const record = cp.submitHeldAction({
      missionId: 'mission-r',
      tenantSlug: 'tenant-a',
      submittedBy: 'agent:x',
      op: 'demo:x',
      params: { n: 1 },
      apply: async () => {
        runs += 1;
        return 'ok';
      },
      steeringApproval: {
        surface: 'cli',
        channel: 'ops',
        threadTs: 't1',
        correlationId: 'c1',
        requestedBy: 'agent:x',
        title: 't',
        summary: 's',
      },
    });
    decideApprovalRequest('mission_controller', {
      ...linkOf(record),
      decision: 'approved',
      decidedBy: 'human:famao',
      decidedByType: 'human',
      authenticated: true,
      payloadHash: record.payloadHash,
      effectBinding: record.effectBinding,
    });
    await drainPendingSteeringApprovalExecutions();
    // The bridge failed, so nothing told the plane — it is still pending.
    expect(new CloudflareOsControlPlane().getHeldAction(record.id)?.status).toBe('pending');

    cp.refreshFromJournals();
    expect(cp.getHeldAction(record.id)?.status).toBe('approved');
    expect((await cp.applyHeldAction(record.id)).status).toBe('applied');
    expect(runs).toBe(1);
  });

  it('picks up a rejection the bridge never delivered', async () => {
    const cp = new CloudflareOsControlPlane();
    const record = submitLinked(cp);
    decideApprovalRequest('mission_controller', {
      ...linkOf(record),
      decision: 'rejected',
      decidedBy: 'human:famao',
      decidedByType: 'human',
      authenticated: true,
      payloadHash: record.payloadHash,
      effectBinding: record.effectBinding,
    });
    await drainPendingSteeringApprovalExecutions();
    cp.reconcileLinkedApprovals();
    expect(cp.getHeldAction(record.id)?.status).toBe('rejected');
  });

  it('cancels the held action when its approval request was cancelled or expired', () => {
    const cp = new CloudflareOsControlPlane();
    const cancelled = submitLinked(cp, 'demo:cancelled');
    const expired = submitLinked(cp, 'demo:expired');
    cancelApprovalRequest('mission_controller', {
      ...linkOf(cancelled),
      cancelledBy: 'human:famao',
      reason: 'turn aborted',
    });
    expireApprovalRequest('mission_controller', { ...linkOf(expired), reason: 'stale_pending' });
    cp.reconcileLinkedApprovals();
    expect(cp.getHeldAction(cancelled.id)?.status).toBe('cancelled');
    expect(cp.getHeldAction(expired.id)?.status).toBe('cancelled');
  });

  it('leaves a held action alone while its request is still pending', () => {
    const cp = new CloudflareOsControlPlane();
    const record = submitLinked(cp);
    expect(cp.reconcileLinkedApprovals()).toBe(0);
    expect(cp.getHeldAction(record.id)?.status).toBe('pending');
  });

  it('cancelling a held action also cancels its pending approval request', () => {
    const cp = new CloudflareOsControlPlane();
    const record = submitLinked(cp);
    cp.cancelHeldAction(record.id, {
      resolvedBy: 'human:famao',
      decidedByType: 'human',
      authenticated: true,
      payloadHash: record.payloadHash,
      effectBinding: record.effectBinding,
      reason: 'no longer needed',
    });
    // Nothing is left pending in the approval queue for it.
    const again = expireApprovalRequest('mission_controller', linkOf(record));
    expect(again.status).toBe('cancelled');
  });

  it('refuses a held record whose approval link names a role other than mission_controller', () => {
    const cp = new CloudflareOsControlPlane();
    const record = submitLinked(cp);
    // A tampered or migrated record: the plane never calls the approval store as that role.
    (record.approvalRequest as { role: string }).role = 'sovereign_concierge';
    expect(() =>
      cp.cancelHeldAction(record.id, {
        resolvedBy: 'human:famao',
        decidedByType: 'human',
        authenticated: true,
        payloadHash: record.payloadHash,
        effectBinding: record.effectBinding,
        reason: 'tampered',
      })
    ).toThrow(/not mission_controller/);
    expect(cp.getHeldAction(record.id)?.status).toBe('pending');
  });
});
