import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { pathResolver, safeExistsSync, safeReadFile, safeReaddir } from '@agent/core';

function loadJson(relativePath: string): any {
  return JSON.parse(safeReadFile(pathResolver.rootResolve(relativePath), { encoding: 'utf8' }) as string);
}

function buildScenario(trigger: Record<string, unknown>) {
  return {
    id: 'daily-email-triage',
    title: '毎朝のメール重要度仕分け',
    description: '重要メールを抽出し、返信下書きと要約を作成する。',
    trigger,
    input: {
      sources: ['gmail'],
      required_params: ['mailbox', 'reply_policy'],
    },
    first_run: {
      reasoning_required: true,
      questions: [
        '重要メールとして扱う条件は何か',
        '返信下書きに含めてよい情報の範囲はどこまでか',
      ],
      profile_output: 'knowledge/personal/task-profiles/daily-email-triage.json',
    },
    repeat_run: {
      pipeline_template: 'knowledge/product/pipeline-templates/email-triage-and-reply-draft.json',
      params_from_profile: true,
    },
    result: {
      artifacts: ['email-triage.md', 'reply-drafts.json'],
      summary_format: 'markdown',
    },
    approval_boundary: {
      required_for: ['send_email'],
      default_action: 'draft-only',
    },
  };
}

describe('TaskScenario schema contract', () => {
  it('validates the example and representative trigger variants', () => {
    const schema = loadJson('schemas/task-scenario.schema.json');
    const example = loadJson('knowledge/product/schemas/task-scenario.example.json');
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);

    const exampleValid = validate(example);
    expect(exampleValid, ajv.errorsText(validate.errors)).toBe(true);

    for (const trigger of [
      { type: 'schedule', cron: '0 8 * * 1-5', timezone: 'Asia/Tokyo' },
      { type: 'event', event_name: 'meeting.completed', source: 'meeting-actuator' },
      { type: 'manual', prompt: '毎朝メールを整理して' },
    ]) {
      const valid = validate(buildScenario(trigger));
      expect(valid, ajv.errorsText(validate.errors)).toBe(true);
    }
  });

  it('validates every committed TaskScenario JSON file', () => {
    const schema = loadJson('schemas/task-scenario.schema.json');
    const scenarioDir = pathResolver.rootResolve('knowledge/product/task-scenarios');
    const files = safeExistsDir(scenarioDir)
      ? safeReaddir(scenarioDir)
          .filter((entry) => entry.endsWith('.json'))
          .map((entry) => pathResolver.rootResolve(`knowledge/product/task-scenarios/${entry}`))
      : [];
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);

    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const scenario = JSON.parse(safeReadFile(file, { encoding: 'utf8' }) as string);
      const valid = validate(scenario);
      expect(valid, `${file}: ${ajv.errorsText(validate.errors)}`).toBe(true);
    }
  });

  it('exposes the required TaskScenario fields and trigger modes', () => {
    const schema = loadJson('schemas/task-scenario.schema.json');

    expect(schema.required).toEqual([
      'id',
      'title',
      'description',
      'trigger',
      'input',
      'first_run',
      'repeat_run',
      'result',
      'approval_boundary',
    ]);

    expect(schema.properties.trigger.oneOf.map((variant: { properties?: { type?: { const?: string } } }) => variant.properties?.type?.const)).toEqual([
      'schedule',
      'event',
      'manual',
    ]);
  });
});

function safeExistsDir(dir: string): boolean {
  return safeExistsSync(dir);
}
