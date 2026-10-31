import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  approvalRequestLogicalPath,
  approvalStoreRoots,
  decideApprovalRequest,
  listApprovalRequests,
} from '@agent/core/governance/approval-store';
import { withExecutionContext } from '@agent/core/governance';
import { pathResolver } from '@agent/core/path-resolver';
import {
  safeExistsSync,
  safeReadFile,
  safeReaddir,
  safeRmSync,
  safeUnlinkSync,
  safeWriteFile,
} from '@agent/core/secure-io';
import {
  main,
  openTriggerStoreRotateApproval,
  runTriggerStoreRotate,
  TRIGGER_STORE_ROTATE_APPROVAL_CHANNEL,
  TRIGGER_STORE_ROTATE_EFFECT_BINDING,
} from './trigger_store_rotate.js';

const authority = { authority_role: 'chronos_gateway', level: 40, tenant_slug: 'common' };
const opened: string[] = [];
const stores: string[] = [];

function segments(store: string): string[] {
  const stem = path.basename(store).replace(/\.jsonl$/u, '');
  return safeReaddir(path.dirname(store))
    .filter((name) => name.startsWith(`${stem}-`))
    .map((name) => path.join(path.dirname(store), name));
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    for (const file of [store, ...segments(store)]) if (safeExistsSync(file)) safeUnlinkSync(file);
  }
  withExecutionContext('mission_controller', () => {
    for (const id of opened.splice(0)) {
      safeRmSync(approvalRequestLogicalPath(TRIGGER_STORE_ROTATE_APPROVAL_CHANNEL, id), {
        force: true,
      });
    }
    const roots = approvalStoreRoots();
    for (const root of [roots.coordination, roots.observability]) {
      safeRmSync(pathResolver.rootResolve(path.join(root, TRIGGER_STORE_ROTATE_APPROVAL_CHANNEL)), {
        recursive: true,
        force: true,
      });
    }
  });
});

function seedStore(): string {
  const store = pathResolver.sharedTmp(`trigger-store-rotate-${randomUUID()}.jsonl`);
  stores.push(store);
  const now = Date.now();
  const lines = Array.from({ length: 6 }, (_, i) =>
    JSON.stringify({
      idempotencyKey: `continuous-owner:act-${i}`,
      source: 'wake',
      status: 'delivered',
      deliveryId: `d-${i}`,
      createdBy: authority,
      requestedAuthority: authority,
      recordedAt: new Date(now - (10 - i) * 60_000).toISOString(),
    })
  );
  safeWriteFile(store, `${lines.join('\n')}\n`);
  return store;
}

function approve(requestId: string, payloadHash: string, decidedByType: 'human') {
  return withExecutionContext(
    'mission_controller',
    () =>
      decideApprovalRequest('mission_controller', {
        channel: TRIGGER_STORE_ROTATE_APPROVAL_CHANNEL,
        storageChannel: TRIGGER_STORE_ROTATE_APPROVAL_CHANNEL,
        requestId,
        decision: 'approved',
        decidedBy: 'sovereign-operator',
        authMethod: 'surface_session',
        decidedByType,
        authenticated: true,
        payloadHash,
        effectBinding: TRIGGER_STORE_ROTATE_EFFECT_BINDING,
      }),
    'worker'
  );
}

describe('scheduler trigger-store rotate', () => {
  it('dry-run is the default and changes nothing', async () => {
    const store = seedStore();
    const before = String(safeReadFile(store, { encoding: 'utf8' }));
    const { result } = await main(['--store', store, '--keep-stable', '2']);
    expect(result).toMatchObject({ mode: 'dry-run', plan: { keep_stable: 2, dropped_keys: 4 } });
    expect(String(safeReadFile(store, { encoding: 'utf8' }))).toBe(before);
    expect(segments(store)).toEqual([]);
  });

  it('refuses --apply without an approved, human, store-bound approval', async () => {
    const store = seedStore();
    await expect(runTriggerStoreRotate({ storePath: store, apply: true })).rejects.toThrow(
      /--approval-request-id/
    );
    const request = openTriggerStoreRotateApproval({ storePath: store, keepStable: 2 });
    opened.push(request.requestId);
    expect(request.created).toBe(true);
    // Re-requesting the same operation reuses the pending request.
    expect(openTriggerStoreRotateApproval({ storePath: store, keepStable: 2 }).requestId).toBe(
      request.requestId
    );
    await expect(
      runTriggerStoreRotate({
        storePath: store,
        keepStable: 2,
        apply: true,
        approvalRequestId: request.requestId,
      })
    ).rejects.toThrow(/approved request/);
    approve(request.requestId, request.payloadHash, 'human');
    // Bound to keep-stable 2: another N is a different operation.
    await expect(
      runTriggerStoreRotate({
        storePath: store,
        keepStable: 3,
        apply: true,
        approvalRequestId: request.requestId,
      })
    ).rejects.toThrow(/different store or --keep-stable/);
    expect(segments(store)).toEqual([]);
  });

  it('applies once with an approval: archives, rewrites and the approval cannot be reused', async () => {
    const store = seedStore();
    const request = openTriggerStoreRotateApproval({ storePath: store, keepStable: 2 });
    opened.push(request.requestId);
    approve(request.requestId, request.payloadHash, 'human');

    const receipt = await runTriggerStoreRotate({
      storePath: store,
      keepStable: 2,
      apply: true,
      approvalRequestId: request.requestId,
    });
    expect(receipt).toMatchObject({
      mode: 'apply',
      approval_request_id: request.requestId,
      approved_by: 'sovereign-operator',
      result: { kept: { in_flight: 0, stable: 2, recent_cron: 0 }, dropped_keys: 4 },
    });
    const live = String(safeReadFile(store, { encoding: 'utf8' }));
    expect(live).toContain('continuous-owner:act-5');
    expect(live).not.toContain('continuous-owner:act-0');
    expect(segments(store)).toHaveLength(1);
    const record = withExecutionContext('mission_controller', () =>
      listApprovalRequests({ storageChannels: [TRIGGER_STORE_ROTATE_APPROVAL_CHANNEL] }).find(
        (entry) => entry.id === request.requestId
      )
    );
    expect(record?.consumption?.consumer).toBe('trigger_store_rotate');

    await expect(
      runTriggerStoreRotate({
        storePath: store,
        keepStable: 2,
        apply: true,
        approvalRequestId: request.requestId,
      })
    ).rejects.toThrow(/already used|used once/);
    expect(segments(store)).toHaveLength(1);
  });
});
