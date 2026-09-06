import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import {
  clearWorkCoordinationStore,
  clearSlackOutboxMessage,
  createWorkItem,
  listSlackOutboxMessages,
  pathResolver,
  registerReasoningBackend,
  resetReasoningBackend,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
  setWorkCoordinationNamespace,
  stubReasoningBackend,
} from '@agent/core';
import { extractActionItemsOp } from '../libs/actuators/meeting-actuator/src/meeting-intelligence-ops.js';
import { runActionItemReminderSweep } from '../scripts/action_item_reminders.js';

const MISSION_ID = 'MSN-MEETING-FOLLOWUP-001';
const WORK_ITEM_ID = 'WITEM-MEETING-FOLLOWUP-001';
const MISSION_DIR = path.join(pathResolver.rootDir(), 'active/missions/confidential', MISSION_ID);
const TRANSCRIPT_PATH = pathResolver.rootResolve('tests/fixtures/meeting-transcript-sample.md');
const REPORT_PATH = pathResolver.rootResolve(
  'active/shared/tmp/test-action-item-reminders-report.json'
);
const PIPELINE_PATH = pathResolver.rootResolve('pipelines/meeting-followup.json');
const SLACK_CORRELATION_PREFIX = `${MISSION_ID}:`;

function readPipeline(): {
  context?: Record<string, unknown>;
  steps?: Array<{
    id: string;
    op?: string;
    params?: Record<string, unknown>;
    consumes?: string | string[];
  }>;
} {
  return JSON.parse(safeReadFile(PIPELINE_PATH, { encoding: 'utf8' }) as string) as any;
}

describe('meeting-to-value contract', () => {
  const originalMissionId = process.env.MISSION_ID;
  const originalMissionRole = process.env.MISSION_ROLE;
  const originalPersona = process.env.KYBERION_PERSONA;

  beforeEach(() => {
    process.env.MISSION_ID = MISSION_ID;
    process.env.MISSION_ROLE = 'mission_controller';
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    setWorkCoordinationNamespace(`meeting-to-value-contract-${process.pid}`);
    clearWorkCoordinationStore();
    createWorkItem({
      itemId: WORK_ITEM_ID,
      title: 'Extract meeting action items',
      description: 'Extract and govern action items from the meeting transcript.',
      projectId: MISSION_ID,
      status: 'in_progress',
      context: {
        organization_id: 'meeting-followup',
        tenant_slug: 'meeting-followup',
        mission_id: MISSION_ID,
        project_id: MISSION_ID,
        task_id: 'extract-action-items',
      },
    });
    safeMkdir(path.join(MISSION_DIR, 'evidence'), { recursive: true });
    safeWriteFile(
      path.join(MISSION_DIR, 'mission-state.json'),
      JSON.stringify(
        {
          mission_id: MISSION_ID,
          tier: 'confidential',
          status: 'active',
          assigned_persona: 'operator',
          // mission-state.json is now loaded through a schema-validated
          // governed catalog; a fixture missing these required fields fails
          // closed, so listMissionSummaries never sees the mission and the
          // reminder sweep scans nothing.
          execution_mode: 'local',
          priority: 3,
          confidence_score: 1.0,
          git: { branch: 'main', start_commit: '', latest_commit: '', checkpoints: [] },
          history: [
            {
              ts: new Date().toISOString(),
              event: 'ACTIVATE',
              note: 'Fixture mission activated for meeting-to-value contract test.',
            },
          ],
        },
        null,
        2
      )
    );
  });

  afterEach(() => {
    resetReasoningBackend();
    clearWorkCoordinationStore();
    setWorkCoordinationNamespace(null);
    vi.restoreAllMocks();
    vi.useRealTimers();
    safeRmSync(MISSION_DIR, { recursive: true, force: true });
    safeRmSync(REPORT_PATH, { force: true });
    for (const message of listSlackOutboxMessages()) {
      if (message.correlation_id?.startsWith(SLACK_CORRELATION_PREFIX)) {
        clearSlackOutboxMessage(message.message_id);
      }
    }
    if (originalMissionId === undefined) delete process.env.MISSION_ID;
    else process.env.MISSION_ID = originalMissionId;
    if (originalMissionRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = originalMissionRole;
    if (originalPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = originalPersona;
  });

  it('keeps the meeting follow-up pipeline wired to minutes and action-item extraction', () => {
    const pipeline = readPipeline();

    expect(pipeline.context).toHaveProperty('mission_evidence_dir', '');
    expect(pipeline.steps?.find((step) => step.id === 'write_minutes')?.params).toMatchObject({
      path: '{{mission_evidence_dir}}/minutes.md',
    });
    expect(pipeline.steps?.find((step) => step.id === 'write_delivery_pack')?.params).toMatchObject(
      {
        path: '{{mission_evidence_dir}}/meeting-followup-pack.json',
      }
    );
    expect(pipeline.steps?.map((step) => step.id)).toEqual([
      'open_log',
      // 1ffdae2ea (pipeline v2.1) replaced the plain system:read_file
      // `read_transcript` step with meeting:normalize_transcript, which adds
      // VTT/SRT cue parsing and speaker normalization on intake.
      'normalize_transcript',
      'draft_minutes',
      'write_minutes',
      'extract_action_items',
      'write_delivery_pack',
      'log_summary',
    ]);
    expect(pipeline.steps?.find((step) => step.id === 'draft_minutes')?.op).toBe(
      'reasoning:analyze'
    );
    expect(pipeline.steps?.find((step) => step.id === 'extract_action_items')?.op).toBe(
      'meeting:extract_action_items'
    );
    expect(
      pipeline.steps?.find((step) => step.id === 'extract_action_items')?.params
    ).toMatchObject({
      work_item_id: '{{work_item_id}}',
      output_path: '{{mission_evidence_dir}}/action-items.jsonl',
    });
  });

  it('extracts action items from the transcript and drives the reminder sweep into Slack outbox', async () => {
    registerReasoningBackend({
      ...stubReasoningBackend,
      name: 'meeting-to-value-test',
      async delegateTask(prompt: string) {
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
              transcript_excerpt:
                '顧客一覧の確認は私がやります。明日の午前中に確認して共有します。',
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
        return JSON.stringify({ text: 'Reminder drafted.' });
      },
    });

    const transcript = safeReadFile(TRANSCRIPT_PATH, { encoding: 'utf8' }) as string;
    const extraction = await extractActionItemsOp({
      mission_id: MISSION_ID,
      work_item_id: WORK_ITEM_ID,
      transcript,
      attendees: [{ name: 'Alice' }, { name: 'Bob' }, { name: 'Operator' }],
      operator_label: 'Operator',
      language: 'ja',
    });

    expect(extraction.written_count).toBe(3);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-05T00:00:00.000Z'));

    const reminderReport = await runActionItemReminderSweep({
      mission_ids: [MISSION_ID],
      tone: 'friendly',
      language: 'ja',
      max_items_per_mission: 20,
      report_path: REPORT_PATH,
    });

    expect(reminderReport.missions_scanned).toBeGreaterThan(0);
    expect(reminderReport.missions_with_pending_items).toBe(1);
    expect(reminderReport.reminders_sent).toBe(2);
    expect(reminderReport.outbox_messages_sent).toBe(2);
    expect(safeReadFile(REPORT_PATH, { encoding: 'utf8' }) as string).toContain(MISSION_ID);

    const dedupedReport = await runActionItemReminderSweep({
      mission_ids: [MISSION_ID],
      tone: 'friendly',
      language: 'ja',
      max_items_per_mission: 20,
      report_path: REPORT_PATH,
    });

    expect(dedupedReport.missions_scanned).toBeGreaterThan(0);
    expect(dedupedReport.missions_with_pending_items).toBe(1);
    expect(dedupedReport.reminders_sent).toBe(0);
    expect(dedupedReport.outbox_messages_sent).toBe(0);

    const outbox = listSlackOutboxMessages().filter((message) =>
      message.correlation_id?.startsWith(SLACK_CORRELATION_PREFIX)
    );
    expect(outbox).toHaveLength(2);
    // Both reminders are enqueued within the same millisecond, so listing
    // order is not deterministic — assert content, not position.
    const outboxTexts = outbox.map((message) => message?.text || '').join('\n');
    expect(outboxTexts).toContain('Confirm customer list');
    expect(outboxTexts).toContain('Prepare the proposal outline');
  });
});
