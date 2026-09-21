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
import { getRegisteredEnvText } from './foundation/env.js';
import { pathResolver } from './path-resolver.js';
import {
  registerAgentExecAdapterBridge,
  type AgentExecAdapterRequest,
} from './agent-exec-adapter-bridge.js';

const PROJECT_ROOT = pathResolver.rootDir();

let registered = false;

function createCodexAdapter(request: AgentExecAdapterRequest): AgentAdapter {
  const mode = (getRegisteredEnvText('KYBERION_CODEX_MODE') || 'app-server').toLowerCase();
  if (mode === 'exec' || mode === 'legacy') return new CodexAdapter();
  return new CodexAppServerAdapter({
    model: request.modelId,
    modelProvider: getRegisteredEnvText('KYBERION_CODEX_MODEL_PROVIDER'),
    cwd: request.cwd || PROJECT_ROOT,
    systemPrompt: request.systemPrompt,
    approvalMode:
      (getRegisteredEnvText('KYBERION_CODEX_APPROVAL') || 'strict').toLowerCase() === 'relaxed'
        ? 'relaxed'
        : 'strict',
  });
}

export function registerBuiltinAgentExecAdapters(): void {
  if (registered) return;
  registered = true;
  registerAgentExecAdapterBridge({
    bridge_id: 'claude',
    createAdapter(request) {
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
      });
    },
  });
  registerAgentExecAdapterBridge({
    bridge_id: 'codex',
    createAdapter: createCodexAdapter,
  });
  registerAgentExecAdapterBridge({
    bridge_id: 'agy',
    createAdapter(request) {
      return new AgyAdapter({
        bin: 'agy',
        cwd: request.cwd || PROJECT_ROOT,
        model: request.modelId,
      });
    },
  });
}

registerBuiltinAgentExecAdapters();
