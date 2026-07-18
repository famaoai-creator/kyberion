import { afterEach, describe, expect, it } from 'vitest';
import {
  buildAutomationFormSchema,
  buildAutomationQuestionSeed,
  buildAutomationSlashCommand,
  createAutomationBlueprintFromPipeline,
  findAutomationBlueprint,
  loadAutomationBlueprint,
  parseAutomationSlashRequest,
  registerAutomationBlueprint,
  resolveAutomationBlueprint,
} from './automation-blueprint.js';
import { loadScheduleRegistry } from './src/pipeline-scheduler.js';
import { pathResolver } from './path-resolver.js';
import { safeRmSync } from './secure-io.js';

const source = {
  name: 'Daily report',
  schedule: {
    id: 'daily-report',
    cron: '30 3 * * *',
    timezone: 'Asia/Tokyo',
    deliver_to: {
      surface: 'slack',
      channel: '#ops',
      thread_ts: 'daily',
      template: '{{pipeline_name}}: {{status}}',
    },
  },
};

describe('automation-blueprint', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) safeRmSync(root, { recursive: true, force: true });
  });

  it('derives one slot schema and uses it for question, slash, and form surfaces', () => {
    const blueprint = createAutomationBlueprintFromPipeline('pipelines/daily-report.json', source);
    const slotIds = blueprint.slots.map((slot) => slot.id);

    expect(slotIds).toEqual(['minute', 'hour', 'delivery_channel']);
    expect(
      buildAutomationQuestionSeed(blueprint).questions.map((question) => question.slot_id)
    ).toEqual(slotIds);
    expect(buildAutomationSlashCommand(blueprint).options.map((option) => option.name)).toEqual(
      slotIds
    );
    expect(buildAutomationFormSchema(blueprint).fields.map((field) => field.id)).toEqual(slotIds);
  });

  it('resolves slot values into a Chronos schedule without requiring cron input', () => {
    const blueprint = createAutomationBlueprintFromPipeline('pipelines/daily-report.json', source);
    const resolved = resolveAutomationBlueprint(blueprint, {
      minute: 15,
      hour: 8,
      delivery_channel: '#engineering',
    });

    expect(resolved.schedule).toMatchObject({
      id: 'daily-report',
      cron: '15 8 * * *',
      timezone: 'Asia/Tokyo',
      deliver_to: {
        surface: 'slack',
        channel: '#engineering',
        thread_ts: 'daily',
      },
    });
  });

  it('keeps defaults and rejects invalid slot values', () => {
    const blueprint = createAutomationBlueprintFromPipeline('pipelines/daily-report.json', source);
    expect(resolveAutomationBlueprint(blueprint).schedule.cron).toBe('30 3 * * *');
    expect(() => resolveAutomationBlueprint(blueprint, { hour: 24 })).toThrow(
      /Invalid numeric automation slot: hour/
    );
    expect(() =>
      createAutomationBlueprintFromPipeline('../pipelines/daily-report.json', source)
    ).toThrow(/must stay under pipelines/);
  });

  it('parses a governed slash request and registers the resolved schedule', () => {
    const request = parseAutomationSlashRequest(
      'schedule daily-report minute=15 hour=8 delivery_channel=C123'
    );
    expect(request).toEqual({
      blueprint_id: 'daily-report',
      values: { minute: '15', hour: '8', delivery_channel: 'C123' },
      open_form: false,
    });

    const rootDir = pathResolver.sharedTmp(`automation-blueprint-${Date.now()}`);
    tempRoots.push(rootDir);
    const entry = {
      blueprint: createAutomationBlueprintFromPipeline('pipelines/daily-report.json', source),
      pipeline: { steps: [], ...source },
    };
    const registered = registerAutomationBlueprint(entry, request.values, { rootDir });

    expect(registered.scheduled).toMatchObject({
      id: 'daily-report',
      pipelinePath: pathResolver.rootResolve('pipelines/daily-report.json'),
      trigger: { type: 'cron', cron: '15 8 * * *', timezone: 'Asia/Tokyo' },
      deliver_to: { surface: 'slack', channel: 'C123', thread_ts: 'daily' },
    });
    expect(loadScheduleRegistry({ rootDir }).schedules).toEqual([
      expect.objectContaining({
        id: 'daily-report',
        trigger: expect.objectContaining({ cron: '15 8 * * *' }),
      }),
    ]);
  });

  it('loads only validated schedule-backed pipelines from the catalog', () => {
    const loaded = loadAutomationBlueprint('pipelines/background-review-curator.json');
    expect(loaded.blueprint.blueprint_id).toBe('background-review-curator');
    expect(findAutomationBlueprint('background-review-curator').pipeline.schedule?.cron).toBe(
      '30 3 * * *'
    );
    expect(() =>
      parseAutomationSlashRequest('schedule background-review-curator hour=3 hour=4')
    ).toThrow(/Duplicate slot assignment/);
  });
});
