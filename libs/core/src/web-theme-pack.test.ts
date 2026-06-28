import path from 'node:path';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { compileSchemaFromPath, safeReadFile } from '@agent/core';
import { describe, expect, it } from 'vitest';

const Ajv = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

describe('web theme pack schema', () => {
  it('validates the example web theme pack', () => {
    const root = process.cwd();
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, path.resolve(root, 'knowledge/product/schemas/web-theme-pack.schema.json'));
    const example = JSON.parse(safeReadFile(path.resolve(root, 'knowledge/product/schemas/web-theme-pack.example.json'), { encoding: 'utf8' }) as string);

    expect(validate(example)).toBe(true);
  });

  it('threads the web design theme into the web concept pipeline', () => {
    const pipeline = JSON.parse(safeReadFile(path.resolve(process.cwd(), 'knowledge/product/pipeline-templates/build-web-concept.json'), { encoding: 'utf8' }) as string);
    const renderPreview = pipeline.steps?.find((step: any) => step.id === 'render_preview');
    const includeParams = renderPreview?.params || {};

    expect(renderPreview?.op).toBe('core:include');
    expect(includeParams?.fragment).toBe('fragments/html-web-preview.json');
    expect(includeParams?.context?.html_brief).toBe('{{concept_brief}}');
    expect(includeParams?.context?.design_system_brief).toBe('{{design_theme}}');
    expect(includeParams?.context?.output_path).toBe('{{output_path}}');
    expect(String(includeParams?.context?.preview_label || '')).toBe('{{preview_label}}');
  });

  it('routes web imports through the web theme pack branch', () => {
    const extractTheme = JSON.parse(safeReadFile(path.resolve(process.cwd(), 'knowledge/product/pipeline-templates/extract-brand-theme.json'), { encoding: 'utf8' }) as string);
    const importHtml = JSON.parse(safeReadFile(path.resolve(process.cwd(), 'knowledge/product/pipeline-templates/import-brand-from-html.json'), { encoding: 'utf8' }) as string);

    const webExtractSteps = extractTheme.steps?.[0]?.params?.then || [];
    const webExtractStep = webExtractSteps.find((step: any) => step.id === 'synthesize_theme_web');
    const webExtractSaveStep = webExtractSteps.find((step: any) => step.id === 'save_brand_web');
    const webImportStep = importHtml.steps?.find((step: any) => step.id === 'synthesize_theme');
    const webImportSaveStep = importHtml.steps?.find((step: any) => step.id === 'save_brand');

    expect(webExtractStep?.produces?.channel).toBe('active_web_theme');
    expect(webExtractStep?.params?.instruction).toContain('Web サイト');
    expect(webExtractSaveStep?.params?.web_theme_from).toBe('active_web_theme');
    expect(webExtractSaveStep?.params?.web_from).toBe('web_snapshot');
    expect(webImportStep?.produces?.channel).toBe('active_web_theme');
    expect(webImportStep?.params?.context).toEqual(['{{web_snapshot}}']);
    expect(webImportSaveStep?.params?.theme_from).toBe('active_web_theme');
    expect(webImportSaveStep?.params?.web_theme_from).toBe('active_web_theme');
    expect(webImportSaveStep?.params?.web_from).toBe('web_snapshot');
  });
});
