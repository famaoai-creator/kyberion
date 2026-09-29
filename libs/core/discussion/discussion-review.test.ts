import { afterAll, describe, expect, it } from 'vitest';
import { withExecutionContext } from '@agent/core/authority';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeReadFile, safeReaddir, safeRmSync } from '@agent/core/secure-io';
import {
  clearWorkCoordinationNamespace,
  listWorkItems,
  setWorkCoordinationNamespace,
} from '../workforce/work-coordination.js';
import { renderDiscussionBriefHtml } from './discussion-brief.js';
import { ensureDiscussionRunning } from './discussion-engine.js';
import { issueMissionForDiscussion, withLiveMissionStatus } from './discussion-mission.js';
import { reviewDiscussion } from './discussion-review.js';
import { ScriptedDiscussionSpeaker } from './discussion-speaker.js';
import {
  createDiscussionRoom,
  readDiscussionRoom,
  submitDiscussionCommand,
} from './discussion-store.js';

const ROLE = 'chronos_localadmin';
const created: string[] = [];
const noSleep = async () => undefined;

async function concludedRoom(id: string, goal = 'Adopt staged rollout') {
  created.push(id);
  withExecutionContext(ROLE, () =>
    createDiscussionRoom({
      id,
      goal,
      scope: { tenant_slug: 'demo', project_id: 'proj-r' },
      config: { turn_delay_ms: 0, speaker: 'scripted', locale: 'en' },
    })
  );
  await withExecutionContext(ROLE, () =>
    ensureDiscussionRunning(id, { speaker: new ScriptedDiscussionSpeaker(), sleep: noSleep })
  );
  return readDiscussionRoom(id)!;
}

afterAll(() => {
  withExecutionContext('mission_controller', () => {
    const previous = process.env.KYBERION_SUDO;
    process.env.KYBERION_SUDO = 'true';
    try {
      const artifactDir = pathResolver.shared('runtime/artifacts');
      if (safeExistsSync(artifactDir)) {
        for (const name of safeReaddir(artifactDir)) {
          const file = `${artifactDir}/${name}`;
          const body = String(safeReadFile(file, { encoding: 'utf8' }));
          if (created.some((id) => body.includes(`"discussion_id": "${id}"`))) {
            safeRmSync(file, { force: true });
          }
        }
      }
      for (const id of created) {
        const dir = pathResolver.shared(`runtime/discussions/${id}`);
        if (safeExistsSync(dir)) safeRmSync(dir, { recursive: true, force: true });
      }
    } finally {
      if (previous === undefined) delete process.env.KYBERION_SUDO;
      else process.env.KYBERION_SUDO = previous;
    }
  });
});

describe('decision brief', () => {
  it('renders a self-contained document, escapes content and only offers review in review mode', async () => {
    const id = 'test-brief-render';
    const room = await concludedRoom(id);
    withExecutionContext(ROLE, () => undefined);
    const view = renderDiscussionBriefHtml(room, { mode: 'view' });
    expect(view).toContain('the team agreed to proceed');
    expect(view).toContain('data-jump=');
    expect(view).not.toContain('data-verdict=');
    expect(view).not.toMatch(/<script[^>]+src=/u);
    const review = renderDiscussionBriefHtml(room, { mode: 'review' });
    expect(review).toContain('data-verdict="accept"');
    expect(review).toContain('f-title');

    const hostile = {
      ...room,
      title: '<img src=x onerror=alert(1)>',
      messages: [
        { ...room.messages[0], text: '</script><script>alert(1)</script>' },
        ...room.messages.slice(1),
      ],
    };
    const html = renderDiscussionBriefHtml(hostile, { mode: 'review' });
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('&lt;/script&gt;');
  });
});

describe('decision review', () => {
  it('accept applies edits, creates the kept WorkItems and raises a mission-start approval', async () => {
    const id = 'test-review-accept';
    const room = await concludedRoom(id);
    const [first, second] = room.outcomes.proposals;
    setWorkCoordinationNamespace(`discussion-review-${Date.now()}`);
    try {
      const result = withExecutionContext(ROLE, () =>
        reviewDiscussion(id, 'reviewer', {
          verdict: 'accept',
          request_mission: true,
          edits: [
            { id: first.id, title: 'Edited title', priority: 'urgent-nope', owner_role: 'planner' },
            { id: second.id, included: false },
            { id: 'wp-ghost', title: 'ignored' },
          ],
        })
      );
      expect(result.created_work_items.map((c) => c.proposal_id)).toEqual(
        room.outcomes.proposals.filter((p) => p.id !== second.id).map((p) => p.id)
      );
      const after = readDiscussionRoom(id)!;
      expect(after.outcomes.review?.verdict).toBe('accept');
      expect(after.outcomes.proposals[0]).toMatchObject({
        title: 'Edited title',
        owner_role: 'planner',
      });
      // An invalid priority is dropped, not trusted.
      expect(after.outcomes.proposals[0].priority).toBe(first.priority);
      const items = withExecutionContext(ROLE, () => listWorkItems({}));
      const item = items.find((i) => i.item_id === result.created_work_items[0].item_id)!;
      expect(item.title).toBe('Edited title');
      expect(item.labels).toContain('owner-role:planner');
      expect(result.mission_approval_id).toBeTruthy();
      expect(withLiveMissionStatus(after).outcomes.mission?.approval_status).toBe('pending');
      // A second review is refused, and the mission cannot start before it is approved.
      expect(() =>
        withExecutionContext(ROLE, () => reviewDiscussion(id, 'r', { verdict: 'reject' }))
      ).toThrow(/already been reviewed/u);
      await expect(
        withExecutionContext(ROLE, () => issueMissionForDiscussion(id, 'r'))
      ).rejects.toThrow(/not been approved/u);
    } finally {
      clearWorkCoordinationNamespace();
    }
  });

  it('reject records the verdict and creates no work', async () => {
    const id = 'test-review-reject';
    await concludedRoom(id);
    setWorkCoordinationNamespace(`discussion-review-${Date.now()}-r`);
    try {
      const result = withExecutionContext(ROLE, () =>
        reviewDiscussion(id, 'reviewer', { verdict: 'reject', note: 'not now' })
      );
      expect(result.created_work_items).toHaveLength(0);
      expect(readDiscussionRoom(id)!.outcomes.review).toMatchObject({
        verdict: 'reject',
        note: 'not now',
      });
    } finally {
      clearWorkCoordinationNamespace();
    }
  });

  it('request-changes needs a comment, reopens the room, and a new decision can then be accepted', async () => {
    const id = 'test-review-changes';
    await concludedRoom(id);
    expect(() =>
      withExecutionContext(ROLE, () =>
        reviewDiscussion(id, 'reviewer', { verdict: 'request-changes' })
      )
    ).toThrow(/comment is required/u);
    const result = withExecutionContext(ROLE, () =>
      reviewDiscussion(id, 'reviewer', { verdict: 'request-changes', note: 'What about cost?' })
    );
    expect(result.reopened).toBe(true);
    const reopened = readDiscussionRoom(id)!;
    expect(reopened.status).toBe('running');
    expect(reopened.decision).toBeNull();
    expect(reopened.outcomes.review).toBeNull();
    expect(reopened.messages.some((m) => m.kind === 'human' && m.text === 'What about cost?')).toBe(
      true
    );

    await withExecutionContext(ROLE, () =>
      ensureDiscussionRunning(id, { speaker: new ScriptedDiscussionSpeaker(), sleep: noSleep })
    );
    const again = readDiscussionRoom(id)!;
    expect(again.status).toBe('concluded');
    expect(again.decision).not.toBeNull();
    expect(again.outcomes.proposals.length).toBeGreaterThan(0);
    expect(again.outcomes.review).toBeNull();
    void submitDiscussionCommand;
  });
});
