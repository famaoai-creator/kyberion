import { describe, expect, it } from 'vitest';

import { evaluateDeliverableQuality } from './deliverable-quality.js';
import { evaluateDeliverableQualityGate } from './mission-review-gates.js';

describe('deliverable-quality', () => {
  it('scores a structured document as ok', () => {
    const report = evaluateDeliverableQuality('doc', {
      text: [
        '# Title',
        '',
        '## Body',
        '',
        'This document contains enough structured content to pass the quality gate.',
        'It has multiple sentences, an explicit heading structure, and enough detail to avoid a short-form warning.',
        'That is sufficient for the baseline quality contract used by the gate.',
      ].join('\n'),
    });

    expect(report.severity).toBe('ok');
    expect(report.hard_checks).toHaveLength(0);
  });

  it('warns on a short deck and blocks a missing one', () => {
    const shortDeck = evaluateDeliverableQuality('deck', {
      slides: [{ title: 'One' }, { title: 'Two' }],
    });
    const missingDeck = evaluateDeliverableQuality('deck', {});

    expect(shortDeck.severity).toBe('warn');
    expect(shortDeck.soft_checks).toContain('slide deck is short (2 slide(s))');
    expect(missingDeck.severity).toBe('poor');
    expect(missingDeck.hard_checks).toContain('slide list is missing');
  });

  it('blocks code and media artifacts that fail verification', () => {
    const codeReport = evaluateDeliverableQuality('code', {
      build_passed: true,
      lint_passed: false,
      tests_passed: true,
    });
    const mediaReport = evaluateDeliverableQuality('media', {
      generated: true,
      rendered: false,
      matches_spec: true,
    });

    expect(codeReport.severity).toBe('poor');
    expect(codeReport.hard_checks).toContain('lint failed');
    expect(mediaReport.severity).toBe('poor');
    expect(mediaReport.hard_checks).toContain('media render failed');
  });

  it('exposes the deliverable quality gate verdict', () => {
    expect(
      evaluateDeliverableQualityGate('doc', {
        text: 'short',
      })
    ).toMatchObject({
      gate_id: 'DELIVERABLE_QUALITY',
      verdict: 'blocked',
    });
  });
});
