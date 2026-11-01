import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  approvalRequestLogicalPath,
  approvalStoreRoots,
  decideApprovalRequest,
  listApprovalRequests,
} from '@agent/core/governance/approval-store';
import { withExecutionContext } from '@agent/core/governance';
import { STALE_COMPACTION_COPY_MS } from '@agent/core/compaction-copy-recovery';
import { pathResolver } from '@agent/core/path-resolver';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeReaddir,
  safeRmSync,
  safeWriteFile,
} from '@agent/core/secure-io';
import { validateWritePermission } from '@agent/core/tier-guard';
import {
  main,
  openRecoverCopiesApproval,
  runRecoverCompactionCopies,
  RECOVER_COPIES_APPROVAL_CHANNEL,
  RECOVER_COPIES_EFFECT_BINDING,
} from './storage_recover_compaction_copies.js';

const ROOT_REL = `active/shared/tmp/storage-recover-copies-test-${process.pid}`;
const STORE_REL = `${ROOT_REL}/queue/items.jsonl`;
const COPY_REL = `${STORE_REL}.compacting-t000000000000001-000000-1-initial`;
const roots = [ROOT_REL];
const opened: string[] = [];
const later = (): Date => new Date(Date.now() + STALE_COMPACTION_COPY_MS + 60_000);

function write(rel: string, lines: string[]): void {
  safeWriteFile(pathResolver.rootResolve(rel), lines.map((line) => `${line}\n`).join(''));
}

function read(rel: string): string[] {
  const file = pathResolver.rootResolve(rel);
  if (!safeExistsSync(file)) return [];
  return String(safeReadFile(file, { encoding: 'utf8' }))
    .split('\n')
    .filter(Boolean);
}

function copiesOnDisk(): string[] {
  return safeReaddir(path.dirname(pathResolver.rootResolve(STORE_REL))).filter((name) =>
    name.includes('.compacting-')
  );
}

function approve(requestId: string, payloadHash: string) {
  return withExecutionContext(
    'mission_controller',
    () =>
      decideApprovalRequest('mission_controller', {
        channel: RECOVER_COPIES_APPROVAL_CHANNEL,
        storageChannel: RECOVER_COPIES_APPROVAL_CHANNEL,
        requestId,
        decision: 'approved',
        decidedBy: 'sovereign-operator',
        authMethod: 'surface_session',
        decidedByType: 'human',
        authenticated: true,
        payloadHash,
        effectBinding: RECOVER_COPIES_EFFECT_BINDING,
      }),
    'worker'
  );
}

beforeEach(() => {
  safeRmSync(pathResolver.rootResolve(ROOT_REL), { recursive: true, force: true });
  safeMkdir(path.dirname(pathResolver.rootResolve(STORE_REL)), { recursive: true });
  write(COPY_REL, ['{"id":1}', '{"id":2}']);
  write(STORE_REL, ['{"id":2}', '{"id":3}']);
});

afterEach(() => {
  safeRmSync(pathResolver.rootResolve(ROOT_REL), { recursive: true, force: true });
  withExecutionContext('mission_controller', () => {
    for (const id of opened.splice(0)) {
      safeRmSync(approvalRequestLogicalPath(RECOVER_COPIES_APPROVAL_CHANNEL, id), { force: true });
    }
    const storeRoots = approvalStoreRoots();
    for (const root of [storeRoots.coordination, storeRoots.observability]) {
      safeRmSync(pathResolver.rootResolve(path.join(root, RECOVER_COPIES_APPROVAL_CHANNEL)), {
        recursive: true,
        force: true,
      });
    }
  });
});

describe('storage recover-compaction-copies', () => {
  it('dry-run is the default, lists the copies per store and changes nothing', async () => {
    const receipt = await runRecoverCompactionCopies({ roots, now: later() });
    expect(receipt.mode).toBe('dry-run');
    expect(receipt.plans).toHaveLength(1);
    expect(receipt.plans![0]).toMatchObject({ store: STORE_REL, action: 'merge' });
    expect(receipt.plans![0]!.copies).toMatchObject([
      { path: COPY_REL, size_bytes: '{"id":1}\n{"id":2}\n'.length, stale: true },
    ]);
    expect(receipt.next).toContain('--request-approval');
    expect(copiesOnDisk()).toHaveLength(1);
    expect(read(STORE_REL)).toEqual(['{"id":2}', '{"id":3}']);
  });

  it('refuses --path outside the store roots', async () => {
    for (const bad of ['knowledge/product/governance/ci-gates.json', 'active/shared/tmp/x.json']) {
      await expect(main(['--path', bad])).rejects.toThrow(/--path must be a \.jsonl store/);
    }
  });

  it('refuses to request or apply while a copy is younger than the stale threshold', async () => {
    expect(() => openRecoverCopiesApproval({ roots })).toThrow(/younger than 60 minutes/);
    await expect(
      runRecoverCompactionCopies({ roots, apply: true, approvalRequestId: 'REQ-X' })
    ).rejects.toThrow(/younger than 60 minutes/);
    expect(copiesOnDisk()).toHaveLength(1);
  });

  it('refuses --apply without an approved, human, copy-set-bound approval', async () => {
    const now = later();
    await expect(runRecoverCompactionCopies({ roots, now, apply: true })).rejects.toThrow(
      /--approval-request-id/
    );
    const request = openRecoverCopiesApproval({ roots, now });
    opened.push(request.requestId);
    expect(request.created).toBe(true);
    expect(openRecoverCopiesApproval({ roots, now }).requestId).toBe(request.requestId);
    await expect(
      runRecoverCompactionCopies({ roots, now, apply: true, approvalRequestId: request.requestId })
    ).rejects.toThrow(/approved request/);
    approve(request.requestId, request.payloadHash);
    // Another copy appeared: the approval no longer matches the copy set.
    write(`${STORE_REL}.compacting-t000000000000002-000000-1-merge-0`, ['{"id":9}']);
    await expect(
      runRecoverCompactionCopies({ roots, now, apply: true, approvalRequestId: request.requestId })
    ).rejects.toThrow(/different store\/copy set/);
    expect(copiesOnDisk()).toHaveLength(2);
  });

  it('applies once with an approval: merges, de-duplicates, removes the copy', async () => {
    const now = later();
    const request = openRecoverCopiesApproval({ roots, now });
    opened.push(request.requestId);
    approve(request.requestId, request.payloadHash);
    const receipt = await runRecoverCompactionCopies({
      roots,
      now,
      apply: true,
      approvalRequestId: request.requestId,
    });
    expect(receipt).toMatchObject({
      mode: 'apply',
      approved_by: 'sovereign-operator',
      results: [{ store: STORE_REL, outcome: 'merged', duplicates_dropped: 1 }],
    });
    expect(read(STORE_REL)).toEqual(['{"id":1}', '{"id":2}', '{"id":3}']);
    expect(copiesOnDisk()).toEqual([]);
    const record = withExecutionContext('mission_controller', () =>
      listApprovalRequests({ storageChannels: [RECOVER_COPIES_APPROVAL_CHANNEL] }).find(
        (entry) => entry.id === request.requestId
      )
    );
    expect(record?.consumption?.consumer).toBe('storage_recover_compaction_copies');
    // Used once: a re-run with the same approval is refused (nothing left to merge either).
    write(COPY_REL, ['{"id":1}']);
    await expect(
      runRecoverCompactionCopies({ roots, now, apply: true, approvalRequestId: request.requestId })
    ).rejects.toThrow(/already used|approved request/);
  });

  it('the recovery role can write the store roots, their lock and the retention audit log', () => {
    withExecutionContext('mission_controller', () => {
      for (const target of [
        'active/shared/observability/x.jsonl',
        'active/shared/runtime/agent-input-queue/q.jsonl.compacting-t1-0-1-x',
        'active/shared/runtime/locks/append-only-store-x.lock',
        'active/shared/observability/work-coordination/events.jsonl',
        'active/shared/logs/audit/storage-retention.jsonl',
        'active/missions/MSN-EXAMPLE/state.jsonl',
      ]) {
        expect(validateWritePermission(pathResolver.rootResolve(target)).allowed, target).toBe(
          true
        );
      }
    });
  });
});
