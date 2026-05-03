import { describe, it, expect, vi } from 'vitest';

vi.mock('../core.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../secure-io.js', () => ({
  safeExistsSync: () => false,
  safeReadFile: () => '[]',
}));

import { compileIntent, buildPipelineGenerationPrompt } from './intent-compiler.js';

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
  ];

  describe('compileIntent', () => {
    it('returns null for unknown intent', () => {
      const result = compileIntent('do something completely unrelated xyz', {
        standardIntents,
        knowledgeHints: [],
      });

      expect(result).toBeNull();
    });

    it('matches by keyword with confidence 0.8', () => {
      const result = compileIntent('I need to take a screenshot of the page', {
        standardIntents,
      });

      expect(result).not.toBeNull();
      expect(result!.confidence).toBe(0.8);
      expect(result!.source).toBe('template');
      expect(result!.intentId).toBe('take-screenshot');
      expect(result!.steps.length).toBeGreaterThan(0);
    });

    it('matches knowledge hints with confidence 0.6', () => {
      const knowledgeHints = [
        { topic: 'pdf generation', hint: 'Use media actuator for PDF', tags: ['pdf', 'media'] },
      ];

      const result = compileIntent('generate a pdf report', {
        standardIntents: [],
        knowledgeHints,
      });

      expect(result).not.toBeNull();
      expect(result!.confidence).toBe(0.6);
      expect(result!.source).toBe('hint');
      expect(result!.steps).toEqual([]); // hints don't produce steps
      expect(result!.warnings).toBeDefined();
    });

    it('synthesizes a deterministic meeting orchestration step', () => {
      const result = compileIntent(
        'Teamsで開催されるオンラインミーティングに私の代わりに参加して無事成功させる',
        {
          standardIntents,
        }
      );

      expect(result).not.toBeNull();
      expect(result!.intentId).toBe('meeting-operations');
      expect(result!.steps.some((step) => step.op === 'core:if')).toBe(true);
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
