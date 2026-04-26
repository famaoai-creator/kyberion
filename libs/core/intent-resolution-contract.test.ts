import path from 'node:path';
import AjvModule from 'ajv';
import { describe, expect, it } from 'vitest';
import { resolveIntentResolutionContract } from './intent-resolution-contract.js';
import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';

const Ajv = (AjvModule as any).default ?? AjvModule;

describe('intent-resolution-contract', () => {
  it('resolves core surface intents into deterministic shapes', () => {
    const fixtures: Array<{ utterance: string; shape: string; outcomeKind: string; authority: string }> = [
      { utterance: 'Webサービスを作って', shape: 'project_bootstrap', outcomeKind: 'answer', authority: 'autonomous' },
      { utterance: 'このPDFをパワポにして', shape: 'task_session', outcomeKind: 'artifact', authority: 'autonomous' },
      { utterance: '今週の進捗レポートを作って', shape: 'task_session', outcomeKind: 'artifact', authority: 'autonomous' },
      { utterance: 'プロジェクトのWBSをエクセルで作って', shape: 'task_session', outcomeKind: 'artifact', authority: 'autonomous' },
      { utterance: 'voice-hub の状態を見て', shape: 'task_session', outcomeKind: 'status_report', authority: 'approval_required' },
      { utterance: '日経新聞を開いて', shape: 'task_session', outcomeKind: 'status_report', authority: 'autonomous' },
      { utterance: '左下の承認ボタンを押して', shape: 'task_session', outcomeKind: 'status_report', authority: 'autonomous' },
      { utterance: 'mission authority を教えて', shape: 'direct_answer', outcomeKind: 'answer', authority: 'autonomous' },
      { utterance: '今日の天気を教えて', shape: 'direct_answer', outcomeKind: 'answer', authority: 'autonomous' },
      { utterance: 'このエージェントのハーネスを benchmark ベースで改善して', shape: 'task_session', outcomeKind: 'answer', authority: 'autonomous' },
    ];

    for (const fixture of fixtures) {
      const contract = resolveIntentResolutionContract(fixture.utterance);
      expect(contract.resolution_shape, fixture.utterance).toBe(fixture.shape);
      expect(contract.outcome_kind, fixture.utterance).toBe(fixture.outcomeKind);
      expect(contract.missing_inputs.length, fixture.utterance).toBe(0);
      expect(contract.authority_level, fixture.utterance).toBe(fixture.authority);
    }
  });

  it('requires clarification when intent cannot be resolved', () => {
    const contract = resolveIntentResolutionContract('zzzzzzzzqqqq');
    expect(contract.normalized_intent).toBe('unresolved_intent');
    expect(contract.missing_inputs.length).toBeGreaterThan(0);
    expect(contract.authority_level).toBe('human_clarification_required');
    expect(contract.resolution_shape).toBe('direct_answer');
  });

  it('emits contracts that satisfy the schema', () => {
    const ajv = new Ajv({ allErrors: true });
    const schemaPath = path.join(pathResolver.rootDir(), 'schemas/intent-resolution.schema.json');
    const validate = compileSchemaFromPath(ajv, schemaPath);
    const contract = resolveIntentResolutionContract('今週の進捗レポートを作って');
    const valid = validate(contract);
    expect(valid, JSON.stringify(validate.errors || [])).toBe(true);
  });
});
