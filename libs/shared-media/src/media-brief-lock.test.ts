/**
 * MP-05: a locked brief separates what the operator said from what we guessed.
 *
 * The failure this prevents is quiet: an inferred audience or tone that never
 * surfaces until the artifact is wrong. So the properties under test are about
 * provenance and visibility, not about the values themselves.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RUN_SHAPE,
  formatBriefForConfirmation,
  inferredDecisions,
  lockMediaBrief,
  lockedMediaBriefSchema,
} from './media-brief-lock.js';

describe('lockMediaBrief', () => {
  it('records stated decisions as stated', () => {
    const brief = lockMediaBrief({
      intent: '導入提案デッキ',
      stated: { audience: '経営層', locale: 'ja-JP' },
    });
    expect(brief.decisions).toHaveLength(2);
    for (const decision of brief.decisions) expect(decision.provenance).toBe('stated');
    expect(inferredDecisions(brief)).toHaveLength(0);
  });

  it('records inferences with their rationale', () => {
    const brief = lockMediaBrief({
      intent: '導入提案デッキ',
      stated: { audience: '経営層' },
      inferred: { tone: { value: 'formal', rationale: '経営層向けのため' } },
    });
    const guessed = inferredDecisions(brief);
    expect(guessed).toHaveLength(1);
    expect(guessed[0].field).toBe('tone');
    expect(guessed[0].rationale).toBe('経営層向けのため');
  });

  it('never lets an inference overwrite something the operator stated', () => {
    const brief = lockMediaBrief({
      intent: 'x',
      stated: { tone: 'casual' },
      inferred: { tone: { value: 'formal', rationale: 'guessed' } },
    });
    const tone = brief.decisions.filter((decision) => decision.field === 'tone');
    expect(tone).toHaveLength(1);
    expect(tone[0].value).toBe('casual');
    expect(tone[0].provenance).toBe('stated');
  });

  it('ignores empty stated values rather than recording them as decisions', () => {
    const brief = lockMediaBrief({
      intent: 'x',
      stated: { audience: '', locale: undefined, tone: '   ' },
    });
    expect(brief.decisions).toHaveLength(0);
  });

  it('produces a schema-valid brief', () => {
    const brief = lockMediaBrief({ intent: 'x', stated: { audience: 'ops' } });
    expect(lockedMediaBriefSchema.safeParse(brief).success).toBe(true);
  });

  it('is deterministic for the same input', () => {
    const input = {
      intent: 'x',
      stated: { audience: 'ops' },
      inferred: { tone: { value: 'neutral', rationale: 'no tone given' } },
    };
    expect(lockMediaBrief(input)).toEqual(lockMediaBrief(input));
  });
});

describe('run shape defaults', () => {
  it('does not send material outward or accept a degraded artifact unless asked', () => {
    // Both are consequential and belong to the operator, not to a default.
    expect(DEFAULT_RUN_SHAPE.allow_external_visual_review).toBe(false);
    expect(DEFAULT_RUN_SHAPE.allow_degraded_fallback).toBe(false);
  });

  it('accepts explicit overrides', () => {
    const brief = lockMediaBrief({
      intent: 'x',
      stated: {},
      runShape: { visual_review_rounds: 3, allow_external_visual_review: true },
    });
    expect(brief.run_shape.visual_review_rounds).toBe(3);
    expect(brief.run_shape.allow_external_visual_review).toBe(true);
    // Unspecified keys keep the conservative default.
    expect(brief.run_shape.allow_degraded_fallback).toBe(false);
  });

  // Pipeline context templating substitutes into JSON as strings, so a
  // run-shape arriving from a pipeline is entirely string-valued.
  it('coerces a string round count from pipeline templating', () => {
    const brief = lockMediaBrief({
      intent: 'x',
      stated: {},
      runShape: { visual_review_rounds: '2' as any },
    });
    expect(brief.run_shape.visual_review_rounds).toBe(2);
  });

  it('reads the string "false" as false, not as a truthy string', () => {
    // z.coerce.boolean() would turn "false" into true and silently convert a
    // conservative default into a permission.
    const brief = lockMediaBrief({
      intent: 'x',
      stated: {},
      runShape: {
        allow_external_visual_review: 'false' as any,
        allow_degraded_fallback: 'true' as any,
      },
    });
    expect(brief.run_shape.allow_external_visual_review).toBe(false);
    expect(brief.run_shape.allow_degraded_fallback).toBe(true);
  });

  it('rejects an out-of-range round count', () => {
    expect(() =>
      lockMediaBrief({ intent: 'x', stated: {}, runShape: { visual_review_rounds: 99 } })
    ).toThrow();
  });
});

describe('formatBriefForConfirmation', () => {
  it('puts assumptions first and labels them as such', () => {
    const brief = lockMediaBrief({
      intent: '導入提案デッキ',
      stated: { audience: '経営層' },
      inferred: { tone: { value: 'formal', rationale: '経営層向けのため' } },
    });
    const rendered = formatBriefForConfirmation(brief);
    expect(rendered.indexOf('Assumed')).toBeLessThan(rendered.indexOf('From your request'));
    expect(rendered).toContain('correct any of these');
    expect(rendered).toContain('経営層向けのため');
  });

  it('always shows the run shape', () => {
    const rendered = formatBriefForConfirmation(
      lockMediaBrief({ intent: 'x', stated: { audience: 'ops' } })
    );
    expect(rendered).toContain('visual review rounds');
    expect(rendered).toContain('external visual review');
  });

  it('omits the assumptions block when nothing was inferred', () => {
    const rendered = formatBriefForConfirmation(
      lockMediaBrief({ intent: 'x', stated: { audience: 'ops' } })
    );
    expect(rendered).not.toContain('Assumed');
  });
});
