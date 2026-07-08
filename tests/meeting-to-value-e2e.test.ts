import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearSlackOutboxMessage,
  listActionItems,
  listOthersPending,
  listSlackOutboxMessages,
  pathResolver,
  registerReasoningBackend,
  resetReasoningBackend,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
} from '@agent/core';
import { createMission } from '../scripts/refactor/mission-creation.js';
import { loadState, saveState } from '../scripts/refactor/mission-state.js';
import { runSteps } from '../scripts/run_pipeline.ts';
import { runActionItemReminderSweep } from '../scripts/action_item_reminders.js';

const MISSION_ID = 'MSN-MEETING-E2E-001';
const CUSTOMER_SLUG = 'demo';
const ROOT = pathResolver.rootDir();
const MISSION_DIR = path.join(ROOT, 'active/missions/confidential', MISSION_ID);
const CUSTOMER_ROOT = path.join(ROOT, 'customer', CUSTOMER_SLUG);
const TRANSCRIPT_PATH = pathResolver.rootResolve('tests/fixtures/meeting-transcript-sample.md');
const PIPELINE_PATH = pathResolver.rootResolve('pipelines/meeting-followup.json');
const REPORT_PATH = pathResolver.rootResolve('active/shared/tmp/meeting-to-value-e2e-report.json');

function readPipeline(): {
  context?: Record<string, unknown>;
  steps?: Array<{ id: string; op?: string; params?: Record<string, unknown> }>;
} {
  return JSON.parse(safeReadFile(PIPELINE_PATH, { encoding: 'utf8' }) as string) as any;
}

describe('meeting-to-value e2e', () => {
  const originalMissionRole = process.env.MISSION_ROLE;
  const originalPersona = process.env.KYBERION_PERSONA;
  const originalCustomer = process.env.KYBERION_CUSTOMER;
  const originalReasoning = process.env.KYBERION_REASONING_BACKEND;

  beforeEach(async () => {
    process.env.MISSION_ROLE = 'mission_controller';
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.KYBERION_CUSTOMER = CUSTOMER_SLUG;
    process.env.KYBERION_REASONING_BACKEND = 'stub';
    safeRmSync(MISSION_DIR, { recursive: true, force: true });
    safeRmSync(CUSTOMER_ROOT, { recursive: true, force: true });
    safeRmSync(REPORT_PATH, { force: true });
    safeMkdir(path.join(CUSTOMER_ROOT, 'deliverables'), { recursive: true });

    await createMission({
      id: MISSION_ID,
      tier: 'confidential',
      tenantSlug: CUSTOMER_SLUG,
      missionType: 'meeting_facilitation',
      persona: 'ecosystem_architect',
      rootDir: ROOT,
    });
    const state = loadState(MISSION_ID);
    expect(state).not.toBeNull();
    if (state) {
      state.status = 'active';
      state.history.push({
        ts: new Date().toISOString(),
        event: 'ACTIVATE',
        note: 'Mission activated for reminder sweep.',
      });
      await saveState(MISSION_ID, state);
    }
  });

  afterEach(() => {
    resetReasoningBackend();
    vi.useRealTimers();
    safeRmSync(MISSION_DIR, { recursive: true, force: true });
    safeRmSync(CUSTOMER_ROOT, { recursive: true, force: true });
    safeRmSync(REPORT_PATH, { force: true });
    for (const message of listSlackOutboxMessages()) {
      if (message.correlation_id?.startsWith(`${MISSION_ID}:`)) {
        clearSlackOutboxMessage(message.message_id);
      }
    }
    if (originalMissionRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = originalMissionRole;
    if (originalPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = originalPersona;
    if (originalCustomer === undefined) delete process.env.KYBERION_CUSTOMER;
    else process.env.KYBERION_CUSTOMER = originalCustomer;
    if (originalReasoning === undefined) delete process.env.KYBERION_REASONING_BACKEND;
    else process.env.KYBERION_REASONING_BACKEND = originalReasoning;
  });

  it('runs the meeting follow-up flow and reminder sweep end to end', async () => {
    // Freeze Date for the WHOLE flow: the fixture uses absolute due dates
    // (2026-07-07 / 2026-07-10), so extraction against real time starts
    // reclassifying items as overdue once the calendar catches up.
    vi.useFakeTimers({ now: new Date('2026-07-05T09:00:00.000Z'), toFake: ['Date'] });

    const respond = async (prompt: string): Promise<string> => {
      if (
        prompt.includes(
          'You analyze a meeting transcript and produce a JSON array of action items.'
        )
      ) {
        return JSON.stringify([
          {
            title: 'Prepare the proposal outline',
            summary: 'Draft the proposal outline and share it by Friday.',
            assignee_label: 'Alice',
            assignee_kind: 'team_member',
            priority: 'must',
            due_at_iso: '2026-07-10T00:00:00.000Z',
            modality: 'declarative',
            speaker_label: 'Alice',
            transcript_excerpt: '私が提案書の骨子を担当します。金曜日までに初稿を送ります。',
            transcript_offset_lines: [2],
          },
          {
            title: 'Confirm customer list',
            summary: 'Confirm the customer list and share it tomorrow morning.',
            assignee_label: 'Bob',
            assignee_kind: 'team_member',
            priority: 'should',
            due_at_iso: '2026-07-07T00:00:00.000Z',
            modality: 'declarative',
            speaker_label: 'Bob',
            transcript_excerpt: '顧客一覧の確認は私がやります。明日の午前中に確認して共有します。',
            transcript_offset_lines: [3],
          },
          {
            title: 'Write the minutes',
            summary: 'Capture the minutes after the meeting.',
            assignee_label: 'Operator',
            assignee_kind: 'operator_self',
            priority: 'should',
            modality: 'declarative',
            speaker_label: 'Operator',
            transcript_excerpt: '議事録は私が整理します。会議後に minutes を残します。',
            transcript_offset_lines: [4],
          },
        ]);
      }
      if (prompt.includes('You draft a SHORT reminder message about an outstanding action item.')) {
        return JSON.stringify({
          text: '共有ありがとうございます。期限前後の進捗だけ一言いただけると助かります。',
        });
      }
      return '# Minutes\n\n## Summary\nMeeting follow-up summary.\n';
    };

    registerReasoningBackend({
      name: 'meeting-to-value-e2e',
      async prompt(prompt: string) {
        return respond(prompt);
      },
      async delegateTask(prompt: string) {
        return respond(prompt);
      },
    });

    const pipeline = readPipeline();
    expect(pipeline.steps?.map((step) => step.id)).toEqual([
      'open_log',
      'read_transcript',
      'draft_minutes',
      'write_minutes',
      'extract_action_items',
      'write_delivery_pack',
      'log_summary',
    ]);
    expect(
      safeReadFile(path.join(MISSION_DIR, 'TASK_BOARD.md'), { encoding: 'utf8' }) as string
    ).toContain('ai-meeting-facilitator-followup');

    const result = await runSteps(
      pipeline.steps ?? [],
      {
        ...(pipeline.context ?? {}),
        mission_id: MISSION_ID,
        transcript_path: TRANSCRIPT_PATH,
        attendees: [{ name: 'Alice' }, { name: 'Bob' }, { name: 'Operator' }],
        operator_label: 'Operator',
        language: 'ja',
      },
      {
        pipelinePath: PIPELINE_PATH,
        quiet: true,
      }
    );

    expect(result.status).toBe('succeeded');
    expect(safeExistsSync(path.join(MISSION_DIR, 'evidence', 'minutes.md'))).toBe(true);
    expect(safeExistsSync(path.join(MISSION_DIR, 'evidence', 'action-items.jsonl'))).toBe(true);
    expect(safeExistsSync(path.join(MISSION_DIR, 'evidence', 'meeting-followup-pack.json'))).toBe(
      true
    );

    const actionItems = listActionItems(MISSION_ID);
    expect(actionItems).toHaveLength(3);
    expect(listOthersPending(MISSION_ID)).toHaveLength(2);

    const reminderReport = await runActionItemReminderSweep({
      mission_ids: [MISSION_ID],
      tone: 'friendly',
      language: 'ja',
      max_items_per_mission: 20,
      report_path: REPORT_PATH,
    });
    expect(reminderReport.reminders_sent).toBe(2);
    expect(reminderReport.outbox_messages_sent).toBe(2);

    const outbox = listSlackOutboxMessages().filter((message) =>
      message.correlation_id?.startsWith(`${MISSION_ID}:`)
    );
    expect(outbox).toHaveLength(2);
    // Same-millisecond enqueue order is not deterministic — assert content.
    const outboxTexts = outbox.map((message) => message?.text || '').join('\n');
    expect(outboxTexts).toContain('Confirm customer list');
    expect(outboxTexts).toContain('Prepare the proposal outline');
    expect(
      safeReadFile(path.join(MISSION_DIR, 'evidence', 'minutes.md'), { encoding: 'utf8' }) as string
    ).toContain('# Minutes');
  });
});
