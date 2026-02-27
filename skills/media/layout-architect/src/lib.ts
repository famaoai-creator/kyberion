import { DocumentArtifact } from '@agent/core/shared-business-types';

export interface TypographySpec {
  font_family: string;
  size: string;
  line_height: string;
  color: string;
}

export interface HeadingSpec extends TypographySpec {
  weight: string;
}

export interface ColorPalette {
  background_main: string;
  brand_accent: string;
  border_muted: string;
}

export interface LayoutSpecs {
  padding: string;
  accent_border_width: string;
}

export interface SlideVariant {
  bg_gradient?: string;
  bg_color?: string;
  title_color?: string;
}

export interface MasterSlideSpecs {
  master_name: string;
  typography: {
    body: TypographySpec;
    heading: HeadingSpec;
  };
  color_palette: ColorPalette;
  layout_specs: LayoutSpecs;
  slide_variants: {
    lead: SlideVariant;
    divider: SlideVariant;
  };
}

export function generateMarpCSS(specs: MasterSlideSpecs): string {
  const t = specs.typography;
  const c = specs.color_palette;
  const l = specs.layout_specs;

  return `/* @theme ${specs.master_name} */
@import 'default';

section {
    width: 1280px;
    height: 720px;
    background-color: ${c.background_main};
    color: ${t.body.color};
    font-family: ${t.body.font_family};
    font-size: ${t.body.size};
    padding: ${l.padding};
    line-height: ${t.body.line_height};
}

h1 {
    color: ${t.heading.color};
    font-family: ${t.heading.font_family};
    font-weight: ${t.heading.weight};
    border-left: ${l.accent_border_width} solid ${c.brand_accent};
    padding-left: 20px;
    margin-bottom: 30px;
}

h2 {
    color: ${c.brand_accent};
    font-weight: bold;
    margin-top: 0;
}

li::before {
    content: "◼";
    color: ${c.brand_accent};
    margin-right: 10px;
}

section.lead {
    background: ${specs.slide_variants.lead.bg_gradient || 'none'};
    color: white;
    justify-content: center;
}

section.lead h1 {
    color: ${specs.slide_variants.lead.title_color || 'white'};
    border-left: none;
    font-size: 70px;
}

section.divider {
    background-color: ${specs.slide_variants.divider.bg_color || '#ccc'};
    justify-content: center;
    text-align: center;
}

footer {
    font-size: 14px;
    color: ${c.brand_accent};
    border-top: 1px solid ${c.border_muted};
}
`;
}

/**
 * Generates a CSS DocumentArtifact from slide specifications.
 */
export function generateCSSArtifact(specs: MasterSlideSpecs): DocumentArtifact {
  const css = generateMarpCSS(specs);
  return {
    title: `${specs.master_name} Theme`,
    body: css,
    format: 'text', // CSS source
    metadata: { master_name: specs.master_name },
  };
}

export function auditLayoutCSS(css: string): string[] {
  const warnings: string[] = [];
  if (!css.includes('@theme')) warnings.push('Marp theme metadata missing');
  if (!css.includes('section')) warnings.push('Base "section" styling missing');
  if (!css.includes('h1')) warnings.push('Base "h1" styling missing');

  const importantCount = (css.match(/!important/g) || []).length;
  if (importantCount > 5) {
    warnings.push(
      `High use of !important (${importantCount} found). This may cause specificity issues.`
    );
  }

  return warnings;
}
