import path from 'node:path';
import AjvModule from 'ajv';
import { beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';
import { safeExistsSync, safeReadFile, safeReaddir, safeRmSync } from './secure-io.js';
import {
  classifyTaskSessionIntent,
  createTaskSession,
  getActiveTaskSession,
  loadTaskSession,
  recordTaskSessionHistory,
  saveTaskSession,
  validateTaskSession,
} from './task-session.js';

const Ajv = (AjvModule as any).default ?? AjvModule;

function cleanupTestTaskSessions() {
  const dir = pathResolver.shared('runtime/task-sessions');
  if (!safeExistsSync(dir)) return;
  for (const entry of safeReaddir(dir)) {
    if (!entry.startsWith('TSK-TEST-') || !entry.endsWith('.json')) continue;
    safeRmSync(`${dir}/${entry}`);
  }
}

describe('task-session', () => {
  beforeEach(() => {
    cleanupTestTaskSessions();
  });

  it('creates and validates a capture task session', () => {
    const session = createTaskSession({
      surface: 'presence',
      taskType: 'capture_photo',
      status: 'collecting_requirements',
      goal: {
        summary: '記録用の写真を撮る',
        success_condition: '画像が保存される',
      },
      requirements: {
        missing: ['subject_hint'],
        collected: { camera_intent: 'record' },
      },
      payload: {
        camera_intent: 'record',
      },
    });
    const result = validateTaskSession(session);
    expect(result.valid).toBe(true);
    expect(session.outcome_contract.success_criteria.length).toBeGreaterThan(0);
    expect(session.work_loop?.resolution.execution_shape).toBe('task_session');
    expect(session.work_loop?.intent.label).toBe('capture_photo');
  });

  it('persists and loads task sessions', () => {
    const session = createTaskSession({
      sessionId: 'TSK-TEST-WBS',
      surface: 'presence',
      taskType: 'workbook_wbs',
      intentId: 'generate-workbook',
      status: 'planning',
      goal: {
        summary: 'WBS を Excel で作る',
        success_condition: 'xlsx が保存される',
      },
      projectContext: {
        project_id: 'PRJ-TEST-WEB',
        project_name: 'Test Web Service',
        track_id: 'TRK-TEST-REL1',
        track_name: 'Release 1',
        tier: 'confidential',
      },
      payload: {
        project_name: 'Kyberion',
      },
    });
    saveTaskSession(session);
    const loaded = loadTaskSession('TSK-TEST-WBS');
    expect(loaded?.task_type).toBe('workbook_wbs');
    expect(loaded?.work_loop?.outcome_design.labels.length).toBeGreaterThan(0);
    expect(loaded?.work_loop?.context.track_id).toBe('TRK-TEST-REL1');
    expect(loaded?.work_loop?.context.track_name).toBe('Release 1');
    expect(getActiveTaskSession('presence')?.session_id).toBeTruthy();
  });

  it('derives approval-required control state from classified service operations', () => {
    const classified = classifyTaskSessionIntent('voice-hub を再起動して');
    expect(classified?.payload?.approval_required).toBe(true);
    const session = createTaskSession({
      sessionId: 'TSK-TEST-APPROVAL',
      surface: 'presence',
      taskType: classified!.taskType,
      intentId: classified!.intentId,
      goal: classified!.goal,
      requirements: classified!.requirements,
      payload: classified!.payload,
    });
    expect(session.control.requires_approval).toBe(true);
    expect(session.work_loop?.authority.requires_approval).toBe(true);
  });

  it('records history updates', () => {
    const session = createTaskSession({
      sessionId: 'TSK-TEST-HISTORY',
      surface: 'presence',
      taskType: 'capture_photo',
      goal: {
        summary: '写真',
        success_condition: '保存',
      },
      payload: {
        camera_intent: 'record',
      },
    });
    saveTaskSession(session);
    const updated = recordTaskSessionHistory('TSK-TEST-HISTORY', {
      ts: new Date().toISOString(),
      type: 'instruction',
      text: 'ちょっと写真をとって',
    });
    expect(updated?.history.at(-1)?.text).toBe('ちょっと写真をとって');
  });

  it('blocks completion when outcome contract requires evidence without artifact refs', () => {
    const session = createTaskSession({
      sessionId: 'TSK-TEST-OUTCOME-CHECK',
      surface: 'presence',
      taskType: 'analysis',
      status: 'completed',
      goal: {
        summary: '横断レビュー',
        success_condition: 'レビュー結果を返す',
      },
      outcomeContract: {
        outcome_id: 'ts_outcome_test',
        requested_result: 'レビュー結果',
        deliverable_kind: 'report',
        success_criteria: ['findings delivered'],
        evidence_required: true,
        expected_artifacts: [],
        verification_method: 'self_check',
      },
    });

    expect(() => saveTaskSession(session)).toThrow(/requires evidence/i);
  });

  it('classifies photo and workbook intents from conversational utterances', () => {
    expect(classifyTaskSessionIntent('ちょっと写真をとって')?.taskType).toBe('capture_photo');
    expect(classifyTaskSessionIntent('Webサービスを作って')?.intentId).toBe('bootstrap-project');
    expect(classifyTaskSessionIntent('Webサービスを作って')?.taskType).toBe('analysis');
    expect(classifyTaskSessionIntent('プロジェクトのWBSをエクセルで作成して')?.taskType).toBe('workbook_wbs');
    expect(classifyTaskSessionIntent('パワーポイントの資料を書いて')?.taskType).toBe('presentation_deck');
    expect(classifyTaskSessionIntent('今週の進捗レポートを docx で作って')?.taskType).toBe('report_document');
    expect(classifyTaskSessionIntent('voice-hub を再起動して')?.taskType).toBe('service_operation');
    expect(classifyTaskSessionIntent('presence-studio の状態を見て')?.payload?.service_name).toBe('presence-studio');
    expect(classifyTaskSessionIntent('voice-hub のログを見て')?.payload?.service_name).toBe('voice-hub');
    expect(classifyTaskSessionIntent('voice-hub を再起動して')?.requirements?.missing).toContain('approval_confirmation');
    expect(classifyTaskSessionIntent('voice-hub のログを見て')?.requirements?.missing || []).not.toContain('approval_confirmation');
    expect(classifyTaskSessionIntent('過去の要件定義を横断的に見て横展開されていないバグを修正して')?.intentId).toBe('cross-project-remediation');
    expect(classifyTaskSessionIntent('過去の要件定義を横断的に見て横展開されていないバグを修正して')?.taskType).toBe('analysis');
    expect(classifyTaskSessionIntent('過去の要件定義を横断的に見て横展開されていないバグを修正して')?.requirements?.missing || []).toEqual([]);
    expect(classifyTaskSessionIntent('過去の要件定義を横断的に見て横展開されていないバグを修正して')?.payload?.analysis_contract_id).toBe('analysis.cross-project-remediation.v1');
    expect(classifyTaskSessionIntent('過去のインシデント結果を踏まえてレビューを実施して')?.intentId).toBe('incident-informed-review');
    expect(classifyTaskSessionIntent('過去のインシデント結果を踏まえてレビューを実施して')?.taskType).toBe('analysis');
    expect(classifyTaskSessionIntent('過去のインシデント結果を踏まえてレビューを実施して')?.requirements?.missing || []).toEqual([]);
    expect(classifyTaskSessionIntent('過去のインシデント結果を踏まえてレビューを実施して')?.payload?.analysis_contract_id).toBe('analysis.incident-informed-review.v1');
    expect(classifyTaskSessionIntent('このエージェントのハーネスを benchmark ベースで改善して')?.intentId).toBe('evolve-agent-harness');
    expect(classifyTaskSessionIntent('このエージェントのハーネスを benchmark ベースで改善して')?.taskType).toBe('analysis');
    expect(classifyTaskSessionIntent('このエージェントのハーネスを benchmark ベースで改善して')?.requirements?.missing || []).toEqual([]);
    expect(classifyTaskSessionIntent('このエージェントのハーネスを benchmark ベースで改善して')?.payload?.analysis_contract_id).toBe('analysis.evolve-agent-harness.v1');
  });

  it('derives task-session payload and requirements from governed policy', () => {
    const deck = classifyTaskSessionIntent('3枚の要約スライドを作って');
    expect(deck?.intentId).toBe('generate-presentation');
    expect(deck?.payload?.deck_purpose).toBe('proposal');
    expect(deck?.payload?.slide_count_hint).toBe(3);

    const remediation = classifyTaskSessionIntent('過去の要件定義を横断的に見て横展開されていないバグを修正して');
    expect(remediation?.payload?.source_corpus).toBe('requirements');
    expect(remediation?.payload?.action_bias).toBe('remediation');
    expect(remediation?.requirements?.missing || []).toEqual([]);
  });

  it('emits task sessions that satisfy the schema', () => {
    const ajv = new Ajv({ allErrors: true });
    const schemaPath = path.join(pathResolver.rootDir(), 'knowledge/public/schemas/task-session.schema.json');
    const validate = compileSchemaFromPath(ajv, schemaPath);
    const session = createTaskSession({
      sessionId: 'TSK-TEST-SCHEMA',
      surface: 'presence',
      taskType: 'presentation_deck',
      goal: {
        summary: 'Create a deck',
        success_condition: 'pptx exists',
      },
      payload: {
        deck_purpose: 'proposal',
      },
    });
    const valid = validate(session);
    expect(valid, JSON.stringify(validate.errors || [])).toBe(true);
  });

  it('accepts the canonical task-session-capture-photo example', () => {
    const ajv = new Ajv({ allErrors: true });
    const schemaPath = path.join(pathResolver.rootDir(), 'knowledge/public/schemas/task-session-capture-photo.schema.json');
    const validate = compileSchemaFromPath(ajv, schemaPath);
    const example = JSON.parse(
      safeReadFile(path.join(pathResolver.rootDir(), 'knowledge/public/schemas/task-session-capture-photo.example.json'), {
        encoding: 'utf8',
      }) as string,
    );

    expect(validate(example.payload), JSON.stringify(validate.errors || [])).toBe(true);
  });

  it('rejects invalid task-session-capture-photo payloads', () => {
    const ajv = new Ajv({ allErrors: true });
    const schemaPath = path.join(pathResolver.rootDir(), 'knowledge/public/schemas/task-session-capture-photo.schema.json');
    const validate = compileSchemaFromPath(ajv, schemaPath);

    expect(validate({
      device_preference: 'rear-camera',
      save_path: 'active/shared/tmp/photo.jpg',
    })).toBe(false);
  });
});
