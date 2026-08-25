import path from 'node:path';
import AjvModule from 'ajv';
import { compileUserIntentFlow } from './intent-contract.js';
import { describe, expect, it } from 'vitest';
import { resolveIntentResolutionContract } from './intent-resolution-contract.js';
import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';

const Ajv = (AjvModule as any).default ?? AjvModule;

describe('intent-resolution-contract', () => {
  it('resolves core surface intents into deterministic shapes', () => {
    const fixtures: Array<{
      utterance: string;
      shape: string;
      outcomeKind: string;
      authority: string;
      missingInputs?: string[];
    }> = [
      {
        utterance: 'Webサービスを作って',
        shape: 'project_bootstrap',
        outcomeKind: 'answer',
        authority: 'human_clarification_required',
        missingInputs: ['project_brief'],
      },
      {
        utterance: 'このPDFをパワポにして',
        shape: 'task_session',
        outcomeKind: 'artifact',
        authority: 'autonomous',
      },
      {
        utterance: '今週の進捗レポートを作って',
        shape: 'task_session',
        outcomeKind: 'artifact',
        authority: 'autonomous',
      },
      {
        utterance: 'プロジェクトのWBSをエクセルで作って',
        shape: 'task_session',
        outcomeKind: 'artifact',
        authority: 'autonomous',
      },
      {
        utterance: 'voice-hub の状態を見て',
        shape: 'task_session',
        outcomeKind: 'status_report',
        authority: 'approval_required',
      },
      {
        utterance: '日経新聞を開いて',
        shape: 'task_session',
        outcomeKind: 'status_report',
        authority: 'autonomous',
      },
      {
        utterance: '左下の承認ボタンを押して',
        shape: 'task_session',
        outcomeKind: 'status_report',
        authority: 'autonomous',
      },
      {
        utterance: '6/6-6/8で沖縄のホテルを探して',
        shape: 'task_session',
        outcomeKind: 'approval_ready_plan',
        authority: 'approval_required',
      },
      {
        utterance: '動画を生成して',
        shape: 'task_session',
        outcomeKind: 'artifact',
        authority: 'approval_required',
      },
      {
        utterance: '今夜のレストランを予約したい',
        shape: 'task_session',
        outcomeKind: 'approval_ready_plan',
        authority: 'approval_required',
      },
      {
        utterance: '歯医者の予約を取りたい',
        shape: 'task_session',
        outcomeKind: 'approval_ready_plan',
        authority: 'approval_required',
      },
      {
        utterance: 'mission authority を教えて',
        shape: 'direct_answer',
        outcomeKind: 'answer',
        authority: 'autonomous',
      },
      {
        utterance: '今日の天気を教えて',
        shape: 'direct_answer',
        outcomeKind: 'answer',
        authority: 'autonomous',
      },
      {
        utterance: '来週の予定教えて',
        shape: 'direct_answer',
        outcomeKind: 'status_report',
        authority: 'autonomous',
      },
      {
        utterance: 'このエージェントのハーネスを benchmark ベースで改善して',
        shape: 'task_session',
        outcomeKind: 'answer',
        authority: 'human_clarification_required',
        missingInputs: ['target harness', 'evaluation corpus or benchmark', 'success metric'],
      },
    ];

    for (const fixture of fixtures) {
      const contract = resolveIntentResolutionContract(fixture.utterance);
      expect(contract.resolution_shape, fixture.utterance).toBe(fixture.shape);
      expect(contract.outcome_kind, fixture.utterance).toBe(fixture.outcomeKind);
      expect(contract.missing_inputs, fixture.utterance).toEqual(fixture.missingInputs || []);
      expect(contract.authority_level, fixture.utterance).toBe(fixture.authority);
      expect(contract.next_action.kind, fixture.utterance).toBe(
        fixture.authority === 'approval_required'
          ? 'request_approval'
          : fixture.authority === 'human_clarification_required'
            ? 'provide_input'
            : 'continue'
      );
    }
  });

  it('requires clarification when intent cannot be resolved', () => {
    const contract = resolveIntentResolutionContract('zzzzzzzzqqqq');
    expect(contract.normalized_intent).toBe('unresolved_intent');
    expect(contract.missing_inputs.length).toBeGreaterThan(0);
    expect(contract.authority_level).toBe('human_clarification_required');
    expect(contract.resolution_shape).toBe('direct_answer');
    expect(contract.next_action.kind).toBe('provide_input');
  });

  it('emits contracts that satisfy the schema', () => {
    const ajv = new Ajv({ allErrors: true });
    const schemaPath = path.join(
      pathResolver.rootDir(),
      'knowledge/product/schemas/intent-resolution.schema.json'
    );
    const validate = compileSchemaFromPath(ajv, schemaPath);
    const contract = resolveIntentResolutionContract('今週の進捗レポートを作って');
    const valid = validate(contract);
    expect(valid, JSON.stringify(validate.errors || [])).toBe(true);
  });

  it('converges the surface preview with the deterministic compiler fallback', async () => {
    const fixtures = [
      {
        utterance: 'Webサービスを作って',
        intent: 'bootstrap-project',
        missing: ['project_brief'],
        clarification: true,
      },
      {
        utterance: '6/6-6/8で沖縄のホテルを探して',
        intent: 'lifestyle-booking',
        missing: [],
        clarification: false,
      },
      {
        utterance: 'zzzzzzzzqqqq',
        intent: 'unresolved_intent',
        missing: ['intent_or_goal'],
        clarification: true,
      },
    ];

    for (const fixture of fixtures) {
      const preview = resolveIntentResolutionContract(fixture.utterance);
      const flow = await compileUserIntentFlow(
        { text: fixture.utterance, correlationId: `contract-${fixture.intent}` },
        { askFn: async () => 'not json' }
      );

      expect(preview.normalized_intent, fixture.utterance).toBe(fixture.intent);
      expect(preview.missing_inputs, fixture.utterance).toEqual(fixture.missing);
      expect(flow.intentContract.intent_id, fixture.utterance).toBe(
        fixture.intent === 'unresolved_intent' ? 'general-request' : fixture.intent
      );
      expect(flow.intentContract.required_inputs, fixture.utterance).toEqual(
        fixture.intent === 'unresolved_intent' ? ['goal_or_target'] : fixture.missing
      );
      expect(Boolean(flow.clarificationPacket), fixture.utterance).toBe(fixture.clarification);
    }
  });
});
