import { describe, it, expect } from 'vitest';
import { generateMarpCSS, auditLayoutCSS, generateCSSArtifact, MasterSlideSpecs } from './lib.js';

describe('layout-architect lib', () => {
  const mockSpecs: MasterSlideSpecs = {
    master_name: 'TestTheme',
    typography: {
      body: { font_family: 'Arial', size: '20px', line_height: '1.5', color: '#000' },
      heading: {
        font_family: 'Helvetica',
        size: '40px',
        line_height: '1.2',
        color: '#333',
        weight: 'bold',
      },
    },
    color_palette: {
      background_main: '#fff',
      brand_accent: '#ff0000',
      border_muted: '#ccc',
    },
    layout_specs: {
      padding: '40px',
      accent_border_width: '10px',
    },
    slide_variants: {
      lead: { bg_gradient: 'linear-gradient(to bottom, #000, #333)', title_color: '#fff' },
      divider: { bg_color: '#eee' },
    },
  };

  it('should generate Marp CSS with correct theme name', () => {
    const css = generateMarpCSS(mockSpecs);
    expect(css).toContain('/* @theme TestTheme */');
    expect(css).toContain("@import 'default';");
  });

  it('should apply color palette correctly', () => {
    const css = generateMarpCSS(mockSpecs);
    expect(css).toContain('background-color: #fff;');
    expect(css).toContain('color: #ff0000;'); // h2 color
  });

  it('should include slide variants', () => {
    const css = generateMarpCSS(mockSpecs);
    expect(css).toContain('section.lead {');
    expect(css).toContain('background: linear-gradient(to bottom, #000, #333);');
    expect(css).toContain('section.divider {');
    expect(css).toContain('background-color: #eee;');
  });

  it('should audit generated CSS and detect potential issues', () => {
    const badCSS = 'body { color: red !important; }';
    const warnings = auditLayoutCSS(badCSS);
    expect(warnings).toContain('Marp theme metadata missing');
    expect(warnings).toContain('Base "section" styling missing');
  });

  it('should warn on excessive !important usage', () => {
    const cssWithImportants = Array(6).fill('p { color: blue !important; }').join('\n');
    const warnings = auditLayoutCSS(cssWithImportants + ' /* @theme x */ section {} h1 {}');
    expect(warnings.some((w: string) => w.includes('High use of !important'))).toBe(true);
  });

  it('should generate DocumentArtifact from specs', () => {
    const artifact = generateCSSArtifact(mockSpecs);
    expect(artifact.title).toBe('TestTheme Theme');
    expect(artifact.body).toContain('@theme TestTheme');
    expect(artifact.format).toBe('text');
  });
});
