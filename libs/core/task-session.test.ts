import path from 'node:path';
import AjvModule from 'ajv';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';
import {
  safeExistsSync,
  safeReadFile,
  safeReaddir,
  safeRmSync,
  safeWriteFile,
} from './secure-io.js';
import {
  loadIntentContractMemorySnapshot,
  refreshIntentContractMemorySnapshot,
  resolveIntentContractMemoryPaths,
} from './intent-contract-learning.js';
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
  const { runtime: intentContractMemoryRuntimePath } = resolveIntentContractMemoryPaths();
  let originalIntentContractMemoryRaw: string | null = null;
  let originalIntentContractMemoryExists = false;

  beforeAll(() => {
    originalIntentContractMemoryExists = safeExistsSync(intentContractMemoryRuntimePath);
    originalIntentContractMemoryRaw = originalIntentContractMemoryExists
      ? (safeReadFile(intentContractMemoryRuntimePath, { encoding: 'utf8' }) as string)
      : null;
  });

  afterAll(() => {
    if (originalIntentContractMemoryExists && originalIntentContractMemoryRaw !== null) {
      safeWriteFile(intentContractMemoryRuntimePath, originalIntentContractMemoryRaw);
    } else if (safeExistsSync(intentContractMemoryRuntimePath)) {
      safeRmSync(intentContractMemoryRuntimePath);
    }
    refreshIntentContractMemorySnapshot();
  });

  beforeEach(() => {
    cleanupTestTaskSessions();
    if (originalIntentContractMemoryExists && originalIntentContractMemoryRaw !== null) {
      safeWriteFile(intentContractMemoryRuntimePath, originalIntentContractMemoryRaw);
    } else if (safeExistsSync(intentContractMemoryRuntimePath)) {
      safeRmSync(intentContractMemoryRuntimePath);
    }
    refreshIntentContractMemorySnapshot();
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

  it('persists iMessage-backed task sessions', () => {
    const session = createTaskSession({
      sessionId: 'TSK-TEST-IMESSAGE',
      surface: 'imessage',
      taskType: 'analysis',
      intentId: 'incident-informed-review',
      status: 'planning',
      goal: {
        summary: 'iMessage のやり取りを分析する',
        success_condition: 'session が検証付きで保存される',
      },
      payload: {
        note: 'surface should now be accepted',
      },
    });

    expect(() => saveTaskSession(session)).not.toThrow();
    const loaded = loadTaskSession('TSK-TEST-IMESSAGE');
    expect(loaded?.surface).toBe('imessage');
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
    expect(session.payload?.intent_id).toBe('restart-service');
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

    expect(() => saveTaskSession(session)).toThrow(/intent goal not satisfied|requires evidence/i);
  });

  it('persists a completion summary when a completed task session has evidence', () => {
    const artifactPath = pathResolver.shared(
      'runtime/task-sessions/TSK-TEST-COMPLETION-SUMMARY.docx'
    );
    const session = createTaskSession({
      sessionId: 'TSK-TEST-COMPLETION-SUMMARY',
      surface: 'presence',
      taskType: 'report_document',
      status: 'completed',
      goal: {
        summary: 'Weekly report',
        success_condition: 'The report file is saved.',
      },
    });
    session.artifact = {
      kind: 'docx',
      output_path: artifactPath,
      preview_text: 'The report file is saved.',
    };

    expect(() => saveTaskSession(session)).not.toThrow();
    const loaded = loadTaskSession('TSK-TEST-COMPLETION-SUMMARY');
    expect(loaded?.completion_summary).toMatchObject({
      requested_result: expect.any(String),
      satisfied: true,
      next_step: expect.stringContaining('Proceed'),
    });
    expect(loaded?.completion_next_action?.satisfied).toBe(true);
  });

  it('records completion outcomes into intent-contract memory', () => {
    const session = createTaskSession({
      sessionId: 'TSK-TEST-COMPLETION-MEMORY',
      surface: 'presence',
      taskType: 'report_document',
      intentId: 'generate-report',
      status: 'completed',
      goal: {
        summary: 'Weekly report',
        success_condition: 'The report file is saved.',
      },
      payload: {
        report_kind: 'status',
      },
    });
    session.artifact = {
      kind: 'docx',
      preview_text: 'The report file is saved.',
    };

    expect(() => saveTaskSession(session)).not.toThrow();
    refreshIntentContractMemorySnapshot();
    const snapshot = loadIntentContractMemorySnapshot();
    const entry = snapshot.entries.find(
      (candidate) =>
        candidate.intent_id === 'generate-report' &&
        candidate.contract_ref.kind === 'task_session_policy' &&
        candidate.contract_ref.ref === 'generate-report'
    );
    expect(entry).toBeTruthy();
    expect(entry?.completion_summary).toMatchObject({
      satisfied: true,
      next_step: expect.stringContaining('Proceed'),
    });
  });

  it('classifies photo and workbook intents from conversational utterances', () => {
    expect(classifyTaskSessionIntent('ちょっと写真をとって')?.taskType).toBe('capture_photo');
    expect(classifyTaskSessionIntent('Webサービスを作って')?.intentId).toBe('bootstrap-project');
    expect(classifyTaskSessionIntent('Webサービスを作って')?.taskType).toBe('analysis');
    expect(classifyTaskSessionIntent('初回セットアップを始めて')?.intentId).toBe(
      'launch-first-run-onboarding'
    );
    expect(classifyTaskSessionIntent('初回セットアップを始めて')?.taskType).toBe(
      'service_operation'
    );
    expect(classifyTaskSessionIntent('CI/CDを設定して')?.intentId).toBe(
      'configure-organization-toolchain'
    );
    expect(classifyTaskSessionIntent('CI/CDを設定して')?.taskType).toBe('service_operation');
    expect(classifyTaskSessionIntent('デザインテーマを登録して')?.intentId).toBe(
      'register-presentation-preference-profile'
    );
    expect(classifyTaskSessionIntent('デザインテーマを登録して')?.taskType).toBe(
      'service_operation'
    );
    expect(classifyTaskSessionIntent('プロジェクトのWBSをエクセルで作成して')?.taskType).toBe(
      'workbook_wbs'
    );
    expect(classifyTaskSessionIntent('パワーポイントの資料を書いて')?.taskType).toBe(
      'presentation_deck'
    );
    expect(classifyTaskSessionIntent('パワーポイントの資料を書いて')?.executionBrief?.kind).toBe(
      'actuator-execution-brief'
    );
    expect(classifyTaskSessionIntent('今週の進捗レポートを docx で作って')?.taskType).toBe(
      'report_document'
    );
    expect(classifyTaskSessionIntent('voice-hub を再起動して')?.taskType).toBe('service_operation');
    expect(classifyTaskSessionIntent('サービスを起動して')?.intentId).toBe('start-service');
    expect(classifyTaskSessionIntent('サービスを起動して')?.requirements?.missing).toContain(
      'service_name'
    );
    expect(classifyTaskSessionIntent('voice-hub を起動して')?.payload?.service_name).toBe(
      'voice-hub'
    );
    expect(classifyTaskSessionIntent('サービスを停止して')?.intentId).toBe('stop-service');
    expect(classifyTaskSessionIntent('サービスを停止して')?.requirements?.missing).toContain(
      'service_name'
    );
    expect(classifyTaskSessionIntent('voice-hub を停止して')?.payload?.service_name).toBe(
      'voice-hub'
    );
    expect(classifyTaskSessionIntent('presence-studio の状態を見て')?.payload?.service_name).toBe(
      'presence-studio'
    );
    expect(classifyTaskSessionIntent('voice-hub のログを見て')?.payload?.service_name).toBe(
      'voice-hub'
    );
    const slackIntent = classifyTaskSessionIntent('Slackと連携して');
    expect(slackIntent?.intentId).toBe('setup-messaging-bridge');
    expect(classifyTaskSessionIntent('voice-hub を再起動して')?.requirements?.missing).toContain(
      'approval_confirmation'
    );
    expect(classifyTaskSessionIntent('承認を依頼して')?.requirements?.missing).toEqual([
      'approval_system',
      'approval_scope',
    ]);
    const voiceInputIntent = classifyTaskSessionIntent('音声入力にして');
    expect(voiceInputIntent?.intentId).toBe('enable-voice-input');
    expect(voiceInputIntent?.payload?.service_name).toBe('voice-hub');
    expect(voiceInputIntent?.payload?.operation).toBe('voice_input_toggle');
    expect(
      classifyTaskSessionIntent('voice-hub のログを見て')?.requirements?.missing || []
    ).not.toContain('approval_confirmation');

    // Weather and transit simulation intents
    const weatherIntent = classifyTaskSessionIntent('東京の天気を教えて');
    expect(weatherIntent?.intentId).toBe('weather-lookup');
    expect(weatherIntent?.payload?.location).toBe('東京');

    const transitIntent = classifyTaskSessionIntent('新宿から渋谷への電車の時間を教えて');
    expect(transitIntent?.intentId).toBe('transit-lookup');
    expect(transitIntent?.payload?.departure_station).toBe('新宿');
    expect(transitIntent?.payload?.arrival_station).toBe('渋谷');

    // Restaurant, News, and Email simulation intents
    const restaurantIntent = classifyTaskSessionIntent('渋谷の美味しいラーメン屋を調べて');
    expect(restaurantIntent?.intentId).toBe('restaurant-search');
    expect(restaurantIntent?.payload?.location).toBe('渋谷');
    expect(restaurantIntent?.payload?.genre).toBe('ラーメン');

    const newsIntent = classifyTaskSessionIntent('AI業界の最近の動向を要約して');
    expect(newsIntent?.intentId).toBe('news-summary');
    expect(newsIntent?.payload?.topic).toBe('AI');

    const emailIntent = classifyTaskSessionIntent('田中さんへの返信メールの下書きを作って');
    expect(emailIntent?.intentId).toBe('email-draft');
    expect(emailIntent?.payload?.recipient).toBe('田中さん');

    // New simulation intents: Calendar, Device, Reminder, Translation
    const calendarIntent = classifyTaskSessionIntent('明日10時のミーティングを登録して');
    expect(calendarIntent?.intentId).toBe('calendar-schedule');
    expect(calendarIntent?.payload?.date).toBe('明日');

    const deviceIntent = classifyTaskSessionIntent('エアコンをつけて');
    expect(deviceIntent?.intentId).toBe('device-control');
    expect(deviceIntent?.payload?.device_name).toBe('エアコン');
    expect(deviceIntent?.payload?.operation).toBe('オン');

    const reminderIntent = classifyTaskSessionIntent('買い物リストに牛乳を追加して');
    expect(reminderIntent?.intentId).toBe('reminder-task');
    expect(reminderIntent?.payload?.task_detail).toBe('牛乳');

    const translationIntent = classifyTaskSessionIntent('「こんにちは」を英語に翻訳して');
    expect(translationIntent?.intentId).toBe('translation-service');
    expect(translationIntent?.payload?.target_language).toBe('英語');

    expect(
      classifyTaskSessionIntent('過去の要件定義を横断的に見て横展開されていないバグを修正して')
        ?.intentId
    ).toBe('cross-project-remediation');
    expect(
      classifyTaskSessionIntent('過去の要件定義を横断的に見て横展開されていないバグを修正して')
        ?.taskType
    ).toBe('analysis');
    expect(
      classifyTaskSessionIntent('過去の要件定義を横断的に見て横展開されていないバグを修正して')
        ?.requirements?.missing || []
    ).toEqual([]);
    expect(
      classifyTaskSessionIntent('過去の要件定義を横断的に見て横展開されていないバグを修正して')
        ?.payload?.analysis_contract_id
    ).toBe('analysis.cross-project-remediation.v1');
    expect(
      classifyTaskSessionIntent('過去のインシデント結果を踏まえてレビューを実施して')?.intentId
    ).toBe('incident-informed-review');
    expect(
      classifyTaskSessionIntent('過去のインシデント結果を踏まえてレビューを実施して')?.taskType
    ).toBe('analysis');
    expect(
      classifyTaskSessionIntent('過去のインシデント結果を踏まえてレビューを実施して')?.requirements
        ?.missing || []
    ).toEqual([]);
    expect(
      classifyTaskSessionIntent('過去のインシデント結果を踏まえてレビューを実施して')?.payload
        ?.analysis_contract_id
    ).toBe('analysis.incident-informed-review.v1');
    expect(
      classifyTaskSessionIntent('このエージェントのハーネスを benchmark ベースで改善して')?.intentId
    ).toBe('evolve-agent-harness');
    expect(
      classifyTaskSessionIntent('このエージェントのハーネスを benchmark ベースで改善して')?.taskType
    ).toBe('analysis');
    expect(
      classifyTaskSessionIntent('このエージェントのハーネスを benchmark ベースで改善して')
        ?.requirements?.missing || []
    ).toEqual([]);
    expect(
      classifyTaskSessionIntent('このエージェントのハーネスを benchmark ベースで改善して')?.payload
        ?.analysis_contract_id
    ).toBe('analysis.evolve-agent-harness.v1');
    expect(classifyTaskSessionIntent('6/6-6/8で沖縄のホテルを探して')?.intentId).toBe(
      'lifestyle-booking'
    );
    expect(classifyTaskSessionIntent('6/6-6/8で沖縄のホテルを探して')?.taskType).toBe('analysis');
    expect(
      classifyTaskSessionIntent('6/6-6/8で沖縄のホテルを探して')?.payload?.booking_category
    ).toBe('hotel');
    expect(
      classifyTaskSessionIntent('6/6-6/8で沖縄のホテルを探して')?.requirements?.missing || []
    ).toContain('booking_path_preference');
    expect(classifyTaskSessionIntent('6/6-6/8で沖縄のホテルを探して')?.executionBrief?.kind).toBe(
      'actuator-execution-brief'
    );
    expect(
      classifyTaskSessionIntent('今夜のレストランを予約したい')?.payload?.booking_category
    ).toBe('restaurant');
    expect(classifyTaskSessionIntent('日用品をまとめて買って')?.payload?.booking_category).toBe(
      'shopping'
    );
    expect(classifyTaskSessionIntent('歯医者の予約を取りたい')?.payload?.booking_category).toBe(
      'medical'
    );
    expect(classifyTaskSessionIntent('家事代行を手配して')?.payload?.booking_category).toBe(
      'home_service'
    );
    expect(classifyTaskSessionIntent('子どもの習い事の送迎を調整したい')?.intentId).toBe(
      'lifestyle-booking'
    );
    expect(
      classifyTaskSessionIntent('子どもの習い事の送迎を調整したい')?.payload?.booking_category
    ).toBe('family');
    expect(classifyTaskSessionIntent('誕生日のギフトを手配して')?.payload?.booking_category).toBe(
      'gifts'
    );
    expect(classifyTaskSessionIntent('今夜のレストランを予約したい')?.intentId).toBe(
      'lifestyle-booking'
    );
    expect(classifyTaskSessionIntent('日用品をまとめて買って')?.intentId).toBe('lifestyle-booking');
    expect(classifyTaskSessionIntent('歯医者の予約を取りたい')?.intentId).toBe('lifestyle-booking');
    expect(classifyTaskSessionIntent('家事代行を手配して')?.intentId).toBe('lifestyle-booking');
    expect(classifyTaskSessionIntent('スケジュールを調整して')?.intentId).toBe(
      'schedule-coordination'
    );
    expect(classifyTaskSessionIntent('スケジュールを調整して')?.taskType).toBe('service_operation');
    expect(
      classifyTaskSessionIntent('スケジュールを調整して')?.requirements?.missing || []
    ).toEqual(['schedule_scope', 'date_range', 'fixed_constraints', 'calendar_action_boundary']);
    expect(classifyTaskSessionIntent('会議の日程を調整して')?.intentId).toBe(
      'schedule-coordination'
    );
    expect(classifyTaskSessionIntent('会議の日程を調整して')?.payload?.handoff_intent_id).toBe(
      'meeting-operations'
    );
  });

  it('derives task-session payload and requirements from governed policy', () => {
    const deck = classifyTaskSessionIntent('3枚の要約スライドを作って');
    expect(deck?.intentId).toBe('generate-presentation');
    expect(deck?.payload?.deck_purpose).toBe('proposal');
    expect(deck?.payload?.slide_count_hint).toBe(3);

    const marketingDeck = classifyTaskSessionIntent('営業資料をパワポで作って');
    expect(marketingDeck?.intentId).toBe('generate-presentation');
    expect(marketingDeck?.payload?.deck_purpose).toBe('marketing');
    expect(marketingDeck?.payload?.theme_hint).toBe('marketing_branded');

    expect(classifyTaskSessionIntent('社内共有のスライドを作って')?.intentId).toBe(
      'generate-presentation'
    );
    expect(classifyTaskSessionIntent('この要件定義を説明する資料を作って')?.intentId).toBe(
      'generate-presentation'
    );
    expect(classifyTaskSessionIntent('新機能の告知用スライドを作って')?.intentId).toBe(
      'generate-presentation'
    );

    const remediation = classifyTaskSessionIntent(
      '過去の要件定義を横断的に見て横展開されていないバグを修正して'
    );
    expect(remediation?.payload?.source_corpus).toBe('requirements');
    expect(remediation?.payload?.action_bias).toBe('remediation');
    expect(remediation?.requirements?.missing || []).toEqual([]);
  });

  it('emits task sessions that satisfy the schema', () => {
    const ajv = new Ajv({ allErrors: true });
    const schemaPath = path.join(
      pathResolver.rootDir(),
      'knowledge/product/schemas/task-session.schema.json'
    );
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
    const schemaPath = path.join(
      pathResolver.rootDir(),
      'knowledge/product/schemas/task-session-capture-photo.schema.json'
    );
    const validate = compileSchemaFromPath(ajv, schemaPath);
    const example = JSON.parse(
      safeReadFile(
        path.join(
          pathResolver.rootDir(),
          'knowledge/product/schemas/task-session-capture-photo.example.json'
        ),
        {
          encoding: 'utf8',
        }
      ) as string
    );

    expect(validate(example.payload), JSON.stringify(validate.errors || [])).toBe(true);
  });

  it('rejects invalid task-session-capture-photo payloads', () => {
    const ajv = new Ajv({ allErrors: true });
    const schemaPath = path.join(
      pathResolver.rootDir(),
      'knowledge/product/schemas/task-session-capture-photo.schema.json'
    );
    const validate = compileSchemaFromPath(ajv, schemaPath);

    expect(
      validate({
        device_preference: 'rear-camera',
        save_path: 'active/shared/tmp/photo.jpg',
      })
    ).toBe(false);
  });

  describe('fetch-external-data intent & provider resolution', () => {
    it('classifies "Yahoo Japanで秋葉原の天気を教えて" and resolves URL using provider catalog', () => {
      const utterance = 'Yahoo Japanで秋葉原の天気を教えて';
      const classified = classifyTaskSessionIntent(utterance);

      expect(classified).toBeTruthy();
      expect(classified?.intentId).toBe('fetch-external-data');
      expect(classified?.taskType).toBe('external_data_fetch');
      expect(classified?.payload?.source_url).toContain('search.yahoo.co.jp');
      expect(classified?.payload?.provider_id).toBe('yahoo-japan-search');
      expect(classified?.payload?.data_topic).toBe('天気 秋葉原');
    });

    it('classifies "天気を教えて" with source_url in missing requirements', () => {
      const utterance = '天気を教えて';
      const classified = classifyTaskSessionIntent(utterance);

      expect(classified).toBeTruthy();
      expect(classified?.intentId).toBe('fetch-external-data');
      expect(classified?.requirements?.missing).toContain('source_url');
    });
  });
});
