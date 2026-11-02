import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { withExecutionContext } from '../authority.js';
import { pathResolver } from '../path-resolver.js';
import {
  configureMissionDevelopmentGates,
  evaluateMissionDevelopmentGate,
  type MissionDevelopmentGateDeps,
} from './mission-development-gates.js';

const mocks = vi.hoisted(() => ({
  publication: vi.fn(async () => ({ ok: true })),
}));
const id = 'MSN-DEVELOPMENT-GATE-TEST';
const development = {
  cwd: '.',
  repository_url: 'https://github.com/owner/repository',
  source_edit_paths: ['libs/core/example.ts'],
  implementation_task_id: 'execution-implement',
  review_task_id: 'self_review-code-review',
  title: 'fix: improve',
  body_file: 'evidence/pr-body.md',
};
const hash = createHash('sha256').update(JSON.stringify(development)).digest('hex');
function harness() {
  const directory = pathResolver.rootResolve('active/shared/tmp/vitest-development-gates', id);
  const marker: Record<string, unknown> = {
    operation_key: 'admitted:mission:improve',
    request_hash: 'a'.repeat(64),
    development,
    development_hash: hash,
  };
  const definitions = [
    {
      mission_id: id,
      phase: 'self_review',
      position: 'exit' as const,
      gate: {
        id: 'CODE_REVIEW_PASSED',
        checks: [
          { kind: 'reviewer_approved' as const, params: { task_id: 'self_review-code-review' } },
        ],
      },
    },
    {
      mission_id: id,
      phase: 'delivery',
      position: 'exit' as const,
      gate: {
        id: 'DELIVERY_APPROVED',
        checks: [
          { kind: 'evidence_exists' as const, params: { path: 'evidence/delivery-report.md' } },
          { kind: 'human_override' as const },
        ],
      },
    },
    {
      mission_id: id,
      phase: 'test',
      position: 'exit' as const,
      gate: {
        id: 'TESTS_PASSED',
        checks: [{ kind: 'evidence_exists' as const, params: { path: 'evidence/test-report.md' } }],
      },
    },
  ];
  const write = vi.fn();
  const deps: MissionDevelopmentGateDeps = {
    proof: mocks.publication,
    state: () =>
      ({ mission_id: id, tier: 'public', organization_id: 'ops' }) as ReturnType<
        NonNullable<MissionDevelopmentGateDeps['state']>
      >,
    scope: () =>
      ({ tier: 'public', organization_id: 'ops' }) as ReturnType<
        NonNullable<MissionDevelopmentGateDeps['scope']>
      >,
    missionPath: () => directory,
    read: (file) => {
      expect(file).toBe(path.join(directory, 'evidence/continuous-owner.json'));
      return marker;
    },
    definition: (file) => {
      const definition = definitions.find((row) => path.basename(file) === `${row.gate.id}.json`);
      if (!definition) throw new Error('missing gate');
      return definition;
    },
    write,
  };
  return { directory, marker, definitions, deps, write };
}
describe('owner-bound development phase gates', () => {
  it('fails closed when its executable has not installed a real proof verifier', async () => {
    const h = harness();
    delete h.deps.proof;
    const result = await evaluateMissionDevelopmentGate(
      {
        missionId: id,
        gateId: 'DELIVERY_APPROVED',
        kind: 'development_publication_verified',
        developmentHash: hash,
      },
      h.deps
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('not installed by the host');
  });
  it('specializes exact owner gates without changing generic catalog definitions or evidence checks', () => {
    const h = harness();
    const current = vi.fn();
    withExecutionContext('mission_controller', () =>
      configureMissionDevelopmentGates(
        { missionId: id, development, assertCurrent: current },
        h.deps
      )
    );
    expect(h.write).toHaveBeenCalledTimes(3);
    expect(h.write.mock.calls[0]?.[1].gate.checks).toEqual([
      { kind: 'development_reviews_verified', params: { development_hash: hash } },
    ]);
    expect(h.write.mock.calls[1]?.[1].gate.checks).toEqual([
      { kind: 'evidence_exists', params: { path: 'evidence/delivery-report.md' } },
      { kind: 'development_publication_verified', params: { development_hash: hash } },
    ]);
    expect(h.write.mock.calls[2]?.[1].gate.checks).toEqual([
      { kind: 'evidence_exists', params: { path: 'evidence/test-report.md' } },
      { kind: 'development_ci_verified', params: { development_hash: hash } },
    ]);
    expect(h.definitions[0]?.gate.checks[0]?.kind).toBe('reviewer_approved');
    expect(h.definitions[1]?.gate.checks[1]?.kind).toBe('human_override');
    expect(current).toHaveBeenCalledTimes(4);
  });
  it('refuses stale descriptor or runtime scope without specializing any gate', () => {
    for (const change of ['descriptor', 'scope'] as const) {
      const h = harness();
      if (change === 'descriptor') h.marker.development_hash = 'b'.repeat(64);
      else
        h.deps.scope = () =>
          ({ tier: 'personal', organization_id: 'ops' }) as ReturnType<
            NonNullable<MissionDevelopmentGateDeps['scope']>
          >;
      expect(() =>
        withExecutionContext('mission_controller', () =>
          configureMissionDevelopmentGates(
            { missionId: id, development, assertCurrent: () => {} },
            h.deps
          )
        )
      ).toThrow();
      expect(h.write).not.toHaveBeenCalled();
    }
  });
  it.each(['review', 'decision'] as const)(
    'preserves an explicit different %s contract without partial specialization',
    (change) => {
      const h = harness();
      const original = h.deps.definition!;
      h.deps.definition = (file, missionId) => {
        const definition = original(file, missionId);
        return {
          ...definition,
          gate: {
            ...definition.gate,
            checks: definition.gate.checks.map((check) =>
              change === 'review' && check.kind === 'reviewer_approved'
                ? { ...check, params: { task_id: 'another-review-task' } }
                : change === 'decision' && check.kind === 'human_override'
                  ? { ...check, params: { allow: false } }
                  : check
            ),
          },
        };
      };
      expect(() =>
        withExecutionContext('mission_controller', () =>
          configureMissionDevelopmentGates(
            { missionId: id, development, assertCurrent: () => {} },
            h.deps
          )
        )
      ).toThrow();
      expect(h.write).not.toHaveBeenCalled();
    }
  );
  it('requires the host read-only proof in review mode and publication mode', async () => {
    const h = harness();
    expect(
      await evaluateMissionDevelopmentGate(
        {
          missionId: id,
          gateId: 'CODE_REVIEW_PASSED',
          kind: 'development_reviews_verified',
          developmentHash: hash,
        },
        h.deps
      )
    ).toEqual({ passed: true });
    expect(mocks.publication).toHaveBeenCalledWith(id, development, 'review');
    expect(
      await evaluateMissionDevelopmentGate(
        {
          missionId: id,
          gateId: 'DELIVERY_APPROVED',
          kind: 'development_publication_verified',
          developmentHash: hash,
        },
        h.deps
      )
    ).toEqual({ passed: true });
    expect(mocks.publication).toHaveBeenCalledWith(id, development);
    mocks.publication.mockResolvedValueOnce({ ok: false });
    expect(
      await evaluateMissionDevelopmentGate(
        {
          missionId: id,
          gateId: 'DELIVERY_APPROVED',
          kind: 'development_publication_verified',
          developmentHash: hash,
        },
        h.deps
      )
    ).toMatchObject({ passed: false });
  });
  it('cannot reuse typed development facts for alignment or omit their source binding', async () => {
    const h = harness();
    expect(
      await evaluateMissionDevelopmentGate(
        {
          missionId: id,
          gateId: 'ALIGNMENT_APPROVED',
          kind: 'development_publication_verified',
          developmentHash: hash,
        },
        h.deps
      )
    ).toMatchObject({ passed: false });
    expect(
      await evaluateMissionDevelopmentGate(
        {
          missionId: id,
          gateId: 'DELIVERY_APPROVED',
          kind: 'development_publication_verified',
          developmentHash: undefined,
        },
        h.deps
      )
    ).toMatchObject({ passed: false });
  });
});
