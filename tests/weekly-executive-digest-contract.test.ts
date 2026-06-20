import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { compileSchemaFromPath } from '../libs/core/schema-loader.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

function readJson(relativePath: string): unknown {
  return JSON.parse(
    safeReadFile(pathResolver.rootResolve(relativePath), { encoding: 'utf8' }) as string,
  ) as unknown;
}

describe('weekly executive digest contract', () => {
  it('keeps the weekly digest scenario aligned with the MVP workflow template', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const schemaPath = pathResolver.rootResolve('schemas/task-scenario.schema.json');
    const validate = compileSchemaFromPath(ajv, schemaPath);
    const scenario = readJson('knowledge/product/task-scenarios/weekly-executive-digest.json');
    const template = readJson('knowledge/product/pipeline-templates/weekly-executive-digest.json') as {
      steps?: Array<{ id: string; params?: Record<string, unknown> }>;
    };

    expect(validate(scenario), JSON.stringify(validate.errors, null, 2)).toBe(true);
    expect(scenario).toMatchObject({
      id: 'weekly-executive-digest',
      repeat_run: {
        pipeline_template: 'knowledge/product/pipeline-templates/weekly-executive-digest.json',
        params_from_profile: true,
      },
      result: {
        artifacts: ['weekly-executive-digest.md', 'weekly-executive-risks.json'],
      },
      approval_boundary: {
        required_for: ['external_sharing'],
        default_action: 'notify-only',
      },
    });
    expect(template.steps?.map((step) => step.id)).toEqual([
      'log_start',
      'read_digest_input',
      'generate_digest',
      'write_digest',
      'write_risks',
      'log_done',
    ]);
    expect(
      safeReadFile(
        pathResolver.rootResolve('knowledge/product/pipeline-templates/weekly-executive-digest.json'),
        { encoding: 'utf8' },
      ) as string,
    ).toContain('## 今週の重要変化');
  });
});
