/** Real standard process definitions + stored gate evaluation; publication transport is synthetic. */
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { seedFirstJobTestRoot } from '../../../scripts/fixtures/first-job-approval-fixture.js';
import { safeRmSync as removeRoot } from '../secure-io.js';
const transport = vi.hoisted(() => ({
  proof: vi.fn(async (): Promise<{ ok: boolean; reason: string; waiting?: boolean }> => ({
    ok: false,
    reason: 'Synthetic merge CI pending',
  })),
}));
const original = process.cwd();
const root = path.join(original, 'active/shared/tmp', `development-gate-${randomUUID()}`);
const missionId = 'MSN-DEVELOPMENT-STORED-GATE';
const development = {
  cwd: '.',
  repository_url: 'https://github.com/owner/repository',
  source_edit_paths: ['libs/core/example.ts'],
  implementation_task_id: 'execution-implement',
  review_task_id: 'self_review-code-review',
  title: 'fix: improve',
  body_file: 'evidence/pr-body.md',
};
let authority: typeof import('../authority.js');
let io: typeof import('../secure-io.js');
let planner: typeof import('./mission-process-planning.js');
let machine: typeof import('../../../scripts/mission_machine_gate.js');
let resolver: typeof import('../path-resolver.js');
let workflow: typeof import('./mission-workflow-catalog.js');
let directory: string;
beforeAll(async () => {
  seedFirstJobTestRoot(original, root);
  process.chdir(root);
  vi.stubEnv('KYBERION_ROOT', root);
  for (const key of [
    'MISSION_ID',
    'KYBERION_TENANT',
    'KYBERION_PROJECT_ID',
    'KYBERION_TASK_ID',
    'KYBERION_CUSTOMER',
  ])
    vi.stubEnv(key, '');
  vi.stubEnv('KYBERION_TIER', 'public');
  vi.stubEnv('KYBERION_ORGANIZATION_ID', 'ops');
  vi.resetModules();
  io = await import('../secure-io.js');
  authority = await import('../authority.js');
  planner = await import('./mission-process-planning.js');
  machine = await import('../../../scripts/mission_machine_gate.js');
  resolver = await import('../path-resolver.js');
  workflow = await import('./mission-workflow-catalog.js');
}, 60000);
afterAll(() => {
  process.chdir(original);
  vi.unstubAllEnvs();
  removeRoot(root, { recursive: true, force: true });
});
describe('stored development completion gates', () => {
  it('uses real standard definitions and schema for machine-only completion without human overrides', async () =>
    authority.withExecutionContextAsync(
      'mission_controller',
      async () => {
        const { installMissionDevelopmentProofVerifier } =
          await import('./mission-development-gates.js');
        installMissionDevelopmentProofVerifier(transport.proof);
        directory = resolver.pathResolver.missionDir(missionId, 'public');
        io.safeMkdir(path.join(directory, 'evidence'), { recursive: true });
        const design = workflow.resolveMissionWorkflowDesign({
          missionClass: 'code_change',
          deliveryShape: 'single_artifact',
          riskProfile: 'review_required',
          stage: 'planning',
          executionShape: 'mission',
          missionTypeHint: 'development',
        });
        io.safeWriteFile(
          path.join(directory, 'mission-state.json'),
          JSON.stringify({
            mission_id: missionId,
            tier: 'public',
            organization_id: 'ops',
            status: 'active',
            execution_mode: 'local',
            priority: 1,
            assigned_persona: 'tester',
            confidence_score: 1,
            relationships: {},
            git: {
              branch: 'agent/kyberion-development',
              start_commit: 'a'.repeat(40),
              latest_commit: 'b'.repeat(40),
              checkpoints: [],
            },
            history: [],
            process_template: {
              workflow_id: design.workflow_id,
              pattern: design.pattern,
              phases: design.phases,
              phase_specs: design.phase_specs,
            },
          })
        );
        io.safeWriteFile(path.join(directory, 'TASK_BOARD.md'), '# Synthetic development mission');
        planner.applyProcessTemplatePlan({ missionId, missionDir: directory, design });
        io.safeWriteFile(
          path.join(directory, 'evidence/delivery-report.md'),
          '# Existing verified publication report'
        );
        const marker = {
          operation_key: 'admitted:mission:improve',
          request_hash: 'a'.repeat(64),
          development,
          development_hash: createHash('sha256').update(JSON.stringify(development)).digest('hex'),
        };
        io.safeWriteFile(
          path.join(directory, 'evidence/continuous-owner.json'),
          JSON.stringify(marker)
        );
        const ports = {
          evaluateStored: (args: { missionId: string; gateId: string; humanConfirmed: false }) =>
            planner.evaluateStoredMissionGate({ ...args, blocking: true }),
          advance: vi.fn(async () => {}),
          markCompleted: vi.fn(() => 0),
          activate: vi.fn(async () => false),
        };
        await expect(
          machine.runMachineOnlyMissionGate({ missionId, gateId: 'DELIVERY_APPROVED' }, ports)
        ).rejects.toThrow('human or reviewer confirmation');
        planner.configureMissionDevelopmentGates({
          missionId,
          development,
          assertCurrent: () => {},
        });
        const testDefinition = design.phase_specs.find((phase) => phase.id === 'test')!.exit_gate!;
        for (const check of testDefinition.checks)
          if (check.kind === 'evidence_exists' && typeof check.params?.path === 'string')
            io.safeWriteFile(path.join(directory, check.params.path), '# Old test report');
        transport.proof.mockResolvedValue({
          ok: false,
          reason: 'Current CI pending after repair',
          waiting: true,
        });
        const testsPending = await planner.evaluateStoredMissionGate({
          missionId,
          gateId: 'TESTS_PASSED',
        });
        expect(testsPending.evaluation?.checks.map((check) => check.kind)).toContain(
          'evidence_exists'
        );
        expect(
          testsPending.evaluation?.checks.find((check) => check.kind === 'development_ci_verified')
            ?.passed
        ).toBe(false);
        await expect(
          machine.runMachineOnlyMissionGate({ missionId, gateId: 'TESTS_PASSED' }, ports)
        ).rejects.toThrow('[DEVELOPMENT_CI_WAITING]');
        expect(ports.advance).not.toHaveBeenCalled();
        transport.proof.mockResolvedValue({ ok: false, reason: 'Merge CI pending' });
        const pending = await planner.evaluateStoredMissionGate({
          missionId,
          gateId: 'DELIVERY_APPROVED',
        });
        expect(pending.evaluation?.verdict).toBe('fail');
        expect(pending.evaluation?.checks.map((check) => check.kind)).toEqual([
          'evidence_exists',
          'development_publication_verified',
        ]);
        await expect(
          machine.runMachineOnlyMissionGate({ missionId, gateId: 'DELIVERY_APPROVED' }, ports)
        ).rejects.toThrow('checks failed');
        expect(ports.advance).not.toHaveBeenCalled();
        transport.proof.mockResolvedValue({ ok: true, reason: '' });
        expect(
          await machine.runMachineOnlyMissionGate({ missionId, gateId: 'DELIVERY_APPROVED' }, ports)
        ).toMatchObject({ verdict: 'pass' });
        expect(transport.proof).toHaveBeenCalledWith(missionId, development);
        expect(
          await machine.runMachineOnlyMissionGate({ missionId, gateId: 'TESTS_PASSED' }, ports)
        ).toMatchObject({ verdict: 'pass' });
        expect(transport.proof).toHaveBeenCalledWith(missionId, development, 'ci');
        expect(ports.advance).toHaveBeenCalledWith(missionId, 'delivery');
        const code = await planner.evaluateStoredMissionGate({
          missionId,
          gateId: 'CODE_REVIEW_PASSED',
        });
        expect(code.evaluation?.verdict).toBe('pass');
        expect(transport.proof).toHaveBeenCalledWith(missionId, development, 'review');
        expect(
          workflow
            .resolveMissionWorkflowDesign({
              missionClass: 'code_change',
              deliveryShape: 'single_artifact',
              riskProfile: 'review_required',
              stage: 'planning',
              executionShape: 'mission',
            })
            .phase_specs.find((phase) => phase.id === 'delivery')
            ?.exit_gate?.checks.some((check) => check.kind === 'human_override')
        ).toBe(true);
        io.safeWriteFile(
          path.join(directory, 'evidence/continuous-owner.json'),
          JSON.stringify({ ...marker, development_hash: 'b'.repeat(64) })
        );
        expect(
          (await planner.evaluateStoredMissionGate({ missionId, gateId: 'DELIVERY_APPROVED' }))
            .evaluation?.verdict
        ).toBe('fail');
      },
      undefined,
      undefined,
      'ops'
    ));
});
