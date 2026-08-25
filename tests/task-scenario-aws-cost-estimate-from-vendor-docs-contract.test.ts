import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { compileSchemaFromPath } from '../libs/core/schema-loader.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

function readJson(relativePath: string): unknown {
  return JSON.parse(
    safeReadFile(pathResolver.rootResolve(relativePath), { encoding: 'utf8' }) as string
  ) as unknown;
}

describe('aws-cost-estimate-from-vendor-docs TaskScenario contract', () => {
  it('captures the vendor-doc cost-estimate workflow with an external-delivery approval boundary', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(
      ajv,
      pathResolver.rootResolve('knowledge/product/schemas/task-scenario.schema.json')
    );
    const scenario = readJson(
      'knowledge/product/task-scenarios/aws-cost-estimate-from-vendor-docs.json'
    ) as any;

    expect(validate(scenario), JSON.stringify(validate.errors, null, 2)).toBe(true);
    expect(scenario).toMatchObject({
      id: 'aws-cost-estimate-from-vendor-docs',
      trigger: { type: 'manual' },
      input: {
        required_params: [
          'vendor_proposal_pdf_path',
          'requirements_doc_pdf_path',
          'aws_region',
          'tenant_theme_id',
        ],
      },
      repeat_run: {
        pipeline_template:
          'knowledge/product/pipeline-templates/aws-cost-estimate-from-vendor-docs.json',
        params_from_profile: true,
      },
      approval_boundary: {
        required_for: ['external_delivery', 'customer_signoff'],
        default_action: 'draft-only',
      },
    });
    expect(scenario.first_run.questions.length).toBeGreaterThanOrEqual(5);
    expect(scenario.first_run.questions.some((q: string) => q.includes('外部接続'))).toBe(true);
    expect(scenario.first_run.questions.some((q: string) => q.includes('CUSTOMER_SIGNOFF'))).toBe(
      true
    );
    expect(scenario.result.artifacts).toContain('aws-cost-estimate.html');
  });
});
