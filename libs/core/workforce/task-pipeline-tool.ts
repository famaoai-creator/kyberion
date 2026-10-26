/** Durable named-pipeline tool: resume suspended work, never replay completed effects. */
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { withLock } from '../foundation/lock-utils.js';
import { readJsonIfPresent } from '../foundation/json.js';
import { safeReadFileSnapshot, assertSafeRepositoryPath } from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';
import { scopedArtifactDir, writeScopedArtifact } from './artifact-store.js';
import { AgentRuntimeApprovalPendingError } from '../agent/agent-prompt-approval-port.js';
import type { TaskToolBinding, TaskToolHandler } from './task-tool-runtime.js';
import { validateTaskPipelineRefs } from '../foundation/task-tool-grant-validation.js';
export { validateTaskPipelineRefs } from '../foundation/task-tool-grant-validation.js';

export interface TaskPipelineExecutionRequest {
  pipelineRef: string;
  sourceSha256: string;
  binding: TaskToolBinding;
  resumeRunId?: string;
  assertCurrent(): void;
}
export interface TaskPipelineExecutionResult {
  status: string;
  results?: readonly { status?: string }[];
  runId?: string;
  approvalRequestId?: string;
  storageChannel?: string;
}
export type TaskPipelineExecutor = (
  request: TaskPipelineExecutionRequest
) => Promise<TaskPipelineExecutionResult>;
let executor: TaskPipelineExecutor | undefined;
export function registerTaskPipelineExecutor(next: TaskPipelineExecutor): () => void {
  if (executor && executor !== next)
    throw new Error('[TASK_PIPELINE_EXECUTOR_DUPLICATE] Task pipeline executor already registered');
  executor = next;
  return () => {
    if (executor === next) executor = undefined;
  };
}

export interface TaskPipelineCheckpoint {
  version: 1;
  identity: string;
  status: 'intent' | 'suspended' | 'succeeded' | 'failed' | 'uncertain';
  pipeline_ref: string;
  source_sha256: string;
  run_id?: string;
  approval_request_id?: string;
  storage_channel?: string;
  output_hashes?: Record<string, string>;
}
export interface TaskPipelineToolOptions {
  assertCurrent(): void;
  rootDir?: string;
  execute?: TaskPipelineExecutor;
  source?: (file: string) => string;
  checkpointPath?: (name: string) => string;
  read?: (file: string) => TaskPipelineCheckpoint | null;
  write?: (name: string, state: TaskPipelineCheckpoint) => void;
  outputHashes?: () => Record<string, string>;
  lock?: <T>(name: string, run: () => Promise<T>) => Promise<T>;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function createTaskPipelineTool(
  binding: TaskToolBinding,
  references: readonly string[],
  options: TaskPipelineToolOptions
): TaskToolHandler {
  const refs = validateTaskPipelineRefs([...references]);
  if (!options.execute && !executor)
    throw new Error(
      '[TASK_TOOL_CAPABILITY_UNAVAILABLE] Task pipeline executor is not installed; start through the governed supervisor or mission controller'
    );
  const root = options.rootDir ?? pathResolver.rootDir();
  const readSource =
    options.source ?? ((file) => safeReadFileSnapshot(file, 1_048_576).toString('utf8'));
  const sourceHashes = new Map(
    refs.map((ref) => [ref, hash(readSource(assertSafeRepositoryPath(path.join(root, ref))))])
  );
  const read = options.read ?? ((file) => readJsonIfPresent<TaskPipelineCheckpoint>(file) ?? null);
  const write =
    options.write ??
    ((name, state) => {
      writeScopedArtifact({
        scope: { mission: binding.missionId, task: binding.taskId },
        artifact_class: 'state',
        name,
        content: state,
        format: 'json',
        tier: binding.scope.tier,
      });
    });
  return {
    definition: {
      name: 'kyberion_task_run_pipeline',
      description:
        'Execute an owner-declared validated pipeline, or resume its original suspended run. Completed effects are not replayed.',
      inputSchema: {
        type: 'object',
        properties: { pipeline_ref: { type: 'string', enum: refs } },
        required: ['pipeline_ref'],
      },
    },
    op: 'pipeline:run',
    async execute(input) {
      options.assertCurrent();
      if (typeof input.pipeline_ref !== 'string' || !sourceHashes.has(input.pipeline_ref))
        throw new Error('[TASK_PIPELINE_DENIED] Pipeline is not granted by the task contract');
      const ref = input.pipeline_ref;
      const sourceHash = hash(readSource(assertSafeRepositoryPath(path.join(root, ref))));
      if (sourceHash !== sourceHashes.get(ref))
        throw new Error(
          '[TASK_PIPELINE_SOURCE_CHANGED] Pipeline source changed; rebind the owner-approved task contract'
        );
      const identity = hash(
        JSON.stringify({
          work_item: binding.workItemId,
          scope: binding.scope,
          pipeline: ref,
          source: sourceHash,
        })
      );
      const name = `pipeline-${hash(ref)}.json`;
      const file = options.checkpointPath
        ? options.checkpointPath(name)
        : path.join(
            scopedArtifactDir(
              { mission: binding.missionId, task: binding.taskId },
              'state',
              binding.scope.tier
            ).dir,
            name
          );
      return (options.lock ?? ((name, run) => withLock(name, run, 120_000)))(
        `task-pipeline:${hash(file)}`,
        async () => {
          options.assertCurrent();
          if (hash(readSource(assertSafeRepositoryPath(path.join(root, ref)))) !== sourceHash)
            throw new Error(
              '[TASK_PIPELINE_SOURCE_CHANGED] Pipeline source changed before execution'
            );
          let state = read(file);
          if (
            state &&
            (state.version !== 1 ||
              state.identity !== identity ||
              state.pipeline_ref !== ref ||
              state.source_sha256 !== sourceHash ||
              !['intent', 'suspended', 'succeeded', 'failed', 'uncertain'].includes(state.status))
          )
            throw new Error(
              '[TASK_PIPELINE_CHECKPOINT_INVALID] Pipeline checkpoint does not match this task and source'
            );
          if (
            state &&
            options.outputHashes &&
            ['succeeded', 'suspended'].includes(state.status) &&
            JSON.stringify(state.output_hashes ?? {}) !== JSON.stringify(options.outputHashes())
          )
            throw new Error(
              '[TASK_PIPELINE_OUTPUT_CHANGED] Pipeline outputs changed after the saved checkpoint; reconcile before resume or completion'
            );
          if (state?.status === 'succeeded')
            return { status: 'succeeded', runId: state.run_id, recovered: true };
          if (state && state.status !== 'suspended')
            throw new Error(
              '[TASK_PIPELINE_EFFECT_UNCERTAIN] Prior pipeline intent is unresolved or failed; inspect scoped checkpoint and reconcile before retrying'
            );
          if (state?.status === 'suspended' && (!state.run_id || !state.approval_request_id))
            throw new Error(
              '[TASK_PIPELINE_CHECKPOINT_INVALID] Suspended run lacks a durable run/approval identity'
            );
          const resumeRunId = state?.run_id;
          state = {
            version: 1,
            identity,
            status: 'intent',
            pipeline_ref: ref,
            source_sha256: sourceHash,
            ...(resumeRunId ? { run_id: resumeRunId } : {}),
          };
          options.assertCurrent();
          write(name, state);
          let result: TaskPipelineExecutionResult;
          try {
            result = await (options.execute ?? executor)!({
              pipelineRef: ref,
              sourceSha256: sourceHash,
              binding,
              ...(resumeRunId ? { resumeRunId } : {}),
              assertCurrent: options.assertCurrent,
            });
          } catch (error) {
            write(name, { ...state, status: 'uncertain' });
            throw error;
          }
          options.assertCurrent();
          if (
            result.status === 'suspended' &&
            result.runId &&
            result.approvalRequestId &&
            result.storageChannel
          ) {
            write(name, {
              ...state,
              status: 'suspended',
              run_id: result.runId,
              approval_request_id: result.approvalRequestId,
              ...(result.storageChannel ? { storage_channel: result.storageChannel } : {}),
              ...(options.outputHashes ? { output_hashes: options.outputHashes() } : {}),
            });
            throw new AgentRuntimeApprovalPendingError(
              result.approvalRequestId,
              binding.scope,
              result.storageChannel,
              'pipeline'
            );
          }
          if (
            result.status !== 'succeeded' ||
            !Array.isArray(result.results) ||
            result.results.some(
              (entry) =>
                !['success', 'succeeded', 'skipped', 'recovered'].includes(entry.status ?? '')
            )
          ) {
            write(name, {
              ...state,
              status: 'failed',
              ...(result.runId ? { run_id: result.runId } : {}),
            });
            throw new Error(
              '[TASK_PIPELINE_FAILED] Declared pipeline did not produce a successful validated receipt'
            );
          }
          write(name, {
            ...state,
            status: 'succeeded',
            ...(result.runId ? { run_id: result.runId } : {}),
            ...(options.outputHashes ? { output_hashes: options.outputHashes() } : {}),
          });
          return { status: 'succeeded', runId: result.runId, steps: result.results.length };
        }
      );
    },
  };
}
