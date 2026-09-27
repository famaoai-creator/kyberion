/** DH-03: inspect the runtime seam catalog without mutating provider state. */
import { coreSeamCatalog, type SeamBindingSnapshot } from '../libs/core/seam.js';
import {
  peekProviderDiscovery,
  type ProviderInfo,
} from '../libs/core/provider/provider-discovery.js';
import { resolveReasoningBackendSelectionFromContext } from '../libs/core/reasoning/reasoning-backend-policy.js';

// Import only modules that declare production seams. Keeping this list explicit
// makes the dump deterministic and prevents a CLI inspection from booting the
// entire core barrel (which may discover credentials or external providers).
import '../libs/core/agent/agent-execution-port.js';
import '../libs/core/mesh/a2a-route-port.js';
import '../libs/core/actuator/actuator-forwarding-port.js';
import '../libs/core/actuator/actuator-op-registry.js';
import '../libs/core/agent/agent-exec-adapter-bridge.js';
import '../libs/core/agent/agent-pane-runtime-bridge.js';
import '../libs/core/voice/audio-bus-bridge.js';
import '../libs/core/governance/audit-forwarder.js';
import '../libs/core/browser/browser-automation-runtime-bridge.js';
import '../libs/core/meeting/calendar-provider-bridge.js';
import '../libs/core/camera-output-bridge.js';
import '../libs/core/provider/bundles/index.js';
import '../libs/core/actuator/deployment-adapter.js';
import '../libs/core/embedding-backend.js';
import '../libs/core/integrations/email-account-catalog.js';
import '../libs/core/knowledge/knowledge-adapter.js';
import '../libs/core/media/image-generation-bridge.js';
import '../libs/core/intent/intent-extractor.js';
import '../libs/core/reasoning/judgment-backend.js';
import '../libs/core/identity-context-bridge.js';
import '../libs/core/meeting/meeting-join-driver.js';
import '../libs/core/mission/mission-llm.js';
import '../libs/core/mission/mission-orchestration-worker-dispatch-port.js';
import '../libs/core/ocr-bridge.js';
import '../libs/core/reasoning/reasoning-backend.js';
import '../libs/core/risky-op-approval-port.js';
import '../libs/core/secret/secret-resolver.js';
import '../libs/core/voice/speech-to-text-bridge.js';
import '../libs/core/voice/streaming-stt-bridge.js';
import '../libs/core/voice/streaming-tts-bridge.js';
import '../libs/core/super-nerve-execution-port.js';
import '../libs/core/actuator/actuator-capability.js';
import '../libs/core/surface/surface-interaction-model.js';
import '../libs/core/task/task-plan-coordinator-port.js';
import '../libs/core/task/task-session.js';
import '../libs/core/surface/ui-element-detector.js';
import '../libs/core/virtual/virtual-camera-bridge.js';
import '../libs/core/voice/voice-bridge.js';
import '../libs/core/voice/vad-registry.js';
import '../libs/core/environment-capability.js';
import { defineScript, isDirectScript } from './lib/harness.js';

export interface BindingInspectionSnapshot extends SeamBindingSnapshot {
  reasoning_selection?: {
    mode: string;
    reason: string;
    provider_probe: 'memory' | 'disk' | 'unavailable';
    available_providers: string[];
  };
}

function providerSnapshots(providers: ProviderInfo[]) {
  return providers.map(({ provider, installed, healthy }) => ({
    provider,
    installed,
    healthy,
  }));
}

export function loadCoreSeamBindings(): BindingInspectionSnapshot[] {
  const bindings = coreSeamCatalog.list();
  const reasoningBinding = bindings.find((entry) => entry.key === 'reasoning-backend');
  if (!reasoningBinding) return bindings;

  const probe = peekProviderDiscovery();
  let selection: BindingInspectionSnapshot['reasoning_selection'];
  try {
    const resolved = resolveReasoningBackendSelectionFromContext({
      env: process.env,
      providers: providerSnapshots(probe.providers),
    });
    selection = {
      mode: resolved.mode,
      reason: resolved.reason,
      provider_probe: probe.source,
      available_providers: probe.providers
        .filter((provider) => provider.installed && provider.healthy)
        .map((provider) => provider.provider)
        .sort(),
    };
  } catch (error) {
    selection = {
      mode: 'unresolved',
      reason: `selection failed: ${error instanceof Error ? error.message : String(error)}`,
      provider_probe: probe.source,
      available_providers: [],
    };
  }

  return bindings.map((binding) =>
    binding === reasoningBinding ? { ...binding, reasoning_selection: selection } : binding
  );
}

function usage(): string {
  return 'Usage: pnpm bindings --dump [--json]';
}

function renderHuman(bindings: BindingInspectionSnapshot[]): string {
  const lines = [`core seams: ${bindings.length}`];
  for (const binding of bindings) {
    const providers = binding.providers.length
      ? binding.providers
          .map(
            ({ id, metadata }) =>
              `${id} [${metadata.provenance}${metadata.source ? `; ${metadata.source}` : ''}; reason=${metadata.reason || 'unspecified'}]`
          )
          .join(', ')
      : '(no provider registered)';
    const selection = binding.reasoning_selection
      ? `; selection=${binding.reasoning_selection.mode} (${binding.reasoning_selection.reason}; probe=${binding.reasoning_selection.provider_probe})`
      : '';
    lines.push(`- ${binding.key} (${binding.multiplicity}): ${providers}${selection}`);
  }
  return lines.join('\n');
}

export const runBindings = defineScript({
  name: 'bindings',
  flags: [],
  run(context) {
    const dump = context.argv.includes('--dump');
    const json = context.argv.includes('--json');
    if (!dump) throw new Error(usage());
    const bindings = loadCoreSeamBindings();
    context.print(json ? JSON.stringify(bindings, null, 2) : renderHuman(bindings));
  },
});

if (
  isDirectScript(import.meta.url, 'bindings.ts') ||
  isDirectScript(import.meta.url, 'bindings.js')
)
  void runBindings();
