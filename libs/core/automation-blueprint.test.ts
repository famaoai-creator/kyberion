import { afterEach, describe, expect, it } from 'vitest';
import {
  buildAutomationFormSchema,
  buildAutomationQuestionSeed,
  buildAutomationSlashCommand,
  createAutomationBlueprintFromPipeline,
  findAutomationBlueprint,
  listMissingAutomationBindingIntroductions,
  loadAutomationBlueprint,
  matchesAutomationBlueprintVocabulary,
  parseAutomationSlashRequest,
  reconcileAutomationBlueprintSeed,
  registerAutomationBlueprint,
  requestMissingAutomationBindingIntroductions,
  resolveAutomationBlueprint,
  validateAutomationBlueprintBindings,
} from './automation-blueprint.js';
import { CloudflareOsControlPlane } from './cloudflare-os-control-plane.js';
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

  it('carries credential-free binding shapes from the pipeline context', () => {
    const blueprint = createAutomationBlueprintFromPipeline('pipelines/gadget.json', {
      ...source,
      context: {
        required_bindings: [
          {
            name: 'slack_publish',
            service: 'slack',
            preset: 'post_message',
            secret: 'SLACK_TOKEN',
          },
        ],
        vocabulary: { proposal: '提案書' },
        fingerprint: 'gadget-seed-v1',
      },
    });

    expect(blueprint.required_bindings).toEqual([
      {
        name: 'slack_publish',
        service: 'slack',
        preset: 'post_message',
        secret: 'SLACK_TOKEN',
      },
    ]);
    expect(blueprint.vocabulary).toEqual({ proposal: '提案書' });
    expect(blueprint.fingerprint).toBe('gadget-seed-v1');
    expect(listMissingAutomationBindingIntroductions(blueprint, {})).toEqual(
      blueprint.required_bindings
    );
    expect(() => validateAutomationBlueprintBindings(blueprint, {})).toThrow(
      'Missing required automation bindings: slack_publish'
    );
    expect(validateAutomationBlueprintBindings(blueprint, ['slack_publish'])).toEqual([
      'slack_publish',
    ]);
  });

  it('rejects binding values disguised as blueprint shape declarations', () => {
    expect(() =>
      createAutomationBlueprintFromPipeline('pipelines/gadget.json', {
        ...source,
        context: {
          required_bindings: [
            { name: 'slack_publish', service: 'slack', secret: 'actual secret value' },
          ],
        },
      })
    ).toThrow('credential-free name shape');
    expect(() =>
      createAutomationBlueprintFromPipeline('pipelines/gadget.json', {
        ...source,
        context: {
          required_bindings: [
            { name: 'slack_publish', service: 'slack', secret: 'xoxb-123456789012345678901234' },
          ],
        },
      })
    ).toThrow('secret must be a reference name');
    expect(() =>
      createAutomationBlueprintFromPipeline('pipelines/gadget.json', {
        ...source,
        context: {
          required_bindings: [
            {
              name: 'slack_publish',
              service: 'slack',
              secret: 'SLACK_TOKEN',
              value: 'actual-secret-value',
            },
          ],
        },
      })
    ).toThrow('Unknown blueprint binding property');
  });

  it('turns missing bindings into held OS-03 introduction requests', () => {
    const plane = new CloudflareOsControlPlane({ persist: false });
    const blueprint = createAutomationBlueprintFromPipeline('pipelines/gadget.json', {
      ...source,
      context: {
        required_bindings: [{ name: 'slack_publish', service: 'slack', secret: 'SLACK_TOKEN' }],
      },
    });

    const requests = requestMissingAutomationBindingIntroductions(
      blueprint,
      {},
      {
        controlPlane: plane,
        missionId: 'mission-automation-binding',
        taskId: 'task-automation-binding',
        requestedBy: 'worker',
        scope: 'write',
        resourceRefs: { slack_publish: 'team:T1' },
      }
    );

    expect(requests).toHaveLength(1);
    expect(requests[0].request).toMatchObject({
      missionId: 'mission-automation-binding',
      taskId: 'task-automation-binding',
      op: 'resource:introduction',
      params: {
        service: 'slack',
        resourceRef: 'team:T1',
        scope: 'write',
      },
      status: 'pending',
    });
    expect(JSON.stringify(requests[0].request)).not.toContain('SLACK_TOKEN');
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

  it('rejects an external scheduled pipeline path', () => {
    const entry = {
      blueprint: createAutomationBlueprintFromPipeline('pipelines/daily-report.json', source),
      pipeline: { steps: [], ...source },
    };

    expect(() =>
      registerAutomationBlueprint(
        entry,
        {},
        {
          pipelinePath: '/tmp/automation-pipeline-external.json',
          rootDir: pathResolver.sharedTmp(`automation-external-${Date.now()}`),
        }
      )
    ).toThrow('RESOURCE_PATH_SCOPE');
  });

  it('refuses to register a blueprint before required bindings are wired', () => {
    const blueprint = createAutomationBlueprintFromPipeline('pipelines/gadget.json', {
      ...source,
      context: {
        required_bindings: [{ name: 'calendar_read', service: 'google_calendar' }],
      },
    });
    expect(() =>
      registerAutomationBlueprint(
        { blueprint, pipeline: { steps: [], ...source } },
        {},
        { rootDir: pathResolver.sharedTmp(`automation-binding-${Date.now()}`) }
      )
    ).toThrow('Missing required automation bindings: calendar_read');
  });

  it('returns held introduction requests instead of scheduling an unwired blueprint', () => {
    const plane = new CloudflareOsControlPlane({ persist: false });
    const blueprint = createAutomationBlueprintFromPipeline('pipelines/gadget.json', {
      ...source,
      context: {
        required_bindings: [{ name: 'calendar_read', service: 'google_calendar' }],
      },
    });
    const result = registerAutomationBlueprint(
      { blueprint, pipeline: { steps: [], ...source } },
      {},
      {
        introductions: {
          controlPlane: plane,
          missionId: 'mission-automation-register',
          requestedBy: 'worker',
          scope: 'read',
          resourceRefs: { calendar_read: 'calendar:primary' },
        },
        rootDir: pathResolver.sharedTmp(`automation-introduction-${Date.now()}`),
      }
    );

    expect(result.scheduled).toBeUndefined();
    expect(result.introductionRequests).toHaveLength(1);
  });

  it('sanitizes binding declarations before writing scheduled context', () => {
    const blueprint = createAutomationBlueprintFromPipeline('pipelines/gadget.json', {
      ...source,
      context: {
        required_bindings: [{ name: 'slack_publish', service: 'slack' }],
      },
    });
    const rootDir = pathResolver.sharedTmp(`automation-context-${Date.now()}`);
    tempRoots.push(rootDir);
    const registered = registerAutomationBlueprint(
      {
        blueprint,
        pipeline: {
          steps: [],
          ...source,
          context: {
            required_bindings: [
              { name: 'slack_publish', service: 'slack', value: 'actual-secret-value' },
            ],
          },
        },
      },
      {},
      { rootDir, bindings: ['slack_publish'] }
    );

    expect(registered.scheduled?.context).toEqual({
      required_bindings: [{ name: 'slack_publish', service: 'slack' }],
    });
  });

  it('resolves vocabulary and preserves operator-customized seeds', () => {
    const blueprint = createAutomationBlueprintFromPipeline('pipelines/gadget.json', {
      ...source,
      context: {
        vocabulary: { proposal: '提案書' },
        fingerprint: 'gadget-seed-v1',
      },
    });
    expect(matchesAutomationBlueprintVocabulary(blueprint, '提案書')).toBe(true);
    expect(matchesAutomationBlueprintVocabulary(blueprint, 'proposal')).toBe(true);

    const shipped = { ...blueprint, name: 'Updated', fingerprint: 'gadget-seed-v2' };
    expect(reconcileAutomationBlueprintSeed(blueprint, blueprint, shipped)).toEqual({
      blueprint: shipped,
      action: 'update',
    });
    const customized = { ...blueprint, name: 'Operator custom' };
    expect(reconcileAutomationBlueprintSeed(customized, blueprint, shipped)).toEqual({
      blueprint: customized,
      action: 'preserve',
    });
  });

  it('loads the catalog pipeline that declares a real binding shape', () => {
    const loaded = loadAutomationBlueprint('pipelines/action-item-reminders.json');
    expect(loaded.blueprint.required_bindings).toEqual([
      {
        name: 'slack_publish',
        service: 'slack',
        preset: 'outbox',
        secret: 'SLACK_BOT_TOKEN',
      },
    ]);
    expect(loaded.blueprint.vocabulary).toEqual({ reminder: 'リマインダー' });
    expect(loaded.blueprint.fingerprint).toBe('action-item-reminders-v2');
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
