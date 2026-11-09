import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAjv, compileSchema } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { DOCUMENT_REVIEW_INPUT_SCHEMA, describeOps } from './op-catalog.js';

const review = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('@agent/core/document-review', () => ({ runDocumentReview: review.run }));
import { dispatchWisdomOperation } from './decision-ops.js';

beforeEach(() => review.run.mockReset());

describe('document review actuator boundary', () => {
  it('exports the evidence report with its effective tier and incomplete status intact', async () => {
    const report = {
      status: 'incomplete',
      effective_tier: 'confidential',
      tenant_slug: 'acme',
      reviewers: [{ reviewer: 'comprehension', status: 'not_run' }],
      findings: [],
    };
    review.run.mockResolvedValue(report);
    const result = await dispatchWisdomOperation(
      'document_review',
      {
        target: '{{document}}',
        references: ['docs/GLOSSARY.md'],
        sources: ['libs/core/core.ts'],
        preset: 'design',
        generator: 'claude',
        timeout_ms: 1000,
        export_as: 'review',
      },
      { document: 'docs/WHY.md' }
    );
    expect(review.run).toHaveBeenCalledExactlyOnceWith({
      target: 'docs/WHY.md',
      references: ['docs/GLOSSARY.md'],
      sources: ['libs/core/core.ts'],
      preset: 'design',
      generator: 'claude',
      timeout_ms: 1000,
    });
    expect(result).toEqual({ handled: true, ctx: { document: 'docs/WHY.md', review: report } });
  });

  it.each([
    { target: 'docs/WHY.md', waive: true },
    { target: 'docs/WHY.md', references: Array(17).fill('docs/WHY.md') },
    { target: 'docs/WHY.md', sources: [''] },
    { target: 'docs/WHY.md', preset: 'auto_accept' },
    { target: 'docs/WHY.md', timeout_ms: 120001 },
    { target: 'docs/WHY.md', timeout_ms: 0 },
    { target: 'docs/WHY.md', timeout_ms: 999 },
    { target: 'docs/WHY.md', preset: 'design', sources: [] },
    { target: 'docs/WHY.md', generator: '' },
    { target: '' },
  ])('rejects unsupported review input before a provider call: %j', async (params) => {
    await expect(dispatchWisdomOperation('document_review', params, {})).rejects.toThrow(
      '[DOCUMENT_REVIEW_INPUT_INVALID]'
    );
    expect(review.run).not.toHaveBeenCalled();
  });

  it('advertises a bounded strict contract and model execution', () => {
    const op = describeOps().find(({ op }) => op === 'document_review');
    expect(op).toMatchObject({ op: 'document_review', execution_kind: 'reasoning_single' });
    const validate = createAjv().compile(DOCUMENT_REVIEW_INPUT_SCHEMA);
    expect(validate({ target: 'docs/WHY.md' })).toBe(true);
    expect(validate({ target: 'docs/WHY.md', output_tier: 'public' })).toBe(false);
  });

  it('enforces the same review boundary in the persisted ADF request schema', () => {
    const validate = compileSchema(
      pathResolver.rootResolve('knowledge/product/schemas/wisdom-action.schema.json')
    );
    const request = (params: unknown) => ({
      action: 'pipeline',
      steps: [{ type: 'apply', op: 'document_review', params }],
    });
    expect(validate(request({ target: 'docs/WHY.md', references: [] }))).toBe(true);
    expect(validate(request({ target: 'docs/WHY.md', resolutions: [] }))).toBe(false);
    expect(validate(request({ target: 'docs/WHY.md', sources: Array(17).fill('x.ts') }))).toBe(
      false
    );
    expect(validate(request({ preset: 'comprehension' }))).toBe(false);
  });
});
