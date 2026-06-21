import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { compileSchemaFromPath } from './schema-loader.js';
import { safeReadFile } from './secure-io.js';
import { loadWorkScopePolicy, resolveWorkScopeDecision } from './work-scope-decision.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

describe('work-scope-decision', () => {
  it('keeps read-only agenda requests at direct reply scope', () => {
    const decision = resolveWorkScopeDecision({
      catalogMinimumShape: 'direct_reply',
    });

    expect(decision.execution_shape).toBe('direct_reply');
    expect(decision.promotion_required).toBe(false);
    expect(decision.matched_rule_ids).toContain('catalog-floor-pass-through');
  });

  it('keeps schedule preparation as task session scope', () => {
    const decision = resolveWorkScopeDecision({
      catalogMinimumShape: 'task_session',
      stakeholderCount: 2,
    });

    expect(decision.execution_shape).toBe('task_session');
    expect(decision.promotion_required).toBe(false);
  });

  it('promotes multi-stakeholder approval work to mission scope', () => {
    const decision = resolveWorkScopeDecision({
      catalogMinimumShape: 'task_session',
      stakeholderCount: 4,
      approvalRequired: true,
    });

    expect(decision.execution_shape).toBe('mission');
    expect(decision.promotion_required).toBe(true);
    expect(decision.accumulation_triggers).toEqual(
      expect.arrayContaining(['stakeholder_count_3plus', 'approval_required']),
    );
  });

  it('keeps replayable PPTX theme import at pipeline scope until mission triggers appear', () => {
    const decision = resolveWorkScopeDecision({
      catalogMinimumShape: 'pipeline',
      replayOrVariantLikelihood: true,
    });

    expect(decision.execution_shape).toBe('pipeline');
    expect(decision.promotion_required).toBe(false);
    expect(decision.accumulation_triggers).toContain('replay_or_variant_likelihood');
  });

  it('promotes customer signoff to mission scope as a mandatory trigger', () => {
    const decision = resolveWorkScopeDecision({
      catalogMinimumShape: 'task_session',
      customerSignoff: true,
    });

    expect(decision.execution_shape).toBe('mission');
    expect(decision.promotion_required).toBe(true);
    expect(decision.mandatory_triggers).toContain('customer_signoff');
  });

  it('promotes two accumulation triggers to mission scope', () => {
    const decision = resolveWorkScopeDecision({
      catalogMinimumShape: 'task_session',
      artifactEstimate: 5,
      stakeholderCount: 3,
    });

    expect(decision.execution_shape).toBe('mission');
    expect(decision.promotion_required).toBe(true);
    expect(decision.accumulation_triggers).toEqual(
      expect.arrayContaining(['artifact_estimate_5plus', 'stakeholder_count_3plus']),
    );
  });

  it('does not promote on one accumulation trigger alone', () => {
    const decision = resolveWorkScopeDecision({
      catalogMinimumShape: 'task_session',
      artifactEstimate: 5,
    });

    expect(decision.execution_shape).toBe('task_session');
    expect(decision.promotion_required).toBe(false);
    expect(decision.accumulation_triggers).toEqual(['artifact_estimate_5plus']);
  });

  it('never demotes a mission-level catalog minimum', () => {
    const decision = resolveWorkScopeDecision({
      catalogMinimumShape: 'mission',
    });

    expect(decision.execution_shape).toBe('mission');
    expect(decision.promotion_required).toBe(true);
    expect(decision.matched_rule_ids).toContain('catalog-floor');
  });

  it('loads the bundled policy and rejects invalid policy payloads', async () => {
    const root = process.cwd();
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(
      ajv,
      path.resolve(root, 'knowledge/product/schemas/work-scope-policy.schema.json'),
    );
    const policy = JSON.parse(
      safeReadFile(path.resolve(root, 'knowledge/product/governance/work-scope-policy.json'), {
        encoding: 'utf8',
      }) as string,
    );

    expect(validate(policy)).toBe(true);
    expect(loadWorkScopePolicy().version).toBe('1.0.0');

    const secureIo = await import('./secure-io.js');
    const spy = vi.spyOn(secureIo, 'safeReadFile').mockReturnValue('{"version":1}') as unknown as {
      mockRestore(): void;
    };
    expect(() => loadWorkScopePolicy()).toThrow('Invalid work-scope-policy');
    spy.mockRestore();
  });
});
