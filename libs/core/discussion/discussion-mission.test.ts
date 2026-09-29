import { afterAll, describe, expect, it, vi } from 'vitest';
import { withExecutionContext, withExecutionContextAsync } from '@agent/core/authority';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeReadFile, safeReaddir, safeRmSync } from '@agent/core/secure-io';
import { decideApprovalRequest } from '../governance/approval-store.js';
import { loadArtifactRecord } from '../workforce/artifact-record.js';
import {
  clearWorkCoordinationNamespace,
  listWorkItems,
  setWorkCoordinationNamespace,
} from '../workforce/work-coordination.js';

// mission_controller is a separate ceremony (and needs an onboarded environment);
// here only the discussion's side of the hand-off is under test.
vi.mock('../surface/surface-mission-proposals.js', () => ({
  issueChronosMissionFromProposal: vi.fn(async () => ({
    missionId: 'MSN-DISCUSSION-TEST',
    tier: 'confidential',
    missionType: 'development',
    persona: 'Ecosystem Architect',
    startOutput: '',
    orchestrationStatus: 'queued' as const,
  })),
}));

const { ensureDiscussionRunning } = await import('./discussion-engine.js');
const { issueMissionForDiscussion, withLiveMissionStatus } =
  await import('./discussion-mission.js');
const { reviewDiscussion } = await import('./discussion-review.js');
const { ScriptedDiscussionSpeaker } = await import('./discussion-speaker.js');
const { createDiscussionRoom, DiscussionUserError, readDiscussionRoom } =
  await import('./discussion-store.js');
const { issueChronosMissionFromProposal } = await import('../surface/surface-mission-proposals.js');

const ROLE = 'chronos_localadmin';
const ID = 'test-mission-handoff';

afterAll(() => {
  withExecutionContext('mission_controller', () => {
    const previous = process.env.KYBERION_SUDO;
    process.env.KYBERION_SUDO = 'true';
    try {
      const artifactDir = pathResolver.shared('runtime/artifacts');
      if (safeExistsSync(artifactDir)) {
        for (const name of safeReaddir(artifactDir)) {
          const file = `${artifactDir}/${name}`;
          if (
            String(safeReadFile(file, { encoding: 'utf8' })).includes(`"discussion_id": "${ID}"`)
          ) {
            safeRmSync(file, { force: true });
          }
        }
      }
      const dir = pathResolver.shared(`runtime/discussions/${ID}`);
      if (safeExistsSync(dir)) safeRmSync(dir, { recursive: true, force: true });
    } finally {
      if (previous === undefined) delete process.env.KYBERION_SUDO;
      else process.env.KYBERION_SUDO = previous;
    }
  });
});

describe('approved decision → mission', () => {
  it('starts the mission only after a human approves, and threads the id through the outputs', async () => {
    withExecutionContext(ROLE, () =>
      createDiscussionRoom({
        id: ID,
        goal: 'Adopt staged rollout',
        scope: { tenant_slug: 'demo', project_id: 'proj-m' },
        config: { turn_delay_ms: 0, speaker: 'scripted', locale: 'en' },
      })
    );
    await withExecutionContext(ROLE, () =>
      ensureDiscussionRunning(ID, {
        speaker: new ScriptedDiscussionSpeaker(),
        sleep: async () => undefined,
      })
    );
    setWorkCoordinationNamespace(`discussion-mission-${Date.now()}`);
    try {
      const result = withExecutionContext(ROLE, () =>
        reviewDiscussion(ID, 'reviewer', { verdict: 'accept', request_mission: true })
      );
      expect(result.mission_error).toBeUndefined();
      const approvalId = result.mission_approval_id!;
      expect(approvalId).toBeTruthy();

      // Still pending → refused with a message a person can act on.
      const pending = withExecutionContextAsync(ROLE, () =>
        issueMissionForDiscussion(ID, 'reviewer')
      );
      await expect(pending).rejects.toBeInstanceOf(DiscussionUserError);
      await expect(pending).rejects.toThrow(/not been approved/u);
      expect(issueChronosMissionFromProposal).not.toHaveBeenCalled();

      withExecutionContext('mission_controller', () =>
        decideApprovalRequest('mission_controller', {
          channel: 'chronos',
          requestId: approvalId,
          decision: 'approved',
          decidedBy: 'user:owner',
          decidedByRole: 'owner',
          authMethod: 'surface_session',
          decidedByType: 'human',
          authenticated: true,
        })
      );
      expect(withLiveMissionStatus(readDiscussionRoom(ID)!).outcomes.mission?.approval_status).toBe(
        'approved'
      );

      const issued = await withExecutionContextAsync(ROLE, () =>
        issueMissionForDiscussion(ID, 'reviewer')
      );
      expect(issued.mission_id).toBe('MSN-DISCUSSION-TEST');
      expect(issueChronosMissionFromProposal).toHaveBeenCalledTimes(1);

      const room = readDiscussionRoom(ID)!;
      expect(room.outcomes.mission?.mission_id).toBe('MSN-DISCUSSION-TEST');
      const items = withExecutionContext(ROLE, () => listWorkItems({}));
      for (const itemId of Object.values(room.outcomes.work_items)) {
        expect(items.find((i) => i.item_id === itemId)?.context?.mission_id).toBe(
          'MSN-DISCUSSION-TEST'
        );
      }
      expect(loadArtifactRecord(room.outcomes.brief!.artifact_id)?.mission_id).toBe(
        'MSN-DISCUSSION-TEST'
      );

      // A second start is refused.
      await expect(
        withExecutionContextAsync(ROLE, () => issueMissionForDiscussion(ID, 'reviewer'))
      ).rejects.toThrow(/already started/u);
    } finally {
      clearWorkCoordinationNamespace();
    }
  });
});
