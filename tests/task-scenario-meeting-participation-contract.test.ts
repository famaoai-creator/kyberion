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

describe('meeting-participation-request TaskScenario contract', () => {
  it('provides a concise guided intake and preserves speaking boundaries', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(
      ajv,
      pathResolver.rootResolve('knowledge/product/schemas/task-scenario.schema.json')
    );
    const scenario = readJson(
      'knowledge/product/task-scenarios/meeting-participation-request.json'
    ) as any;

    expect(validate(scenario), JSON.stringify(validate.errors, null, 2)).toBe(true);
    expect(scenario).toMatchObject({
      id: 'meeting-participation-request',
      trigger: { type: 'manual' },
      input: {
        required_params: ['meeting_url', 'meeting_role_boundary', 'meeting_purpose'],
      },
      repeat_run: {
        pipeline_template: 'knowledge/product/pipeline-templates/meeting-proxy-workflow.json',
        params_from_profile: true,
      },
      approval_boundary: {
        required_for: ['speak_in_meeting', 'share_summary_externally', 'send_followup'],
        default_action: 'notify-only',
      },
    });
    expect(scenario.first_run.questions).toHaveLength(3);
    expect(scenario.first_run.questions[0]).toContain('会議のURL');
    expect(scenario.first_run.questions[2]).toContain('発言');
    expect(scenario.description).toContain('安全な境界');
  });
});
