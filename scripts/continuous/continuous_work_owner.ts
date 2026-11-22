import { hasCliFlag } from '../lib/cli/cli-guard.js';
/** Governed controller adapters for the continuous mission-owner execution surface. */
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { buildExecutionEnv, withExecutionContextAsync } from '@agent/core/authority';
import {
  safeExistsSync,
  safeReadFileSnapshot,
  safeReaddir,
  safeWriteFile,
} from '@agent/core/secure-io';
import { parseSafeJsonInput } from '@agent/core/foundation/safe-json';
import { pathResolver, findMissionPath } from '@agent/core/path-resolver';
import { isolatedScopeEnvPath } from '@agent/core/scope-context';
import { loadMissionNextTaskObjectsAtPath } from '@agent/core/mission/mission-next-task-reader';
import { isSupersedeProvenForGate } from '@agent/core/mission/mission-task-supersede-proof';
import { loadState } from '@agent/core/mission/mission-state';
import { DISTILL_MEMORY_OUTBOX_FILE } from '@agent/core/mission/mission-distill';
import { loadProjectRecord, type ProjectRecord } from '@agent/core/project/project-registry';
import { loadOrganizationOperationalState } from '@agent/core/organization/organization-operating-model';
import { advanceMissionDevelopment } from '@agent/core/mission/mission-development-continuation';
import { verifyMissionDevelopmentPublication } from '@agent/core/mission/mission-development-proof';
import { installMissionDevelopmentProofVerifier } from '@agent/core/mission/mission-development-gates';
import { writeMissionNextTasks } from '@agent/core/mission/mission-lifecycle-completion';
import {
  configureMissionDevelopmentGates,
  getMissionAlignmentGate,
  readStoredMissionGate,
  loadMissionGateRecordAtPath,
  fingerprintMissionGateInputs,
  type MissionGateRecord,
} from '@agent/core/mission/mission-process-planning';
import { withContinuousMissionScope } from '@agent/core/organization/continuous-mission-scope';
import { continuousDevelopmentAlignmentScope } from '@agent/core/organization/continuous-development-consent';
import { listWorkItems, updateWorkItem } from '@agent/core/workforce/work-coordination';
import {
  runContinuousWorkOwner,
  ContinuousOwnerPreEffectError,
  type ContinuousWorkOwnerPorts,
  type ContinuousWorkOwnerScope,
  type ContinuousMissionProgress,
  type EnsureContinuousMissionInput,
  type AdvanceContinuousMissionInput,
} from '@agent/core/organization/continuous-work-owner';
import { CONTINUOUS_MANAGED_WORK_PIPELINE } from '@agent/core/organization/continuous-work-plan';
import type { DotCharter } from '@agent/core/dot/dot-charter';
import { openAlignmentApproval } from '../mission/mission_alignment_request.js';
import { assessAlignmentDecision } from '../mission/mission_alignment_decision.js';
import { loadMissionBriefAtPath } from '../mission-alignment-gate/mission-brief.js';

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
  development?: typeof advanceMissionDevelopment;
  board?: typeof writeMissionNextTasks;
  configureDevelopmentGates?: typeof configureMissionDevelopmentGates;
  storedGate?: typeof readStoredMissionGate;
  gateRecords?: typeof readGateRecords;
  missionScope?: typeof withContinuousMissionScope;
  developmentProof?: typeof verifyMissionDevelopmentPublication;
}
const fingerprint = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

function readGateRecords(missionId: string, missionDir: string): MissionGateRecord[] {
  return ['gates', 'gates/records'].flatMap((relativePath) => {
    const directory = path.join(missionDir, relativePath);
    return safeExistsSync(directory)
      ? safeReaddir(directory)
          .filter((entry) => entry.endsWith('.json'))
          .map((entry) => loadMissionGateRecordAtPath(path.join(directory, entry), missionId))
      : [];
  });
}

function latestGateRecord(
  records: MissionGateRecord[],
  gateId: string
): MissionGateRecord | undefined {
  return records
    .filter((record) => record.gate_id === gateId)
    .sort(
      (left, right) =>
        (right.sequence ?? 0) - (left.sequence ?? 0) ||
        (right.checked_at ?? '').localeCompare(left.checked_at ?? '') ||
        Number(right.verdict !== 'pass') - Number(left.verdict !== 'pass')
    )[0];
}
function scopeArgs(scope: ContinuousWorkOwnerScope): string[] {
  return [
    '--tier',
    scope.tier,
    '--organization-id',
    scope.organization_id,
    ...(scope.tenant_slug ? ['--tenant-slug', scope.tenant_slug] : []),
  ];
}

/** Convert only known controller messages into safe details for durable owner state. */
function controllerDiagnostic(output: string): string {
  if (/Unknown objective\(s\) for organization/.test(output))
    return 'project references an unregistered organization objective. Check pnpm organization status';
  if (
    /Organization not found for project|Organization is not configured for the selected tenant/.test(
      output
    )
  )
    return 'organization is missing for the selected scope. Check pnpm organization status';
  if (/project creation is denied/.test(output))
    return 'organization must be active before creating a project';
  if (/has no project-os/.test(output))
    return 'project OS is missing. Run pnpm project scaffold for the linked project';
  if (/project ledger target .* is not writable/.test(output))
    return 'project ledger is unwritable. Check the linked project scope and ledger permissions';
  if (/Confidential Mission requires a tenant/.test(output))
    return 'confidential mission requires a registered tenant. Check the continuous owner scope';
  if (
    /\[PROJECT_LINK_INVALID\]|conflicts across the selected Mission, Project, Stance or CLI context/.test(
      output
    )
  )
    return 'mission and project scope do not agree. Check tenant, organization and tier';
  return 'check the governed controller preflight for the approved scope';
}

class ContinuousMissionPrerequisitesPending extends Error {
  constructor() {
    super('Mission activation is waiting for prerequisite missions to finish');
  }
}

function inspectMissionPreflight(stdout: string): void {
  const report = parseSafeJsonInput(stdout, 'continuous mission preflight') as {
    input?: { preflight?: { ready?: boolean; issues?: string[] } };
  } | null;
  if (report?.input?.preflight?.ready !== true) {
    const issues = report?.input?.preflight?.issues;
    const output = Array.isArray(issues) ? issues.join(' ') : '';
    if (output.includes('[MISSION_PREREQUISITES_UNMET]'))
      throw new ContinuousMissionPrerequisitesPending();
    throw new Error('Mission preflight refused. ' + controllerDiagnostic(output));
  }
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
  const project = (id: string) => (deps.project ?? loadProjectRecord)(id, { rootDir: root });
  const controllerPath = (script: string) => path.join(root, 'dist/scripts', script);
  const assertControllerBuilt = (script: string): void => {
    if (!deps.exec && !exists(controllerPath(script)))
      throw new ContinuousOwnerPreEffectError(
        'Build the governed controller before continuous execution: ' + script
      );
  };
  const projectOsPath = (record: ProjectRecord): string =>
    record.project_os_path
      ? path.resolve(root, record.project_os_path)
      : pathResolver.projectOsDir(record.project_id, record.tier, record.tenant_slug, root);
  const projectScopeMatches = (record: ProjectRecord, scope: ContinuousWorkOwnerScope): boolean =>
    record.tier === scope.tier &&
    record.organization_id === scope.organization_id &&
    (record.tenant_slug ?? '') === (scope.tenant_slug ?? '');
  const command = async (
    script: string,
    args: string[],
    input: { scope: ContinuousWorkOwnerScope; signal?: AbortSignal; assertCurrent: () => void },
    options: {
      expectedRefusal?: 'TESTS_PASSED';
      inspectPreflight?: (stdout: string) => void;
      preflight?: boolean;
    } = {}
  ): Promise<boolean> => {
    const { expectedRefusal } = options;
    if (
      expectedRefusal &&
      (script !== 'mission_controller.bundle.js' ||
        args[0] !== 'gate-pass' ||
        args[2] !== expectedRefusal ||
        !hasCliFlag(args, '--machine-only'))
    )
      throw new Error('Known gate refusal handling is limited to the typed development CI gate');
    const { scope, signal } = input;
    if (signal?.aborted) throw new Error('Continuous owner effect aborted before controller');
    const scriptPath = controllerPath(script);
    if (!deps.exec && !exists(scriptPath))
      throw new Error('Build the governed controller before continuous execution: ' + script);
    const env = buildExecutionEnv(process.env, 'mission_controller');
    // Empty overrides survive buildSafeExecEnv, which merges the supervisor's env.
    Object.assign(env, {
      KYBERION_SCOPE_ENV_PATH: isolatedScopeEnvPath(),
      MISSION_ID: '',
      KYBERION_TASK_ID: '',
      TASK_ID: '',
      KYBERION_STANCE: '',
      KYBERION_CUSTOMER: '',
      KYBERION_PROJECT_ID: '',
      KYBERION_ORGANIZATION_ID: scope.organization_id,
      KYBERION_TIER: scope.tier,
      KYBERION_TENANT: scope.tenant_slug ?? '',
    });
    input.assertCurrent();
    const result = await exec(process.execPath, [scriptPath, ...args], {
      cwd: root,
      env,
      timeoutMs: 120_000,
      maxOutputMB: 2,
      ...(signal ? { signal } : {}),
    }).catch(() => {
      throw new Error(
        `${script} ${args[0]} controller could not run${options.preflight ? ' its preflight' : '; verify effects before recovery'}`
      );
    });
    input.assertCurrent();
    if (signal?.aborted)
      throw new Error('Continuous owner effect expired; verify controller effects before recovery');
    if (
      expectedRefusal &&
      result.status === 1 &&
      !result.error &&
      `${result.stdout}\n${result.stderr}`.includes(
        `[DEVELOPMENT_CI_WAITING] Machine-only gate checks failed: ${args[1]}/${expectedRefusal}`
      )
    )
      return false;
    if (result.status !== 0 || result.error) {
      throw new Error(
        `Governed controller ${options.preflight ? 'preflight failed' : 'failed or timed out; verify effects before recovery'}: ` +
          `${script} ${args[0]} (exit ${result.status}). ${controllerDiagnostic(result.stderr + '\n' + result.stdout)}`
      );
    }
    options.inspectPreflight?.(result.stdout);
    return true;
  };
  const preflight = async (
    script: string,
    args: string[],
    input: Parameters<typeof command>[2],
    inspectPreflight?: (stdout: string) => void,
    priorEffect = false
  ): Promise<void> => {
    try {
      await command(script, [...args, '--dry-run'], input, { preflight: true, inspectPreflight });
    } catch (error) {
      if (priorEffect || error instanceof ContinuousMissionPrerequisitesPending) throw error;
      throw new ContinuousOwnerPreEffectError(
        error instanceof Error ? error.message : 'Controller preflight failed'
      );
    }
  };
  const ensureProjectOs = async (
    record: ProjectRecord,
    input: Parameters<typeof command>[2]
  ): Promise<void> => {
    const target = projectOsPath(record);
    if (exists(target)) return;
    await command('project_controller.js', ['scaffold', record.project_id, '--json'], input);
    if (!exists(target))
      throw new Error('Project scaffold did not persist the project OS at the registered path');
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
      assertControllerBuilt('mission_controller.bundle.js');
      let record = project(input.project_id);
      if (!record) {
        assertControllerBuilt('project_controller.js');
        const args = [
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
        ];
        await preflight('project_controller.js', args, input);
        await command('project_controller.js', args, input);
        record = project(input.project_id);
      }
      if (
        !record ||
        !projectScopeMatches(record, input.scope) ||
        record.name !== input.name ||
        record.summary !== input.summary ||
        record.metadata?.continuous_operation_key !== input.operation_key
      )
        throw new Error('Continuous project identity mismatch');
      await ensureProjectOs(record, input);
      return { project_id: record.project_id };
    },
    async ensureMission(input) {
      let dir = missionPath(input.mission_id);
      if (!dir) {
        const script = 'mission_controller.bundle.js';
        assertControllerBuilt(script);
        const record = project(input.project_id);
        if (!record || !projectScopeMatches(record, input.scope))
          throw new ContinuousOwnerPreEffectError(
            'Linked project is missing from the approved continuous scope. Check pnpm project show'
          );
        const scaffoldNeeded = !exists(projectOsPath(record));
        if (scaffoldNeeded) {
          if (
            record.project_os_path &&
            pathResolver.projectOsDir(record.project_id, record.tier, record.tenant_slug, root) !==
              projectOsPath(record)
          )
            throw new ContinuousOwnerPreEffectError(
              'The linked project OS is missing from its registered path. Restore that path before creating the mission'
            );
          assertControllerBuilt('project_controller.js');
          await ensureProjectOs(record, input);
        }
        const args = [
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
          input.mission_type ?? (input.development ? 'development' : 'operations_report'),
          ...(input.prerequisites.length ? ['--prerequisites', input.prerequisites.join(',')] : []),
          '--json',
        ];
        await preflight(script, args, input, inspectMissionPreflight, scaffoldNeeded);
        await command(script, args, input);
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
          ...(input.development
            ? { development: input.development, development_hash: fingerprint(input.development) }
            : {}),
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
          scope: {
            in: [
              input.goal,
              ...(input.development
                ? continuousDevelopmentAlignmentScope(input.development, input.scope)
                : []),
            ],
            out: ['Unapproved external effects', 'Cross-tenant access'],
          },
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
        (input.development &&
          fingerprint(brief.scope?.in) !==
            fingerprint([
              input.goal,
              ...continuousDevelopmentAlignmentScope(input.development, input.scope),
            ])) ||
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
      if (input.development) {
        input.assertCurrent();
        (deps.missionScope ?? withContinuousMissionScope)(
          { mission_id: input.mission_id, scope: input.scope, assertCurrent: input.assertCurrent },
          () =>
            (deps.configureDevelopmentGates ?? configureMissionDevelopmentGates)({
              missionId: input.mission_id,
              development: input.development!,
              assertCurrent: input.assertCurrent,
            })
        );
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
      if (input.development)
        installMissionDevelopmentProofVerifier(verifyMissionDevelopmentPublication);
      const dir = missionPath(input.mission_id);
      if (!dir) throw new Error('Continuous mission evidence missing');
      const marker = readMarker(dir, input.creation_key);
      if (
        (marker.development_hash ?? null) !==
        (input.development ? fingerprint(input.development) : null)
      )
        throw new Error('Continuous development specification drift or missing reviewed pin');
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
        !brief.victoryConditions[0]?.trim() ||
        (input.development &&
          fingerprint(brief.scope?.in) !==
            fingerprint([
              brief.intent,
              ...continuousDevelopmentAlignmentScope(input.development, input.scope),
            ]))
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
      const developmentProgress = async () => {
        if (!input.development) return undefined;
        input.assertCurrent();
        const result = await (deps.development ?? advanceMissionDevelopment)(
          {
            missionId: input.mission_id,
            development: input.development,
            assertCurrent: input.assertCurrent,
            ...(input.signal ? { signal: input.signal } : {}),
          },
          {
            dispatch: async (mission, options) => {
              const itemIds = options?.itemIds;
              if (
                mission.mission_id !== input.mission_id ||
                !Array.isArray(itemIds) ||
                !itemIds.length ||
                itemIds.length > 64 ||
                itemIds.some((id) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id))
              )
                throw new Error('Continuous development dispatch requires exact mission WorkItems');
              await command(
                'mission_controller.bundle.js',
                [
                  'dispatch-workitems',
                  input.mission_id,
                  '--dispatch-item-ids',
                  itemIds.join(','),
                  '--dispatch-limit',
                  '1',
                  '--dispatch-rounds',
                  '1',
                  '--dispatch-statuses',
                  'ready,backlog',
                  '--dispatch-final-status',
                  'done',
                ],
                input
              );
            },
          }
        );
        input.assertCurrent();
        return result;
      };
      if (['completed', 'archived'].includes(state.status)) {
        if (!complete() || state.verification?.status !== 'verified')
          return {
            status: 'blocked',
            evidence_refs: refs,
            reason: 'Mission has unfinished contracts or lacks verified outcome evidence',
          };
        const development = await developmentProgress();
        if (development && development.status !== 'completed') return development;
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
        const alignmentGate = getMissionAlignmentGate(state, deps.storedGate);
        const script = 'mission_controller.bundle.js';
        assertControllerBuilt(script);
        const args = alignmentGate
          ? ['gate-pass', input.mission_id, alignmentGate, '--machine-only']
          : [
              'start',
              input.mission_id,
              '--goal',
              brief.intent,
              '--success-condition',
              brief.victoryConditions[0],
            ];
        try {
          await preflight(script, [...args, '--json'], input, inspectMissionPreflight);
        } catch (error) {
          if (!(error instanceof ContinuousMissionPrerequisitesPending)) throw error;
          return {
            status: 'running',
            evidence_refs: refs,
            approval_request_id: approval.requestId,
            reason: error.message,
          };
        }
        await command(script, args, input);
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
      const evaluatedMachineGates = new Set<string>();
      const advanceExitGates = async (): Promise<ContinuousMissionProgress | undefined> => {
        const rows = tasks();
        let records: MissionGateRecord[] | undefined;
        for (const phase of state.process_template?.phase_specs ?? []) {
          if (
            input.development &&
            ['test', 'self_review', 'delivery', 'retrospective'].includes(phase.id)
          )
            continue;
          const gateId = phase.exit_gate?.id;
          if (!gateId || !closedRows(rows.filter((row) => row.phase === phase.id))) continue;
          const stored = (deps.storedGate ?? readStoredMissionGate)(input.mission_id, gateId);
          const definition = stored?.definition;
          if (definition && (definition.position !== 'exit' || definition.phase !== phase.id))
            throw new Error('Stored gate definition differs from the current phase exit gate');
          const checks = definition?.gate.checks ?? phase.exit_gate?.checks ?? [];
          const humanRequired = checks.some(
            (check) => check.kind === 'reviewer_approved' || check.kind === 'human_override'
          );
          if (humanRequired) {
            records ??= (deps.gateRecords ?? readGateRecords)(input.mission_id, dir);
            const record = latestGateRecord(records, gateId);
            if (
              definition &&
              record?.verdict === 'pass' &&
              !record.override &&
              record.checks?.length === checks.length &&
              checks.every(
                (check, index) =>
                  record.checks?.[index]?.kind === check.kind &&
                  record.checks[index]?.passed === true
              ) &&
              record.input_digest === fingerprintMissionGateInputs(definition.gate, dir)
            )
              continue;
            return {
              status: 'pending_approval',
              evidence_refs: refs,
              reason: `Gate ${gateId} requires a current human or reviewer decision. After review, run pnpm mission gate-pass ${input.mission_id} ${gateId}`,
            };
          }
          const phases = state.process_template?.phases ?? [];
          const current = phases.indexOf(state.process_template?.current_phase ?? '');
          const phaseIndex = phases.indexOf(phase.id);
          if (evaluatedMachineGates.has(gateId) || (phaseIndex >= 0 && phaseIndex < current))
            continue;
          await command(
            'mission_controller.bundle.js',
            ['gate-pass', input.mission_id, gateId, '--machine-only'],
            input
          );
          evaluatedMachineGates.add(gateId);
        }
        return undefined;
      };
      const waitingForGate = await advanceExitGates();
      if (waitingForGate) return waitingForGate;
      const developmentBefore = await developmentProgress();
      if (
        input.development &&
        (developmentBefore?.ci_verified || developmentBefore?.status === 'completed')
      ) {
        const currentTasks = tasks();
        for (const phase of state.process_template?.phase_specs ?? []) {
          if (
            phase.id !== 'test' ||
            phase.exit_gate?.id !== 'TESTS_PASSED' ||
            !closedRows(currentTasks.filter((row) => row.phase === phase.id))
          )
            continue;
          const ci = await (deps.developmentProof ?? verifyMissionDevelopmentPublication)(
            input.mission_id,
            input.development,
            'ci'
          );
          input.assertCurrent();
          if (!ci.ok)
            return {
              status: ci.waiting ? 'running' : 'blocked',
              evidence_refs: developmentBefore.evidence_refs,
              reason:
                ci.reason ?? 'Current CI evidence is not ready; reconcile on the next owner wake',
            };
          const passed = await command(
            'mission_controller.bundle.js',
            ['gate-pass', input.mission_id, 'TESTS_PASSED', '--machine-only'],
            input,
            { expectedRefusal: 'TESTS_PASSED' }
          );
          if (!passed)
            return {
              status: 'running',
              evidence_refs: developmentBefore.evidence_refs,
              reason:
                'CI evidence changed during gate evaluation; reconcile on the next owner wake',
            };
        }
      }
      if (
        developmentBefore &&
        developmentBefore.status !== 'completed' &&
        !developmentBefore.allow_task_dispatch
      )
        return developmentBefore;
      if (developmentBefore?.status === 'completed') {
        const refs = developmentBefore.evidence_refs;
        if (
          !Array.isArray(refs) ||
          !refs.length ||
          refs.length > 16 ||
          refs.some(
            (ref) => typeof ref !== 'string' || ref.length > 2048 || /[\u0000-\u001f]/u.test(ref)
          )
        )
          throw new Error('Invalid verified development publication references');
        const receipt = fingerprint(refs);
        const marker = '\n\n[VERIFIED_DEVELOPMENT_PUBLICATION]\n';
        const note = [
          'The continuous owner has already verified publication, the immutable merge commit and required CI.',
          'This delivery or retrospective task reports the existing outcome. Do not create another PR, push, merge, or repeat publication.',
          'Use these existing references as evidence for the original acceptance criteria; do not claim unperformed work:',
          ...refs.map((ref) => `- ${ref}`),
        ].join('\n');
        const description = (value: unknown) =>
          `${String(value ?? '').split(marker)[0]}${marker}${note}`;
        const targets = rowsBefore.filter((row) =>
          ['delivery', 'retrospective'].includes(String(row.phase))
        );
        const items = (deps.workItems ?? listWorkItems)({}, { rootDir: root }).filter(
          (item) =>
            item.context?.mission_id === input.mission_id &&
            item.context.organization_id === input.scope.organization_id &&
            (item.context.tenant_slug ?? '') === (input.scope.tenant_slug ?? '') &&
            item.context.project_id === input.project_id &&
            targets.some((task) => task.task_id === item.context?.task_id) &&
            ['ready', 'backlog'].includes(item.status)
        );
        if (targets.some((row) => row.description !== description(row.description))) {
          input.assertCurrent();
          (deps.board ?? writeMissionNextTasks)(dir, (rows) =>
            rows.map((row) =>
              targets.some((task) => task.task_id === row.task_id)
                ? { ...row, description: description(row.description) }
                : row
            )
          );
        }
        for (const item of items) {
          if (
            item.metadata?.development_publication_receipt === receipt &&
            item.description === description(item.description)
          )
            continue;
          input.assertCurrent();
          (deps.updateItem ?? updateWorkItem)({
            itemId: item.item_id,
            expectedVersion: item.version,
            rootDir: root,
            description: description(item.description),
            metadata: { ...item.metadata, development_publication_receipt: receipt },
          });
        }
      }
      if (developmentBefore?.status === 'completed')
        for (const phase of state.process_template?.phase_specs ?? []) {
          if (
            ['self_review', 'delivery', 'retrospective'].includes(phase.id) &&
            phase.exit_gate &&
            closedRows(rowsBefore.filter((row) => row.phase === phase.id))
          )
            await command(
              'mission_controller.bundle.js',
              ['gate-pass', input.mission_id, phase.exit_gate.id, '--machine-only'],
              input
            );
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
        const waitingForGate = await advanceExitGates();
        if (waitingForGate) return waitingForGate;
        const development = await developmentProgress();
        if (development && development.status !== 'completed') return development;
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
    verifyCreatedProject(input) {
      const { scope } = input;
      const record = project(input.project_id);
      if (
        !record ||
        record.project_id !== input.project_id ||
        record.tier !== scope.tier ||
        record.tenant_slug !== scope.tenant_slug ||
        record.organization_id !== scope.organization_id ||
        record.name !== input.name ||
        record.summary !== input.summary ||
        record.status !== 'active' ||
        record.metadata?.continuous_operation_key !== input.operation_key ||
        JSON.stringify([...(record.objective_ids ?? [])].sort()) !==
          JSON.stringify([...new Set(input.objective_ids ?? [])].sort())
      )
        return false;
      return (
        loadOrganizationOperationalState(scope.organization_id, {
          tier: scope.tier,
          tenantSlug: scope.tenant_slug,
          rootDir: root,
        })?.active_project_ids?.includes(input.project_id) === true
      );
    },
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
        () =>
          (deps.missionScope ?? withContinuousMissionScope)(
            {
              mission_id: input.mission_id,
              scope: input.scope,
              assertCurrent: input.assertCurrent,
            },
            () => ports.advanceMission(input)
          ),
        undefined,
        input.scope.tenant_slug,
        input.scope.organization_id
      ),
  };
}
export async function runContinuousManagedOwner(
  charter: DotCharter,
  options: { now?: Date; rootDir?: string; itemId?: string } = {}
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
