import { afterAll, describe, expect, it } from 'vitest';
import { withExecutionContext } from '@agent/core/authority';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeRmSync } from '@agent/core/secure-io';
import {
  createDiscussionRoom,
  readDiscussionRoom,
  submitDiscussionCommand,
} from './discussion-store.js';
import { composeDiscussionTeam } from './discussion-team.js';
import { ensureDiscussionRunning } from './discussion-engine.js';
import { extractJson, ScriptedDiscussionSpeaker } from './discussion-speaker.js';

const created: string[] = [];
const noSleep = async () => undefined;
const ROLE = 'chronos_localadmin';

function newRoom(goal: string, id: string, extra: Record<string, unknown> = {}) {
  created.push(id);
  return withExecutionContext(ROLE, () =>
    createDiscussionRoom({
      id,
      goal,
      config: { turn_delay_ms: 0, speaker: 'scripted', locale: 'en', ...extra },
    })
  );
}

afterAll(() => {
  withExecutionContext('mission_controller', () => {
    const previous = process.env.KYBERION_SUDO;
    process.env.KYBERION_SUDO = 'true';
    try {
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

describe('discussion team composition', () => {
  it("always seats a facilitator, researcher, devil's advocate and scribe", () => {
    const plan = composeDiscussionTeam('Decide whether to adopt a new billing system');
    const roles = plan.participants.map((p) => p.role);
    for (const role of ['facilitator', 'researcher', 'devils_advocate', 'scribe']) {
      expect(roles).toContain(role);
    }
    expect(new Set(roles).size).toBe(roles.length);
  });

  it('adds goal-driven seats', () => {
    const plan = composeDiscussionTeam('リスクを踏まえた計画を決める');
    const roles = plan.participants.map((p) => p.role);
    expect(roles).toContain('planner');
    expect(roles).toContain('reviewer');
  });
});

describe('discussion engine', () => {
  it('runs a facilitated discussion to a decision', async () => {
    newRoom('Adopt staged rollout for the new platform', 'test-disc-run');
    await withExecutionContext(ROLE, () =>
      ensureDiscussionRunning('test-disc-run', {
        speaker: new ScriptedDiscussionSpeaker(),
        sleep: noSleep,
      })
    );
    const room = readDiscussionRoom('test-disc-run')!;
    expect(room.status).toBe('concluded');
    expect(room.decision?.next_steps.length).toBeGreaterThan(0);
    expect(room.messages.filter((m) => m.kind === 'agent').length).toBeGreaterThan(6);
    expect(room.consensus_history.length).toBeGreaterThan(0);
    expect(room.consensus).toBeGreaterThan(0.5);
    expect(room.messages[0].speaker).toBe('facilitator');
  });

  it('applies a human stop command', async () => {
    newRoom('Stop me early', 'test-disc-stop');
    withExecutionContext(ROLE, () => {
      // Command lands before the engine starts; it must be acknowledged first.
      submitDiscussionCommand('test-disc-stop', 'human', { kind: 'stop' });
    });
    await withExecutionContext(ROLE, () =>
      ensureDiscussionRunning('test-disc-stop', {
        speaker: new ScriptedDiscussionSpeaker(),
        sleep: noSleep,
      })
    );
    const room = readDiscussionRoom('test-disc-stop')!;
    expect(room.status).toBe('stopped');
    expect(room.pending_commands).toHaveLength(0);
  });

  it('routes an injected human message to a reply and supports votes', async () => {
    newRoom('Vote and steer', 'test-disc-steer');
    withExecutionContext(ROLE, () => {
      submitDiscussionCommand('test-disc-steer', 'human', {
        kind: 'inject',
        text: 'Please consider the cost angle',
        target: 'researcher',
      });
      submitDiscussionCommand('test-disc-steer', 'human', {
        kind: 'open_vote',
        text: 'Proceed?',
        options: ['yes', 'no'],
      });
      submitDiscussionCommand('test-disc-steer', 'human', { kind: 'cast_vote', choice: 'yes' });
    });
    await withExecutionContext(ROLE, () =>
      ensureDiscussionRunning('test-disc-steer', {
        speaker: new ScriptedDiscussionSpeaker(),
        sleep: noSleep,
      })
    );
    const room = readDiscussionRoom('test-disc-steer')!;
    expect(room.messages.some((m) => m.kind === 'human')).toBe(true);
    const vote = room.votes[0];
    expect(vote.status).toBe('closed');
    expect(vote.ballots.human?.choice).toBe('yes');
    expect(room.status).toBe('concluded');
  });
});

describe('extractJson', () => {
  it('finds the object inside surrounding prose', () => {
    expect(extractJson('Sure! {"text":"hi","stance":"support"} done')).toEqual({
      text: 'hi',
      stance: 'support',
    });
  });

  it('returns null for missing or malformed objects', () => {
    expect(extractJson('no json here')).toBeNull();
    expect(extractJson('{not json}')).toBeNull();
  });

  it('stays fast on adversarial brace-heavy output', () => {
    const started = Date.now();
    expect(extractJson('{'.repeat(200_000))).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
