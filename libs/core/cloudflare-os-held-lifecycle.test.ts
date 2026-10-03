import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeMkdir } from './secure-io.js';
import { auditChain } from './governance/audit-chain.js';
import { CloudflareOsControlPlane } from './cloudflare-os-control-plane.js';
import {
  controlPlaneJournalPath,
  setControlPlaneRuntimeRootForTests,
} from './cloudflare-os-journal.js';

let root: string;
let counter = 0;

beforeEach(() => {
  counter += 1;
  root = pathResolver.shared(`tmp/held-lifecycle-${process.pid}-${counter}`);
  safeMkdir(root, { recursive: true });
  setControlPlaneRuntimeRootForTests(root);
  vi.spyOn(auditChain, 'record').mockImplementation(() => ({}) as never);
});

afterEach(() => {
  setControlPlaneRuntimeRootForTests(undefined);
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

const human = (r: { payloadHash: string; effectBinding: string }) => ({
  resolvedBy: 'human:famao',
  decidedByType: 'human' as const,
  authenticated: true,
  payloadHash: r.payloadHash,
  effectBinding: r.effectBinding,
});
const base = {
  missionId: 'mission-l',
  tenantSlug: 'tenant-a',
  submittedBy: 'agent:x',
  params: { n: 1 },
};
const submit = (cp: CloudflareOsControlPlane, op: string, extra: Record<string, unknown> = {}) =>
  cp.submitHeldAction({ ...base, op, apply: async () => 'ok', ...extra });

describe('a journal line cut short by a crash', () => {
  it('does not swallow the next event appended after it', () => {
    const first = new CloudflareOsControlPlane();
    submit(first, 'demo:a');
    const dir = path.join(root, 'confidential', 'tenant-a', 'cloudflare-os');
    // The process died mid-append: a partial line with no trailing newline.
    fs.appendFileSync(
      controlPlaneJournalPath(dir),
      '{"seq":2,"ts":"2026-10-03T00:00:00Z","kind":"held","op":"upsert","recor'
    );
    const next = submit(new CloudflareOsControlPlane(), 'demo:b');
    expect(new CloudflareOsControlPlane().getHeldAction(next.id)?.op).toBe('demo:b');
  });
});

describe('dependencies between held actions', () => {
  it('cancels an already-approved dependent when its dependency is rejected', () => {
    const cp = new CloudflareOsControlPlane();
    const a = submit(cp, 'demo:a');
    const b = submit(cp, 'demo:b', { dependsOn: [a.id] });
    cp.decideHeldAction(b.id, 'approved', human(b));
    cp.decideHeldAction(a.id, 'rejected', human(a));
    expect(cp.getHeldAction(b.id)?.status).toBe('cancelled');
  });

  it('does not run a dependent whose dependency failed, and cancels it', async () => {
    const cp = new CloudflareOsControlPlane();
    let ran = 0;
    const a = submit(cp, 'demo:a', {
      apply: async () => {
        throw new Error('boom');
      },
    });
    const b = submit(cp, 'demo:b', {
      dependsOn: [a.id],
      apply: async () => {
        ran += 1;
        return 'ok';
      },
    });
    cp.decideHeldAction(a.id, 'approved', human(a));
    cp.decideHeldAction(b.id, 'approved', human(b));
    expect((await cp.applyHeldAction(a.id)).status).toBe('failed');
    expect(cp.getHeldAction(b.id)?.status).toBe('cancelled');
    expect((await cp.applyHeldAction(b.id)).status).toBe('cancelled');
    expect(ran).toBe(0);
  });

  it('waits (without running or failing) while a dependency is not yet applied', async () => {
    const cp = new CloudflareOsControlPlane();
    let ran = 0;
    const a = submit(cp, 'demo:a');
    const b = submit(cp, 'demo:b', {
      dependsOn: [a.id],
      apply: async () => {
        ran += 1;
        return 'ok';
      },
    });
    cp.decideHeldAction(b.id, 'approved', human(b));
    expect((await cp.applyHeldAction(b.id)).status).toBe('approved');
    expect(ran).toBe(0);
    cp.decideHeldAction(a.id, 'approved', human(a));
    await cp.applyHeldAction(a.id);
    expect((await cp.applyHeldAction(b.id)).status).toBe('applied');
    expect(ran).toBe(1);
  });

  it('cancels a dependent whose dependency does not exist', async () => {
    const cp = new CloudflareOsControlPlane();
    const b = submit(cp, 'demo:b', { dependsOn: ['no-such-action'] });
    cp.decideHeldAction(b.id, 'approved', human(b));
    expect((await cp.applyHeldAction(b.id)).status).toBe('cancelled');
  });
});

describe('cancelling a held action that can no longer proceed', () => {
  it('lets an authenticated human cancel a pending or approved action, with a reason', () => {
    const cp = new CloudflareOsControlPlane();
    const pending = submit(cp, 'demo:a');
    const approved = submit(cp, 'demo:b');
    cp.decideHeldAction(approved.id, 'approved', human(approved));
    expect(
      cp.cancelHeldAction(pending.id, { ...human(pending), reason: 'op was retired' }).status
    ).toBe('cancelled');
    expect(
      cp.cancelHeldAction(approved.id, { ...human(approved), reason: 'executor removed' }).status
    ).toBe('cancelled');
    expect(new CloudflareOsControlPlane().getHeldAction(approved.id)?.status).toBe('cancelled');
  });

  it('cascades to dependents and refuses without a human, a reason, or on a settled action', async () => {
    const cp = new CloudflareOsControlPlane();
    const a = submit(cp, 'demo:a');
    const b = submit(cp, 'demo:b', { dependsOn: [a.id] });
    expect(() =>
      cp.cancelHeldAction(a.id, { ...human(a), decidedByType: 'ai_agent', reason: 'x' })
    ).toThrow(/authenticated human/);
    expect(() => cp.cancelHeldAction(a.id, { ...human(a), reason: ' ' })).toThrow();
    cp.cancelHeldAction(a.id, { ...human(a), reason: 'obsolete' });
    expect(cp.getHeldAction(b.id)?.status).toBe('cancelled');

    const done = submit(cp, 'demo:done');
    cp.decideHeldAction(done.id, 'approved', human(done));
    await cp.applyHeldAction(done.id);
    expect(() => cp.cancelHeldAction(done.id, { ...human(done), reason: 'late' })).toThrow(
      /cannot be cancelled/
    );
  });

  it('refuses to cancel while an apply claim is unresolved (the effect may have run)', () => {
    const cp = new CloudflareOsControlPlane();
    const a = submit(cp, 'demo:a');
    cp.decideHeldAction(a.id, 'approved', human(a));
    const store = (
      cp as unknown as { journalStore: { claimHeldApply(id: string, by: string): boolean } }
    ).journalStore;
    expect(store.claimHeldApply(a.id, 'ghost:1')).toBe(true);
    expect(() => cp.cancelHeldAction(a.id, { ...human(a), reason: 'stuck' })).toThrow(/release/);
  });
});

describe('draining held actions', () => {
  it('applies a dependent submitted before its dependency in one drain', async () => {
    const cp = new CloudflareOsControlPlane();
    const order: string[] = [];
    const dependent = submit(cp, 'demo:dependent', {
      dependsOn: ['dep-a'],
      apply: async () => {
        order.push('dependent');
        return 'ok';
      },
    });
    const dependency = submit(cp, 'demo:dependency', {
      id: 'dep-a',
      apply: async () => {
        order.push('dependency');
        return 'ok';
      },
    });
    cp.decideHeldAction(dependent.id, 'approved', human(dependent));
    cp.decideHeldAction(dependency.id, 'approved', human(dependency));
    await cp.drainHeldActions('mission-l');
    expect(order).toEqual(['dependency', 'dependent']);
    expect(cp.getHeldAction(dependent.id)?.status).toBe('applied');
  });
});

describe('recording the outcome of an applied effect', () => {
  it('retries a transient persistence failure so the claim does not outlive the effect', async () => {
    const cp = new CloudflareOsControlPlane();
    const record = submit(cp, 'demo:a');
    cp.decideHeldAction(record.id, 'approved', human(record));
    const target = cp as unknown as {
      recordMutation: (kind: string, ...records: unknown[]) => void;
    };
    const original = target.recordMutation.bind(cp);
    let failures = 2;
    vi.spyOn(target, 'recordMutation').mockImplementation((kind, ...records) => {
      if (
        kind === 'held' &&
        (records[0] as { status?: string }).status === 'applied' &&
        failures > 0
      ) {
        failures -= 1;
        throw new Error('lock timeout');
      }
      original(kind, ...records);
    });
    expect((await cp.applyHeldAction(record.id)).status).toBe('applied');
    expect(new CloudflareOsControlPlane().getHeldAction(record.id)?.status).toBe('applied');
  });
});
