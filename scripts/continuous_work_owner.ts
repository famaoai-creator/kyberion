/** Governed controller adapters for the continuous mission-owner execution surface. */
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { buildExecutionEnv, withExecutionContextAsync } from '@agent/core/authority';
import { safeExistsSync, safeReadFileSnapshot, safeWriteFile } from '@agent/core/secure-io';
import { parseSafeJsonInput } from '@agent/core/foundation/safe-json';
import { pathResolver, findMissionPath } from '@agent/core/path-resolver';
import { loadMissionNextTaskObjectsAtPath } from '@agent/core/mission/mission-next-task-reader';
import { isSupersedeProvenForGate } from '@agent/core/mission/mission-task-supersede-proof';
import { loadState } from '@agent/core/mission/mission-state';
import { DISTILL_MEMORY_OUTBOX_FILE } from '@agent/core/mission/mission-distill';
import { loadProjectRecord } from '@agent/core/project/project-registry';
import { listWorkItems, updateWorkItem } from '@agent/core/workforce/work-coordination';
import {
  runContinuousWorkOwner,
  type ContinuousWorkOwnerPorts,
  type ContinuousWorkOwnerScope,
  type EnsureContinuousMissionInput,
  type AdvanceContinuousMissionInput,
} from '@agent/core/organization/continuous-work-owner';
import { CONTINUOUS_MANAGED_WORK_PIPELINE } from '@agent/core/organization/continuous-work-plan';
import type { DotCharter } from '@agent/core/dot/dot-charter';
import { openAlignmentApproval } from './mission_alignment_request.js';
import { assessAlignmentDecision } from './mission_alignment_decision.js';
import { loadMissionBriefAtPath } from './mission-alignment-gate/mission-brief.js';

import {
  runContinuousOwnerProcess,
  type ContinuousOwnerProcessOptions,
  type ContinuousOwnerProcessResult,
} from './continuous_owner_process.js';
type Exec = (
  command: string,
  args: string[],
  options: ContinuousOwnerProcessOptions
) => Promise<ContinuousOwnerProcessResult>;
export interface ContinuousOwnerAdapterDeps {
  rootDir?: string;
  exec?: Exec;
  project?: typeof loadProjectRecord;
  mission?: typeof loadState;
  missionPath?: typeof findMissionPath;
  read?: (file: string) => unknown;
  write?: (file: string, value: unknown) => void;
  exists?: (file: string) => boolean;
  openApproval?: typeof openAlignmentApproval;
  assessApproval?: typeof assessAlignmentDecision;
  brief?: typeof loadMissionBriefAtPath;
  tasks?: typeof loadMissionNextTaskObjectsAtPath;
  /** The mission-side supersede proof (tests); defaults to isSupersedeProvenForGate. */
  supersedeProven?: (missionId: string, taskId: string) => boolean;
  workItems?: typeof listWorkItems;
  updateItem?: typeof updateWorkItem;
}
const fingerprint = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
function scopeArgs(scope: ContinuousWorkOwnerScope): string[] {
  return [
    '--tier',
    scope.tier,
    '--organization-id',
    scope.organization_id,
    ...(scope.tenant_slug ? ['--tenant-slug', scope.tenant_slug] : []),
  ];
}
/** Child controllers isolate their process-global mission identity and use argv, never a shell. */
export function createContinuousOwnerPorts(
  deps: ContinuousOwnerAdapterDeps = {}
): ContinuousWorkOwnerPorts {
  const root = deps.rootDir ?? pathResolver.rootDir();
  const exec = deps.exec ?? runContinuousOwnerProcess;
  const read =
    deps.read ??
    ((file) =>
      parseSafeJsonInput(
        safeReadFileSnapshot(file, 1_048_576).toString('utf8'),
        'continuous owner evidence'
      ));
  const write =
    deps.write ?? ((file, value) => safeWriteFile(file, JSON.stringify(value, null, 2) + '\n'));
  const exists = deps.exists ?? safeExistsSync;
  const mission = deps.mission ?? loadState;
  const missionPath = deps.missionPath ?? findMissionPath;
  const command = async (
    script: string,
    args: string[],
    input: { scope: ContinuousWorkOwnerScope; signal?: AbortSignal; assertCurrent: () => void }
  ): Promise<void> => {
    const { scope, signal } = input;
    if (signal?.aborted) throw new Error('Continuous owner effect aborted before controller');
    const scriptPath = path.join(root, 'dist/scripts', script);
    if (!deps.exec && !exists(scriptPath))
      throw new Error('Build the governed controller before continuous execution: ' + scriptPath);
    const env = buildExecutionEnv(process.env, 'mission_controller');
    // No parent mission, customer stance, or worker project restriction crosses this owner handoff.
    delete env.MISSION_ID;
    delete env.KYBERION_CUSTOMER;
    delete env.KYBERION_PROJECT_ID;
    env.KYBERION_ORGANIZATION_ID = scope.organization_id;
    if (scope.tenant_slug) env.KYBERION_TENANT = scope.tenant_slug;
    else delete env.KYBERION_TENANT;
    input.assertCurrent();
    const result = await exec(process.execPath, [scriptPath, ...args], {
      cwd: root,
      env,
      timeoutMs: 120_000,
      maxOutputMB: 2,
      ...(signal ? { signal } : {}),
    });
    input.assertCurrent();
    if (signal?.aborted)
      throw new Error('Continuous owner effect expired; verify controller effects before recovery');
    if (result.status !== 0 || result.error)
      throw new Error(
        'Governed controller failed or timed out; verify effects before recovery: ' +
          script +
          ' ' +
          args[0] +
          ' (exit ' +
          String(result.status) +
          ')'
      );
  };
  const readMarker = (dir: string, operationKey: string) => {
    const marker = read(path.join(dir, 'evidence/continuous-owner.json')) as {
      operation_key?: string;
      brief_hash?: string;
      [key: string]: unknown;
    };
    if (marker?.operation_key !== operationKey)
      throw new Error('Continuous mission owner identity mismatch');
    return marker;
  };
  const assertMissionScope = (
    input: AdvanceContinuousMissionInput | EnsureContinuousMissionInput
  ) => {
    const state = mission(input.mission_id);
    if (
      !state ||
      state.mission_id !== input.mission_id ||
      state.tier !== input.scope.tier ||
      (state.tenant_slug ?? '') !== (input.scope.tenant_slug ?? '') ||
      (state.organization_id ?? state.relationships?.organization?.organization_id) !==
        input.scope.organization_id ||
      state.relationships?.project?.project_id !== input.project_id
    )
      throw new Error('Continuous mission context mismatch');
    return state;
  };
  const ports: ContinuousWorkOwnerPorts = {
    async ensureProject(input) {
      let record = (deps.project ?? loadProjectRecord)(input.project_id, { rootDir: root });
      if (!record) {
        await command(
          'project_controller.js',
          [
            'create',
            '--project-id',
            input.project_id,
            '--name',
            input.name,
            '--summary',
            input.summary,
            ...scopeArgs(input.scope),
            '--status',
            'active',
            '--metadata',
            JSON.stringify({ continuous_operation_key: input.operation_key }),
            ...(input.objective_ids?.length
              ? ['--objective-ids', input.objective_ids.join(',')]
              : []),
            '--json',
          ],
          input
        );
        record = (deps.project ?? loadProjectRecord)(input.project_id, { rootDir: root });
      }
      if (
        !record ||
        record.tier !== input.scope.tier ||
        record.organization_id !== input.scope.organization_id ||
        (record.tenant_slug ?? '') !== (input.scope.tenant_slug ?? '') ||
        record.name !== input.name ||
        record.summary !== input.summary ||
        record.metadata?.continuous_operation_key !== input.operation_key
      )
        throw new Error('Continuous project identity mismatch');
      return { project_id: record.project_id };
    },
    async ensureMission(input) {
      let dir = missionPath(input.mission_id);
      if (!dir) {
        await command(
          'mission_controller.bundle.js',
          [
            'create',
            input.mission_id,
            ...scopeArgs(input.scope),
            '--project-id',
            input.project_id,
            '--project-relationship',
            'belongs_to',
            '--goal',
            input.goal,
            '--success-condition',
            input.success_condition,
            '--mission-type',
            input.mission_type ?? 'operations_report',
            ...(input.prerequisites.length
              ? ['--prerequisites', input.prerequisites.join(',')]
              : []),
          ],
          input
        );
        dir = missionPath(input.mission_id);
        if (!dir) throw new Error('Continuous mission creation did not persist a mission');
        assertMissionScope(input);
        // Written only after the controller created the mission, inside the owner's evidence scope.
        input.assertCurrent();
        write(path.join(dir, 'evidence/continuous-owner.json'), {
          operation_key: input.operation_key,
          project_id: input.project_id,
          scope: input.scope,
          request_hash: fingerprint({ ...input, signal: undefined }),
        });
      } else {
        assertMissionScope(input);
        readMarker(dir, input.operation_key);
        const marker = read(path.join(dir, 'evidence/continuous-owner.json')) as {
          request_hash?: string;
        };
        if (marker.request_hash !== fingerprint({ ...input, signal: undefined }))
          throw new Error('Continuous mission specification drift');
      }
      const briefPath = path.join(dir, 'evidence/mission-brief.json');
      if (!exists(briefPath)) {
        input.assertCurrent();
        write(briefPath, {
          missionId: input.mission_id,
          title: input.title,
          intent: input.goal,
          tier: input.scope.tier,
          projectId: input.project_id,
          victoryConditions: [input.success_condition],
          scope: { in: [input.goal], out: ['Unapproved external effects', 'Cross-tenant access'] },
          flow: [
            {
              step: 1,
              title: 'Execute governed task contracts',
              detail:
                'Plan and execute the native mission process with phase gates and independent review.',
            },
          ],
          roles: [{ who: 'Continuous operations owner', role: 'mission_controller' }],
          deliverables: [input.success_condition],
          source: {
            kind: 'continuous_operations',
            ref: input.operation_key,
            ...(input.scope.tenant_slug ? { tenantSlug: input.scope.tenant_slug } : {}),
          },
          gate: { approvalRequired: true },
        });
      }
      const brief = (deps.brief ?? loadMissionBriefAtPath)(briefPath);
      if (
        brief.source?.kind !== 'continuous_operations' ||
        brief.source.ref !== input.operation_key ||
        brief.projectId !== input.project_id ||
        brief.intent !== input.goal ||
        brief.missionId !== input.mission_id ||
        brief.tier !== input.scope.tier ||
        brief.victoryConditions.length !== 1 ||
        brief.victoryConditions[0] !== input.success_condition ||
        (brief.source.tenantSlug ?? '') !== (input.scope.tenant_slug ?? '')
      )
        throw new Error('Continuous alignment brief identity mismatch');
      const marker = readMarker(dir, input.operation_key);
      const briefHash = fingerprint(brief);
      if (marker.brief_hash && marker.brief_hash !== briefHash)
        throw new Error('Continuous alignment brief drift');
      if (!marker.brief_hash) {
        input.assertCurrent();
        write(path.join(dir, 'evidence/continuous-owner.json'), {
          ...marker,
          brief_hash: briefHash,
        });
      }
      input.assertCurrent();
      const approval = (deps.openApproval ?? openAlignmentApproval)(input.mission_id, {
        requestedBy: 'continuous-owner',
      });
      if (!approval.requestId)
        throw new Error('Continuous alignment approval was not opened: ' + approval.reason);
      return { mission_id: input.mission_id };
    },
    async advanceMission(input) {
      let state = assertMissionScope(input);
      const dir = missionPath(input.mission_id);
      if (!dir) throw new Error('Continuous mission evidence missing');
      const marker = readMarker(dir, input.creation_key);
      const brief = (deps.brief ?? loadMissionBriefAtPath)(
        path.join(dir, 'evidence/mission-brief.json')
      );
      if (
        !marker.brief_hash ||
        fingerprint(brief) !== marker.brief_hash ||
        brief.missionId !== input.mission_id ||
        brief.projectId !== input.project_id ||
        brief.tier !== input.scope.tier ||
        brief.source?.kind !== 'continuous_operations' ||
        brief.source.ref !== input.creation_key ||
        (brief.source.tenantSlug ?? '') !== (input.scope.tenant_slug ?? '') ||
        !brief.intent?.trim() ||
        brief.victoryConditions.length !== 1 ||
        !brief.victoryConditions[0]?.trim()
      )
        throw new Error('Continuous alignment brief drift or missing immutable pin');
      const refs = ['mission:' + input.mission_id];
      const tasks = () =>
        (deps.tasks ?? loadMissionNextTaskObjectsAtPath)(
          path.join(dir, 'NEXT_TASKS.json'),
          input.mission_id
        ) ?? [];
      // A superseded row is closed only with the mission-side proof (an
      // approved, human supersede-task); an unproven one is pending. Its
      // replacement carries the work, and at least one row must be completed.
      const supersedeProven =
        deps.supersedeProven ??
        ((missionId: string, taskId: string) =>
          isSupersedeProvenForGate(missionId, taskId, 'the continuous owner'));
      const closedRows = (rows: ReadonlyArray<{ status?: unknown; task_id?: unknown }>) =>
        rows.length > 0 &&
        rows.every(
          (row) =>
            row.status === 'completed' ||
            (row.status === 'superseded' &&
              supersedeProven(input.mission_id, String(row.task_id ?? '')))
        ) &&
        rows.some((row) => row.status === 'completed');
      const complete = () => closedRows(tasks());
      const reconcileLearning = async () => {
        const outboxPath = path.join(dir, 'evidence', DISTILL_MEMORY_OUTBOX_FILE);
        if (!exists(outboxPath)) return;
        const pending = () => {
          const outbox = read(outboxPath) as {
            version?: number;
            mission_id?: string;
            status?: string;
          };
          if (
            !outbox ||
            outbox.version !== 1 ||
            outbox.mission_id !== input.mission_id ||
            !['pending', 'delivered'].includes(outbox.status ?? '')
          )
            throw new Error('Invalid mission learning delivery evidence');
          return outbox.status === 'pending';
        };
        if (pending()) {
          await command('mission_controller.bundle.js', ['distill', input.mission_id], input);
          if (pending())
            throw new Error(
              'Mission learning registration remains pending; retry governed distillation recovery'
            );
        }
      };
      if (['completed', 'archived'].includes(state.status)) {
        if (!complete() || state.verification?.status !== 'verified')
          return {
            status: 'blocked',
            evidence_refs: refs,
            reason: 'Mission has unfinished contracts or lacks verified outcome evidence',
          };
        await reconcileLearning();
        return { status: 'completed', evidence_refs: refs };
      }

      if (state.status === 'failed')
        return { status: 'failed', evidence_refs: refs, reason: 'Mission failed' };
      if (state.status === 'paused')
        return { status: 'blocked', evidence_refs: refs, reason: 'Mission paused by its owner' };
      const approval = (deps.assessApproval ?? assessAlignmentDecision)(input.mission_id);
      if (!approval.satisfied)
        return {
          status: approval.verdict === 'rejected' ? 'blocked' : 'pending_approval',
          evidence_refs: refs,
          ...(approval.requestId ? { approval_request_id: approval.requestId } : {}),
          reason: approval.reasons.join('; '),
        };
      if (state.status === 'planned') {
        const gated = state.process_template?.phase_specs?.some(
          (phase) => phase.exit_gate?.id === 'ALIGNMENT_APPROVED'
        );
        if (gated)
          await command(
            'mission_controller.bundle.js',
            ['gate-pass', input.mission_id, 'ALIGNMENT_APPROVED', '--machine-only'],
            input
          );
        else
          await command(
            'mission_controller.bundle.js',
            [
              'start',
              input.mission_id,
              '--goal',
              brief.intent,
              '--success-condition',
              brief.victoryConditions[0],
            ],
            input
          );
        state = assertMissionScope(input);
        if (state.status === 'planned') throw new Error('Approved mission did not activate');
      }
      // Native ticket creation rejects missions with no planned tasks. Existing
      // reviewed/ready WorkItems still need a dispatch/rework sweep in that case.
      if (tasks().some((row) => (row.status || 'planned') === 'planned'))
        await command(
          'mission_controller.bundle.js',
          ['dispatch-tickets', input.mission_id, '--ticket-targets', 'workitem'],
          input
        );
      const rowsBefore = tasks();
      for (const phase of state.process_template?.phase_specs ?? []) {
        if (phase.exit_gate && closedRows(rowsBefore.filter((row) => row.phase === phase.id))) {
          await command(
            'mission_controller.bundle.js',
            ['gate-pass', input.mission_id, phase.exit_gate.id, '--machine-only'],
            input
          );
        }
      }
      // One bounded dispatch round; native mission gates and independent review remain authoritative.
      await command(
        'mission_controller.bundle.js',
        [
          'dispatch-workitems',
          input.mission_id,
          '--dispatch-limit',
          '1',
          '--dispatch-rounds',
          '1',
          '--dispatch-statuses',
          'ready',
          '--dispatch-final-status',
          'done',
        ],
        input
      );
      // Rework loop-back: with final-status 'done', an item can only land in
      // 'review' when the independent review did not approve (or repair needs
      // eyes). Return those items to 'ready' with the verdict noted so the
      // next sweep re-dispatches them; bounded by rework_count so an
      // unapprovable item still parks for the operator.
      const interventions: string[] = [];
      const pendingApprovals: string[] = [];
      for (const item of (deps.workItems ?? listWorkItems)({}, { rootDir: root })) {
        if (
          item.context?.mission_id !== input.mission_id ||
          item.context.organization_id !== input.scope.organization_id ||
          (item.context.tenant_slug ?? '') !== (input.scope.tenant_slug ?? '') ||
          item.context.project_id !== input.project_id
        )
          continue;
        if (item.status === 'blocked') {
          if (
            item.metadata?.awaiting_approval === true &&
            typeof item.metadata.approval_request_id === 'string'
          ) {
            pendingApprovals.push(item.metadata.approval_request_id);
            continue;
          }
          interventions.push(item.item_id);
          continue;
        }
        if (item.status !== 'review') continue;
        const reworks = Number(item.metadata?.rework_count ?? 0);
        const exhausted = !Number.isSafeInteger(reworks) || reworks < 0 || reworks >= 2;
        input.assertCurrent();
        (deps.updateItem ?? updateWorkItem)({
          itemId: item.item_id,
          expectedVersion: item.version,
          rootDir: root,
          status: exhausted ? 'blocked' : 'ready',
          metadata: {
            ...(item.metadata || {}),
            ...(exhausted
              ? {
                  blocked_reason:
                    'Independent review rework limit reached or invalid counter; operator intervention required',
                  next_action:
                    'Inspect review evidence, repair the task or revise its approved contract, then explicitly return the child WorkItem and its blocked continuous-owner WorkItem to ready',
                }
              : { rework_count: reworks + 1 }),
            rework_reason: exhausted
              ? 'Independent review cannot advance automatically; held for operator review'
              : 'landed at review — independent review not approved; requeued for rework',
            rework_actor: 'continuous-work-owner',
          },
        });
        if (exhausted) interventions.push(item.item_id);
      }
      if (pendingApprovals.length && !interventions.length)
        return {
          status: 'pending_approval',
          evidence_refs: refs,
          approval_request_id: pendingApprovals[0],
          reason:
            'Runtime tool approval pending; the continuous owner resumes after the human decision',
        };
      if (interventions.length)
        return {
          status: 'blocked',
          evidence_refs: [...refs, ...interventions.map((id) => `workitem:${id}`)],
          reason: `WorkItems require operator intervention: ${interventions.join(', ')}. Inspect review evidence, repair the task or revise its approved contract, then explicitly return the child WorkItem and its blocked continuous-owner WorkItem to ready.`,
          approval_request_id: approval.requestId,
        };
      state = assertMissionScope(input);
      if (complete()) {
        await command(
          'mission_controller.bundle.js',
          [
            'verify',
            input.mission_id,
            'verified',
            'Native process contracts and independent review completed with evidence.',
          ],
          input
        );
        await command('mission_controller.bundle.js', ['distill', input.mission_id], input);
        state = assertMissionScope(input);
        await reconcileLearning();
      }
      const remaining = tasks();
      const blocked = remaining.some((row) => row.status === 'blocked');
      return {
        status:
          ['completed', 'archived'].includes(state.status) &&
          complete() &&
          state.verification?.status === 'verified'
            ? 'completed'
            : blocked
              ? 'blocked'
              : 'running',
        evidence_refs: refs,
        approval_request_id: approval.requestId,
      };
    },
  };
  return {
    ensureProject: (input) =>
      withExecutionContextAsync(
        'mission_controller',
        () => ports.ensureProject(input),
        undefined,
        input.scope.tenant_slug,
        input.scope.organization_id
      ),
    ensureMission: (input) =>
      withExecutionContextAsync(
        'mission_controller',
        () => ports.ensureMission(input),
        undefined,
        input.scope.tenant_slug,
        input.scope.organization_id
      ),
    advanceMission: (input) =>
      withExecutionContextAsync(
        'mission_controller',
        () => ports.advanceMission(input),
        undefined,
        input.scope.tenant_slug,
        input.scope.organization_id
      ),
  };
}
export async function runContinuousManagedOwner(
  charter: DotCharter,
  options: { now?: Date; rootDir?: string } = {}
) {
  if (
    !charter.scope.organization_id ||
    !charter.authority.allowed_pipelines?.includes(CONTINUOUS_MANAGED_WORK_PIPELINE)
  )
    return [];
  return runContinuousWorkOwner(
    charter,
    createContinuousOwnerPorts({ rootDir: options.rootDir }),
    options
  );
}
