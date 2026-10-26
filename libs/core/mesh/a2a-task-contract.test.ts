import path from 'node:path';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { compileSchemaFromPath } from '../schema-loader.js';
import { isA2ATaskContractLike, validateA2ATaskContract } from './a2a-task-contract.js';

const AjvCtor = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

describe('a2a-task-contract schema', () => {
  it('validates real claimed-runtime dispatch fields consistently in Zod and JSON schema', () => {
    const ajv = new AjvCtor({ allErrors: true, strict: false });
    const validate = compileSchemaFromPath(
      ajv,
      path.resolve(process.cwd(), 'knowledge/product/schemas/a2a-task-contract.schema.json')
    );
    const context = {
      mission_id: 'MSN-public-task',
      team_role: 'planner',
      task_id: 'alignment-requirements',
      work_item_id: 'WI-public-task',
      lease_id: 'lease-claimed',
      capability_profile: 'planner',
      requested_selection: {
        mode: 'fixed',
        agent_id: 'control-plane-agent',
        provider: 'codex',
        model_id: 'codex',
        execution_route: 'agent_runtime',
      },
      selection_resolution: { source: 'requested', reason: 'Explicit runtime-only selection' },
      required_capabilities: ['reasoning', 'planning'],
      security_scope: {
        mission_id: 'MSN-public-task',
        read_tiers: ['public'],
        write_tier: 'public',
        purpose: 'planning',
      },
    };
    const contract = { intent: 'workitem_execution', text: 'Execute the bounded task', context };
    const parsed = validateA2ATaskContract(contract);
    expect(parsed.valid, JSON.stringify(parsed.errors)).toBe(true);
    expect(parsed.value?.context).toEqual(context);
    expect(validate(contract), JSON.stringify(validate.errors)).toBe(true);
    const invalid = [
      { ...context, lease_id: '' },
      { ...context, task_id: undefined },
      { ...context, capability_profile: 'administrator' },
      { ...context, requested_selection: { mode: 'fixed' } },
      {
        ...context,
        requested_selection: { ...context.requested_selection, execution_route: 'shell' },
      },
      { ...context, selection_resolution: { source: 'invented', reason: 'bad' } },
      { ...context, required_capabilities: [''] },
      { ...context, unexpected_authority: true },
    ];
    for (const candidate of invalid) {
      const value = JSON.parse(JSON.stringify({ ...contract, context: candidate }));
      expect(validateA2ATaskContract(value).valid, JSON.stringify(value)).toBe(false);
      expect(validate(value), JSON.stringify(value)).toBe(false);
    }
  });

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
        context_mode: 'fresh',
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

  it('accepts the Kyberion context-mode extension', () => {
    const result = validateA2ATaskContract({
      intent: 'request_mission_work',
      text: 'execute the work item',
      context: {
        mission_id: 'MSN-schema-1',
        team_role: 'worker',
        context_mode: 'continue',
      },
    });

    expect(result.valid).toBe(true);
    expect(result.value?.context.context_mode).toBe('continue');
  });

  it('accepts WorkItem attribution in the A2A context', () => {
    const result = validateA2ATaskContract({
      intent: 'workitem_execution',
      text: 'execute the work item',
      context: {
        mission_id: 'MSN-schema-1',
        team_role: 'worker',
        work_item_id: 'WITEM-schema-1',
      },
    });

    expect(result.valid).toBe(true);
    expect(result.value?.context.work_item_id).toBe('WITEM-schema-1');
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

describe('isA2ATaskContractLike', () => {
  it('does not treat a bare surface handoff as a mission task contract', () => {
    expect(isA2ATaskContractLike({ intent: 'surface_handoff', text: 'hand over' })).toBe(false);
  });

  it('still validates a surface handoff that carries context', () => {
    expect(
      isA2ATaskContractLike({ intent: 'surface_handoff', text: 'x', context: { channel: 'slack' } })
    ).toBe(true);
  });

  it('still validates a surface handoff that adds task fields', () => {
    expect(isA2ATaskContractLike({ intent: 'surface_handoff', text: 'x', objective: 'y' })).toBe(
      true
    );
  });

  it('keeps treating other intents as contracts', () => {
    expect(isA2ATaskContractLike({ intent: 'request_mission_work', text: 'x' })).toBe(true);
  });
});
