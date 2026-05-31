import AjvModule from 'ajv';
import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';
import {
  loadStandardIntentCatalog,
  normalizeForTriggerMatch,
  resolveIntentResolutionPacket,
} from './intent-resolution.js';

const Ajv = (AjvModule as any).default ?? AjvModule;

describe('intent-resolution', () => {
  it('resolves implemented task-session and bootstrap intents from their first surface examples', () => {
    const intents = loadStandardIntentCatalog().filter((intent) =>
      [
        'bootstrap-project',
        'generate-presentation',
        'generate-report',
        'generate-workbook',
        'inspect-service',
        'generate-video',
        'transcribe-audio',
        'live-voice',
        'launch-first-run-onboarding',
        'configure-organization-toolchain',
        'register-presentation-preference-profile',
        'meeting-operations',
        'cross-project-remediation',
        'incident-informed-review',
        'evolve-agent-harness',
      ].includes(String(intent.id))
    );

    for (const intent of intents) {
      const sample = intent.surface_examples?.[0];
      expect(sample, `missing surface example for ${intent.id}`).toBeTruthy();
      const packet = resolveIntentResolutionPacket(String(sample));
      expect(packet.selected_intent_id, `failed to resolve ${intent.id}`).toBe(intent.id);
      expect(packet.selected_confidence || 0, `low confidence for ${intent.id}`).toBeGreaterThan(
        0.45
      );
    }
  });

  it('keeps service operations and document intents bound to their catalog resolution', () => {
    const servicePacket = resolveIntentResolutionPacket('voice-hub を再起動して');
    expect(servicePacket.selected_intent_id).toBe('inspect-service');
    expect(servicePacket.selected_resolution?.task_kind).toBe('service_operation');

    const reportPacket = resolveIntentResolutionPacket('今週の進捗レポートを docx で作って');
    expect(reportPacket.selected_intent_id).toBe('generate-report');
    expect(reportPacket.selected_resolution?.task_kind).toBe('report_document');
  });

  it('resolves knowledge lookup and browser navigation as first-class direct paths', () => {
    const knowledgePacket = resolveIntentResolutionPacket('mission authority を教えて');
    expect(knowledgePacket.selected_intent_id).toBe('knowledge-query');
    expect(knowledgePacket.selected_resolution?.result_shape).toBe('knowledge_answer');

    const openSitePacket = resolveIntentResolutionPacket('Open OpenAI docs');
    expect(openSitePacket.selected_intent_id).toBe('open-site');
    expect(openSitePacket.selected_resolution?.shape).toBe('browser_session');
    expect(openSitePacket.bundle_candidates?.[0]?.bundle_id).toBe('browser-exploration-governed');

    const browserStepPacket = resolveIntentResolutionPacket('左下の承認ボタンを押して');
    expect(browserStepPacket.selected_intent_id).toBe('browser-step');
    expect(browserStepPacket.selected_resolution?.shape).toBe('browser_session');
  });

  it('infers platform ids for messaging bridge setup intents', () => {
    const slackPacket = resolveIntentResolutionPacket('Slackと連携して');
    expect(slackPacket.selected_intent_id).toBe('setup-messaging-bridge');
    expect(slackPacket.selected_parameters?.platform_id).toBe('slack');

    const imessagePacket = resolveIntentResolutionPacket('iMessageの連携を設定して');
    expect(imessagePacket.selected_intent_id).toBe('setup-messaging-bridge');
    expect(imessagePacket.selected_parameters?.platform_id).toBe('imessage');

    const telegramPacket = resolveIntentResolutionPacket('Telegram連携を設定して');
    expect(telegramPacket.selected_intent_id).toBe('setup-messaging-bridge');
    expect(telegramPacket.selected_parameters?.platform_id).toBe('telegram');
  });

  it('resolves Kyberion expansion and service lifecycle intents', () => {
    const cases = [
      ['Kyberionの実行環境を初期化して', 'bootstrap-kyberion-runtime', 'environment_bootstrapped'],
      ['環境の準備状態を確認して', 'verify-environment-readiness', 'environment_readiness_report'],
      ['初回セットアップを始めて', 'launch-first-run-onboarding', 'onboarding_plan'],
      ['推論バックエンドを設定して', 'configure-reasoning-backend', 'reasoning_backend_configured'],
      ['CI/CDを設定して', 'configure-organization-toolchain', 'organization_toolchain_configured'],
      ['デザインテーマを登録して', 'register-presentation-preference-profile', 'presentation_preference_profile_registered'],
      ['Kyberionのベースライン状態を確認して', 'check-kyberion-baseline', 'kyberion_baseline_status'],
      ['Kyberionのvitalを確認して', 'check-kyberion-vital', 'kyberion_vital_status'],
      ['Kyberionを診断して', 'diagnose-kyberion-system', 'kyberion_diagnostics_report'],
      ['runtime supervisorの状態を確認して', 'inspect-runtime-supervisor', 'runtime_supervisor_summary'],
      ['サービスを起動して', 'start-service', 'service_started'],
      ['サービスを停止して', 'stop-service', 'service_stopped'],
      ['新しいadapterを追加して', 'register-actuator-adapter', 'actuator_adapter_registered'],
    ] as const;

    for (const [sample, intentId, resultShape] of cases) {
      const packet = resolveIntentResolutionPacket(sample);
      expect(packet.selected_intent_id, `failed to resolve ${intentId}`).toBe(intentId);
      expect(packet.selected_resolution?.result_shape, `wrong result shape for ${intentId}`).toBe(
        resultShape
      );
      expect(packet.selected_confidence || 0, `low confidence for ${intentId}`).toBeGreaterThan(
        0.45
      );
    }
  });

  it('resolves meeting operations as a first-class surface intent', () => {
    const packet = resolveIntentResolutionPacket(
      'Teamsで開催されるオンラインミーティングに私の代わりに参加して無事成功させる'
    );
    expect(packet.selected_intent_id).toBe('meeting-operations');
    expect(packet.selected_resolution?.task_kind).toBe('meeting_operations');
    expect(packet.bundle_candidates?.[0]?.bundle_id).toBe('meeting-operations-governed');
  });

  it('resolves video generation, transcription, and live voice as first-class surface intents', () => {
    const videoPacket = resolveIntentResolutionPacket('動画を生成して');
    expect(videoPacket.selected_intent_id).toBe('generate-video');
    expect(videoPacket.selected_resolution?.shape).toBe('pipeline');

    const transcriptPacket = resolveIntentResolutionPacket('この音声を書き起こして');
    expect(transcriptPacket.selected_intent_id).toBe('transcribe-audio');
    expect(transcriptPacket.selected_resolution?.shape).toBe('pipeline');

    const liveVoicePacket = resolveIntentResolutionPacket('ライブ音声で会話したい');
    expect(liveVoicePacket.selected_intent_id).toBe('live-voice');
    expect(liveVoicePacket.selected_resolution?.task_kind).toBe('voice_conversation');
  });

  it('resolves generic schedule adjustments as a first-class surface intent', () => {
    const packet = resolveIntentResolutionPacket('スケジュールを調整して');
    expect(packet.selected_intent_id).toBe('schedule-coordination');
    expect(packet.selected_resolution?.task_kind).toBe('service_operation');
  });

  it('routes read-only calendar agenda requests away from schedule mutation', () => {
    const packet = resolveIntentResolutionPacket('来週の予定教えて');
    expect(packet.selected_intent_id).toBe('schedule-read-agenda');
    expect(packet.selected_resolution?.shape).toBe('direct_reply');
    expect(packet.selected_resolution?.result_shape).toBe('calendar_agenda_summary');
  });

  it('resolves human-LLM conversation intents as first-class direct replies', () => {
    const cases = [
      ['不足している情報を質問して', 'clarify-user-request', 'clarification_packet'],
      ['続けて', 'continue-conversation', 'conversation_reply'],
      ['ここまでを要約して', 'summarize-conversation', 'conversation_summary'],
      ['この会話をミッションにして', 'conversation-to-mission', 'mission_brief']
    ] as const;

    for (const [sample, intentId, resultShape] of cases) {
      const packet = resolveIntentResolutionPacket(sample);
      expect(packet.selected_intent_id, `failed to resolve ${intentId}`).toBe(intentId);
      expect(packet.selected_resolution?.result_shape, `wrong result shape for ${intentId}`).toBe(
        resultShape
      );
      expect(packet.selected_confidence || 0, `low confidence for ${intentId}`).toBeGreaterThan(
        0.45
      );
    }
  });

  it('resolves ringi approval requests and approval resolution intents from surface phrasing', () => {
    const resolvePacket = resolveIntentResolutionPacket('稟議の決裁しておいて');
    expect(resolvePacket.selected_intent_id).toBe('resolve-approval');
    expect(resolvePacket.selected_resolution?.shape).toBe('task_session');
    expect(resolvePacket.selected_resolution?.result_shape).toBe('summary');

    const voiceInputPacket = resolveIntentResolutionPacket('音声入力にして');
    expect(voiceInputPacket.selected_intent_id).toBe('enable-voice-input');
    expect(voiceInputPacket.selected_resolution?.shape).toBe('task_session');
    expect(voiceInputPacket.selected_resolution?.result_shape).toBe('summary');

    const requestPacket = resolveIntentResolutionPacket('承認を依頼して');
    expect(requestPacket.selected_intent_id).toBe('request-approval');
    expect(requestPacket.selected_resolution?.shape).toBe('task_session');
  });

  it('resolves CEO/CTO operator harness intents from simulated requests', () => {
    const cases = [
      ['今期の成長戦略を3案で比較して、最も現実的な案を提案して', 'executive-strategy-brief', 'strategy_brief'],
      ['次の四半期にやることを5つに絞って、やらないことも決めて', 'executive-prioritization', 'priority_roadmap'],
      ['今月の経営会議向けにKPIサマリを1枚でまとめて', 'executive-reporting', 'executive_report'],
      ['役員会向けに社員向けメッセージのたたき台を作って', 'stakeholder-communication', 'stakeholder_message'],
      ['大口顧客のアップセル戦略を整理して、提案の切り口を出して', 'sales-account-strategy', 'account_strategy_plan'],
      ['この投資判断の技術面を整理して、採用可否を1枚でまとめて', 'technical-decision-memo', 'technical_decision_memo'],
      ['OpenAI / Anthropic / Gemini のどれを使うべきか、コストと品質で比較して', 'llm-provider-selection', 'provider_selection_report'],
      ['エージェントの起動数とメモリ上限を調整して、遅延を半分にして', 'agent-runtime-tuning', 'runtime_tuning_plan'],
      ['明日のデプロイをgo/no-go判定して、条件付きなら条件も出して', 'release-readiness-review', 'release_readiness_report'],
      ['承認を依頼して', 'request-approval', 'summary'],
      ['承認依頼を解決して', 'resolve-approval', 'summary'],
      ['CEO/CTOとしての使い方にKyberionを最適化して', 'operator-profile-learning', 'operator_learning_update'],
    ] as const;

    for (const [sample, intentId, resultShape] of cases) {
      const packet = resolveIntentResolutionPacket(sample);
      expect(packet.selected_intent_id, `failed to resolve ${intentId}`).toBe(intentId);
      expect(packet.selected_resolution?.result_shape, `wrong result shape for ${intentId}`).toBe(
        resultShape
      );
      expect(packet.selected_confidence || 0, `low confidence for ${intentId}`).toBeGreaterThan(
        0.45
      );
    }
  });

  it('routes meeting date changes through schedule coordination first', () => {
    const packet = resolveIntentResolutionPacket('会議の日程を調整して');
    expect(packet.selected_intent_id).toBe('schedule-coordination');
    expect(packet.selected_resolution?.task_kind).toBe('service_operation');
  });

  it('catalogs capture-photo as a first-class surface intent', () => {
    const packet = resolveIntentResolutionPacket('ちょっと写真をとって');
    expect(packet.selected_intent_id).toBe('capture-photo');
    expect(packet.candidates[0]?.source).not.toBe('legacy');
    expect(packet.selected_resolution?.task_kind).toBe('capture_photo');
  });

  it('emits packets that satisfy the intent-resolution schema', () => {
    const ajv = new Ajv({ allErrors: true });
    const schemaPath = pathResolver.knowledge(
      'public/schemas/intent-resolution-packet.schema.json'
    );
    const validate = compileSchemaFromPath(ajv, schemaPath);
    const packet = resolveIntentResolutionPacket(
      'このエージェントのハーネスを benchmark ベースで改善して'
    );
    const valid = validate(packet);
    expect(valid, JSON.stringify(validate.errors || [])).toBe(true);
  });

  it('applies governed confidence threshold and legacy fallback policy', () => {
    const packet = resolveIntentResolutionPacket('voice-hub の状態とログを見せて');
    expect(packet.selected_intent_id).toBe('inspect-service');
    expect(packet.selected_confidence || 0).toBeGreaterThan(0.45);
    expect(
      packet.candidates.some((candidate) =>
        candidate.reasons.includes('service operation heuristic')
      )
    ).toBe(true);
  });
});

describe('normalizeForTriggerMatch', () => {
  it('converts full-width ASCII to half-width', () => {
    expect(normalizeForTriggerMatch('ＡＩ')).toBe('ai');
    expect(normalizeForTriggerMatch('Ｓｌａｃｋ')).toBe('slack');
  });

  it('converts katakana to hiragana', () => {
    expect(normalizeForTriggerMatch('スラック')).toBe('すらっく');
    expect(normalizeForTriggerMatch('テレグラム')).toBe('てれぐらむ');
  });

  it('applies standard lowercasing and whitespace normalization', () => {
    expect(normalizeForTriggerMatch('  Slack  ')).toBe('slack');
    expect(normalizeForTriggerMatch('MEETING URL')).toBe('meeting url');
  });

  it('handles mixed full-width and regular characters', () => {
    const result = normalizeForTriggerMatch('スラックSlack');
    expect(result).toContain('slack');
  });

  it('returns empty string for empty input', () => {
    expect(normalizeForTriggerMatch('')).toBe('');
  });
});
