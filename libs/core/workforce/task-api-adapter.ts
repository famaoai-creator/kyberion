/** API reasoning providers use the same claimed-task tool runtime as native hosts. */
import type { AgentAdapter, AgentAskOptions, AgentResponse } from '../agent/agent-adapter.js';
import {
  registerAgentExecAdapterBridge,
  listAgentExecAdapterBridges,
  type AgentExecAdapterRequest,
} from '../agent/agent-exec-adapter-bridge.js';
import {
  listReasoningProviderDescriptors,
  resolveReasoningProviderDescriptor,
} from '../reasoning/reasoning-provider-registry.js';
import type { ReasoningBackend } from '../reasoning/reasoning-backend.js';
import { buildTaskBackend } from './task-execution-port.js';
import { runTaskToolLoop, type TaskToolRuntime } from './task-tool-runtime.js';
import type { RunGoalDrivenLoopOptions } from './worker-goal-driver.js';
import {
  PROVIDER_IDS,
  resolveProviderPermissionArgs,
  type ProviderId,
} from '../provider/provider-permission-profiles.js';
import { isPromptedToolCallingEnabled } from '../reasoning/reasoning-backend-policy.js';

export interface TaskApiAdapterOptions {
  mode: string;
  modelId?: string;
  systemPrompt?: string;
  runtime: TaskToolRuntime;
  backend?: Pick<ReasoningBackend, 'generateWithTools'>;
  /** CLI prompted tools execute only via this runtime; CLI native tools stay off. */
  isolateNativeTools?: boolean;
  /** Trusted host budget/persistence seams, never model-supplied. */
  loopOptions?: Partial<RunGoalDrivenLoopOptions>;
}

export class TaskApiAdapter implements AgentAdapter {
  private backend?: Pick<ReasoningBackend, 'generateWithTools'>;
  private controller?: AbortController;
  constructor(private readonly options: TaskApiAdapterOptions) {
    this.backend = options.backend;
  }
  async boot(): Promise<void> {
    this.options.runtime.assertCurrent();
    if (this.options.isolateNativeTools) {
      const descriptor = resolveReasoningProviderDescriptor(this.options.mode);
      if (
        !descriptor ||
        !isPromptedToolCallingEnabled(descriptor.mode) ||
        !(PROVIDER_IDS as readonly string[]).includes(descriptor.provider)
      )
        throw new Error(
          '[TASK_TOOL_CAPABILITY_UNAVAILABLE] CLI has no governed prompted-tool isolation contract'
        );
      const permission = resolveProviderPermissionArgs(
        'planner',
        descriptor.provider as ProviderId
      );
      if (permission.kind === 'refused')
        throw new Error(
          `[TASK_TOOL_CAPABILITY_UNAVAILABLE] Native tool isolation refused: ${permission.reason}`
        );
    }
    if (!this.backend) {
      this.backend = buildTaskBackend(this.options.mode);
    }
    if (!this.backend?.generateWithTools)
      throw new Error(
        `[TASK_TOOL_CAPABILITY_UNAVAILABLE] ${this.options.mode} cannot execute the task tool contract`
      );
  }
  async ask(prompt: string, askOptions?: AgentAskOptions): Promise<AgentResponse> {
    await this.boot();
    this.controller = new AbortController();
    const onAbort = () => this.controller?.abort();
    if (askOptions?.signal?.aborted) this.controller.abort();
    askOptions?.signal?.addEventListener('abort', onAbort, { once: true });
    const signal = this.controller.signal;
    const backend: Pick<ReasoningBackend, 'generateWithTools'> = {
      generateWithTools: async (prompt, tools, options) => {
        if (signal.aborted) throw new Error('[TASK_TOOL_CANCELLED] Task execution cancelled');
        const result = await this.backend!.generateWithTools!(prompt, tools, {
          ...options,
          ...(this.options.modelId ? { model: this.options.modelId } : {}),
          capability_profile: this.options.isolateNativeTools
            ? 'planner'
            : this.options.runtime.binding.capabilityProfile,
          ...(this.options.isolateNativeTools ? { profile: 'planner', role: 'planner' } : {}),
          signal,
        });
        if (signal.aborted)
          throw new Error(
            '[TASK_TOOL_CANCELLED] Late provider result discarded after cancellation'
          );
        this.options.runtime.assertCurrent();
        return result;
      },
    };
    try {
      return await runTaskToolLoop(this.options.runtime, backend, prompt, {
        ...this.options.loopOptions,
        systemPrompt: this.options.systemPrompt,
      });
    } finally {
      askOptions?.signal?.removeEventListener('abort', onAbort);
      this.controller = undefined;
    }
  }
  async shutdown(): Promise<void> {
    this.controller?.abort();
  }
  getRuntimeInfo(): Record<string, unknown> {
    return { mode: 'task-api-tools', provider: this.options.mode, model: this.options.modelId };
  }
}

/** Native CLI hosts may choose the same prompted/governed tool path. */
export function createTaskBackedAgentAdapter(request: AgentExecAdapterRequest): AgentAdapter {
  const runtime = (request as AgentExecAdapterRequest & { taskToolRuntime?: TaskToolRuntime })
    .taskToolRuntime;
  if (!runtime) throw new Error('[TASK_TOOL_BINDING] Claimed task tool runtime required');
  const descriptor =
    resolveReasoningProviderDescriptor(request.provider) ??
    listReasoningProviderDescriptors().find(
      (entry) => entry.provider === request.provider && entry.transport === 'cli'
    );
  if (!descriptor)
    throw new Error(
      `[TASK_TOOL_CAPABILITY_UNAVAILABLE] No reasoning adapter for ${request.provider}`
    );
  return new TaskApiAdapter({
    mode: descriptor.mode,
    modelId: request.modelId,
    systemPrompt: request.systemPrompt,
    runtime,
    isolateNativeTools: descriptor.transport === 'cli',
  });
}

/** Descriptor-driven registration: adding an API provider needs no lifecycle branch. */
export function registerTaskApiAdapters(): void {
  const registered = new Set(listAgentExecAdapterBridges().map((entry) => entry.bridge_id));
  for (const descriptor of listReasoningProviderDescriptors()) {
    if (!['api', 'local-server'].includes(descriptor.transport) || !descriptor.profile.tool_calling)
      continue;
    const id = descriptor.mode;
    if (registered.has(id)) continue;
    registerAgentExecAdapterBridge(
      {
        bridge_id: id,
        governedTaskTools: true,
        createAdapter(request: AgentExecAdapterRequest) {
          const runtime = (
            request as AgentExecAdapterRequest & { taskToolRuntime?: TaskToolRuntime }
          ).taskToolRuntime;
          if (!runtime)
            throw new Error(
              '[TASK_TOOL_BINDING] API task execution requires a claimed task tool runtime'
            );
          return new TaskApiAdapter({
            mode: id,
            modelId: request.modelId,
            systemPrompt: request.systemPrompt,
            runtime,
          });
        },
      },
      { provenance: 'builtin', source: 'workforce/task-api-adapter' }
    );
    registered.add(id);
  }
}
