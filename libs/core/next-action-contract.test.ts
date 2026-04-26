import path from 'node:path';
import AjvModule from 'ajv';
import { describe, expect, it } from 'vitest';
import { createNextActionContract, validateNextActionContract } from './next-action-contract.js';
import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';

const Ajv = (AjvModule as any).default ?? AjvModule;

describe('next-action-contract', () => {
  it('accepts a valid action contract', () => {
    const action = createNextActionContract({
      actionId: 'act-1',
      type: 'approve',
      reason: 'Pending approval blocks mission progression.',
      risk: 'medium',
      suggestedCommand: 'pnpm control chronos approvals',
      approvalRequired: true,
    });
    const validation = validateNextActionContract(action);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toHaveLength(0);
  });

  it('rejects action without reason or target operation', () => {
    const validation = validateNextActionContract({
      action_id: 'act-2',
      next_action_type: 'inspect_evidence',
      reason: '',
      risk: 'low',
      approval_required: false,
    });
    expect(validation.valid).toBe(false);
    expect(validation.errors.some((error) => error.includes('reason'))).toBe(true);
    expect(validation.errors.some((error) => error.includes('suggested_command'))).toBe(true);
  });

  it('requires approval for destructive commands', () => {
    const validation = validateNextActionContract({
      action_id: 'act-3',
      next_action_type: 'retry_delivery',
      reason: 'Force cleanup and retry delivery path.',
      risk: 'high',
      suggested_command: 'rm -rf active/missions/MSN-1',
      approval_required: false,
    });
    expect(validation.valid).toBe(false);
    expect(validation.errors.some((error) => /approval_required/u.test(error))).toBe(true);
  });

  it('rejects unknown suggested_surface_action route', () => {
    const validation = validateNextActionContract({
      action_id: 'act-4',
      next_action_type: 'inspect_evidence',
      reason: 'Route to an unsupported panel',
      risk: 'low',
      suggested_surface_action: 'unknown-panel',
      approval_required: false,
    });
    expect(validation.valid).toBe(false);
    expect(validation.errors.some((error) => /suggested_surface_action/u.test(error))).toBe(true);
  });

  it('emits contracts that satisfy the schema', () => {
    const ajv = new Ajv({ allErrors: true });
    const schemaPath = path.join(pathResolver.rootDir(), 'schemas/next-action.schema.json');
    const validate = compileSchemaFromPath(ajv, schemaPath);
    const action = createNextActionContract({
      actionId: 'act-5',
      type: 'promote_mission_seed',
      reason: 'Queued seeds can be promoted safely.',
      risk: 'low',
      suggestedSurfaceAction: 'mission-seeds',
      approvalRequired: false,
    });
    const valid = validate(action);
    expect(valid, JSON.stringify(validate.errors || [])).toBe(true);
  });
});
