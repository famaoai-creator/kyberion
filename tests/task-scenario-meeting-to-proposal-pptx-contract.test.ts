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

describe('meeting-to-proposal-pptx TaskScenario contract', () => {
  it('stays aligned with the canonical TaskScenario schema', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const schemaPath = pathResolver.rootResolve('schemas/task-scenario.schema.json');
    const validate = compileSchemaFromPath(ajv, schemaPath);
    const scenario = readJson('knowledge/product/task-scenarios/meeting-to-proposal-pptx.json');

    expect(validate(scenario), JSON.stringify(validate.errors, null, 2)).toBe(true);
    expect(scenario).toMatchObject({
      id: 'meeting-to-proposal-pptx',
      repeat_run: {
        pipeline_template: 'knowledge/product/pipeline-templates/meeting-to-pptx-workflow.json',
        params_from_profile: true,
      },
      result: {
        artifacts: ['proposal-deck.pptx', 'deck-brief.json'],
      },
      approval_boundary: {
        required_for: ['send_external', 'finalize_deck'],
        default_action: 'requires-human-approval',
      },
    });
  });
});
