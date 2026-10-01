import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeReadFile, safeRmSync } from '@agent/core/secure-io';
import {
  registerReasoningBackend,
  resetReasoningBackend,
  stubReasoningBackend,
} from '@agent/core/reasoning/reasoning-backend';
import { resetVoiceBridge } from '@agent/core/voice/voice-bridge';
import { handleAction } from './index.js';

const OUT_DIR = 'active/shared/tmp/meeting-facilitation-ops-test';

type PipelineResult = {
  status: string;
  results: Array<{ status: string; error?: string }>;
  context: Record<string, any>;
};

function runApply(op: string, params: Record<string, unknown>): Promise<PipelineResult> {
  return handleAction({
    action: 'pipeline',
    steps: [{ type: 'apply', op, params }],
    context: {},
  } as never) as Promise<PipelineResult>;
}

describe('meeting-actuator facilitation ops (ephemeral, no mission scope)', () => {
  let savedMission: string | undefined;
  beforeEach(() => {
    savedMission = process.env.MISSION_ID;
    delete process.env.MISSION_ID;
  });
  afterEach(() => {
    if (savedMission === undefined) delete process.env.MISSION_ID;
    else process.env.MISSION_ID = savedMission;
    resetReasoningBackend();
    resetVoiceBridge();
  });
  afterAll(() => {
    safeRmSync(pathResolver.rootResolve(OUT_DIR), { recursive: true, force: true });
  });

  it('generate_facilitation_script returns the judged utterance', async () => {
    const delegateTask = vi.fn(async (instruction: string) =>
      /candidate [12]\/2/u.test(instruction)
        ? JSON.stringify({ speech_text: 'Shall we move on?', next_action: 'transition_topic' })
        : JSON.stringify({ winner_index: 0, rationale: 'only candidate shape' })
    );
    registerReasoningBackend({ ...stubReasoningBackend, name: 'facilitation-test', delegateTask });

    const result = await runApply('generate_facilitation_script', {
      agenda: ['Status', 'Next steps'],
      current_topic: 'Status',
      language: 'en',
      export_as: 'script',
    });

    expect(result.status).toBe('succeeded');
    expect(result.context.script).toEqual({
      speech_text: 'Shall we move on?',
      next_action: 'transition_topic',
    });
    expect(delegateTask.mock.calls[0]![0]).toContain('1. Status');
  });

  it('generate_reminder_message drafts the text and CCs the manager for must items', async () => {
    registerReasoningBackend({
      ...stubReasoningBackend,
      name: 'reminder-test',
      delegateTask: vi.fn(async () => '{"text":"Could you share the notes by Friday?"}'),
    });

    const result = await runApply('generate_reminder_message', {
      item: {
        item_id: 'AI-1',
        title: 'Share the notes',
        priority: 'must',
        assignee: { label: 'Aki', channel_handle: '@aki' },
        policy: { manager_handle: '@lead' },
      },
      days_overdue: 2,
      export_as: 'reminder',
    });

    expect(result.status).toBe('succeeded');
    expect(result.context.reminder).toEqual({
      channel: '@aki',
      text: 'Could you share the notes by Friday?',
      cc: ['@lead'],
    });

    const missing = await runApply('generate_reminder_message', {});
    expect(missing.status).toBe('failed');
    expect(missing.results[0]!.error).toContain('missing params.item');
  });

  it('conduct_1on_1 records the voice-bridge session to output_path', async () => {
    const outputPath = path.posix.join(OUT_DIR, 'one-on-one.json');
    const result = await runApply('conduct_1on_1', {
      counterparty_ref: 'operator',
      proposal_draft_ref: 'active/shared/tmp/proposal.md',
      structure: ['opening', 'concerns'],
      output_path: outputPath,
      export_as: 'one_on_one',
    });

    expect(result.status).toBe('succeeded');
    expect(result.context.one_on_one).toMatchObject({ written_to: outputPath });
    const absolute = pathResolver.rootResolve(outputPath);
    expect(safeExistsSync(absolute)).toBe(true);
    const record = JSON.parse(String(safeReadFile(absolute, { encoding: 'utf8' })));
    expect(record.structure).toEqual(['opening', 'concerns']);
    expect(record.reasoning_mode).toBe(result.context.one_on_one.reasoning_mode);
  });

  it('chat is dispatched to the meeting bridge and audited', async () => {
    const result = await runApply('chat', {
      platform: 'auto',
      text: 'Please summarize the decision.',
      export_as: 'chat_result',
    });

    expect(result.status).toBe('succeeded');
    expect(result.context.chat_result).toMatchObject({ audit_event_id: expect.any(String) });
  });
});
