import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { defineCatalog } from './foundation/governed-catalog.js';
import { compileSchemaFromPath } from './schema-loader.js';
import { pathResolver } from './path-resolver.js';
import { safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';
import { withoutSchemaMetadata } from './test-governance-payload.js';
import {
  loadWorkScopePolicy,
  resolveWorkScopeDecision,
  resolveWorkScopeSignalOptions,
} from './work-scope-decision.js';

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
      expect.arrayContaining(['stakeholder_count_3plus', 'approval_required'])
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

  it('promotes a high-stakes action to mission scope as a mandatory trigger', () => {
    const decision = resolveWorkScopeDecision({
      catalogMinimumShape: 'direct_reply',
      highStakesAction: true,
    });

    expect(decision.execution_shape).toBe('mission');
    expect(decision.promotion_required).toBe(true);
    expect(decision.mandatory_triggers).toContain('high_stakes_action');
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
      expect.arrayContaining(['artifact_estimate_5plus', 'stakeholder_count_3plus'])
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

  it('reads only explicit work-scope signals from runtime context', () => {
    expect(
      resolveWorkScopeSignalOptions({
        work_scope_signals: {
          external_audience: true,
          expected_continuation_beyond_session: true,
          cross_system_mutation: false,
          replay_or_variant_likelihood: true,
          high_stakes_action: true,
        },
        inferred_from_text: true,
      })
    ).toEqual({
      externalAudience: true,
      expectedContinuationBeyondSession: true,
      crossSystemMutation: false,
      replayOrVariantLikelihood: true,
      highStakesAction: true,
    });
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
      path.resolve(root, 'knowledge/product/schemas/work-scope-policy.schema.json')
    );
    const policy = withoutSchemaMetadata(
      JSON.parse(
        safeReadFile(path.resolve(root, 'knowledge/product/governance/work-scope-policy.json'), {
          encoding: 'utf8',
        }) as string
      )
    );

    expect(validate(policy)).toBe(true);
    expect(loadWorkScopePolicy().version).toBe('1.0.0');

    const invalidCatalogPath = pathResolver.sharedTmp('work-scope-policy-invalid.json');
    safeWriteFile(invalidCatalogPath, JSON.stringify({ version: 1 }));
    const invalidCatalog = defineCatalog<unknown>({
      id: 'work-scope-policy-test',
      path: invalidCatalogPath,
      schema: path.resolve(root, 'knowledge/product/schemas/work-scope-policy.schema.json'),
    });
    expect(() => invalidCatalog.load()).toThrow('Invalid catalog work-scope-policy-test');
    safeRmSync(invalidCatalogPath, { force: true });
  });
});
