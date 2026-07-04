import { describe, expect, it } from 'vitest';
import { safeReadFile, safeRmSync } from '@agent/core';
import {
  buildTaskRoutingSamples,
  summarizeTaskRouting,
  writeTaskRoutingSummary,
} from './summarize_task_model_routing.js';
describe('summarize_task_model_routing', () => {
  it('correlates task issues with runtime completions and aggregates by role and tier', () => {
    const samples = buildTaskRoutingSamples(
      [
        {
          event_type: 'task_issued',
          mission_id: 'MSN-1',
          task_id: 'task-1',
          agent_id: 'agent-1',
          team_role: 'implementer',
          payload: {
            task_model_hint: {
              tier: 'small',
              effort: 'low',
              model_id: 'openai:gpt-5.4-mini',
              route_reason: 'mechanical',
            },
          },
        },
        {
          event_type: 'task_issued',
          mission_id: 'MSN-1',
          task_id: 'task-1',
          agent_id: 'agent-1',
          team_role: 'implementer',
          payload: {
            task_model_hint: {
              tier: 'small',
              effort: 'low',
              model_id: 'openai:gpt-5.4-mini',
              route_reason: 'mechanical',
            },
          },
        },
      ],
      [
        {
          decision: 'agent_runtime_ask_completed',
          agent_id: 'agent-1',
          model_id: 'openai:gpt-5.5',
          duration_ms: 1200,
          input_tokens: 100,
          output_tokens: 50,
          total_tokens: 150,
        },
        {
          decision: 'agent_runtime_ask_completed',
          agent_id: 'agent-1',
          model_id: 'openai:gpt-5.5',
          duration_ms: 1400,
          input_tokens: 120,
          output_tokens: 70,
          total_tokens: 190,
        },
      ]
    );

    expect(samples).toHaveLength(2);
    expect(samples[0]).toMatchObject({
      planned_tier: 'small',
      actual_model_id: 'openai:gpt-5.5',
      duration_ms: 1200,
      rework_count: 0,
    });
    expect(samples[1]).toMatchObject({
      planned_tier: 'small',
      actual_model_id: 'openai:gpt-5.5',
      duration_ms: 1400,
      rework_count: 1,
    });

    const rows = summarizeTaskRouting(samples);
    expect(rows).toEqual([
      expect.objectContaining({
        team_role: 'implementer',
        planned_tier: 'small',
        samples: 2,
        avg_duration_ms: 1300,
        avg_input_tokens: 110,
        avg_output_tokens: 60,
        avg_total_tokens: 170,
        avg_rework_count: 0.5,
        actual_models: ['openai:gpt-5.5'],
      }),
    ]);
  });

  it('writes the summary payload to disk when requested', () => {
    const outputPath = 'active/shared/tmp/task-model-routing-summary-test.json';
    writeTaskRoutingSummary({
      samples: [],
      rows: [],
      outputPath,
    });

    const parsed = JSON.parse(safeReadFile(outputPath, { encoding: 'utf8' }) as string) as {
      samples: unknown[];
      rows: unknown[];
    };
    expect(parsed).toEqual({ samples: [], rows: [] });
    safeRmSync(outputPath);
  });
});
