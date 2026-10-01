// Team Channel P2: a mission issued from a team channel runs in the channel's
// tenant, never above the channel's disclosure tier, and records who confirmed it.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  safeExec: vi.fn(() => 'started'),
  enqueue: vi.fn((input: Record<string, unknown>) => ({ ...input, event_id: 'ME-1' })),
  startWorker: vi.fn(() => 'job-path'),
  observe: vi.fn(),
}));

vi.mock('../secure-io.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../secure-io.js')>()),
  safeExec: mocks.safeExec,
}));
vi.mock('../mission/mission-orchestration-events.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../mission/mission-orchestration-events.js')>()),
  enqueueMissionOrchestrationEvent: mocks.enqueue,
  startMissionOrchestrationWorker: mocks.startWorker,
  emitMissionOrchestrationObservation: mocks.observe,
}));
vi.mock('../workforce/artifact-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../workforce/artifact-store.js')>()),
  appendGovernedArtifactJsonl: vi.fn(() => 'observability-path'),
}));

import { issueMissionFromProposal } from './surface-mission-proposals.js';

const proposal = {
  title: 'Fix release notes',
  summary: 'Fix the release notes',
  tier: 'personal' as const,
  mission_type: 'development',
};

describe('mission issuance scope', () => {
  beforeEach(() => vi.clearAllMocks());

  it('caps the tier, passes the tenant and records the confirmer', async () => {
    const result = await issueMissionFromProposal({
      surface: 'slack',
      channel: 'C-team',
      thread: '1.0',
      proposal: proposal as never,
      confirmedBy: 'user:lead',
      scope: { tenant_slug: 'acme', tier: 'confidential' },
    });
    expect(result.tier).toBe('confidential');
    const args = (mocks.safeExec.mock.calls[0] as unknown[])[1] as string[];
    expect(args).toContain('confidential');
    expect(args).not.toContain('personal');
    expect(args.slice(-2)).toEqual(['--tenant-slug', 'acme']);
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { tenant_slug: 'acme', tier: 'confidential' },
        payload: expect.objectContaining({
          confirmedBy: 'user:lead',
          scope: { tenant_slug: 'acme', tier: 'confidential' },
          tier: 'confidential',
        }),
      })
    );
  });

  it('keeps owner-direct issuance unchanged', async () => {
    const result = await issueMissionFromProposal({
      surface: 'slack',
      channel: 'C-dm',
      thread: '1.0',
      proposal: proposal as never,
    });
    expect(result.tier).toBe('personal');
    const args = (mocks.safeExec.mock.calls[0] as unknown[])[1] as string[];
    expect(args).not.toContain('--tenant-slug');
    const input = (mocks.enqueue.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(input.scope).toBeUndefined();
  });
});
