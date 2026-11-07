import { describe, expect, it } from 'vitest';
import {
  contrastRatio,
  parseHexColor,
  relativeLuminance,
  validateThemeCatalog,
  validateThemeContrast,
} from './design-qa.js';

describe('design QA (deterministic WCAG checks)', () => {
  it('computes canonical contrast ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    // symmetric regardless of argument order
    expect(contrastRatio('#0066cc', '#ffffff')).toBeCloseTo(
      contrastRatio('#ffffff', '#0066cc')!,
      6
    );
    // #767676 on white is the classic 4.5:1 boundary color
    expect(contrastRatio('#767676', '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });

  it('rejects unparseable colors instead of guessing', () => {
    expect(parseHexColor('rebeccapurple')).toBeNull();
    expect(parseHexColor('#12345')).toBeNull();
    expect(relativeLuminance('not-a-color')).toBeNull();
    expect(contrastRatio('#fff', '#000000')).toBeNull(); // 3-digit form unsupported by design
  });

  it('flags unreadable body text as must_fix', () => {
    const issues = validateThemeContrast({ background: '#ffffff', text: '#cccccc' });
    expect(issues.some((i) => i.pair === 'text/background' && i.severity === 'must_fix')).toBe(
      true
    );
  });

  it('decorative accent passes when a text-safe accent_text is provided', () => {
    const withoutAccentText = validateThemeContrast({
      background: '#ffffff',
      text: '#0f172a',
      accent: '#f59e0b', // amber: ~2:1 on white
    });
    expect(withoutAccentText.some((i) => i.pair === 'accent_text/background')).toBe(true);

    const withAccentText = validateThemeContrast({
      background: '#ffffff',
      text: '#0f172a',
      accent: '#f59e0b',
      accent_text: '#b45309', // amber-700: AA-safe
    });
    expect(withAccentText).toHaveLength(0);
  });

  it('checks text on surfaces and reports catalog-level report shape', () => {
    const report = validateThemeCatalog({
      themes: {
        good: {
          colors: {
            background: '#ffffff',
            surface: '#f1f5f9',
            text: '#0f172a',
            accent: '#0066cc',
          },
        },
        bad: {
          colors: { background: '#ffffff', surface: '#333333', text: '#0f172a' },
        },
      },
    });
    expect(report.themes_checked).toBe(2);
    expect(report.must_fix.some((i) => i.theme === 'bad' && i.pair === 'text/surface')).toBe(true);
    expect(report.must_fix.some((i) => i.theme === 'good')).toBe(false);
  });
});
