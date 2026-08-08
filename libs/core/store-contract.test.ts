import { afterEach, describe, expect, it } from 'vitest';
import { exerciseJsonRecordStoreContract } from './store-contract.js';
import {
  approvalRequestLogicalPath,
  createApprovalRequest,
  listApprovalRequests,
  loadApprovalRequest,
} from './approval-store.js';
import {
  clearSurfaceOutboxMessage,
  enqueueSurfaceOutboxMessage,
  listSurfaceOutboxMessages,
} from './surface-coordination-store.js';
import { pathResolver } from './path-resolver.js';
import { safeUnlinkSync } from './secure-io.js';
import { withExecutionContext } from './authority.js';

const approvalChannel = `qm10-contract-${process.pid}-${Date.now()}`;
const surface = 'imessage' as const;
const createdApprovalIds: string[] = [];
const createdSurfaceIds: string[] = [];

afterEach(() => {
  for (const id of createdApprovalIds.splice(0)) {
    withExecutionContext('mission_controller', () =>
      safeUnlinkSync(pathResolver.resolve(approvalRequestLogicalPath(approvalChannel, id)))
    );
  }
  withExecutionContext('surface_runtime', () => {
    for (const id of createdSurfaceIds.splice(0)) clearSurfaceOutboxMessage(surface, id);
  });
});

describe('QM-10 JSON store contract template', () => {
  it('covers the approval store adapter', () => {
    const result = exerciseJsonRecordStoreContract({
      create: (label) => {
        const record = createApprovalRequest('mission_controller', {
          channel: approvalChannel,
          storageChannel: approvalChannel,
          threadTs: label,
          correlationId: label,
          requestedBy: 'qm10-contract-test',
          draft: { title: label, summary: label, details: label, severity: 'low' },
        });
        createdApprovalIds.push(record.id);
        return record;
      },
      list: () => listApprovalRequests({ storageChannels: [approvalChannel] }),
      id: (record) => record.id,
      load: (id) => loadApprovalRequest(approvalChannel, id),
    });
    expect(result.firstId).not.toBe(result.secondId);
    expect(result.listedIds).toEqual(expect.arrayContaining([result.firstId, result.secondId]));
    expect(result.loadedFirst).toBe(true);
    expect(result.loadedSecond).toBe(true);
  });

  it('covers the surface outbox adapter', () => {
    const result = exerciseJsonRecordStoreContract({
      create: (label) => {
        const path = enqueueSurfaceOutboxMessage({
          surface,
          correlationId: label,
          channel: `qm10-${label}`,
          threadTs: label,
          text: label,
        });
        const id =
          path
            .split('/')
            .pop()
            ?.replace(/\.json$/u, '') || '';
        createdSurfaceIds.push(id);
        return listSurfaceOutboxMessages(surface).find((record) => record.message_id === id)!;
      },
      list: () =>
        listSurfaceOutboxMessages(surface).filter((record) =>
          record.correlation_id.startsWith('contract-')
        ),
      id: (record) => record.message_id,
      load: (id) =>
        listSurfaceOutboxMessages(surface).find((record) => record.message_id === id) || null,
    });
    expect(result.firstId).not.toBe(result.secondId);
    expect(result.listedIds).toEqual(expect.arrayContaining([result.firstId, result.secondId]));
    expect(result.loadedFirst).toBe(true);
    expect(result.loadedSecond).toBe(true);
  });
});
