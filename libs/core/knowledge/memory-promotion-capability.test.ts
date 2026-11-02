import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { safeExistsSync, safeReadFile, safeRmSync, safeWriteFile } from '../secure-io.js';
import {
  createMemoryPromotionCandidate,
  enqueueMemoryPromotionCandidate,
  listMemoryPromotionCandidates,
  memoryPromotionQueuePath,
  memoryWritePartition,
  updateMemoryPromotionCandidateStatus,
  type MemoryWriteCapability,
} from './memory-promotion-queue.js';
import { issueMemoryCapabilityToken } from './memory-capability-token.js';

// W3: opt-in capability enforcement on the durable queue write chokepoints.
// Hermetic: an isolated queue path and an injected HMAC secret (no audit-chain
// key, no env key) so verification is pinned to this test.

const TEST_SECRET = 'w3-test-hmac-secret';
const DENIED = '[MEMORY_CAPABILITY_DENIED]';

// Keep the aggregate read from discovering the repository's real tenant
// shards during this suite — unique per file to avoid collisions.
process.env.KYBERION_MEMORY_QUEUE_PATH = 'active/shared/tmp/test-memory-queue-capability.jsonl';

describe('memory promotion queue — write capability gate (W3)', () => {
  const queuePath = memoryPromotionQueuePath();
  let originalQueueRaw: string | null = null;
  const savedRequired = process.env.KYBERION_MEMORY_CAPABILITY_REQUIRED;

  beforeAll(() => {
    if (safeExistsSync(queuePath)) {
      originalQueueRaw = safeReadFile(queuePath, { encoding: 'utf8' }) as string;
    }
  });

  beforeEach(() => {
    if (safeExistsSync(queuePath)) safeRmSync(queuePath);
    delete process.env.KYBERION_MEMORY_CAPABILITY_REQUIRED;
  });

  afterEach(() => {
    if (savedRequired === undefined) delete process.env.KYBERION_MEMORY_CAPABILITY_REQUIRED;
    else process.env.KYBERION_MEMORY_CAPABILITY_REQUIRED = savedRequired;
  });

  afterAll(() => {
    if (originalQueueRaw !== null) {
      safeWriteFile(queuePath, originalQueueRaw);
      return;
    }
    if (safeExistsSync(queuePath)) safeRmSync(queuePath);
  });

  const candidate = (
    sourceRef: string,
    sensitivityTier: 'confidential' | 'public' = 'confidential'
  ) =>
    createMemoryPromotionCandidate({
      sourceType: 'mission',
      sourceRef,
      proposedMemoryKind: 'sop',
      summary: 'Promote repeatable mission closing flow.',
      evidenceRefs: [`evidence:${sourceRef}`],
      sensitivityTier,
    });

  const capability = (overrides?: {
    partition?: string;
    ops?: ('read' | 'write' | 'promote')[];
    /** Secret the verifier is told to use (defaults to the signing secret). */
    verifySecret?: string;
  }): MemoryWriteCapability => {
    const verifySecret = overrides?.verifySecret ?? TEST_SECRET;
    return {
      token: issueMemoryCapabilityToken(
        {
          partition: overrides?.partition ?? 'tier:confidential',
          ops: overrides?.ops ?? ['write'],
          subject: 'w3-test-writer',
          issuer: 'w3-test-issuer',
          expiresAt: new Date(Date.now() + 60_000),
        },
        { secret: TEST_SECRET }
      ),
      secret: verifySecret,
    };
  };

  it('derives the write partition from the candidate scope/tier', () => {
    expect(memoryWritePartition({ sensitivity_tier: 'public' })).toBe('tier:public');
    expect(
      memoryWritePartition({
        sensitivity_tier: 'confidential',
        scope: { tier: 'confidential', tenant_slug: 'acme' } as never,
      })
    ).toBe('confidential/acme');
    // Personal queues are physically partitioned by owner — the capability
    // partition must bind the owner, not the whole personal tier.
    expect(
      memoryWritePartition({
        sensitivity_tier: 'personal',
        scope: { tier: 'personal', owner_nhi: 'alice' } as never,
      })
    ).toBe('personal/alice');
    expect(memoryWritePartition({ sensitivity_tier: 'personal' })).toBe('tier:personal');
  });

  describe('flag unset (default: current behavior preserved)', () => {
    it('enqueues without a token', () => {
      const c = candidate('mission:MSN-W3-DEFAULT');
      expect(() => enqueueMemoryPromotionCandidate(c)).not.toThrow();
    });

    it('updates status without a token', () => {
      const c = candidate('mission:MSN-W3-DEFAULT-UPD');
      enqueueMemoryPromotionCandidate(c);
      expect(() =>
        updateMemoryPromotionCandidateStatus({ candidateId: c.candidate_id, status: 'rejected' })
      ).not.toThrow();
    });
  });

  describe('flag set — fail closed', () => {
    beforeEach(() => {
      process.env.KYBERION_MEMORY_CAPABILITY_REQUIRED = '1';
    });

    it('refuses enqueue when the token is absent', () => {
      expect(() => enqueueMemoryPromotionCandidate(candidate('mission:MSN-W3-NOTOKEN'))).toThrow(
        DENIED
      );
      // Nothing committed.
      expect(safeExistsSync(queuePath)).toBe(false);
    });

    it('refuses enqueue when the verifier secret does not match the signature', () => {
      expect(() =>
        enqueueMemoryPromotionCandidate(candidate('mission:MSN-W3-BADSIG'), {
          capability: capability({ verifySecret: 'a-different-secret' }),
        })
      ).toThrow(DENIED);
    });

    it('refuses enqueue when the token is bound to another partition', () => {
      expect(() =>
        enqueueMemoryPromotionCandidate(candidate('mission:MSN-W3-BADPART'), {
          capability: capability({ partition: 'tier:public' }),
        })
      ).toThrow(DENIED);
    });

    it('refuses enqueue when the token does not grant write', () => {
      expect(() =>
        enqueueMemoryPromotionCandidate(candidate('mission:MSN-W3-READONLY'), {
          capability: capability({ ops: ['read'] }),
        })
      ).toThrow(DENIED);
    });

    it('refuses the status write when the token is absent', () => {
      const cap = capability();
      const c = candidate('mission:MSN-W3-UPD-NOTOKEN');
      enqueueMemoryPromotionCandidate(c, { capability: cap });
      expect(() =>
        updateMemoryPromotionCandidateStatus({ candidateId: c.candidate_id, status: 'rejected' })
      ).toThrow(DENIED);
    });
  });

  describe('flag set — valid token commits', () => {
    beforeEach(() => {
      process.env.KYBERION_MEMORY_CAPABILITY_REQUIRED = '1';
    });

    it('enqueues with a valid write-capability token', () => {
      const c = candidate('mission:MSN-W3-VALID');
      expect(() => enqueueMemoryPromotionCandidate(c, { capability: capability() })).not.toThrow();
      expect(safeExistsSync(queuePath)).toBe(true);
    });

    it('updates status with a valid write-capability token', () => {
      const cap = capability();
      const c = candidate('mission:MSN-W3-UPD-VALID');
      enqueueMemoryPromotionCandidate(c, { capability: cap });
      const updated = updateMemoryPromotionCandidateStatus({
        candidateId: c.candidate_id,
        status: 'rejected',
        capability: cap,
      });
      expect(updated?.status).toBe('rejected');
    });

    it('denies a scopeUpdate that only covers the destination partition', () => {
      // The gate authorizes BOTH the current and the resulting partition of
      // every committed row — a token for tenant-b must not move a row out
      // of the tier:confidential partition it cannot grant.
      const cap = capability({ partition: 'confidential/tenant-b' });
      const c = candidate('mission:MSN-W3-SCOPEMOVE');
      enqueueMemoryPromotionCandidate(c, {
        capability: capability({ partition: 'tier:confidential' }),
      });
      expect(() =>
        updateMemoryPromotionCandidateStatus({
          candidateId: c.candidate_id,
          status: 'queued',
          scopeUpdate: { tier: 'confidential', tenant_slug: 'tenant-b' } as never,
          capability: cap,
        })
      ).toThrow(DENIED);
      // Nothing committed: the row still sits in its original partition.
      const row = listMemoryPromotionCandidates()[0]!;
      expect(row.scope).toBeUndefined();
    });
  });
});
