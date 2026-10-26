/** A task's model-visible tools, independent of CLI/API transport. */
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { normalizeEventScope, type EventScope, type EventScopeInput } from '../event-scope.js';
import { getWorkItem, listActiveWorkLeases } from './work-coordination.js';
import { coordinationNamespace } from './work-coordination-ledger.js';
import type { WorkItem, WorkLease } from './work-coordination-types.js';
import {
  getSubagentCapabilityProfile,
  resolveDelegationCapabilityProfile,
} from '../subagent-capability-profiles.js';
import { pathResolver, findMissionPath } from '../path-resolver.js';
import {
  safeReadFileSnapshot,
  assertSafeRepositoryPath,
  safeRealpath,
  safeExecResultAsync,
  safeWriteFile,
  safeExistsSync,
} from '../secure-io.js';
import { buildExecutionEnv } from '../authority.js';
import { writeScopedArtifact } from './artifact-store.js';
import { loadMissionStateAtPath } from '../mission/mission-state-reader.js';
import type { MissionState } from '../mission/mission-types.js';
import { loadMissionNextTaskObjectsAtPath } from '../mission/mission-next-task-reader.js';
import type { ToolDefinition, ReasoningBackend } from '../reasoning/reasoning-backend.js';
import type { RunGoalDrivenLoopOptions } from './worker-goal-driver.js';
import { executeTaskGoalLoop } from './task-execution-port.js';
import {
  createTaskSourceEditTool,
  validateTaskSourcePaths,
  type TaskSourceEditOptions,
} from './task-source-edit.js';
import {
  createTaskPipelineTool,
  validateTaskPipelineRefs,
  type TaskPipelineExecutor,
} from './task-pipeline-tool.js';

export interface TaskToolBinding {
  scope: EventScope;
  actorId: string;
  workItemId: string;
  taskId: string;
  missionId: string;
  leaseId: string;
  capabilityProfile: string;
  externalEgress?: 'allow' | 'deny';
  allowedReasoningBackends?: readonly string[];
  readRoots: readonly string[];
  writeRoots: readonly string[];
}
export interface TaskToolHandler {
  definition: ToolDefinition;
  /** Canonical capability op, not a model-selected permission. */
  op: string;
  execute(input: Record<string, unknown>, binding: TaskToolBinding): Promise<unknown> | unknown;
}
export interface TaskToolRuntime {
  readonly binding: TaskToolBinding;
  readonly definitions: ToolDefinition[];
  assertCurrent(): void;
  assertComplete?(): void;
  execute(call: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
}
export interface TaskToolRuntimeOptions {
  actorId?: string;
  rootDir?: string;
  readRoots?: string[];
  writeRoots?: string[];
  tools?: readonly TaskToolHandler[];
  assertCurrent?: () => void;
  getItem?: (id: string) => WorkItem | null;
  leases?: () => WorkLease[];
  mission?: (missionId: string) => MissionState | null;
  missionPath?: (id: string) => string | null | undefined;
  tasks?: () => Array<Record<string, unknown>>;
  read?: (file: string) => string;
  writeArtifact?: typeof writeScopedArtifact;
  recordEvidence?: (binding: TaskToolBinding, note: string) => Promise<unknown>;
  writeDeliverable?: (file: string, content: string) => void;
  inspectDeliverable?: (file: string) => string | undefined;
  sourceEditApproval?: TaskSourceEditOptions['approve'];
  pipelineExecutor?: TaskPipelineExecutor;
  now?: () => number;
}
function required(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`[TASK_TOOL_BINDING] ${label} required`);
  return value.trim();
}
const SCOPE_FIELDS = [
  'tenant_slug',
  'organization_id',
  'project_id',
  'mission_id',
  'task_id',
] as const;

/** Resolve grants from the live claimed WorkItem; a payload alone grants nothing. */
export function createRuntimeForTask(
  metadata: Record<string, unknown>,
  scopeInput: EventScopeInput,
  options: TaskToolRuntimeOptions = {}
): TaskToolRuntime | undefined {
  if (!metadata.work_item_id) return undefined;
  const root = options.rootDir ?? pathResolver.rootDir();
  const getItem = options.getItem ?? ((id: string) => getWorkItem(id, { rootDir: root }));
  const workItemId = required(metadata.work_item_id, 'work_item_id');
  const initial = getItem(workItemId);
  if (!initial) throw new Error('[TASK_TOOL_BINDING] WorkItem not found');
  const scope = normalizeEventScope({
    ...scopeInput,
    task_id: scopeInput.task_id ?? initial.context?.task_id,
  });
  const missionId = required(scope.mission_id, 'mission_id');
  const taskId = required(scope.task_id, 'task_id');
  const profileName = required(metadata.capability_profile, 'capability_profile');
  const profile = getSubagentCapabilityProfile(profileName);
  if (!profile) throw new Error('[TASK_TOOL_BINDING] Unknown capability profile');
  let role =
    typeof initial.metadata?.team_role === 'string' ? initial.metadata.team_role : undefined;
  let ceiling = resolveDelegationCapabilityProfile({
    teamRole: role,
    purpose: metadata.purpose === 'review' ? 'review' : 'implementation',
  });
  const levels = { planner: 0, explorer: 1, implementer: 2 } as Record<string, number>;
  if (!(profileName in levels) || levels[profileName]! > levels[ceiling]!)
    throw new Error('[TASK_TOOL_BINDING] Capability profile exceeds task role');
  const leaseId = required(metadata.lease_id ?? initial.lease_id, 'lease_id');
  const holder = required(initial.claimed_by_peer_id, 'claim holder');
  const actorId = options.actorId ?? holder;
  if (actorId !== holder)
    throw new Error('[TASK_TOOL_ACTOR_DENIED] Runtime actor must be the current claim holder');
  const securityScope = initial.metadata?.security_scope;
  if (
    securityScope !== undefined &&
    (!securityScope || typeof securityScope !== 'object' || Array.isArray(securityScope))
  )
    throw new Error('[TASK_TOOL_BINDING] Invalid stored security scope');
  const security = (securityScope ?? {}) as Record<string, unknown>;
  if (
    security.external_egress !== undefined &&
    !['allow', 'deny'].includes(String(security.external_egress))
  )
    throw new Error('[TASK_TOOL_BINDING] Invalid stored egress policy');
  if (
    security.allowed_reasoning_backends !== undefined &&
    (!Array.isArray(security.allowed_reasoning_backends) ||
      security.allowed_reasoning_backends.some(
        (entry) => typeof entry !== 'string' || !entry.trim()
      ))
  )
    throw new Error('[TASK_TOOL_BINDING] Invalid stored backend allowlist');
  const policySnapshot = JSON.stringify(securityScope ?? null);
  const externalEgress: 'allow' | 'deny' =
    security.external_egress === 'allow'
      ? 'allow'
      : security.external_egress === 'deny' || scope.tier !== 'public'
        ? 'deny'
        : 'allow';
  const allowedReasoningBackends = security.allowed_reasoning_backends as string[] | undefined;
  const missionDir = (options.missionPath ?? findMissionPath)(missionId);
  if (!missionDir) throw new Error('[TASK_TOOL_BINDING] Mission directory is not visible');
  const tasks =
    options.tasks ??
    (() =>
      loadMissionNextTaskObjectsAtPath(path.join(missionDir, 'NEXT_TASKS.json'), missionId) ?? []);
  const task = tasks().find((entry) => entry.task_id === taskId);
  if (!task) throw new Error('[TASK_TOOL_BINDING] Task contract is not present in NEXT_TASKS');
  const assignment = task.assigned_to as { role?: unknown } | undefined;
  if (typeof assignment?.role === 'string') {
    role = assignment.role;
    ceiling = resolveDelegationCapabilityProfile({
      teamRole: role,
      purpose: metadata.purpose === 'review' ? 'review' : 'implementation',
    });
    if (levels[profileName]! > levels[ceiling]!)
      throw new Error('[TASK_TOOL_BINDING] Capability profile exceeds canonical task role');
  }
  const canonicalProfile = resolveDelegationCapabilityProfile({
    teamRole: role,
    purpose: 'implementation',
  });
  const canEmitResult =
    profileName === canonicalProfile ||
    (profileName === 'explorer' &&
      (task.phase_kind === 'review' || typeof task.review_target === 'string'));
  const contractShape = (entry: Record<string, unknown>) =>
    JSON.stringify({
      deliverable: entry.deliverable,
      target_path: entry.target_path,
      source_edit_paths: entry.source_edit_paths,
      source_edit_requires_approval: entry.source_edit_requires_approval,
      allowed_pipelines: entry.allowed_pipelines,
      assigned_to: entry.assigned_to,
      phase_kind: entry.phase_kind,
      review_target: entry.review_target,
    });
  const initialContract = contractShape(task);
  if (
    task.source_edit_paths !== undefined &&
    (!Array.isArray(task.source_edit_paths) ||
      task.source_edit_paths.some((entry) => typeof entry !== 'string'))
  )
    throw new Error(
      '[TASK_SOURCE_GRANT_INVALID] source_edit_paths must be an owner-authored list of exact public files'
    );
  const sourcePaths = validateTaskSourcePaths((task.source_edit_paths ?? []) as string[]);
  const pipelineRefs =
    task.allowed_pipelines === undefined ? [] : validateTaskPipelineRefs(task.allowed_pipelines);
  if (
    task.source_edit_requires_approval !== undefined &&
    typeof task.source_edit_requires_approval !== 'boolean'
  )
    throw new Error('[TASK_SOURCE_GRANT_INVALID] source_edit_requires_approval must be boolean');
  const target = typeof task.target_path === 'string' ? task.target_path : undefined;
  const sourceTarget =
    target &&
    ['libs/', 'scripts/', 'tests/', 'docs/', 'pipelines/', 'knowledge/product/'].some((prefix) =>
      target.startsWith(prefix)
    )
      ? target
      : undefined;
  if (sourceTarget && profileName === 'implementer' && !sourcePaths.includes(sourceTarget))
    sourcePaths.push(...validateTaskSourcePaths([sourceTarget]));
  const declaredOutput =
    typeof task.deliverable === 'string'
      ? task.deliverable
      : typeof task.target_path === 'string' && !sourceTarget
        ? task.target_path
        : undefined;
  const deliverablePath = declaredOutput ? path.resolve(missionDir, declaredOutput) : undefined;
  const insideMissionOutput = (file: string) =>
    ['evidence', 'artifacts'].some((name) =>
      file.startsWith(path.resolve(missionDir, name) + path.sep)
    );
  if (deliverablePath && !insideMissionOutput(deliverablePath))
    throw new Error(
      '[TASK_TOOL_CAPABILITY_UNAVAILABLE] Task needs an approved source-edit workspace; governed task tools cannot edit arbitrary source paths'
    );
  const readRoots = options.readRoots ?? [
    'libs',
    'scripts',
    'docs',
    'pipelines',
    'knowledge/product',
    path.join(missionDir, 'evidence'),
    path.join(missionDir, 'artifacts'),
    ...sourcePaths.map((relative) => path.resolve(root, relative)),
  ];
  // Native tools need a separate enforced task workspace. No root-repository write grant.
  const writeRoots = options.writeRoots ?? [];
  const binding: TaskToolBinding = Object.freeze({
    scope: Object.freeze(scope),
    actorId,
    workItemId,
    taskId,
    missionId,
    leaseId,
    capabilityProfile: profileName,
    externalEgress,
    ...(allowedReasoningBackends
      ? { allowedReasoningBackends: Object.freeze([...allowedReasoningBackends]) }
      : {}),
    readRoots: Object.freeze([...readRoots]),
    writeRoots: Object.freeze([...writeRoots]),
  });
  const assertCurrent = () => {
    options.assertCurrent?.();
    const item = getItem(workItemId);
    if (
      !item ||
      item.status !== 'in_progress' ||
      item.lease_id !== leaseId ||
      item.claimed_by_peer_id !== holder
    )
      throw new Error('[TASK_TOOL_LEASE_LOST] Task claim is no longer current');
    if (JSON.stringify(item.metadata?.security_scope ?? null) !== policySnapshot)
      throw new Error(
        '[TASK_TOOL_EGRESS_POLICY_CHANGED] Stored task egress policy changed; rebind before another model or tool call'
      );
    if (
      SCOPE_FIELDS.some((key) => {
        // Legacy standalone mission tickets used their mission id as a display
        // project link. It is not a new project authorization boundary.
        const value =
          key === 'project_id' &&
          !scope.project_id &&
          item.context?.project_id === missionId &&
          item.context.mission_id === missionId
            ? undefined
            : item.context?.[key];
        return (value ?? '') !== (scope[key] ?? '');
      })
    )
      throw new Error('[TASK_TOOL_SCOPE_DENIED] WorkItem scope differs from runtime');
    const lease = (options.leases ?? listActiveWorkLeases)().find(
      (entry) =>
        entry.lease_id === leaseId &&
        entry.item_id === workItemId &&
        entry.holder_peer_id === holder
    );
    if (
      !lease ||
      lease.status !== 'active' ||
      Date.parse(lease.expires_at) <= (options.now ?? Date.now)()
    )
      throw new Error('[TASK_TOOL_LEASE_LOST] Task lease expired');
    const state = options.mission
      ? options.mission(missionId)
      : loadMissionStateAtPath(path.join(missionDir, 'mission-state.json'));
    if (
      !state ||
      state.mission_id !== missionId ||
      state.tier !== scope.tier ||
      (state.tenant_slug ?? '') !== (scope.tenant_slug ?? '') ||
      (state.organization_id ?? state.relationships?.organization?.organization_id ?? '') !==
        (scope.organization_id ?? '') ||
      (state.relationships?.project?.project_id ?? '') !== (scope.project_id ?? '')
    )
      throw new Error('[TASK_TOOL_SCOPE_DENIED] Mission scope differs from runtime');
    if (state.status !== 'active')
      throw new Error(
        '[TASK_TOOL_MISSION_NOT_ACTIVE] Mission must be active before a worker tool executes'
      );
    const currentTask = tasks().find((entry) => entry.task_id === taskId);
    if (!currentTask || contractShape(currentTask) !== initialContract)
      throw new Error('[TASK_TOOL_SCOPE_DENIED] Task output contract changed; rebind the runtime');
  };
  assertCurrent();
  const read =
    options.read ?? ((file: string) => safeReadFileSnapshot(file, 1_048_576).toString('utf8'));
  const artifact = options.writeArtifact ?? writeScopedArtifact;
  const inspectOutput =
    options.inspectDeliverable ??
    ((file: string) =>
      safeExistsSync(file) ? safeReadFileSnapshot(file, 1_048_576).toString('utf8') : undefined);
  const digest = (content: string) => createHash('sha256').update(content).digest('hex');
  let outputDigest: string | undefined;
  let evidenceRecorded = false;
  const sourceProofs = new Map<string, string>();
  const assertOutputCurrent = (): void => {
    if (!deliverablePath && !sourceTarget)
      throw new Error(
        '[TASK_TOOL_OUTPUT_UNVERIFIED] Task must declare a verifiable deliverable or source target'
      );
    if (deliverablePath) {
      const content = inspectOutput(deliverablePath);
      if (!outputDigest || content === undefined || digest(content) !== outputDigest)
        throw new Error(
          '[TASK_TOOL_OUTPUT_UNVERIFIED] No current-lease verified declared output; write and read back the task deliverable first'
        );
    }
    if (sourcePaths.length && sourceProofs.size === 0)
      throw new Error(
        '[TASK_TOOL_OUTPUT_UNVERIFIED] Source-edit task has no approved verified source change'
      );
    for (const [file, expected] of sourceProofs) {
      const content = inspectOutput(file);
      if (content === undefined || digest(content) !== expected)
        throw new Error('[TASK_TOOL_OUTPUT_UNVERIFIED] Source changed after the granted edit');
    }
  };
  const builtins: TaskToolHandler[] = [
    {
      definition: {
        name: 'kyberion_task_read_file',
        description: 'Read public repository source or this task artifact; bounded to 1 MiB.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
      op: 'file:read',
      execute(input) {
        const relative = required(input.path, 'path');
        const absolute = path.resolve(root, relative);
        if (
          !binding.readRoots.some((allowed) => {
            const base = path.resolve(root, allowed);
            return absolute === base || absolute.startsWith(base + path.sep);
          })
        )
          throw new Error('[TASK_TOOL_SCOPE_DENIED] Read path is outside task roots');
        const canonical = safeRealpath(assertSafeRepositoryPath(absolute));
        if (
          !binding.readRoots.some((allowed) => {
            const base = path.resolve(root, allowed);
            return canonical === base || canonical.startsWith(base + path.sep);
          })
        )
          throw new Error('[TASK_TOOL_SCOPE_DENIED] Read path traverses an ungranted root');
        return { path: relative, content: read(canonical) };
      },
    },
    {
      definition: {
        name: 'kyberion_task_read_deliverable',
        description:
          'Read back exactly the declared task deliverable written and verified by this current lease. No path argument is accepted.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      op: 'task:emit_result',
      execute(input) {
        if (
          !input ||
          typeof input !== 'object' ||
          Array.isArray(input) ||
          Object.keys(input).length
        )
          throw new Error('[TASK_TOOL_INPUT] Deliverable read-back accepts no arguments');
        if (!deliverablePath)
          throw new Error(
            '[TASK_TOOL_CAPABILITY_UNAVAILABLE] Task contract has no file deliverable'
          );
        const content = inspectOutput(deliverablePath);
        if (!outputDigest || content === undefined || digest(content) !== outputDigest)
          throw new Error(
            '[TASK_TOOL_OUTPUT_UNVERIFIED] No current-lease verified declared output to read back'
          );
        return { deliverable: deliverablePath, content, sha256: outputDigest };
      },
    },
    {
      definition: {
        name: 'kyberion_task_write_deliverable',
        description:
          'Write exactly this task NEXT_TASKS declared evidence/artifact deliverable; path is fixed by the server contract.',
        inputSchema: {
          type: 'object',
          properties: { content: { type: 'string' } },
          required: ['content'],
        },
      },
      op: 'task:emit_result',
      execute(input) {
        if (!deliverablePath)
          throw new Error(
            '[TASK_TOOL_CAPABILITY_UNAVAILABLE] Task contract has no file deliverable'
          );
        if (typeof input.content !== 'string' || Buffer.byteLength(input.content) > 1_048_576)
          throw new Error('[TASK_TOOL_INPUT] Deliverable content must be at most 1 MiB');
        evidenceRecorded = false;
        outputDigest = undefined;
        const published = artifact({
          scope: { mission: missionId, task: taskId },
          artifact_class: 'report',
          name: path.basename(deliverablePath),
          content: input.content,
          format: 'text',
          tier: scope.tier,
        });
        assertCurrent();
        (
          options.writeDeliverable ??
          ((file, content) =>
            safeWriteFile(assertSafeRepositoryPath(file, { allowMissingLeaf: true }), content, {
              mkdir: true,
            }))
        )(deliverablePath, input.content);
        const written = inspectOutput(deliverablePath);
        if (written !== input.content)
          throw new Error(
            '[TASK_TOOL_OUTPUT_UNVERIFIED] Declared output read-back differs from requested content'
          );
        outputDigest = digest(written);
        return { status: 'written', deliverable: deliverablePath, artifact: published };
      },
    },
    {
      definition: {
        name: 'kyberion_task_write_artifact',
        description:
          'Write a deliverable in this task scoped artifact store. Cannot write another task or source repository.',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' }, content: { type: 'string' } },
          required: ['name', 'content'],
        },
      },
      op: 'file:write',
      execute(input) {
        const name = required(input.name, 'name');
        if (typeof input.content !== 'string' || Buffer.byteLength(input.content) > 1_048_576)
          throw new Error('[TASK_TOOL_INPUT] Artifact content must be at most 1 MiB');
        return artifact({
          scope: { mission: missionId, task: taskId },
          artifact_class: 'report',
          name,
          content: input.content,
          format: 'text',
          tier: scope.tier,
        });
      },
    },
    {
      definition: {
        name: 'kyberion_task_record_evidence',
        description:
          'Record evidence for this claimed task only through the canonical mission controller; does not verify or finish the mission.',
        inputSchema: {
          type: 'object',
          properties: { note: { type: 'string' } },
          required: ['note'],
        },
      },
      op: 'task:record_evidence',
      async execute(input) {
        const note = required(input.note, 'note');
        if (note.startsWith('-'))
          throw new Error('[TASK_TOOL_INPUT] Note cannot begin with a CLI option');
        assertOutputCurrent();
        if (options.recordEvidence) {
          const result = await options.recordEvidence(binding, note);
          evidenceRecorded = true;
          return result;
        }
        const env = buildExecutionEnv(process.env, 'mission_controller');
        env.KYBERION_WORK_COORDINATION_NAMESPACE = coordinationNamespace();
        env.MISSION_ID = missionId;
        if (scope.tenant_slug) env.KYBERION_TENANT = scope.tenant_slug;
        else delete env.KYBERION_TENANT;
        if (scope.organization_id) env.KYBERION_ORGANIZATION_ID = scope.organization_id;
        else delete env.KYBERION_ORGANIZATION_ID;
        const result = await safeExecResultAsync(
          process.execPath,
          [
            path.join(root, 'dist/scripts/mission_controller.bundle.js'),
            'record-evidence',
            missionId,
            taskId,
            note,
            '--actor-id',
            actorId,
            '--task-binding',
            JSON.stringify({
              workItemId,
              leaseId,
              actorId,
              scope,
              artifactPath: declaredOutput,
              artifactSha256: outputDigest,
              verifiedSources: [...sourceProofs].map(([file, sha256]) => ({
                path: path.relative(root, file).split(path.sep).join('/'),
                sha256,
              })),
            }),
          ],
          { cwd: root, env, timeoutMs: 120_000, maxOutputMB: 2 }
        );
        if (result.status !== 0 || result.error) {
          const diagnostic = artifact({
            scope: { mission: missionId, task: taskId },
            artifact_class: 'evidence',
            name: 'record-evidence-failure.json',
            content: {
              status: result.status,
              error: result.error ? String(result.error) : undefined,
              stderr: result.stderr.slice(-32_000),
              stdout: result.stdout.slice(-32_000),
            },
            format: 'json',
            tier: scope.tier,
          });
          throw new Error(
            `[TASK_TOOL_EVIDENCE_FAILED] Governed evidence controller failed (exit ${String(result.status)}); inspect ${diagnostic.repo_relative_path}`
          );
        }
        evidenceRecorded = true;
        return { status: 'recorded', task_id: taskId, output: result.stdout };
      },
    },
  ];
  const handlers = new Map<string, TaskToolHandler>();
  const sourceTools =
    sourcePaths.length && profileName === 'implementer'
      ? [
          createTaskSourceEditTool(binding, sourcePaths, {
            rootDir: root,
            assertCurrent,
            approve: options.sourceEditApproval,
            artifact,
            requiresApproval: task.source_edit_requires_approval === true,
          }),
        ]
      : [];
  const pipelineTools =
    pipelineRefs.length && profileName === 'implementer'
      ? [
          createTaskPipelineTool(binding, pipelineRefs, {
            rootDir: root,
            assertCurrent,
            execute: options.pipelineExecutor,
            outputHashes: () => {
              const outputs: Record<string, string> = {};
              for (const file of [
                ...(deliverablePath ? [deliverablePath] : []),
                ...sourcePaths.map((relative) => path.resolve(root, relative)),
              ]) {
                const content = inspectOutput(file);
                if (content !== undefined) outputs[path.relative(root, file)] = digest(content);
              }
              return outputs;
            },
          }),
        ]
      : [];
  for (const handler of [...builtins, ...sourceTools, ...pipelineTools, ...(options.tools ?? [])]) {
    if (
      !/^[A-Za-z0-9_-]{1,64}$/.test(handler.definition.name) ||
      ['goal_update', 'context_rewind', 'tool_search'].includes(handler.definition.name)
    )
      throw new Error('[TASK_TOOL_BINDING] Invalid or reserved task tool name');
    const allowed =
      (canEmitResult && ['task:emit_result', 'task:record_evidence'].includes(handler.op)) ||
      profile.allowedOps === '*' ||
      profile.allowedOps.includes(handler.op);
    if (!allowed || handler.op.startsWith('goal:')) continue;
    if (handlers.has(handler.definition.name))
      throw new Error('[TASK_TOOL_BINDING] Duplicate task tool');
    handlers.set(handler.definition.name, handler);
  }
  let calls = 0;
  return {
    binding,
    definitions: [...handlers.values()].map((handler) => handler.definition),
    assertCurrent,
    assertComplete() {
      assertCurrent();
      if (!canEmitResult) return;
      assertOutputCurrent();
      if ((deliverablePath || sourcePaths.length) && !evidenceRecorded)
        throw new Error('[TASK_TOOL_OUTPUT_UNVERIFIED] Task evidence has not been recorded');
      const completedTask = tasks().find((entry) => entry.task_id === taskId);
      if (
        completedTask?.phase_kind !== 'review' &&
        !completedTask?.review_target &&
        completedTask?.status !== 'completed'
      )
        throw new Error(
          '[TASK_TOOL_OUTPUT_UNVERIFIED] Controller has not reflected task completion'
        );
    },
    async execute(call) {
      assertCurrent();
      if (++calls > 64)
        throw new Error('[TASK_TOOL_BUDGET_EXCEEDED] Task tool call budget exhausted');
      const handler = handlers.get(call.name);
      if (!handler) throw new Error(`[TASK_TOOL_DENIED] Tool is not granted: ${call.name}`);
      if (call.name === 'kyberion_task_write_source' || call.name === 'kyberion_task_run_pipeline')
        evidenceRecorded = false;
      const result = await handler.execute(call.arguments, binding);
      assertCurrent();
      if (call.name === 'kyberion_task_write_source' && result && typeof result === 'object') {
        const proof = result as { path?: unknown; sha256?: unknown };
        if (typeof proof.path === 'string' && typeof proof.sha256 === 'string')
          sourceProofs.set(path.resolve(root, proof.path), proof.sha256);
      }
      if (
        call.name === 'kyberion_task_run_pipeline' &&
        result &&
        typeof result === 'object' &&
        (result as { status?: string }).status === 'succeeded'
      ) {
        if (deliverablePath) {
          const content = inspectOutput(deliverablePath);
          if (content !== undefined) outputDigest = digest(content);
        }
        for (const relative of sourcePaths) {
          const file = path.resolve(root, relative);
          const content = inspectOutput(file);
          if (content !== undefined) sourceProofs.set(file, digest(content));
        }
      }
      return result;
    },
  };
}

/** Bounded API tool pursuit using the existing audited goal driver. */
export async function runTaskToolLoop(
  runtime: TaskToolRuntime,
  backend: Pick<ReasoningBackend, 'generateWithTools'>,
  prompt: string,
  options: Partial<RunGoalDrivenLoopOptions> = {}
): Promise<{ text: string; stopReason: string; metadata: Record<string, unknown> }> {
  runtime.assertCurrent();
  if (!backend.generateWithTools)
    throw new Error('[TASK_TOOL_CAPABILITY_UNAVAILABLE] Backend cannot call tools');
  let lastText = '';
  let pendingApproval: { code?: string; approvalRequestId?: string } | undefined;
  const checkedBackend: Pick<ReasoningBackend, 'generateWithTools'> = {
    async generateWithTools(prompt, tools, callOptions) {
      runtime.assertCurrent();
      const result = await backend.generateWithTools!(prompt, tools, callOptions);
      if (result.text) lastText = result.text;
      return result;
    },
  };
  const result = await executeTaskGoalLoop({
    ...options,
    objective: prompt,
    goalId: `task:${runtime.binding.workItemId}:${runtime.binding.leaseId}`,
    missionId: runtime.binding.missionId,
    actorId: runtime.binding.actorId,
    backend: checkedBackend,
    systemPrompt: [
      options.systemPrompt,
      'Use only the granted task tools. File-producing tasks must write the server-declared deliverable and verify their output before completion. When all requirements are met, return the requested TASK_RESULT protocol and call goal_update with status complete; prose alone does not terminate execution.',
    ]
      .filter(Boolean)
      .join('\n'),
    maxTurns: Math.min(options.maxTurns ?? 12, 32),
    extraTools: runtime.definitions,
    preStep: [
      () => {
        runtime.assertCurrent();
        return { decision: 'enter' };
      },
      ...(options.preStep ?? []),
    ],
    executeTool: async (call) => {
      let value: unknown;
      try {
        value = await runtime.execute({ name: call.name, arguments: call.input });
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          (error as { code?: string }).code === 'AGENT_APPROVAL_PENDING'
        ) {
          pendingApproval = error as { code?: string; approvalRequestId?: string };
          return {
            resultText: JSON.stringify({
              status: 'awaiting_approval',
              approval_request_id: pendingApproval.approvalRequestId,
            }),
          };
        }
        throw error;
      }
      return {
        resultText: typeof value === 'string' ? value : JSON.stringify(value),
        externalEffect: call.name !== 'kyberion_task_read_file',
      };
    },
    shouldStopAfterTurn: async (ctx) =>
      Boolean(pendingApproval) || Boolean(await options.shouldStopAfterTurn?.(ctx)),
  });
  runtime.assertCurrent();
  if (pendingApproval) throw pendingApproval;
  if (result.finalState !== 'complete')
    throw new Error(
      `[TASK_TOOL_INCOMPLETE] Task stopped in ${result.finalState}; model prose is not completion evidence`
    );
  runtime.assertComplete?.();
  return {
    text: lastText || result.finalReport || result.goal.terminalReason || '',
    stopReason: result.finalState === 'complete' ? 'end_turn' : result.finalState,
    metadata: {
      task_goal: result.persisted,
      turns: result.turnsRun,
      work_item_id: runtime.binding.workItemId,
    },
  };
}
