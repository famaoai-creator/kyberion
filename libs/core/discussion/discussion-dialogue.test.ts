import { afterAll, describe, expect, it } from 'vitest';
import { withExecutionContext } from '@agent/core/authority';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeReadFile, safeReaddir, safeRmSync } from '@agent/core/secure-io';
import { addDiscussionAttachment } from './discussion-attachments.js';
import {
  archiveDiscussionRoom,
  recordMessageFeedback,
  renameDiscussionRoom,
} from './discussion-dialogue-actions.js';
import { ensureDiscussionRunning } from './discussion-engine.js';
import { requestGenerationStop } from './discussion-live.js';
import { computeDialogueReadiness } from './discussion-reducer.js';
import {
  parseDialogueReply,
  ScriptedDiscussionSpeaker,
  splitDialogueStream,
  type DialogueHooks,
  type DialogueReply,
  type DialogueTurnRequest,
} from './discussion-speaker.js';
import {
  createDiscussionRoom,
  readDiscussionRoom,
  submitDiscussionCommand,
} from './discussion-store.js';
import { renderDiscussionBriefHtml } from './discussion-brief.js';

const ROLE = 'chronos_localadmin';
const created: string[] = [];
const noSleep = async () => undefined;

function newDialogue(id: string, goal = 'Launch the new onboarding flow') {
  created.push(id);
  withExecutionContext(ROLE, () =>
    createDiscussionRoom({
      id,
      goal,
      config: { turn_delay_ms: 0, speaker: 'scripted', locale: 'en', mode: 'dialogue' },
    })
  );
}

async function settle(id: string, speaker = new ScriptedDiscussionSpeaker()) {
  await withExecutionContext(ROLE, () =>
    ensureDiscussionRunning(id, { speaker, sleep: noSleep, exitWhenIdle: true })
  );
  return readDiscussionRoom(id)!;
}

function say(id: string, text: string, extra: Record<string, unknown> = {}) {
  withExecutionContext(ROLE, () =>
    submitDiscussionCommand(id, 'human', { kind: 'inject', text, ...extra })
  );
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
          if (created.some((id) => body.includes(`"discussion_id": "${id}"`)))
            safeRmSync(file, { force: true });
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

describe('dialogue readiness', () => {
  it('is deterministic and only ready when nothing blocking is open', () => {
    const base = {
      objective: 'x',
      success_criteria: [],
      constraints: [],
      assumptions: [],
      decisions: [],
      questions: [],
    };
    expect(computeDialogueReadiness(base).readiness).toBe(0.2);
    const full = {
      objective: 'x',
      success_criteria: ['a'],
      constraints: ['b'],
      assumptions: [],
      decisions: ['c'],
      questions: ['1', '2', '3', '4'].map((id) => ({
        id,
        text: id,
        blocking: true,
        status: 'resolved' as const,
      })),
    };
    expect(computeDialogueReadiness(full)).toEqual({ readiness: 1, ready: true });
    const oneOpen = {
      ...full,
      questions: [
        ...full.questions.slice(1),
        { id: 'o', text: 'o', blocking: true, status: 'open' as const },
      ],
    };
    expect(computeDialogueReadiness(oneOpen).ready).toBe(false);
  });
});

describe('dialogue with the facilitator', () => {
  it('opens with a question, records the goal as the human answers, and gets ready', async () => {
    const id = 'test-dlg-flow';
    newDialogue(id);
    let room = await settle(id);
    expect(room.config.mode).toBe('dialogue');
    expect(room.messages).toHaveLength(1);
    expect(room.messages[0].speaker).toBe('facilitator');
    expect(room.messages[0].suggestions?.length).toBeGreaterThan(0);
    expect(room.dialogue.objective).toBe('Launch the new onboarding flow');
    expect(room.dialogue.questions.filter((q) => q.status === 'open')).toHaveLength(4);
    expect(room.dialogue.ready).toBe(false);

    say(id, 'New users finish setup in under five minutes');
    room = await settle(id);
    expect(room.dialogue.success_criteria).toEqual([
      'New users finish setup in under five minutes',
    ]);
    expect(room.messages.at(-1)?.text).toContain('Recorded as **Success criteria**');
    expect(room.phase).toBe('exploring');

    say(id, 'Deadline is end of month');
    say(id, 'Start small with one region');
    say(id, 'I will start this week');
    room = await settle(id);
    expect(room.dialogue.constraints).toEqual(['Deadline is end of month']);
    expect(room.dialogue.decisions).toHaveLength(2);
    expect(room.dialogue.ready).toBe(true);
    expect(room.dialogue.readiness).toBe(1);
    expect(room.phase).toBe('converging');
    expect(room.messages.at(-1)?.text).toContain('Draft the brief');
  });

  it('finalizing turns the conversation into a decision, minutes and a goal-based brief', async () => {
    const id = 'test-dlg-finalize';
    newDialogue(id);
    await settle(id);
    for (const answer of ['Criteria', 'Constraint', 'Decision', 'First step']) say(id, answer);
    await settle(id);
    withExecutionContext(ROLE, () => submitDiscussionCommand(id, 'human', { kind: 'finalize' }));
    const room = await settle(id);
    expect(room.status).toBe('concluded');
    expect(room.decision?.agreements).toContain('Criteria');
    expect(room.decision?.dissent).toHaveLength(0);
    expect(room.outcomes.proposals.length).toBeGreaterThan(0);
    expect(room.outcomes.brief).not.toBeNull();
    const html = renderDiscussionBriefHtml(room, { mode: 'view' });
    expect(html).toContain('Launch the new onboarding flow');
    expect(html).toContain('Success criteria');
  });

  it('regenerate replaces the reply and rolls the earlier goal patch back', async () => {
    const id = 'test-dlg-regen';
    newDialogue(id);
    await settle(id);
    say(id, 'First idea');
    let room = await settle(id);
    const firstReply = room.messages.at(-1)!;
    expect(room.dialogue.success_criteria).toEqual(['First idea']);
    withExecutionContext(ROLE, () =>
      submitDiscussionCommand(id, 'human', { kind: 'regenerate', target: firstReply.id })
    );
    room = await settle(id);
    const visible = room.messages.filter((m) => !m.superseded);
    expect(room.messages.find((m) => m.id === firstReply.id)?.superseded).toBe(true);
    expect(visible.at(-1)?.id).not.toBe(firstReply.id);
    expect(room.dialogue.success_criteria).toEqual(['First idea']); // once, not twice
    expect(room.dialogue.questions.filter((q) => q.status === 'resolved')).toHaveLength(1);
  });

  it('editing a message re-answers it and rebuilds the goal from what is left', async () => {
    const id = 'test-dlg-edit';
    newDialogue(id);
    await settle(id);
    say(id, 'Wrong criteria');
    say(id, 'Some constraint');
    let room = await settle(id);
    const target = room.messages.find((m) => m.kind === 'human' && m.text === 'Wrong criteria')!;
    withExecutionContext(ROLE, () =>
      submitDiscussionCommand(id, 'human', {
        kind: 'edit_message',
        target: target.id,
        text: 'Right criteria',
      })
    );
    room = await settle(id);
    expect(room.messages.find((m) => m.id === target.id)).toMatchObject({
      text: 'Right criteria',
      edited: true,
    });
    expect(room.dialogue.success_criteria).toEqual(['Right criteria']);
    // The later constraint answer was part of the abandoned branch.
    expect(room.dialogue.constraints).toEqual([]);
  });

  it('a stopped generation is not answered again until the person asks', async () => {
    const id = 'test-dlg-stop';
    newDialogue(id);
    await settle(id);
    class StoppingSpeaker extends ScriptedDiscussionSpeaker {
      async dialogueTurn(
        request: DialogueTurnRequest,
        hooks: DialogueHooks
      ): Promise<DialogueReply> {
        hooks.onText('partial…');
        requestGenerationStop(id);
        return super.dialogueTurn(request, hooks);
      }
    }
    say(id, 'Something long');
    let room = await settle(id, new StoppingSpeaker());
    expect(room.stalled_for).toBe(room.messages.at(-1)?.id);
    expect(room.messages.filter((m) => m.speaker === 'facilitator')).toHaveLength(1); // only the opening
    room = await settle(id); // engine restarts: still not auto-answered
    expect(room.stalled_for).not.toBeNull();
    withExecutionContext(ROLE, () => submitDiscussionCommand(id, 'human', { kind: 'regenerate' }));
    room = await settle(id);
    expect(room.stalled_for).toBeNull();
    expect(room.messages.filter((m) => m.speaker === 'facilitator').length).toBeGreaterThan(1);
  });

  it('@mentions and consult bring in a teammate without derailing the facilitator', async () => {
    const id = 'test-dlg-consult';
    newDialogue(id);
    await settle(id);
    say(id, '@researcher what do we know about churn?');
    const room = await settle(id);
    const reply = room.messages.at(-1)!;
    expect(reply).toMatchObject({ speaker: 'researcher', consulted: true });
    expect(room.dialogue.success_criteria).toEqual([]); // the mention was not an answer
  });

  it('records feedback, renames and archives without touching the engine', async () => {
    const id = 'test-dlg-meta';
    newDialogue(id);
    let room = await settle(id);
    const message = room.messages[0];
    withExecutionContext(ROLE, () => {
      recordMessageFeedback(id, 'me', message.id, 'up');
      renameDiscussionRoom(id, 'me', '  Onboarding plan  ');
      archiveDiscussionRoom(id, 'me', true);
    });
    room = readDiscussionRoom(id)!;
    expect(room.messages[0].feedback).toBe('up');
    expect(room.title).toBe('Onboarding plan');
    expect(room.archived).toBe(true);
    expect(() =>
      withExecutionContext(ROLE, () => recordMessageFeedback(id, 'me', 'nope', 'up'))
    ).toThrow(/assistant message/u);
  });

  it('attachments are stored, read, and shown to the facilitator', async () => {
    const id = 'test-dlg-attach';
    newDialogue(id);
    await settle(id);
    const attachment = await withExecutionContext(ROLE, () =>
      addDiscussionAttachment(id, 'me', {
        name: 'notes.md',
        bytes: Buffer.from('# Notes\nBudget is 10k'),
      })
    );
    expect(attachment).toMatchObject({ status: 'read', mime: 'text/plain; charset=utf-8' });
    expect(attachment.excerpt).toContain('Budget is 10k');
    const image = await withExecutionContext(ROLE, () =>
      addDiscussionAttachment(id, 'me', { name: 'shot.png', bytes: Buffer.from([137, 80, 78, 71]) })
    );
    expect(image.status).toBe('stored');
    await expect(
      withExecutionContext(ROLE, () =>
        addDiscussionAttachment(id, 'me', { name: 'x.exe', bytes: Buffer.from('MZ') })
      )
    ).rejects.toThrow(/not supported/u);

    let seen = '';
    class SpyingSpeaker extends ScriptedDiscussionSpeaker {
      async dialogueTurn(
        request: DialogueTurnRequest,
        hooks: DialogueHooks
      ): Promise<DialogueReply> {
        seen = JSON.stringify(request.human.attachments);
        return super.dialogueTurn(request, hooks);
      }
    }
    say(id, 'See the attached notes', { attachments: [attachment.id] });
    const room = await settle(id, new SpyingSpeaker());
    expect(seen).toContain('Budget is 10k');
    expect(room.messages.find((m) => m.kind === 'human')?.attachments).toEqual([attachment.id]);
    expect(room.messages.at(-1)?.text).toContain('I read the attachment');
  });
});

describe('dialogue reply parsing', () => {
  it('splits the visible reply from the control block while streaming', () => {
    expect(splitDialogueStream('REPLY:\nHello there').text).toBe('Hello there');
    const whole = splitDialogueStream('Hi!\n===JSON===\n{"suggestions":["a"]}');
    expect(whole.text).toBe('Hi!');
    expect(whole.json).toContain('suggestions');
  });

  it('keeps only valid, known fields from the model', () => {
    const reply = parseDialogueReply(
      'Got it.\n===JSON===\n' +
        JSON.stringify({
          goal_patch: { add_success_criteria: ['ship', 42, ''], objective: 'Ship it' },
          resolve: [{ id: 'q-1', answer: 'yes' }, { id: 'ghost' }],
          new_questions: [{ text: 'Who owns it?', blocking: true }, { text: '' }],
          suggestions: ['Me', 'Bob'],
          consult: ['researcher', 'wizard'],
        }),
      { questionIds: ['q-1'], roles: ['researcher', 'planner'] }
    )!;
    expect(reply.text).toBe('Got it.');
    expect(reply.goal_patch.add_success_criteria).toEqual(['ship']);
    expect(reply.goal_patch.objective).toBe('Ship it');
    expect(reply.resolve).toEqual([{ id: 'q-1', answer: 'yes' }]);
    expect(reply.new_questions).toHaveLength(1);
    expect(reply.consult).toEqual(['researcher']);
    expect(parseDialogueReply('   ', { questionIds: [], roles: [] })).toBeNull();
    // A reply without a control block still works as plain text.
    expect(parseDialogueReply('Just words', { questionIds: [], roles: [] })?.text).toBe(
      'Just words'
    );
  });
});
