import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { safeRmSync } from '@agent/core/secure-io';
import { withExecutionContext } from '@agent/core/authority';

/**
 * D8: a completed browser-extension run is captured as a personal learning of
 * the local owner on the MemoryCandidate queue — never a DistillCandidateRecord,
 * and never captured without an owner to scope it to.
 */
const owner = vi.hoisted(() => ({ principalId: 'user:receipt-owner' as string | null }));
const enqueued = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock('@agent/core/governance/cli-operator-principal', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveCliOperatorIdentity: () => ({ principalId: owner.principalId, displayName: 'Owner' }),
}));
vi.mock('@agent/core/knowledge/memory-promotion-queue', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  enqueueMemoryPromotionCandidate: (row: Record<string, unknown>) => {
    enqueued.push(row);
    return row.candidate_id;
  },
}));
vi.mock('@agent/core/governance/audit-chain', () => ({ auditChain: { record: vi.fn() } }));

let handle: typeof import('./browser_bridge_host.js').handle;
const written: string[] = [];

beforeAll(async () => {
  ({ handle } = await import('./browser_bridge_host.js'));
}, 60_000);
afterEach(() => {
  enqueued.splice(0);
  withExecutionContext('surface_runtime', () => {
    for (const file of written.splice(0)) safeRmSync(file, { force: true });
  });
});

function receipt(id: string, status: 'completed' | 'failed' = 'completed') {
  return {
    kind: 'browser-extension-receipt.v1',
    receipt_id: `RCPT-D8-${id}-${process.pid}`,
    mission_id: 'MSN-PROC-d8-test',
    pipeline_id: 'browser-procedure',
    recording_id: 'REC-D8-TEST',
    tab_id: 'tab-1',
    origin: 'https://example.test',
    status,
    summary: 'Filled the example form',
    created_at: '2026-11-10T00:00:00.000Z',
  };
}

async function submit(id: string, status?: 'completed' | 'failed') {
  const reply = (await handle({ type: 'submit_receipt', receipt: receipt(id, status) })) as {
    ok: boolean;
    evidence_path?: string;
    error?: string;
  };
  if (reply.evidence_path) written.push(reply.evidence_path);
  return reply;
}

describe('browser receipt learning capture (D8)', () => {
  it('captures a completed run as a personal learning of the local owner', async () => {
    owner.principalId = 'user:receipt-owner';
    const reply = await submit('owner');
    expect(reply.ok).toBe(true);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      kind: 'lesson',
      source_ref: `browser_receipt:RCPT-D8-owner-${process.pid}`,
      sensitivity_tier: 'personal',
      scope: { tier: 'personal', owner_nhi: 'user:receipt-owner' },
    });
    expect(enqueued[0]!.origin).toBeUndefined();
  });

  it('does not capture without an owner, or for a run that did not complete', async () => {
    owner.principalId = null;
    expect((await submit('no-owner')).ok).toBe(true);
    owner.principalId = 'user:receipt-owner';
    expect((await submit('failed', 'failed')).ok).toBe(true);
    expect(enqueued).toEqual([]);
  });
});
