import path from 'node:path';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { compileSchemaFromPath } from './schema-loader.js';
import { validateA2ATaskContract } from './a2a-task-contract.js';

const AjvCtor = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

describe('a2a-task-contract schema', () => {
  it('accepts a governed A2A task payload', () => {
    const root = process.cwd();
    const ajv = new AjvCtor({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(
      ajv,
      path.resolve(root, 'knowledge/product/schemas/a2a-task-contract.schema.json')
    );

    const valid = {
      intent: 'request_mission_work',
      text: '進捗をまとめて',
      context: {
        mission_id: 'MSN-schema-1',
        team_role: 'mission-controller',
        execution_mode: 'task',
        channel: 'slack',
      },
    };

    expect(validate(valid)).toBe(true);
  });

  it('rejects payloads without the required team role context', () => {
    const root = process.cwd();
    const ajv = new AjvCtor({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(
      ajv,
      path.resolve(root, 'knowledge/product/schemas/a2a-task-contract.schema.json')
    );

    const invalid = {
      intent: 'request_mission_work',
      text: '進捗をまとめて',
      context: {
        mission_id: 'MSN-schema-1',
      },
    };

    expect(validate(invalid)).toBe(false);
  });

  it('validates richer task contract payloads through the helper', () => {
    const result = validateA2ATaskContract({
      intent: 'request_mission_work',
      text: '進捗をまとめて',
      objective: 'team_status_summary',
      acceptance_criteria: ['mission status is summarized', 'open questions are listed'],
      expected_outputs: ['short summary', 'open issues'],
      rationale: 'The requester needs a concise report',
      prior_decisions: ['Prefer summary-first output'],
      context: {
        mission_id: 'MSN-schema-1',
        team_role: 'mission-controller',
        execution_mode: 'task',
        channel: 'slack',
        correlation_id: 'corr-1',
        task_model_hint: {
          model_id: 'openai:gpt-5.4-mini',
          tier: 'small',
          effort: 'low',
          route_reason: 'structured request',
        },
      },
    });

    expect(result.valid).toBe(true);
    expect(result.value?.context.correlation_id).toBe('corr-1');
  });

  it('rejects malformed task contract payloads through the helper', () => {
    const result = validateA2ATaskContract({
      intent: 'request_mission_work',
      text: '進捗をまとめて',
      context: {
        mission_id: 'MSN-schema-1',
      },
    });

    expect(result.valid).toBe(false);
    expect(result.value).toBeUndefined();
    expect(result.errors.some((error) => error.includes('/context/team_role'))).toBe(true);
  });
});
