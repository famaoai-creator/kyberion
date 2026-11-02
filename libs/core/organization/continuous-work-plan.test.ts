import { describe, expect, it } from 'vitest';
import { parseContinuousWorkPlan } from './continuous-work-plan.js';
import { parseContinuousOperationsConfig } from './continuous-operations-policy.js';
import { normalizeDotProposal } from '../dot/dot-proposals.js';
import { dotProposalHash } from '../dot/dot-action-ledger.js';
const mission = {
  key: 'investigate',
  title: 'Investigate errors',
  goal: 'Find cause',
  success_condition: 'Cause verified',
};
const development = {
  cwd: '.',
  repository_url: 'https://github.com/owner/repository',
  source_edit_paths: ['libs/core/example.ts'],
  implementation_task_id: 'execution-implement',
  review_task_id: 'self_review-code-review',
  title: 'fix: restore reliability',
  body_file: 'evidence/pr-body.md',
  max_repairs: 2,
};
describe('continuous managed work plan', () => {
  it('refuses development descriptors on unrelated process templates before admission', () => {
    expect(() =>
      parseContinuousWorkPlan({
        kind: 'mission',
        missions: [{ ...mission, development, mission_type: 'operations_report' }],
      })
    ).toThrow('development mission process');
    expect(
      parseContinuousWorkPlan({
        kind: 'mission',
        missions: [{ ...mission, development, mission_type: 'development' }],
      }).missions[0]?.mission_type
    ).toBe('development');
  });
  it('requires one isolated development run while retaining mixed and nondevelopment mission groups', () => {
    const first = { ...mission, development };
    const second = { ...mission, key: 'followup', depends_on: [mission.key] };
    expect(
      parseContinuousWorkPlan({ kind: 'mission_group', missions: [first, second] }).missions
    ).toHaveLength(2);
    expect(() =>
      parseContinuousWorkPlan({
        kind: 'mission_group',
        missions: [first, { ...second, development }],
      })
    ).toThrow('one development mission');
    expect(
      parseContinuousWorkPlan({ kind: 'mission_group', missions: [mission, second] }).missions
    ).toHaveLength(2);
  });
  it.each(['public', 'confidential', 'personal'] as const)(
    'reaches the development parser through the actual continuous config in %s scope',
    (tier) => {
      const config = parseContinuousOperationsConfig({
        version: '1',
        loop_id: 'development-loop',
        dot_id: 'operator',
        scope: {
          tier,
          organization_id: 'ops',
          project_id: 'development',
          ...(tier === 'confidential' ? { tenant_slug: 'acme' } : {}),
        },
        enabled: false,
        max_proposals_per_run: 1,
        cooldown_seconds: 60,
        sources: [
          { source_id: 'organization', kind: 'organization_metrics', max_age_seconds: 300 },
        ],
        rules: [
          {
            rule_id: 'development',
            source_id: 'organization',
            metric: 'open_incidents',
            operator: 'gt',
            threshold: 0,
            objective_ref: 'reliability',
            title: 'Improve',
            objective: 'Fix the reviewed issue',
            pipeline_ref: 'pipelines/continuous-managed-work.json',
            work_plan: { kind: 'mission', missions: [{ ...mission, development }] },
          },
        ],
      });
      expect(config.rules[0]?.work_plan?.missions[0]?.development).toEqual(development);
    }
  );
  it('binds the bounded development descriptor into the admitted proposal identity', () => {
    const plan = parseContinuousWorkPlan({
      kind: 'mission',
      missions: [{ ...mission, development }],
    });
    expect(plan.missions[0]?.development).toEqual(development);
    const normalized = normalizeDotProposal({
      title: 'Fix',
      objective: 'Restore service',
      work_shape: 'pipeline',
    });
    const first = dotProposalHash('operator', { ...normalized, continuous_work: plan });
    const changed = parseContinuousWorkPlan({
      kind: 'mission',
      missions: [
        { ...mission, development: { ...development, title: 'Different reviewed effect' } },
      ],
    });
    expect(first).not.toBe(
      dotProposalHash('operator', { ...normalized, continuous_work: changed })
    );
  });
  it.each([
    { cwd: '../other-checkout' },
    { cwd: '/other-checkout' },
    { cwd: 'worktree' },
    { source_edit_paths: [] },
    { source_edit_paths: ['libs/core/'] },
    { source_edit_paths: ['libs/core/*.ts'] },
    { source_edit_paths: ['libs/core/../example.ts'] },
    { source_edit_paths: ['libs/core/.git/config'] },
    { source_edit_paths: ['.git/config'] },
    { source_edit_paths: ['active/shared/tmp/code.ts'] },
    { source_edit_paths: ['knowledge/personal/private.ts'] },
    { source_edit_paths: ['libs/core/example.ts', 'libs/core/example.ts'] },
    { source_edit_paths: Array.from({ length: 65 }, (_, index) => `libs/core/file-${index}.ts`) },
    { repository_url: 'https://user:secret@github.com/owner/repository' },
    { repository_url: 'file:///owner/repository' },
    { repository_url: 'https://github.com/owner/repository?token=secret' },
    { body_file: 'evidence/../secret' },
    { body_file: 'knowledge/personal/body.md' },
    { review_task_id: development.implementation_task_id },
    { max_repairs: 4 },
    { max_repairs: -1 },
    { max_repairs: 0.5 },
    { approved: true },
  ])('rejects unsafe or self-authorizing development inputs: %j', (change) => {
    expect(() =>
      parseContinuousWorkPlan({
        kind: 'mission',
        missions: [{ ...mission, development: { ...development, ...change } }],
      })
    ).toThrow();
  });
  it('accepts a bounded dependency graph and rejects cycles, dangling keys and duplicates', () => {
    const valid = {
      kind: 'mission_group',
      missions: [mission, { ...mission, key: 'fix', depends_on: ['investigate'] }],
    };
    expect(parseContinuousWorkPlan(valid).missions).toHaveLength(2);
    expect(() =>
      parseContinuousWorkPlan({
        ...valid,
        missions: [{ ...mission, depends_on: ['fix'] }, valid.missions[1]],
      })
    ).toThrow('Cyclic');
    expect(() =>
      parseContinuousWorkPlan({ ...valid, missions: [{ ...mission, depends_on: ['missing'] }] })
    ).toThrow('Unknown');
    expect(() => parseContinuousWorkPlan({ ...valid, missions: [mission, mission] })).toThrow(
      'Duplicate'
    );
  });
  it('requires project data only for project plans and strictly rejects unknown authority fields', () => {
    expect(() => parseContinuousWorkPlan({ kind: 'project', missions: [mission] })).toThrow(
      'project'
    );
    expect(() =>
      parseContinuousWorkPlan({ kind: 'mission', missions: [mission], actor: 'user:invented' })
    ).toThrow('unknown');
    expect(() =>
      parseContinuousWorkPlan({ kind: 'mission', missions: [{ ...mission, key: '../escape' }] })
    ).toThrow();
  });
  it('model normalization strips managed authority and dedupe hashes bind trusted plans', () => {
    const proposal = {
      title: 'Investigate',
      objective: 'Fix failures',
      work_shape: 'pipeline',
      continuous_work: { kind: 'mission', missions: [mission] },
    };
    const normalized = normalizeDotProposal(proposal);
    expect(normalized.continuous_work).toBeUndefined();
    const trusted = {
      ...normalized,
      continuous_work: parseContinuousWorkPlan(proposal.continuous_work),
    };
    expect(dotProposalHash('operator', normalized)).not.toBe(dotProposalHash('operator', trusted));
    expect(dotProposalHash('operator', trusted)).not.toBe(
      dotProposalHash('operator', {
        ...trusted,
        continuous_work: {
          ...trusted.continuous_work,
          missions: [{ ...mission, goal: 'Different effect' }],
        },
      })
    );
  });
});
