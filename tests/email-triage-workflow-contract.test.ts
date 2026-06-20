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

function readText(relativePath: string): string {
  return safeReadFile(pathResolver.rootResolve(relativePath), { encoding: 'utf8' }) as string;
}

describe('email triage workflow contract', () => {
  it('keeps the TaskScenario aligned with the workflow template contract', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const schemaPath = pathResolver.rootResolve('schemas/task-scenario.schema.json');
    const validate = compileSchemaFromPath(ajv, schemaPath);
    const scenario = readJson('knowledge/product/task-scenarios/daily-email-triage.json');
    const template = readJson('knowledge/product/pipeline-templates/email-triage-workflow.json') as {
      context?: { triage_output_path?: string; reply_drafts_path?: string };
      steps?: Array<{ id: string; params?: Record<string, unknown> }>;
    };

    expect(validate(scenario), JSON.stringify(validate.errors, null, 2)).toBe(true);
    expect(scenario).toMatchObject({
      id: 'daily-email-triage',
      repeat_run: {
        pipeline_template: 'knowledge/product/pipeline-templates/email-triage-workflow.json',
        params_from_profile: true,
      },
      result: {
        artifacts: ['email-triage.md', 'reply-drafts.json'],
      },
      approval_boundary: {
        required_for: ['send_email'],
        default_action: 'draft-only',
      },
    });
    expect(template?.context).toMatchObject({
      triage_output_path: 'active/shared/tmp/email-triage.md',
      reply_drafts_path: 'active/shared/tmp/reply-drafts.json',
    });
    expect(readText('knowledge/product/pipeline-templates/email-triage-workflow.json')).toContain(
      'active/shared/tmp/email-triage.md',
    );
    expect(readText('knowledge/product/pipeline-templates/email-triage-workflow.json')).toContain(
      'reply-drafts.json',
    );
  });
});
