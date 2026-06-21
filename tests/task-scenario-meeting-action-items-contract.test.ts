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

describe('meeting-action-items TaskScenario contract', () => {
  it('stays aligned with the meeting postprocess MVP contract', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const schemaPath = pathResolver.rootResolve('schemas/task-scenario.schema.json');
    const validate = compileSchemaFromPath(ajv, schemaPath);
    const scenario = readJson('knowledge/product/task-scenarios/meeting-action-items.json');

    expect(validate(scenario), JSON.stringify(validate.errors, null, 2)).toBe(true);
    expect(scenario).toMatchObject({
      id: 'meeting-action-items',
      trigger: {
        type: 'event',
        event_name: 'meeting.completed',
        source: 'meeting-actuator',
      },
      repeat_run: {
        pipeline_template: 'knowledge/product/pipeline-templates/meeting-facilitation-postprocess.json',
        params_from_profile: true,
        profile_input: 'knowledge/personal/task-profiles/meeting-action-items.json',
      },
      result: {
        artifacts: [
          'action-items-extracted-{{mission_id}}.json',
          'speaker-fairness-{{mission_id}}.json',
        ],
      },
      approval_boundary: {
        required_for: ['share_summary', 'send_followup'],
        default_action: 'notify-only',
      },
    });
    expect((scenario as { first_run?: { questions?: string[] } }).first_run?.questions).toEqual([
      '何を action item とみなすか',
      '期限が曖昧な場合に確認扱いにするか',
      '社外共有前に誰が確認するか',
      'フォローアップ文面を自動生成してよいか',
    ]);
  });
});
