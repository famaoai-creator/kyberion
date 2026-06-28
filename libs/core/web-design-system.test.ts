import path from 'node:path';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { compileSchemaFromPath, safeReadFile } from '@agent/core';
import { describe, expect, it } from 'vitest';

import {
  composeWebDesignSystem,
  DEFAULT_CHRONOS_WEB_DESIGN_SYSTEM_PACK,
  DEFAULT_CHRONOS_WEB_THEME_PACK,
  webThemePackToCssVars,
} from './web-design-system.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

describe('web design system pack', () => {
  it('validates the example web design system pack', () => {
    const root = process.cwd();
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, path.resolve(root, 'knowledge/product/schemas/web-design-system-pack.schema.json'));
    const example = JSON.parse(
      safeReadFile(path.resolve(root, 'knowledge/product/schemas/web-design-system-pack.example.json'), {
        encoding: 'utf8',
      }) as string,
    );

    expect(validate(example)).toBe(true);
  });

  it('composes the default chronos web theme and design system into css vars', () => {
    const resolved = composeWebDesignSystem(DEFAULT_CHRONOS_WEB_THEME_PACK, DEFAULT_CHRONOS_WEB_DESIGN_SYSTEM_PACK);

    expect(resolved.section_order[0]).toBe('hero');
    expect(resolved.section_patterns.some((entry) => entry.section_id === 'design-system')).toBe(true);
    expect(resolved.css_vars['--kb-bg-main']).toBe('#020617');
    expect(resolved.css_vars['--kb-panel-bg']).toContain('rgba(');
    expect(resolved.css_vars['--kb-container-max-width']).toBe('1440px');
    expect(resolved.css_vars['--kb-grid-columns']).toBe('12');
  });

  it('derives css vars directly from a theme pack', () => {
    const cssVars = webThemePackToCssVars(DEFAULT_CHRONOS_WEB_THEME_PACK);

    expect(cssVars['--kb-accent']).toBe('#00F2FF');
    expect(cssVars['--kb-font-sans']).toBe('Inter, sans-serif');
  });
});
