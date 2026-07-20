/**
 * MP-04: visual review contract.
 *
 * The behaviours pinned here are the ones where being wrong is worse than
 * being absent: a review that never looked must not read as a pass, and
 * rendered pages of tenant material must not leave the host just because a
 * review was requested.
 */
import { describe, expect, it } from 'vitest';
import {
  formatVisualReviewReport,
  loadVisualReviewRubric,
  runVisualReview,
  visualReviewResponseSchema,
} from './visual-review.js';
import { runVisualReviewLoop } from './visual-review-loop.js';
import type { ContextSecurityScope } from './context-security-scope.js';

const OPEN_SCOPE: ContextSecurityScope = {
  tenant_id: 'kyberion',
  mission_id: 'MSN-TEST',
  read_tiers: ['public'],
  write_tier: 'public',
  purpose: 'visual review test',
  external_egress: 'allow',
};

const LOCKED_SCOPE: ContextSecurityScope = {
  ...OPEN_SCOPE,
  read_tiers: ['confidential'],
  write_tier: 'confidential',
  external_egress: 'deny',
};

const IMAGES = ['/tmp/page-1.png', '/tmp/page-2.png'];

function critiqueReturning(payload: unknown) {
  return async () => payload;
}

const CLEAN_CRITIQUE = critiqueReturning({ findings: [], verdict: 'looks good' });

describe('rubric', () => {
  it('loads criteria from the catalog', () => {
    const rubric = loadVisualReviewRubric();
    expect(rubric.criteria.length).toBeGreaterThanOrEqual(5);
    expect(rubric.criteria.some((criterion) => criterion.id === 'overflow')).toBe(true);
    expect(rubric.iteration.max_rounds).toBeGreaterThanOrEqual(1);
  });

  it('flags machine-made tells as a criterion', () => {
    const rubric = loadVisualReviewRubric();
    expect(rubric.banned_patterns.length).toBeGreaterThan(0);
    expect(rubric.criteria.some((criterion) => criterion.id === 'ai-defaults')).toBe(true);
  });
});

describe('egress control', () => {
  it('does not send pages when the scope forbids external egress', async () => {
    let called = false;
    const report = await runVisualReview({
      images: IMAGES,
      artifactKind: 'pptx',
      scope: LOCKED_SCOPE,
      backendName: 'anthropic',
      critique: async () => {
        called = true;
        return { findings: [], verdict: 'ok' };
      },
    });

    expect(called, 'critique must not be invoked when egress is denied').toBe(false);
    expect(report.status).toBe('skipped');
    expect(report.skipped_reason).toContain('EGRESS');
    expect(report.images_reviewed).toBe(0);
  });

  it('allows a local backend under the same locked scope', async () => {
    const report = await runVisualReview({
      images: IMAGES,
      artifactKind: 'pptx',
      scope: LOCKED_SCOPE,
      backendName: 'ollama',
      critique: CLEAN_CRITIQUE,
    });
    expect(report.status).toBe('reviewed');
  });

  it('blocks tenant material from an unapproved provider even when the scope allows egress', async () => {
    // Reasoning backends use their own SDK clients, so `secureFetch`'s tier
    // rule never sees this send; the review has to consult it itself.
    let called = false;
    const report = await runVisualReview({
      images: IMAGES,
      artifactKind: 'pptx',
      scope: {
        ...OPEN_SCOPE,
        read_tiers: ['confidential'],
        tenant_id: 'aster-bank',
        external_egress: 'allow',
      },
      backendName: 'anthropic',
      critique: async () => {
        called = true;
        return { findings: [], verdict: 'ok' };
      },
    });

    expect(called, 'tenant pages must not be sent to an unapproved provider').toBe(false);
    expect(report.status).toBe('skipped');
    expect(report.skipped_reason).toContain('TIER_EGRESS_DENIED');
  });

  it('allows public material to the same provider', async () => {
    const report = await runVisualReview({
      images: IMAGES,
      artifactKind: 'pptx',
      scope: { ...OPEN_SCOPE, read_tiers: ['public'] },
      backendName: 'anthropic',
      critique: CLEAN_CRITIQUE,
    });
    expect(report.status).toBe('reviewed');
  });

  it('allows tenant material to a local backend', async () => {
    const report = await runVisualReview({
      images: IMAGES,
      artifactKind: 'pptx',
      scope: {
        ...OPEN_SCOPE,
        read_tiers: ['confidential'],
        tenant_id: 'aster-bank',
        external_egress: 'allow',
      },
      backendName: 'ollama',
      critique: CLEAN_CRITIQUE,
    });
    expect(report.status).toBe('reviewed');
  });

  it('respects an explicit backend allowlist', async () => {
    const report = await runVisualReview({
      images: IMAGES,
      artifactKind: 'pptx',
      scope: { ...OPEN_SCOPE, allowed_reasoning_backends: ['ollama'] },
      backendName: 'anthropic',
      critique: CLEAN_CRITIQUE,
    });
    expect(report.status).toBe('skipped');
    expect(report.skipped_reason).toContain('EGRESS_DENIED');
  });
});

describe('an unavailable review is never a pass', () => {
  it('skips with a reason when there are no images', async () => {
    const report = await runVisualReview({
      images: [],
      artifactKind: 'pptx',
      scope: OPEN_SCOPE,
      backendName: 'anthropic',
      critique: CLEAN_CRITIQUE,
    });
    expect(report.status).toBe('skipped');
    expect(report.skipped_reason).toBeTruthy();
    expect(report.error_count).toBe(0);
  });

  it('skips when the active backend has no vision channel', async () => {
    // The session backend here is not vision-capable, so rather than falling
    // back to a text delegation the review reports that it never looked.
    const report = await runVisualReview({
      images: IMAGES,
      artifactKind: 'pptx',
      scope: OPEN_SCOPE,
      backendName: 'anthropic',
    });
    expect(report.status).toBe('skipped');
    expect(report.skipped_reason).toMatch(/no vision channel|not inspected/);
  });

  it('skips on a stub backend when no channel is supplied', async () => {
    const report = await runVisualReview({
      images: IMAGES,
      artifactKind: 'pptx',
      scope: OPEN_SCOPE,
      backendName: 'stub',
    });
    expect(report.status).toBe('skipped');
    expect(report.skipped_reason).toMatch(/stub|no vision channel/);
  });

  it('uses an explicitly supplied channel regardless of backend name', async () => {
    // Injecting a critique means the caller has provided the vision channel;
    // the configured backend name is then irrelevant.
    const report = await runVisualReview({
      images: IMAGES,
      artifactKind: 'pptx',
      scope: OPEN_SCOPE,
      backendName: 'stub',
      critique: CLEAN_CRITIQUE,
    });
    expect(report.status).toBe('reviewed');
  });

  it('reports a malformed critique as failed, not as clean', async () => {
    const report = await runVisualReview({
      images: IMAGES,
      artifactKind: 'pptx',
      scope: OPEN_SCOPE,
      backendName: 'anthropic',
      critique: critiqueReturning({ nonsense: true }),
    });
    expect(report.status).toBe('failed');
    expect(report.error_count).toBe(0);
  });

  it('reports a throwing critique as failed', async () => {
    const report = await runVisualReview({
      images: IMAGES,
      artifactKind: 'pptx',
      scope: OPEN_SCOPE,
      backendName: 'anthropic',
      critique: async () => {
        throw new Error('backend exploded');
      },
    });
    expect(report.status).toBe('failed');
    expect(report.skipped_reason).toContain('failed');
  });
});

describe('findings', () => {
  it('counts errors and warnings separately', async () => {
    const report = await runVisualReview({
      images: IMAGES,
      artifactKind: 'pptx',
      scope: OPEN_SCOPE,
      backendName: 'anthropic',
      critique: critiqueReturning({
        verdict: 'needs work',
        findings: [
          {
            criterion_id: 'overflow',
            severity: 'error',
            page: 1,
            summary: 'text clipped',
            fix: 'shorten',
          },
          {
            criterion_id: 'density',
            severity: 'warning',
            page: 2,
            summary: 'sparse',
            fix: 'merge',
          },
        ],
      }),
    });
    expect(report.status).toBe('reviewed');
    expect(report.error_count).toBe(1);
    expect(report.warning_count).toBe(1);
  });

  it('drops findings citing pages outside the render', async () => {
    // A model naming page 9 of a 2-page deck is not describing this render.
    const report = await runVisualReview({
      images: IMAGES,
      artifactKind: 'pptx',
      scope: OPEN_SCOPE,
      backendName: 'anthropic',
      critique: critiqueReturning({
        verdict: 'x',
        findings: [
          { criterion_id: 'overflow', severity: 'error', page: 9, summary: 'ghost', fix: 'n/a' },
          { criterion_id: 'overflow', severity: 'error', page: 2, summary: 'real', fix: 'shorten' },
        ],
      }),
    });
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].summary).toBe('real');
  });

  it('requires a concrete fix on every finding', () => {
    const parsed = visualReviewResponseSchema.safeParse({
      verdict: 'x',
      findings: [{ criterion_id: 'overflow', severity: 'error', page: 1, summary: 'bad', fix: '' }],
    });
    expect(parsed.success).toBe(false);
  });
});

describe('formatVisualReviewReport', () => {
  it('says plainly when a review did not run', async () => {
    const report = await runVisualReview({
      images: [],
      artifactKind: 'pptx',
      scope: OPEN_SCOPE,
      backendName: 'anthropic',
      critique: CLEAN_CRITIQUE,
    });
    expect(formatVisualReviewReport(report)).toContain('skipped');
  });

  it('lists errors before warnings', async () => {
    const report = await runVisualReview({
      images: IMAGES,
      artifactKind: 'pptx',
      scope: OPEN_SCOPE,
      backendName: 'anthropic',
      critique: critiqueReturning({
        verdict: 'mixed',
        findings: [
          {
            criterion_id: 'density',
            severity: 'warning',
            page: 1,
            summary: 'sparse',
            fix: 'merge',
          },
          {
            criterion_id: 'overflow',
            severity: 'error',
            page: 2,
            summary: 'clipped',
            fix: 'shorten',
          },
        ],
      }),
    });
    const lines = formatVisualReviewReport(report).split('\n');
    expect(lines[1]).toContain('[error]');
  });
});

describe('review loop', () => {
  it('stops as soon as the errors are gone', async () => {
    let renders = 0;
    const result = await runVisualReviewLoop({
      render: async () => {
        renders += 1;
        return { images: IMAGES };
      },
      review: {
        artifactKind: 'pptx',
        scope: OPEN_SCOPE,
        backendName: 'anthropic',
        critique: CLEAN_CRITIQUE,
      },
    });
    expect(result.outcome).toBe('clean');
    expect(renders).toBe(1);
  });

  it('re-renders while fixes are being applied, up to the cap', async () => {
    let renders = 0;
    const result = await runVisualReviewLoop({
      maxRounds: 3,
      render: async () => {
        renders += 1;
        return { images: IMAGES };
      },
      applyFixes: async () => 1,
      review: {
        artifactKind: 'pptx',
        scope: OPEN_SCOPE,
        backendName: 'anthropic',
        critique: critiqueReturning({
          verdict: 'still broken',
          findings: [
            {
              criterion_id: 'overflow',
              severity: 'error',
              page: 1,
              summary: 'clipped',
              fix: 'shorten',
            },
          ],
        }),
      },
    });
    expect(renders).toBe(3);
    expect(result.outcome).toBe('residual');
    expect(result.outstanding).toHaveLength(1);
    expect(result.summary).toContain('delivered with known issues');
  });

  it('stops early when no fix could be applied', async () => {
    // Re-critiquing an unchanged artifact just buys the same findings again.
    let renders = 0;
    await runVisualReviewLoop({
      maxRounds: 3,
      render: async () => {
        renders += 1;
        return { images: IMAGES };
      },
      applyFixes: async () => 0,
      review: {
        artifactKind: 'pptx',
        scope: OPEN_SCOPE,
        backendName: 'anthropic',
        critique: critiqueReturning({
          verdict: 'broken',
          findings: [
            {
              criterion_id: 'overflow',
              severity: 'error',
              page: 1,
              summary: 'clipped',
              fix: 'shorten',
            },
          ],
        }),
      },
    });
    expect(renders).toBe(1);
  });

  it('reports unreviewed loudly when nothing could be rasterized', async () => {
    const result = await runVisualReviewLoop({
      render: async () => ({ images: [], unavailable_reason: 'soffice not installed' }),
      review: {
        artifactKind: 'pptx',
        scope: OPEN_SCOPE,
        backendName: 'anthropic',
        critique: CLEAN_CRITIQUE,
      },
    });
    expect(result.outcome).toBe('unreviewed');
    expect(result.summary).toContain('NOT inspected');
    expect(result.summary).toContain('soffice');
  });

  it('emits a record per round for tracing', async () => {
    const seen: number[] = [];
    await runVisualReviewLoop({
      maxRounds: 2,
      render: async () => ({ images: IMAGES }),
      applyFixes: async () => 1,
      review: {
        artifactKind: 'pptx',
        scope: OPEN_SCOPE,
        backendName: 'anthropic',
        critique: critiqueReturning({
          verdict: 'broken',
          findings: [
            {
              criterion_id: 'overflow',
              severity: 'error',
              page: 1,
              summary: 'clipped',
              fix: 'shorten',
            },
          ],
        }),
      },
      onRound: (round) => seen.push(round.round),
    });
    expect(seen).toEqual([1, 2]);
  });
});
