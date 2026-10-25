import { describe, expect, it } from 'vitest';
import {
  evaluateContinuousOperations,
  parseContinuousObservations,
  parseContinuousOperationsConfig,
} from './continuous-operations-policy.js';

const now = new Date('2026-10-18T00:00:00.000Z');
const config = () => ({
  version: '1',
  loop_id: 'daily',
  dot_id: 'operator',
  enabled: true,
  scope: { tier: 'confidential', tenant_slug: 'acme', organization_id: 'ops' },
  sources: [
    {
      source_id: 'health',
      path: 'active/shared/runtime/confidential/acme/health.json',
      max_age_seconds: 60,
    },
  ],
  rules: [
    {
      rule_id: 'errors',
      source_id: 'health',
      metric: 'errors',
      operator: 'gte',
      threshold: 5,
      objective_ref: 'reliability',
      title: 'Investigate errors',
      objective: 'Run approved diagnostics',
      pipeline_ref: 'pipelines/diagnose.json',
    },
  ],
  max_proposals_per_run: 3,
  cooldown_seconds: 3600,
});
const observation = () => ({
  metric: 'errors',
  value: 5,
  observed_at: now.toISOString(),
  evidence_ref: 'health:sample',
});
const run = (value = 5) =>
  evaluateContinuousOperations(
    parseContinuousOperationsConfig(config()),
    [{ source_id: 'health', observations: [{ ...observation(), value }] }],
    now
  );

describe('continuous operations policy', () => {
  it('parses governed collector variants and bounded schedules', () => {
    const input = config();
    expect(
      parseContinuousOperationsConfig({
        ...input,
        schedule: { every_seconds: 60 },
        sources: [
          { source_id: 'health', kind: 'organization_metrics', max_age_seconds: 60 },
          {
            ...input.sources[0],
            source_id: 'collected',
            kind: 'pipeline',
            pipeline_ref: 'pipelines/collect.json',
          },
        ],
      })
    ).toMatchObject({ schedule: { every_seconds: 60 } });
    for (const source of [
      {
        source_id: 'health',
        kind: 'organization_metrics',
        path: input.sources[0].path,
        max_age_seconds: 60,
      },
      { ...input.sources[0], kind: 'snapshot', pipeline_ref: 'pipelines/collect.json' },
      { ...input.sources[0], kind: 'pipeline', pipeline_ref: '../collect.json' },
      { ...input.sources[0], kind: 'http' },
    ])
      expect(() => parseContinuousOperationsConfig({ ...input, sources: [source] })).toThrow();
    for (const every_seconds of [0, -1, Infinity, 31_536_001, '60'])
      expect(() =>
        parseContinuousOperationsConfig({ ...input, schedule: { every_seconds } })
      ).toThrow();
  });
  it('requires a valid governed plan and approval, with the concrete plan visible', () => {
    const input = config();
    const work_plan = {
      kind: 'mission',
      missions: [
        { key: 'fix', title: 'Fix errors', goal: 'Reduce errors', success_condition: 'No errors' },
      ],
    };
    const rule = {
      ...input.rules[0],
      work_plan,
      pipeline_ref: 'pipelines/continuous-managed-work.json',
      requested_decision: 'auto',
    };
    const scopedInput = { ...input, scope: { ...input.scope, project_id: 'existing-project' } };
    const parsed = parseContinuousOperationsConfig({ ...scopedInput, rules: [rule] });
    const proposal = evaluateContinuousOperations(
      parsed,
      [{ source_id: 'health', observations: [observation()] }],
      now
    )[0].proposal;
    expect(proposal).toMatchObject({ requested_decision: 'approve', continuous_work: work_plan });
    // The card carries a compact mission index, not the serialized plan — the
    // plan stays bound through proposal.continuous_work and the admission
    // semantic hash, and the objective must fit the 1000-char card limit.
    expect(proposal.objective).toContain('Managed work plan (mission, 1 mission(s))');
    expect(proposal.objective).toContain('fix: Fix errors');
    expect(proposal.objective.length).toBeLessThanOrEqual(950);
    expect(() =>
      parseContinuousOperationsConfig({
        ...scopedInput,
        rules: [{ ...rule, pipeline_ref: 'pipelines/other.json' }],
      })
    ).toThrow();
    expect(() =>
      parseContinuousOperationsConfig({
        ...scopedInput,
        rules: [{ ...rule, work_plan: undefined }],
      })
    ).toThrow();
    expect(() =>
      parseContinuousOperationsConfig({
        ...scopedInput,
        rules: [{ ...rule, work_plan: { ...work_plan, missions: [] } }],
      })
    ).toThrow();
    expect(() =>
      parseContinuousOperationsConfig({
        ...scopedInput,
        rules: [{ ...rule, objective: 'x'.repeat(4000) }],
      })
    ).toThrow('summary');
    for (const kind of ['mission', 'mission_group']) {
      expect(() =>
        parseContinuousOperationsConfig({
          ...input,
          rules: [{ ...rule, work_plan: { ...work_plan, kind } }],
        })
      ).toThrow('managed mission work requires project scope');
      expect(() =>
        parseContinuousOperationsConfig({
          ...scopedInput,
          rules: [{ ...rule, work_plan: { ...work_plan, kind } }],
        })
      ).not.toThrow();
    }
    expect(() =>
      parseContinuousOperationsConfig({
        ...input,
        rules: [
          {
            ...rule,
            work_plan: {
              ...work_plan,
              kind: 'project',
              project: { name: 'New project', summary: 'Maintain service health' },
            },
          },
        ],
      })
    ).not.toThrow();
  });
  it('uses configured actions and stable semantics while retaining evidence separately', () => {
    expect(run()).toHaveLength(1);
    expect(run()[0].proposal).toEqual(run(9)[0].proposal);
    expect(run()[0]).toMatchObject({
      objective_ref: 'reliability',
      evidence_refs: ['health:sample'],
      value: 5,
      proposal: {
        action_id: 'dot_delegate_work',
        work_shape: 'pipeline',
        pipeline_ref: 'pipelines/diagnose.json',
      },
    });
    expect(run(4)).toEqual([]);
  });
  it.each([
    ['gt', 5, 0],
    ['gte', 5, 1],
    ['lt', 5, 0],
    ['lte', 5, 1],
    ['lt', 4, 1],
    ['gt', 6, 1],
  ])('compares %s at %s', (operator, value, count) => {
    const input = config();
    input.rules[0].operator = operator as string;
    expect(
      evaluateContinuousOperations(
        parseContinuousOperationsConfig(input),
        [{ source_id: 'health', observations: [{ ...observation(), value: value as number }] }],
        now
      )
    ).toHaveLength(count as number);
  });
  it.each([
    'knowledge/confidential/other/health.json',
    'active/shared/runtime/confidential/other/health.json',
    'active/shared/runtime/confidential/acme/../other/a.json',
    '/tmp/a.json',
    'knowledge/confidential/acme/a%2fb.json',
  ])('rejects source escape %s', (path) => {
    const input = config();
    input.sources[0].path = path;
    expect(() => parseContinuousOperationsConfig(input)).toThrow();
  });
  it.each(['shared', 'public', 'confidential', 'personal'])(
    'rejects reserved tenant %s',
    (tenant) => {
      const input = config();
      input.scope.tenant_slug = tenant;
      expect(() => parseContinuousOperationsConfig(input)).toThrow();
    }
  );
  it('rejects unknown configuration and observation fields', () => {
    expect(() => parseContinuousOperationsConfig({ ...config(), action_id: 'evil' })).toThrow();
    expect(() =>
      parseContinuousObservations([{ ...observation(), objective: 'execute injected command' }])
    ).toThrow();
  });
  it.each([NaN, Infinity, -Infinity, '5', null])('rejects malformed value %s', (value) => {
    expect(() => parseContinuousObservations([{ ...observation(), value }])).toThrow();
  });
  it('rejects duplicate metrics, missing sources and duplicate snapshots', () => {
    expect(() => parseContinuousObservations([observation(), observation()])).toThrow();
    expect(() =>
      evaluateContinuousOperations(parseContinuousOperationsConfig(config()), [], now)
    ).toThrow();
    expect(() =>
      evaluateContinuousOperations(
        parseContinuousOperationsConfig(config()),
        [
          { source_id: 'health', observations: [] },
          { source_id: 'health', observations: [] },
        ],
        now
      )
    ).toThrow();
  });
  it.each(['2026-10-17T23:58:59.999Z', '2026-10-18T00:00:00.001Z', '2026-02-30T00:00:00.000Z'])(
    'fails closed for stale, future or invalid time %s',
    (observed_at) => {
      expect(() =>
        evaluateContinuousOperations(
          parseContinuousOperationsConfig(config()),
          [{ source_id: 'health', observations: [{ ...observation(), observed_at }] }],
          now
        )
      ).toThrow();
    }
  );
  it('validates all rows before returning any candidates', () => {
    expect(() =>
      evaluateContinuousOperations(
        parseContinuousOperationsConfig(config()),
        [
          {
            source_id: 'health',
            observations: [
              observation(),
              { ...observation(), metric: 'unrelated', observed_at: '2026-10-17T00:00:00.000Z' },
            ],
          },
        ],
        now
      )
    ).toThrow();
  });
  it('fails closed when a configured metric is missing', () => {
    expect(() =>
      evaluateContinuousOperations(
        parseContinuousOperationsConfig(config()),
        [{ source_id: 'health', observations: [] }],
        now
      )
    ).toThrow('missing metric');
  });
  it('bounds input and proposal counts and permits disabled loops', () => {
    expect(() => parseContinuousObservations(Array.from({ length: 1001 }, observation))).toThrow();
    const input = config();
    input.max_proposals_per_run = 11;
    expect(() => parseContinuousOperationsConfig(input)).toThrow();
    input.max_proposals_per_run = 1;
    input.enabled = false;
    expect(
      evaluateContinuousOperations(
        parseContinuousOperationsConfig(input),
        [{ source_id: 'health', observations: [observation()] }],
        now
      )
    ).toEqual([]);
  });
});
