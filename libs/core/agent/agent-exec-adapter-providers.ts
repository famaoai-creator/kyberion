/**
 * Builtin pipe/exec AgentAdapter providers for the agent-exec-adapter seam.
 * Vendor adapter classes stay here; lifecycle only talks to the seam.
 */

import {
  AgyAdapter,
  ClaudeAdapter,
  CodexAdapter,
  CodexAppServerAdapter,
  type AgentAdapter,
} from './agent-adapter.js';
import { getRegisteredEnvText } from '../foundation/env.js';
import { pathResolver } from '../path-resolver.js';
import { createTaskBackedAgentAdapter } from '../workforce/task-api-adapter.js';
import { createScopedRuntimeApprovalHandler } from './agent-task-approval.js';
import {
  registerAgentExecAdapterBridge,
  type AgentExecAdapterRequest,
} from './agent-exec-adapter-bridge.js';

const PROJECT_ROOT = pathResolver.rootDir();

let registered = false;

function createCodexAdapter(request: AgentExecAdapterRequest): AgentAdapter {
  const mode = (getRegisteredEnvText('KYBERION_CODEX_MODE') || 'app-server').toLowerCase();
  // Legacy exec has no host tool executor: it must never swallow a claimed
  // task binding and fall back to unrestricted provider-native tools. It
  // cannot disable inherited MCP servers either, so a read-only (unclaimed)
  // runtime also takes the isolated app-server path.
  if (!request.taskToolRuntime && !request.readOnly && (mode === 'exec' || mode === 'legacy'))
    return new CodexAdapter({ model: request.modelId });
  const confined = Boolean(request.taskToolRuntime || request.readOnly);
  return new CodexAppServerAdapter({
    model: request.modelId,
    modelProvider: getRegisteredEnvText('KYBERION_CODEX_MODEL_PROVIDER'),
    codexProfile: getRegisteredEnvText('KYBERION_CODEX_PROFILE'),
    cwd: request.cwd || PROJECT_ROOT,
    systemPrompt: request.systemPrompt,
    taskToolRuntime: request.taskToolRuntime,
    ...(request.readOnly ? { readOnly: true } : {}),
    sandboxMode: confined ? 'read-only' : undefined,
    networkAccess: confined ? false : undefined,
    requestApproval:
      request.scope && request.agentId
        ? createScopedRuntimeApprovalHandler({
            agentId: request.agentId,
            provider: 'codex',
            cwd: request.cwd || PROJECT_ROOT,
            scope: request.scope,
            missionId: request.missionId,
          })
        : undefined,
    approvalMode:
      (getRegisteredEnvText('KYBERION_CODEX_APPROVAL') || 'strict').toLowerCase() === 'relaxed'
        ? 'relaxed'
        : 'strict',
  });
}

export function registerBuiltinAgentExecAdapters(): void {
  if (registered) return;
  registered = true;
  registerAgentExecAdapterBridge(
    {
      bridge_id: 'claude',
      governedTaskTools: true,
      readOnlyTools: true,
      createAdapter(request) {
        if (request.taskToolRuntime) return createTaskBackedAgentAdapter(request);
        if (request.readOnly)
          // Manifest tool lists are ignored: they may only widen the read-only projection.
          return new ClaudeAdapter({
            systemPrompt: request.systemPrompt,
            cwd: request.cwd || PROJECT_ROOT,
            model: request.modelId,
            effort: request.effort,
            readOnly: true,
          });
        const fromManifest =
          request.allowedActuators || request.deniedActuators
            ? ClaudeAdapter.resolveToolRestrictions(
                request.allowedActuators || [],
                request.deniedActuators || []
              )
            : { allowedTools: [] as string[], disallowedTools: [] as string[] };
        const allowedTools =
          request.allowedTools && request.allowedTools.length > 0
            ? request.allowedTools
            : fromManifest.allowedTools.length > 0
              ? fromManifest.allowedTools
              : undefined;
        const disallowedTools =
          request.disallowedTools && request.disallowedTools.length > 0
            ? request.disallowedTools
            : fromManifest.disallowedTools.length > 0
              ? fromManifest.disallowedTools
              : undefined;
        return new ClaudeAdapter({
          systemPrompt: request.systemPrompt,
          cwd: request.cwd || PROJECT_ROOT,
          model: request.modelId,
          effort: request.effort,
          allowedTools,
          disallowedTools,
          permissionMode: 'auto',
          governedMcp: true,
          ...(request.toolsDisabled ? { toolsDisabled: true } : {}),
        });
      },
    },
    { provenance: 'builtin', source: 'agent-exec-adapter-providers' }
  );
  registerAgentExecAdapterBridge(
    {
      bridge_id: 'codex',
      governedTaskTools: true,
      readOnlyTools: true,
      createAdapter: createCodexAdapter,
    },
    { provenance: 'builtin', source: 'agent-exec-adapter-providers' }
  );
  registerAgentExecAdapterBridge(
    {
      bridge_id: 'agy',
      // No `readOnlyTools`: agy's sandbox flag has no verified read-only
      // filesystem mode (sandbox-policy marks it partial), so lifecycle
      // refuses an unclaimed agy delegation instead of starting it writable.
      createAdapter(request) {
        if (request.taskToolRuntime) return createTaskBackedAgentAdapter(request);
        if (request.readOnly)
          throw new Error(
            '[TOOL_READ_ONLY_UNSUPPORTED] agy has no verified read-only filesystem mode'
          );
        return new AgyAdapter({
          bin: 'agy',
          cwd: request.cwd || PROJECT_ROOT,
          model: request.modelId,
        });
      },
    },
    { provenance: 'builtin', source: 'agent-exec-adapter-providers' }
  );
}

registerBuiltinAgentExecAdapters();
