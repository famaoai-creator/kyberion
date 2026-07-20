import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  pathResolver,
  safeMkdir,
  safeRmSync,
  safeWriteFile,
  safeReadFile,
  registerReasoningBackend,
  resetReasoningBackend,
  stubReasoningBackend,
} from '@agent/core';
import * as path from 'node:path';
import { extractActionItemsOp } from '../libs/actuators/meeting-actuator/src/meeting-intelligence-ops.js';

const FIXTURE_MISSION_ID = 'MSN-POSTPROCESS-001';
const FIXTURE_TRANSCRIPT = pathResolver.rootResolve(
  'tests/fixtures/meeting-postprocess/transcript.txt'
);
const FIXTURE_MISSION_DIR = path.join(
  pathResolver.rootDir(),
  'active/missions/confidential',
  FIXTURE_MISSION_ID
);

function readText(relativePath: string): string {
  return safeReadFile(pathResolver.rootResolve(relativePath), { encoding: 'utf8' }) as string;
}

describe('meeting postprocess contract', () => {
  const originalPersona = process.env.KYBERION_PERSONA;
  const originalRole = process.env.MISSION_ROLE;
  const originalMissionId = process.env.MISSION_ID;

  beforeEach(() => {
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.MISSION_ROLE = 'mission_controller';
    process.env.MISSION_ID = FIXTURE_MISSION_ID;
    safeMkdir(path.join(FIXTURE_MISSION_DIR, 'evidence'), { recursive: true });
    safeWriteFile(
      path.join(FIXTURE_MISSION_DIR, 'mission-state.json'),
      JSON.stringify(
        {
          mission_id: FIXTURE_MISSION_ID,
          tier: 'confidential',
          assigned_persona: 'ecosystem_architect',
        },
        null,
        2
      )
    );
  });

  afterEach(() => {
    resetReasoningBackend();
    vi.restoreAllMocks();
    safeRmSync(FIXTURE_MISSION_DIR, { recursive: true, force: true });
    if (originalPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = originalPersona;
    if (originalRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = originalRole;
    if (originalMissionId === undefined) delete process.env.MISSION_ID;
    else process.env.MISSION_ID = originalMissionId;
  });

  it('keeps the postprocess template aligned with transcript extraction and structured output', async () => {
    const template = JSON.parse(
      readText('knowledge/product/pipeline-templates/meeting-facilitation-postprocess.json')
    ) as {
      context?: Record<string, unknown>;
      steps?: Array<{
        id: string;
        op?: string;
        params?: Record<string, unknown>;
        consumes?: string;
      }>;
    };

    expect(template.context).toMatchObject({
      transcript_path: 'active/shared/tmp/meeting-transcript-{{mission_id}}.txt',
      action_items_path: 'active/shared/tmp/action-items-extracted-{{mission_id}}.json',
      speaker_fairness_path: 'active/shared/tmp/speaker-fairness-{{mission_id}}.json',
    });
    expect(template.steps?.map((step) => step.id)).toEqual([
      'open_log',
      'read_transcript',
      'extract_action_items',
      'write_action_items',
      'write_fairness_stub',
      'log_summary',
    ]);

    const extractionStep = template.steps?.find((step) => step.id === 'extract_action_items');
    expect(extractionStep?.op).toBe('reasoning:analyze');
    expect(String(extractionStep?.params?.instruction)).toContain('summary');
    expect(String(extractionStep?.params?.instruction)).toContain('decisions');
    expect(String(extractionStep?.params?.instruction)).toContain('action_items');
    expect(String(extractionStep?.params?.instruction)).toContain('risks');

    registerReasoningBackend({
      ...stubReasoningBackend,
      name: 'meeting-postprocess-test',
      async delegateTask(prompt: string) {
        expect(prompt).toContain(
          'Alice: I will own the proposal outline and send the first version tomorrow.'
        );
        return JSON.stringify([
          {
            title: 'Send the first proposal outline',
            summary: 'Prepare the proposal outline and share the first version tomorrow.',
            assignee_label: 'Alice',
            assignee_kind: 'team_member',
            priority: 'must',
            due_at_iso: '2026-06-22T00:00:00.000Z',
            modality: 'declarative',
            speaker_label: 'Alice',
            transcript_excerpt:
              'I will own the proposal outline and send the first version tomorrow.',
            transcript_offset_lines: [2],
          },
        ]);
      },
    });

    const report = await extractActionItemsOp({
      mission_id: FIXTURE_MISSION_ID,
      transcript: safeReadFile(FIXTURE_TRANSCRIPT, { encoding: 'utf8' }) as string,
      attendees: [{ name: 'Alice' }, { name: 'Bob' }],
      language: 'ja',
      operator_label: 'Operator',
    });

    expect(report.items).toHaveLength(1);
    expect(report.items[0]).toMatchObject({
      title: 'Send the first proposal outline',
      assignee: {
        kind: 'team_member',
        label: 'Alice',
      },
    });
    expect(report.written_count).toBe(1);
    expect(report.pending_review_count).toBe(0);
    expect(report.partial_count).toBe(0);
    expect(report.restricted_count).toBe(0);
  });
});
