import path from 'node:path';
import AjvModule from 'ajv';
import { compileUserIntentFlow, summarizeRelevantIntents } from './intent-contract.js';
import { describe, expect, it } from 'vitest';
import {
  parseIntentResolutionContract,
  resolveIntentResolutionContract,
} from './intent-resolution-contract.js';
import { loadStandardIntentCatalog, type IntentResolutionPacket } from './intent-resolution.js';
import { classifyTaskSessionIntent, getTaskIntentBuilder } from './task-session.js';
import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import { t } from './t.js';

const Ajv = (AjvModule as any).default ?? AjvModule;

describe('intent-resolution-contract', () => {
  it('parses the transport contract and rejects malformed or polluted projections', () => {
    const contract = resolveIntentResolutionContract('動画を生成して');
    const parsed = parseIntentResolutionContract(JSON.parse(JSON.stringify(contract)));

    expect(parsed).toEqual(contract);
    expect(
      parseIntentResolutionContract({
        ...contract,
        authority_level: 'admin',
      })
    ).toBeUndefined();
    expect(
      parseIntentResolutionContract({
        ...contract,
        next_action: { ...contract.next_action, consequence: 42 },
      })
    ).toBeUndefined();
    expect(parseIntentResolutionContract({ ...contract, extra: 'leak' })).toBeUndefined();
  });

  it('copies nested arrays and objects so a surface cannot mutate the source payload', () => {
    const source = {
      ...resolveIntentResolutionContract('動画を生成して'),
      missing_inputs: ['approval_scope'],
      project_context: { project_id: 'PRJ-1', confidence: 0.8 },
    };
    const parsed = parseIntentResolutionContract(source);

    expect(parsed).toBeDefined();
    parsed?.missing_inputs.push('unexpected');
    if (parsed?.project_context) parsed.project_context.project_id = 'PRJ-2';
    expect(source.missing_inputs).toEqual(['approval_scope']);
    expect(source.project_context.project_id).toBe('PRJ-1');
  });

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

  it('sources next-action prose from the shared vocabulary catalog', () => {
    const clarification = resolveIntentResolutionContract('zzzzzzzzqqqq');
    expect(clarification.next_action.label).toBe(
      t('next_action:intent_resolution_provide_input', undefined, 'en')
    );
    expect(clarification.next_action.consequence).toBe(
      t('next_action:intent_resolution_provide_input_consequence', undefined, 'en')
    );

    const approval = resolveIntentResolutionContract('動画を生成して');
    expect(approval.next_action.label).toBe(
      t('next_action:intent_resolution_request_approval', undefined, 'en')
    );
    expect(approval.next_action.consequence).toBe(
      t('next_action:intent_resolution_request_approval_consequence', undefined, 'en')
    );

    const autonomous = resolveIntentResolutionContract('来週の予定教えて');
    expect(autonomous.next_action.label).toBe(
      t('next_action:intent_resolution_continue', undefined, 'en')
    );
    expect(autonomous.next_action.consequence).toBe(
      t('next_action:intent_resolution_continue_consequence', undefined, 'en')
    );
  });

  it('reuses an injected resolution packet when deriving task requirements', () => {
    const contract = resolveIntentResolutionContract('unrelated text', {
      packet: {
        kind: 'intent_resolution_packet',
        utterance: 'unrelated text',
        selected_intent_id: 'bootstrap-project',
        selected_confidence: 0.9,
        selected_resolution: {
          shape: 'project_bootstrap',
          result_shape: 'project_created',
        },
        candidates: [],
      },
    });

    expect(contract.normalized_intent).toBe('bootstrap-project');
    expect(contract.missing_inputs).toEqual(['project_brief']);
    expect(contract.authority_level).toBe('human_clarification_required');
  });

  it('uses the tier-resolved catalog when deriving authority from an injected packet', () => {
    const overlayPath = pathResolver.sharedTmp('intent-resolution-contract-overlay.json');
    const baseIntent = loadStandardIntentCatalog().find(
      (intent) => intent.id === 'knowledge-query'
    );
    expect(baseIntent, 'missing base knowledge-query intent').toBeTruthy();
    safeMkdir(path.dirname(overlayPath), { recursive: true });
    safeWriteFile(
      overlayPath,
      JSON.stringify({
        version: '1.0.0',
        intents: [{ ...baseIntent, risk_profile: 'approval_required' }],
      })
    );

    try {
      const contract = resolveIntentResolutionContract('mission authority を教えて', {
        tier: 'personal',
        overlayPaths: [overlayPath],
        packet: {
          kind: 'intent_resolution_packet',
          utterance: 'mission authority を教えて',
          selected_intent_id: 'knowledge-query',
          selected_confidence: 0.95,
          selected_resolution: { shape: 'direct_reply', result_shape: 'knowledge_answer' },
          candidates: [],
        },
      });

      expect(contract.authority_level).toBe('approval_required');
      expect(contract.next_action.kind).toBe('request_approval');
    } finally {
      safeRmSync(overlayPath, { force: true });
    }
  });

  it('uses the scoped catalog when deriving task-session fallback intents', () => {
    const overlayPath = pathResolver.sharedTmp('intent-resolution-task-session-overlay.json');
    const baseIntent = loadStandardIntentCatalog().find(
      (intent) => intent.id === 'monitor-service-health'
    );
    expect(baseIntent, 'missing base monitor-service-health intent').toBeTruthy();
    expect(getTaskIntentBuilder('monitor-service-health')).toBeUndefined();
    safeMkdir(path.dirname(overlayPath), { recursive: true });
    safeWriteFile(
      overlayPath,
      JSON.stringify({
        version: '1.0.0',
        intents: [
          {
            ...baseIntent,
            resolution: { ...(baseIntent?.resolution || {}), shape: 'direct_reply' },
          },
        ],
      })
    );

    const packet: IntentResolutionPacket = {
      kind: 'intent_resolution_packet',
      utterance: 'サービスの健全性を確認して',
      selected_intent_id: 'monitor-service-health',
      selected_confidence: 0.95,
      selected_resolution: { shape: 'task_session', result_shape: 'status_report' },
      candidates: [],
    };

    try {
      expect(
        classifyTaskSessionIntent('サービスの健全性を確認して', packet, {
          tier: 'personal',
          overlayPaths: [overlayPath],
        })
      ).toBeNull();
    } finally {
      safeRmSync(overlayPath, { force: true });
    }
  });

  it('passes overlay paths into packet resolution for ordinary contract calls', () => {
    const overlayPath = pathResolver.sharedTmp('intent-resolution-contract-selection-overlay.json');
    const baseIntent = loadStandardIntentCatalog().find(
      (intent) => intent.id === 'knowledge-query'
    );
    expect(baseIntent, 'missing base knowledge-query intent').toBeTruthy();
    safeMkdir(path.dirname(overlayPath), { recursive: true });
    safeWriteFile(
      overlayPath,
      JSON.stringify({
        version: '1.0.0',
        intents: [
          {
            ...baseIntent,
            trigger_keywords: [...(baseIntent?.trigger_keywords || []), 'zqxvcontractoverlay'],
            risk_profile: 'approval_required',
          },
        ],
      })
    );

    try {
      const contract = resolveIntentResolutionContract('zqxvcontractoverlay', {
        tier: 'personal',
        overlayPaths: [overlayPath],
      });

      expect(contract.normalized_intent).toBe('knowledge-query');
      expect(contract.authority_level).toBe('approval_required');
    } finally {
      safeRmSync(overlayPath, { force: true });
    }
  });

  it('uses the tier-resolved catalog when building the compiler intent summary', () => {
    const overlayPath = pathResolver.sharedTmp('intent-resolution-summary-overlay.json');
    const baseIntent = loadStandardIntentCatalog().find(
      (intent) => intent.id === 'knowledge-query'
    );
    expect(baseIntent, 'missing base knowledge-query intent').toBeTruthy();
    safeMkdir(path.dirname(overlayPath), { recursive: true });
    safeWriteFile(
      overlayPath,
      JSON.stringify({
        version: '1.0.0',
        intents: [{ ...baseIntent, intake_requirements: ['approval_scope'] }],
      })
    );

    try {
      const summary = summarizeRelevantIntents(
        'mission authority を教えて',
        {
          kind: 'intent_resolution_packet',
          utterance: 'mission authority を教えて',
          selected_intent_id: 'knowledge-query',
          selected_confidence: 0.95,
          selected_resolution: { shape: 'direct_reply', result_shape: 'knowledge_answer' },
          candidates: [
            {
              intent_id: 'knowledge-query',
              confidence: 0.95,
              source: 'catalog',
              matched_keywords: [],
              reasons: [],
            },
          ],
        },
        { tier: 'personal', overlayPaths: [overlayPath] }
      );

      expect(JSON.parse(summary.text)[0].intake_requirements).toContain('approval_scope');
    } finally {
      safeRmSync(overlayPath, { force: true });
    }
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
