import { beforeEach, describe, it, expect, vi } from 'vitest';

vi.mock('../core.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../secure-io.js', () => ({
  safeExistsSync: () => false,
  safeReadFile: () => '[]',
}));

const mocks = vi.hoisted(() => ({
  catalog: [] as unknown[],
  resolveRoutingPacket: vi.fn(),
}));

vi.mock('./intent-resolution.js', () => ({
  loadStandardIntentCatalog: () => mocks.catalog,
}));

vi.mock('./intent-resolver-entry.js', () => ({
  resolveRoutingPacket: mocks.resolveRoutingPacket,
}));

import type { RoutingDecision } from '../contracts/routing-decision.js';
import { compileIntent, buildPipelineGenerationPrompt } from './intent-compiler.js';

/** A carried decision selecting `intentId`; the compiler must not re-resolve. */
function carried(intentId: string | undefined, confidence = 0.9): RoutingDecision {
  return {
    kind: 'routing_decision',
    ...(intentId ? { intent_id: intentId } : {}),
    confidence,
    execution_shape: 'pipeline',
    authority_level: 'autonomous',
    delivery_mode: 'one_shot',
    promotion: {
      required: false,
      execution_shape: 'pipeline',
      reasons: [],
      matched_rule_ids: [],
      policy_version: 'test',
    },
  };
}

describe('intent-compiler', () => {
  const standardIntents = [
    {
      id: 'take-screenshot',
      triggers: ['screenshot', 'capture screen'],
      pipeline: {
        steps: [
          { id: 'goto', op: 'goto', params: { url: '{{url}}' } },
          { id: 'capture', op: 'screenshot', params: { path: '{{output}}' } },
        ],
      },
    },
    {
      id: 'health-check',
      triggers: ['health', 'status check'],
      pipeline: {
        steps: [{ id: 'check', op: 'evaluate', params: { expression: 'true' } }],
      },
    },
    {
      id: 'meeting-operations',
      triggers: ['meeting', 'Teams', 'Zoom', 'ミーティング'],
      pipeline: [
        {
          id: 'meeting-guard',
          op: 'core:if',
          params: {
            condition: { from: 'meeting_url', operator: 'exists' },
            then: [
              {
                op: 'system:log',
                params: {
                  message: 'meeting-operations ready',
                },
              },
            ],
          },
        },
      ],
    },
    {
      id: 'live-voice',
      triggers: ['live voice', 'voice conversation', '会話', '音声対話'],
      pipeline: [
        {
          id: 'live-voice-smoke',
          op: 'system:shell',
          params: {
            cmd: 'node dist/scripts/run_pipeline.js --input pipelines/live-voice-smoke.json',
          },
        },
      ],
    },
    {
      id: 'clone-my-voice',
      triggers: ['クローン', '録音', 'register', 'clone', 'voice clone', '使えるようにして'],
      pipeline: [
        {
          id: 'clone-voice',
          op: 'system:shell',
          params: {
            cmd: 'node dist/scripts/run_pipeline.js --input pipelines/clone-my-voice.json',
          },
        },
      ],
    },
    {
      id: 'start-service',
      triggers: ['start service', 'start', '起動', '立ち上げて'],
      pipeline: [
        {
          id: 'start-service-list',
          op: 'system:shell',
          params: {
            cmd: 'node dist/scripts/service/service_lifecycle_control.js --operation start',
          },
        },
      ],
    },
    {
      id: 'stop-service',
      triggers: ['stop service', 'stop', '停止', '止めて'],
      pipeline: [
        {
          id: 'stop-service-list',
          op: 'system:shell',
          params: {
            cmd: 'node dist/scripts/service/service_lifecycle_control.js --operation list',
          },
        },
      ],
    },
  ];

  describe('compileIntent', () => {
    beforeEach(() => {
      mocks.catalog = standardIntents;
      mocks.resolveRoutingPacket.mockReset();
      mocks.resolveRoutingPacket.mockReturnValue({ selected_intent_id: undefined });
    });

    it('returns null when the resolver selects nothing and no hint matches', () => {
      const result = compileIntent('do something completely unrelated xyz', {
        knowledgeHints: [],
      });

      expect(result).toBeNull();
      expect(mocks.resolveRoutingPacket).toHaveBeenCalledTimes(1);
    });

    it('selects only through the resolver: a catalog trigger word alone no longer matches', () => {
      // Before R3 an explicit catalog matched 'screenshot' by keyword (0.8).
      expect(compileIntent('I need to take a screenshot of the page')).toBeNull();
    });

    it('compiles the resolver-selected intent with its confidence', () => {
      mocks.resolveRoutingPacket.mockReturnValue({
        selected_intent_id: 'take-screenshot',
        selected_confidence: 0.83,
      });
      const result = compileIntent('I need to take a screenshot of the page');

      expect(result).not.toBeNull();
      expect(result!.confidence).toBe(0.83);
      expect(result!.source).toBe('template');
      expect(result!.intentId).toBe('take-screenshot');
      expect(result!.steps.length).toBeGreaterThan(0);
    });

    it('acts on a carried decision without re-resolving', () => {
      const result = compileIntent('anything', { routingDecision: carried('health-check', 0.7) });
      expect(result?.intentId).toBe('health-check');
      expect(result?.confidence).toBe(0.7);
      expect(mocks.resolveRoutingPacket).not.toHaveBeenCalled();
    });

    it('matches knowledge hints with confidence 0.6', () => {
      const knowledgeHints = [
        { topic: 'pdf generation', hint: 'Use media actuator for PDF', tags: ['pdf', 'media'] },
      ];

      const result = compileIntent('generate a pdf report', { knowledgeHints });

      expect(result).not.toBeNull();
      expect(result!.confidence).toBe(0.6);
      expect(result!.source).toBe('hint');
      expect(result!.steps).toEqual([]); // hints don't produce steps
      expect(result!.warnings).toBeDefined();
    });

    it('matches knowledge hints from a spaceless Japanese intent', () => {
      const knowledgeHints = [
        { topic: '請求書', hint: 'Use the invoice template', tags: ['経理'] },
      ];
      // Whitespace split kept '請求書を作成して' as one word that no topic contains.
      const result = compileIntent('請求書を作成して', { knowledgeHints });
      expect(result?.source).toBe('hint');
      expect(result?.confidence).toBe(0.6);
      // Particles shared with an unrelated topic do not count.
      expect(
        compileIntent('メールを送って', {
          knowledgeHints: [{ topic: '予定を確認', tags: [] }],
        })
      ).toBeNull();
    });

    it('synthesizes a deterministic meeting orchestration step', () => {
      const result = compileIntent(
        'Teamsで開催されるオンラインミーティングに私の代わりに参加して無事成功させる',
        { routingDecision: carried('meeting-operations') }
      );

      expect(result).not.toBeNull();
      expect(result!.intentId).toBe('meeting-operations');
      expect(result!.steps.some((step) => step.op === 'core:if')).toBe(true);
    });

    it('synthesizes deterministic live voice and voice clone steps', () => {
      const liveVoiceResult = compileIntent('ライブ音声で会話したい', {
        routingDecision: carried('live-voice'),
      });
      expect(liveVoiceResult).not.toBeNull();
      expect(liveVoiceResult!.intentId).toBe('live-voice');
      expect(liveVoiceResult!.steps[0]?.params?.cmd).toContain('pipelines/live-voice-smoke.json');

      const cloneVoiceResult = compileIntent('自分の声を使えるようにして', {
        routingDecision: carried('clone-my-voice'),
      });
      expect(cloneVoiceResult).not.toBeNull();
      expect(cloneVoiceResult!.intentId).toBe('clone-my-voice');
      expect(cloneVoiceResult!.steps[0]?.params?.cmd).toContain('pipelines/clone-my-voice.json');
    });

    it('lists running services before stopping when no target is selected', () => {
      const result = compileIntent('サービスを停止して', {
        routingDecision: carried('stop-service'),
      });

      expect(result).not.toBeNull();
      expect(result!.intentId).toBe('stop-service');
      expect(result!.steps[0]?.params?.cmd).toContain('service_lifecycle_control.js');
      expect(result!.steps[0]?.params?.cmd).toContain('--operation list');
      expect(result!.steps[0]?.params?.cmd).not.toContain('voice-hub');
    });

    it('lists startable services before starting when no target is selected', () => {
      const result = compileIntent('サービスを起動して', {
        routingDecision: carried('start-service'),
      });

      expect(result).not.toBeNull();
      expect(result!.intentId).toBe('start-service');
      expect(result!.steps[0]?.params?.cmd).toContain('service_lifecycle_control.js');
      expect(result!.steps[0]?.params?.cmd).toContain('--operation start');
      expect(result!.steps[0]?.params?.cmd).not.toContain('voice-hub');
    });
  });

  describe('buildPipelineGenerationPrompt', () => {
    it('includes hints in output', () => {
      const hints = [
        { topic: 'browser automation', hint: 'Use Playwright', tags: ['browser'] },
        { topic: 'screencapture', hint: 'Use vision actuator', tags: ['vision'] },
      ];

      const prompt = buildPipelineGenerationPrompt('automate browser testing', hints, [
        'browser-actuator',
        'vision-actuator',
      ]);

      expect(prompt).toContain('automate browser testing');
      expect(prompt).toContain('browser automation');
      expect(prompt).toContain('Use Playwright');
      expect(prompt).toContain('browser-actuator');
      expect(prompt).toContain('vision-actuator');
      expect(prompt).toContain('Relevant Knowledge Hints');
      expect(prompt).toContain('Available Actuators');
    });
  });
});
