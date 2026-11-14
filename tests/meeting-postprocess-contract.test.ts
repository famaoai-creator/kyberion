import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getSecretResolver,
  registerSecretResolver,
  resetSecretResolver,
  type SecretResolver,
} from '@agent/core/secret/secret-resolver';
import { credentialBindingReadiness } from '@agent/core/foundation/credential-binding';
import {
  clearWorkCoordinationStore,
  createWorkItem,
  pathResolver,
  safeMkdir,
  safeRmSync,
  safeWriteFile,
  setWorkCoordinationNamespace,
  safeReadFile,
  registerReasoningBackend,
  resetReasoningBackend,
  stubReasoningBackend,
} from '@agent/core';
import * as path from 'node:path';
import { extractActionItemsOp } from '../libs/actuators/meeting-actuator/src/meeting-intelligence-ops.js';

const FIXTURE_MISSION_ID = 'MSN-POSTPROCESS-001';
const FIXTURE_WORK_ITEM_ID = 'WITEM-POSTPROCESS-001';
const FIXTURE_TRANSCRIPT = pathResolver.rootResolve(
  'tests/fixtures/meeting-postprocess/transcript.txt'
);
const FIXTURE_MISSION_DIR = pathResolver.missionDir(
  FIXTURE_MISSION_ID,
  'confidential',
  'postprocess'
);

function readText(relativePath: string): string {
  return safeReadFile(pathResolver.rootResolve(relativePath), { encoding: 'utf8' }) as string;
}

describe('meeting postprocess contract', () => {
  let previousResolver: SecretResolver | null = null;
  const originalPersona = process.env.KYBERION_BASE_ROLE;
  const originalRole = process.env.MISSION_ROLE;
  const originalMissionId = process.env.MISSION_ID;

  beforeEach(() => {
    // The core barrel installs the local account resolver. This credential-free
    // provider stub uses real dispatch and its empty-binding fallback instead.
    previousResolver = getSecretResolver();
    resetSecretResolver();
    vi.stubEnv('KYBERION_TIER', 'confidential');
    vi.stubEnv('KYBERION_TENANT', 'postprocess');
    vi.stubEnv('KYBERION_ORGANIZATION_ID', 'postprocess');
    vi.stubEnv('KYBERION_PROJECT_ID', FIXTURE_MISSION_ID);
    vi.stubEnv('KYBERION_TASK_ID', '');
    process.env.KYBERION_BASE_ROLE = 'ecosystem_architect';
    process.env.MISSION_ROLE = 'mission_controller';
    process.env.MISSION_ID = FIXTURE_MISSION_ID;
    setWorkCoordinationNamespace(`meeting-postprocess-${process.pid}`);
    clearWorkCoordinationStore();
    createWorkItem({
      itemId: FIXTURE_WORK_ITEM_ID,
      title: 'Extract postprocess action items',
      description: 'Extract structured action items from the postprocess transcript.',
      projectId: FIXTURE_MISSION_ID,
      status: 'in_progress',
      context: {
        organization_id: 'postprocess',
        tenant_slug: 'postprocess',
        mission_id: FIXTURE_MISSION_ID,
        project_id: FIXTURE_MISSION_ID,
        task_id: 'postprocess-extract-action-items',
      },
    });
    safeMkdir(path.join(FIXTURE_MISSION_DIR, 'evidence'), { recursive: true });
    safeWriteFile(
      path.join(FIXTURE_MISSION_DIR, 'mission-state.json'),
      JSON.stringify(
        {
          mission_id: FIXTURE_MISSION_ID,
          tenant_slug: 'postprocess',
          organization_id: 'postprocess',
          relationships: {
            project: {
              project_id: FIXTURE_MISSION_ID,
              project_path: `active/projects/confidential/postprocess/${FIXTURE_MISSION_ID}/project-os`,
              relationship_type: 'supports',
              affected_artifacts: [],
              gate_impact: 'informational',
              traceability_refs: [],
              note: 'Synthetic meeting postprocess fixture',
            },
          },
          tier: 'confidential',
          status: 'active',
          org_role: 'ecosystem_architect',
          execution_mode: 'local',
          priority: 3,
          confidence_score: 1,
          git: { branch: 'main', start_commit: '', latest_commit: '', checkpoints: [] },
          history: [{ ts: new Date().toISOString(), event: 'ACTIVATE', note: 'Fixture activated' }],
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
    safeRmSync(FIXTURE_MISSION_DIR, { recursive: true, force: true });
    vi.unstubAllEnvs();
    resetSecretResolver();
    if (previousResolver) registerSecretResolver(previousResolver);
    previousResolver = null;
    if (originalPersona === undefined) delete process.env.KYBERION_BASE_ROLE;
    else process.env.KYBERION_BASE_ROLE = originalPersona;
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
        expect(credentialBindingReadiness().status).toBe('bound');
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
      work_item_id: FIXTURE_WORK_ITEM_ID,
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
