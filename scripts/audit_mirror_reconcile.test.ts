import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import {
  approvalEventLogicalPath,
  approvalRequestLogicalPath,
  decideApprovalRequest,
  loadApprovalRequest,
  type ApprovalRequestRecord,
} from '@agent/core/governance/approval-store';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeReaddir,
  safeRmSync,
  safeWriteFile,
} from '@agent/core/secure-io';
import { AUDIT_CHAIN_LOCK_ID } from '@agent/core/governance/audit-chain';
import { revokeApprovalRequest } from '@agent/core/governance/approval-revocation';
import {
  AUDIT_MIRROR_APPROVAL_CHANNEL,
  AUDIT_MIRROR_EFFECT_BINDING,
  collectAuditMirrorFindings,
  openAuditMirrorApproval,
  runAuditMirrorReconciliation,
} from './audit_mirror_reconcile.js';

// A stand-in for an apply that read the record before another apply consumed
// it: the script's pre-check sees this copy, the consume reads the store.
const staleRead = vi.hoisted(() => ({ record: undefined as ApprovalRequestRecord | undefined }));
vi.mock('@agent/core/governance/approval-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/governance/approval-store')>();
  return {
    ...actual,
    loadApprovalRequest: (...args: Parameters<typeof actual.loadApprovalRequest>) =>
      staleRead.record ?? actual.loadApprovalRequest(...args),
  };
});

// Runs when the apply takes the audit chain lock, before the locked work:
// stands in for an audit append that lands between the approval check and the
// lock. `byApply` counts audit-lock holds taken from the apply itself.
const onLock = vi.hoisted(() => ({
  byApply: 0,
  before: undefined as (() => void) | undefined,
}));
vi.mock('@agent/core/foundation/lock-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/foundation/lock-utils')>();
  return {
    ...actual,
    withLockSync: <T>(resourceId: string, fn: () => T, timeoutMs?: number): T =>
      actual.withLockSync(
        resourceId,
        () => {
          if (resourceId === 'audit-chain-global') {
            const limit = Error.stackTraceLimit;
            Error.stackTraceLimit = 100;
            const stack = new Error().stack;
            Error.stackTraceLimit = limit;
            if (stack?.includes('runAuditMirrorReconciliation')) onLock.byApply++;
            onLock.before?.();
          }
          return fn();
        },
        timeoutMs
      ),
  };
});

// Per file run: concurrent runs in one checkout never share the fixture.
const ROOT = pathResolver.sharedTmp(`audit-mirror-reconcile-test-${randomUUID()}`);
const MASTER = `${ROOT}/active/shared/logs/audit/audit-2026-07-01.jsonl`;
const MIRROR = `${ROOT}/customer/acme/logs/audit/audit-2026-07-01.jsonl`;

function entry(id: string, previousHash: string, tenantSlug = 'acme') {
  return {
    id,
    timestamp: '2026-07-01T10:00:00.000Z',
    agentId: 'agent-1',
    action: 'act',
    operation: 'op',
    result: 'completed',
    tenantSlug,
    previousHash,
    currentHash: `${id}-hash`,
  };
}

const lines = (...values: Array<string | object>) =>
  values.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join('\n') +
  '\n';

describe('audit mirror reconcile findings', () => {
  afterEach(() => safeRmSync(ROOT, { recursive: true, force: true }));

  function fixture(master: string, mirror: string) {
    safeMkdir(`${ROOT}/customer/acme/logs/audit`, { recursive: true });
    safeWriteFile(MASTER, master);
    safeWriteFile(MIRROR, mirror);
  }

  it('turns an unreadable mirror line into a rebuild finding instead of throwing', () => {
    const a = entry('AUD-A', '0'.repeat(64));
    const b = entry('AUD-B', a.currentHash);
    fixture(lines(a, b), lines(a, 'not json', b));

    expect(collectAuditMirrorFindings(ROOT)).toEqual([
      expect.objectContaining({
        slug: 'acme',
        reason: 'mirror_unreadable',
        action: 'quarantine_and_rebuild',
        unreadable_lines: 1,
        mirror_count: 2,
        master_count: 2,
      }),
    ]);
  });

  it('reads the master leniently: an unreadable master line hides only itself', () => {
    const a = entry('AUD-A', '0'.repeat(64));
    const b = entry('AUD-B', a.currentHash);
    fixture(lines(a, '{"x":', b), lines(a, b));

    expect(collectAuditMirrorFindings(ROOT)).toEqual([]);
  });
});

describe('audit mirror reconcile apply (SA-01)', () => {
  const MISSION = 'MSN-AUDIT-MIRROR-APPLY-TEST';
  const STALE_MIRROR = `${ROOT}/customer/globex/logs/audit/audit-2026-07-01.jsonl`;
  const opened: string[] = [];
  let previousRole: string | undefined;

  beforeEach(() => {
    previousRole = process.env.MISSION_ROLE;
    process.env.MISSION_ROLE = 'mission_controller';
  });

  afterEach(() => {
    onLock.before = undefined;
    staleRead.record = undefined;
    for (const id of opened.splice(0)) {
      safeRmSync(approvalRequestLogicalPath(AUDIT_MIRROR_APPROVAL_CHANNEL, id), { force: true });
    }
    // The vitest approval store is per run and pool (approvalStoreRoots), and
    // the store guard requires each file to leave it empty: clear the events
    // log the decisions above appended to.
    safeRmSync(approvalEventLogicalPath(AUDIT_MIRROR_APPROVAL_CHANNEL), { force: true });
    safeRmSync(ROOT, { recursive: true, force: true });
    if (previousRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = previousRole;
  });

  const a = entry('AUD-A', '0'.repeat(64));
  const b = entry('AUD-B', a.currentHash);
  const old = entry('AUD-OLD', '0'.repeat(64), 'globex');

  /** acme's mirror misses AUD-B (rebuild); globex has a mirror but no master entry (quarantine). */
  function drift() {
    safeMkdir(`${ROOT}/customer/acme/logs/audit`, { recursive: true });
    safeMkdir(`${ROOT}/customer/globex/logs/audit`, { recursive: true });
    safeWriteFile(MASTER, lines(a, b));
    safeWriteFile(MIRROR, lines(a));
    safeWriteFile(STALE_MIRROR, lines(old));
  }

  function request(mission = MISSION): string {
    const result = openAuditMirrorApproval({
      missionId: mission,
      requestedBy: 'audit-mirror-test-requester',
      rootDir: ROOT,
    });
    expect(result.created).toBe(true);
    opened.push(result.requestId!);
    return result.requestId!;
  }

  function decide(id: string, overrides: Record<string, unknown> = {}) {
    const record = loadApprovalRequest(AUDIT_MIRROR_APPROVAL_CHANNEL, id)!;
    decideApprovalRequest('mission_controller', {
      channel: record.channel,
      storageChannel: AUDIT_MIRROR_APPROVAL_CHANNEL,
      requestId: id,
      decision: 'approved',
      decidedBy: 'human-mirror-operator',
      decidedByRole: 'sovereign',
      authMethod: 'manual',
      decidedByType: 'human',
      authenticated: true,
      payloadHash: record.accountability?.payloadHash,
      effectBinding: record.accountability?.effectBinding,
      ...overrides,
    });
  }

  const untouched = () => {
    expect(safeReadFile(MIRROR, { encoding: 'utf8' })).toBe(lines(a));
    expect(safeReadFile(STALE_MIRROR, { encoding: 'utf8' })).toBe(lines(old));
    expect(safeExistsSync(`${ROOT}/active/archive`)).toBe(false);
  };

  it('a dry run writes only its receipt', () => {
    drift();
    const receipt = runAuditMirrorReconciliation({ missionId: MISSION, rootDir: ROOT });
    expect(receipt).toMatchObject({ mode: 'dry-run', archived: [], rebuilt: [] });
    expect(
      JSON.parse(safeReadFile(`${ROOT}/${receipt.receipt_path}`, { encoding: 'utf8' }) as string)
    ).toMatchObject({ mode: 'dry-run', findings: receipt.findings });
    expect(receipt.findings.map((finding) => [finding.slug, finding.action])).toEqual([
      ['acme', 'quarantine_and_rebuild'],
      ['globex', 'quarantine'],
    ]);
    untouched();
  });

  it('refuses to apply without an approved, matching, human-authenticated request', () => {
    drift();
    const apply = (approvalRequestId?: string, missionId = MISSION) =>
      runAuditMirrorReconciliation({ missionId, apply: true, approvalRequestId, rootDir: ROOT });

    expect(() => apply()).toThrow(/--approval-request-id is required/u);
    const pending = request();
    expect(() => apply(pending)).toThrow(/requires an approved mission_gate request/u);
    expect(() => apply(randomUUID())).toThrow(/requires an approved mission_gate request/u);

    decide(pending);
    // Bound to another mission.
    expect(() => apply(pending, 'MSN-AUDIT-MIRROR-OTHER')).toThrow(/different mission/u);
    // The findings changed after the approval: the hash no longer matches.
    safeWriteFile(MIRROR, lines(a, b, entry('AUD-C', b.currentHash)));
    expect(() => apply(pending)).toThrow(/different findings set/u);
    expect(safeExistsSync(`${ROOT}/active/archive`)).toBe(false);
    safeWriteFile(MIRROR, lines(a));
    untouched();
  });

  it('refuses an approval decided by a non-human or unauthenticated actor', () => {
    drift();
    const agent = request();
    // The store refuses such a decision outright: the request stays pending.
    expect(() => decide(agent, { decidedByType: 'agent' })).toThrow(/human decider/u);
    expect(() => decide(agent, { authenticated: false })).toThrow(/POLICY_VIOLATION/u);
    expect(loadApprovalRequest(AUDIT_MIRROR_APPROVAL_CHANNEL, agent)?.status).toBe('pending');
    untouched();
  });

  it.each([
    ['an unauthenticated decider', { authenticated: false }],
    ['an agent decider', { decidedByType: 'agent' }],
  ])('rechecks the stored decision: an approved record with %s is refused', (_label, tamper) => {
    drift();
    const id = request();
    decide(id);
    // The record on disk says approved, but its decision entry is not a
    // human-authenticated one (a hand-edited or forged record).
    const file = approvalRequestLogicalPath(AUDIT_MIRROR_APPROVAL_CHANNEL, id);
    const stored = JSON.parse(safeReadFile(file, { encoding: 'utf8' }) as string);
    stored.workflow.approvals = stored.workflow.approvals.map((entry: object) => ({
      ...entry,
      ...tamper,
    }));
    safeWriteFile(file, JSON.stringify(stored));
    expect(loadApprovalRequest(AUDIT_MIRROR_APPROVAL_CHANNEL, id)?.status).toBe('approved');
    expect(() =>
      runAuditMirrorReconciliation({
        missionId: MISSION,
        apply: true,
        approvalRequestId: id,
        rootDir: ROOT,
      })
    ).toThrow(/SA-01 requires an authenticated human approval/u);
    untouched();
  });

  it('applies an approved request: archives every mirror, rebuilds only from the master', () => {
    drift();
    const masterBefore = safeReadFile(MASTER, { encoding: 'utf8' });
    const id = request();
    decide(id);
    const record = loadApprovalRequest(AUDIT_MIRROR_APPROVAL_CHANNEL, id)!;
    expect(record.accountability?.effectBinding).toBe(AUDIT_MIRROR_EFFECT_BINDING);

    const receipt = runAuditMirrorReconciliation({
      missionId: MISSION,
      apply: true,
      approvalRequestId: id,
      rootDir: ROOT,
    });
    expect(receipt).toMatchObject({
      mode: 'apply',
      approval_request_id: id,
      rebuilt: [{ slug: 'acme', path: 'customer/acme/logs/audit', entries: 2 }],
    });
    expect(receipt.archived.map((item) => item.from)).toEqual([
      'customer/acme/logs/audit',
      'customer/globex/logs/audit',
    ]);
    // The master is never written; acme is rebuilt from it; globex is only quarantined.
    expect(safeReadFile(MASTER, { encoding: 'utf8' })).toBe(masterBefore);
    expect(safeReadFile(MIRROR, { encoding: 'utf8' })).toBe(lines(a, b));
    expect(safeExistsSync(`${ROOT}/customer/globex/logs/audit`)).toBe(false);
    // Archived copies keep the exact old content.
    const archivedContent = Object.fromEntries(
      receipt.archived.map((item) => {
        expect(safeReaddir(`${ROOT}/${item.to}`)).toEqual(['audit-2026-07-01.jsonl']);
        return [
          item.from,
          safeReadFile(`${ROOT}/${item.to}/audit-2026-07-01.jsonl`, { encoding: 'utf8' }),
        ];
      })
    );
    expect(archivedContent).toEqual({
      'customer/acme/logs/audit': lines(a),
      'customer/globex/logs/audit': lines(old),
    });
    // The receipt is written where it says, and a second run finds nothing to do.
    expect(
      JSON.parse(safeReadFile(`${ROOT}/${receipt.receipt_path}`, { encoding: 'utf8' }) as string)
    ).toMatchObject({ mode: 'apply', approval_request_id: id });
    expect(collectAuditMirrorFindings(ROOT)).toEqual([]);
  });

  it('uses an approval once: the same drift recurring needs a new approval', () => {
    drift();
    const findings = collectAuditMirrorFindings(ROOT);
    const id = request();
    decide(id);
    const apply = () =>
      runAuditMirrorReconciliation({
        missionId: MISSION,
        apply: true,
        approvalRequestId: id,
        rootDir: ROOT,
      });
    const receipt = apply();
    expect(loadApprovalRequest(AUDIT_MIRROR_APPROVAL_CHANNEL, id)?.consumption).toMatchObject({
      consumer: 'audit_mirror_reconcile',
      consumedBy: 'human-mirror-operator',
      effectRef: receipt.archived[0].to.split('/').slice(0, 4).join('/'),
    });

    // The identical drift comes back: the findings, and so the payload hash, match again.
    drift();
    expect(collectAuditMirrorFindings(ROOT)).toEqual(findings);
    const archives = safeReaddir(`${ROOT}/active/archive/.trash`);
    expect(() => apply()).toThrow(/was already used by audit_mirror_reconcile/u);
    // Refused before any effect: nothing more archived, the mirrors are as drifted.
    expect(safeReaddir(`${ROOT}/active/archive/.trash`)).toEqual(archives);
    expect(safeReadFile(MIRROR, { encoding: 'utf8' })).toBe(lines(a));
    expect(safeReadFile(STALE_MIRROR, { encoding: 'utf8' })).toBe(lines(old));

    // A fresh request for the same findings is a new approval, not the consumed one.
    expect(request()).not.toBe(id);
  });

  it('a racing apply that passed the pre-check is still stopped by the consume', () => {
    drift();
    const id = request();
    decide(id);
    const approved = loadApprovalRequest(AUDIT_MIRROR_APPROVAL_CHANNEL, id)!;
    const apply = () =>
      runAuditMirrorReconciliation({
        missionId: MISSION,
        apply: true,
        approvalRequestId: id,
        rootDir: ROOT,
      });
    expect(apply().approved_by).toBe('human-mirror-operator');
    drift();
    const archives = safeReaddir(`${ROOT}/active/archive/.trash`);
    staleRead.record = approved;
    try {
      // The store lock refuses the second consumer before anything moves.
      expect(() => apply()).toThrow(/approvals are used once/u);
    } finally {
      staleRead.record = undefined;
    }
    expect(safeReaddir(`${ROOT}/active/archive/.trash`)).toEqual(archives);
    expect(safeReadFile(MIRROR, { encoding: 'utf8' })).toBe(lines(a));
  });

  it('rechecks the findings under the audit chain lock: a change after the check applies nothing', () => {
    drift();
    const id = request();
    decide(id);
    onLock.byApply = 0;
    // An append lands on acme's mirror after the approval check, before the lock.
    onLock.before = () => {
      onLock.before = undefined;
      safeWriteFile(MIRROR, lines(a, b));
    };
    expect(() =>
      runAuditMirrorReconciliation({
        missionId: MISSION,
        apply: true,
        approvalRequestId: id,
        rootDir: ROOT,
      })
    ).toThrow(/AUDIT_MIRROR_CHANGED/u);
    expect(onLock.byApply).toBe(1);
    // Nothing moved and the approval is still unused.
    expect(safeExistsSync(`${ROOT}/active/archive`)).toBe(false);
    expect(safeReadFile(MIRROR, { encoding: 'utf8' })).toBe(lines(a, b));
    expect(safeReadFile(STALE_MIRROR, { encoding: 'utf8' })).toBe(lines(old));
    expect(loadApprovalRequest(AUDIT_MIRROR_APPROVAL_CHANNEL, id)?.consumption).toBeUndefined();
  });

  it('takes the audit chain lock the appends take', () => {
    // The mock above matches the id by value; keep it in step with the chain.
    expect(AUDIT_CHAIN_LOCK_ID).toBe('audit-chain-global');
  });

  it('refuses an approval revoked after the check with the reason, without waiting on the audit lock', () => {
    drift();
    const id = request();
    decide(id);
    const approved = loadApprovalRequest(AUDIT_MIRROR_APPROVAL_CHANNEL, id)!;
    revokeApprovalRequest('mission_controller', {
      channel: AUDIT_MIRROR_APPROVAL_CHANNEL,
      requestId: id,
      revokedBy: 'human-mirror-operator',
    });
    // The pre-check still sees the approval as it was before the revoke.
    staleRead.record = approved;
    const started = Date.now();
    expect(() =>
      runAuditMirrorReconciliation({
        missionId: MISSION,
        apply: true,
        approvalRequestId: id,
        rootDir: ROOT,
      })
    ).toThrow(/was revoked by human-mirror-operator/u);
    // Refused under the record lock, before the apply holds the audit lock:
    // the refusal's own audit entry is written at once instead of waiting out
    // the 5 s lock budget behind the apply and failing.
    expect(Date.now() - started).toBeLessThan(4000);
    untouched();
  });

  it('names mirror entries the master can no longer read, in the finding and the approval', () => {
    // The master line of AUD-B is unreadable: only the mirror still holds it.
    safeMkdir(`${ROOT}/customer/acme/logs/audit`, { recursive: true });
    safeWriteFile(MASTER, lines(a, '{"truncated":'));
    safeWriteFile(MIRROR, lines(a, b));

    const [finding] = collectAuditMirrorFindings(ROOT);
    expect(finding).toMatchObject({
      slug: 'acme',
      reason: 'mirror_out_of_sync',
      action: 'quarantine_and_rebuild',
      mirror_count: 2,
      master_count: 1,
      archive_only_entries: 1,
      archive_only_ids: ['AUD-B'],
    });
    const id = request();
    const record = loadApprovalRequest(AUDIT_MIRROR_APPROVAL_CHANNEL, id)!;
    expect(record.summary).toContain(
      '1 mirror entry has no matching readable master copy: the rebuild leaves it out of the live mirror and it survives only in the archive.'
    );
    expect(record.justification?.impactSummary).toContain('survives only in the archive');
    expect(record.details).toContain('AUD-B');

    decide(id);
    const receipt = runAuditMirrorReconciliation({
      missionId: MISSION,
      apply: true,
      approvalRequestId: id,
      rootDir: ROOT,
    });
    // The live mirror holds what the master can read; AUD-B stays in the archive.
    expect(safeReadFile(MIRROR, { encoding: 'utf8' })).toBe(lines(a));
    expect(
      safeReadFile(`${ROOT}/${receipt.archived[0].to}/audit-2026-07-01.jsonl`, {
        encoding: 'utf8',
      })
    ).toBe(lines(a, b));
  });

  it('counts a differing copy, once per copy, and never an entry readable under another tenant', () => {
    const c = entry('AUD-C', b.currentHash);
    const tampered = { ...c, currentHash: 'AUD-C-other-hash' };
    const foreign = entry('AUD-G', '0'.repeat(64), 'globex');
    safeMkdir(`${ROOT}/customer/acme/logs/audit`, { recursive: true });
    safeWriteFile(MASTER, lines(a, b, c, foreign));
    // A duplicated line, a copy that differs from the master, and globex's
    // entry (readable in the master) in acme's mirror.
    safeWriteFile(MIRROR, lines(a, b, b, tampered, foreign));
    expect(collectAuditMirrorFindings(ROOT)).toEqual([
      expect.objectContaining({
        slug: 'acme',
        action: 'quarantine_and_rebuild',
        archive_only_entries: 1,
        archive_only_ids: ['AUD-C'],
      }),
    ]);
  });

  it('names nothing for a quarantine-only finding: its whole mirror is archived on purpose', () => {
    drift();
    const findings = collectAuditMirrorFindings(ROOT);
    expect(findings.find((finding) => finding.slug === 'globex')).not.toHaveProperty(
      'archive_only_entries'
    );
    const id = request();
    expect(loadApprovalRequest(AUDIT_MIRROR_APPROVAL_CHANNEL, id)?.summary).not.toContain(
      'only in the archive'
    );
  });
});
