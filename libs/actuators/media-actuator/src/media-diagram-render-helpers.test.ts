import { describe, expect, it } from 'vitest';
import { deriveThemeFromPptxDesign } from './media-diagram-render-helpers.js';

// The unmodified default Office theme — dk1/lt1/dk2/lt2/accent1 etc. exactly as
// PowerPoint ships them when nobody has customized the theme. Real-world decks
// frequently carry this untouched, which previously made `accent` come back as
// the stock Office blue (#4472C4) even when the deck itself never draws with it.
const DEFAULT_OFFICE_THEME = {
  dk1: '000000',
  lt1: 'FFFFFF',
  dk2: '44546A',
  lt2: 'E7E6E6',
  accent1: '4472C4',
  accent2: 'ED7D31',
};

function rectWithFill(fill: string) {
  return { type: 'shape', shapeType: 'rect', pos: { x: 0, y: 0, w: 1, h: 1 }, style: { fill } };
}

describe('deriveThemeFromPptxDesign — accent color robustness', () => {
  it('prefers a color actually used in slide content over an unused theme-scheme accent', () => {
    const design = {
      theme: DEFAULT_OFFICE_THEME,
      slides: [
        { elements: [rectWithFill('1155CC'), rectWithFill('1155CC'), rectWithFill('1155CC')] },
        {
          elements: [{ type: 'text', pos: { x: 0, y: 0, w: 1, h: 1 }, style: { color: '000000' } }],
        },
      ],
    };
    const theme = deriveThemeFromPptxDesign(design);
    expect(theme.colors.accent).toBe('#1155CC');
  });

  it('keeps the theme-scheme accent when the deck actually draws with it', () => {
    const design = {
      theme: DEFAULT_OFFICE_THEME,
      slides: [{ elements: [rectWithFill('4472C4'), rectWithFill('4472C4')] }],
    };
    const theme = deriveThemeFromPptxDesign(design);
    expect(theme.colors.accent).toBe('#4472C4');
  });

  it('does not switch accent on a single stray color occurrence', () => {
    const design = {
      theme: DEFAULT_OFFICE_THEME,
      slides: [{ elements: [rectWithFill('2E7D32')] }],
    };
    const theme = deriveThemeFromPptxDesign(design);
    expect(theme.colors.accent).toBe('#4472C4');
  });

  it('does not let recurring reddish emphasis colors hijack the brand accent', () => {
    const design = {
      theme: DEFAULT_OFFICE_THEME,
      slides: [
        {
          elements: [
            rectWithFill('FF0000'),
            rectWithFill('FF0000'),
            rectWithFill('FF0000'),
            rectWithFill('1155CC'),
            rectWithFill('1155CC'),
          ],
        },
      ],
    };
    const theme = deriveThemeFromPptxDesign(design);
    expect(theme.colors.accent).toBe('#1155CC');
  });

  it('falls back to the theme accent when no chromatic content color is evidenced', () => {
    const design = {
      theme: DEFAULT_OFFICE_THEME,
      slides: [{ elements: [rectWithFill('000000'), rectWithFill('FFFFFF')] }],
    };
    const theme = deriveThemeFromPptxDesign(design);
    expect(theme.colors.accent).toBe('#4472C4');
  });
});
