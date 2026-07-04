import { describe, expect, it, vi } from 'vitest';
import {
  resolveQuestionInteractionPacket,
  resolveQuestionResolution,
} from './question-resolver.js';

vi.mock('./core.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

describe('question-resolver', () => {
  it('resolves meeting operations questions from policy and intent requirements', () => {
    const result = resolveQuestionResolution({
      text: 'この会議に参加して',
      intentId: 'meeting-operations',
      executionShape: 'task_session',
      confidence: 0.6,
    });

    expect(result.kind).toBe('question-resolution-packet');
    expect(result.should_clarify).toBe(true);
    expect(result.missing_inputs).toEqual(
      expect.arrayContaining(['meeting_url', 'meeting_role_boundary'])
    );
    expect(result.questions.map((item) => item.id)).toEqual([
      'meeting_purpose',
      'meeting_url',
      'meeting_role_boundary',
    ]);
    expect(result.sources).toEqual(
      expect.arrayContaining(['standard-intent-catalog', 'meeting-operations intake'])
    );
  });

  it('builds a clarification packet for presentation generation', () => {
    const packet = resolveQuestionInteractionPacket({
      text: 'この要件定義を説明する資料を作って',
      intentId: 'generate-presentation',
      executionShape: 'pipeline',
      confidence: 0.7,
    });

    expect(packet).toBeTruthy();
    expect(packet?.interaction_type).toBe('clarification');
    expect(packet?.questions?.map((item) => item.id)).toEqual([
      'deck_purpose',
      'audience',
      'source_material',
    ]);
    expect(packet?.llm_touchpoints?.[0]?.stage).toBe('question_resolution');
  });

  it('renders clarification text in Japanese when locale is ja', () => {
    const packet = resolveQuestionInteractionPacket({
      text: '会議の準備をして',
      requiredInputs: ['meeting_url'],
      executionShape: 'task_session',
      confidence: 0.3,
      locale: 'ja',
      maxQuestions: 1,
    });

    expect(packet?.headline).toBe('実行前に追加の確認が必要です');
    expect(packet?.summary).toBe('実行を続ける前に入力内容の確認が必要です。');
    expect(packet?.questions?.[0]?.question).toBe('meeting url を確認してください。');
    expect(packet?.questions?.[0]?.reason).toBe(
      '不足している入力は確認しきい値を超えています(1 > 1)'
    );
  });

  it('renders clarification text in English by default', () => {
    const packet = resolveQuestionInteractionPacket({
      text: 'Prepare the meeting',
      requiredInputs: ['meeting_url'],
      executionShape: 'task_session',
      confidence: 0.3,
      locale: 'en',
      maxQuestions: 1,
    });

    expect(packet?.headline).toBe('More context is required before execution');
    expect(packet?.summary).toBe(
      'The request needs clarification before Kyberion can proceed safely.'
    );
    expect(packet?.questions?.[0]?.question).toBe('Please confirm meeting url.');
    expect(packet?.questions?.[0]?.reason).toBe(
      'Missing inputs remain above the clarification threshold (1 > 1).'
    );
  });

  it('tracks omitted clarification questions when maxQuestions truncates the packet', () => {
    const result = resolveQuestionResolution({
      text: '会議の準備をして',
      intentId: 'meeting-operations',
      executionShape: 'task_session',
      confidence: 0.4,
      maxQuestions: 1,
    });

    expect(result.questions).toHaveLength(1);
    expect(result.omitted_question_count).toBeGreaterThan(0);

    const packet = resolveQuestionInteractionPacket({
      text: '会議の準備をして',
      intentId: 'meeting-operations',
      executionShape: 'task_session',
      confidence: 0.4,
      maxQuestions: 1,
    });

    expect(packet?.missing_inputs).toEqual(result.missing_inputs);
    expect(packet?.omitted_question_count).toBe(result.omitted_question_count);
  });

  it('logs omitted clarification questions when truncation happens', async () => {
    const { logger } = await import('./core.js');
    resolveQuestionResolution({
      text: '会議の準備をして',
      intentId: 'meeting-operations',
      executionShape: 'task_session',
      confidence: 0.4,
      maxQuestions: 1,
    });

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('[question-resolver] omitted 2 clarification question(s)')
    );
  });

  it('does not require clarification when the intent is already clear', () => {
    const packet = resolveQuestionInteractionPacket({
      text: '今週の進捗レポートを作って',
      intentId: 'generate-report',
      executionShape: 'task_session',
      confidence: 0.95,
    });

    expect(packet).toBeUndefined();
  });
});
