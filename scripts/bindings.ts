/** DH-03: inspect the runtime seam catalog without mutating provider state. */
import { coreSeamCatalog, type SeamBindingSnapshot } from '@agent/core/seam';
import { peekProviderDiscovery, type ProviderInfo } from '@agent/core/provider/provider-discovery';
import { resolveReasoningBackendSelectionFromContext } from '@agent/core/reasoning/reasoning-backend-policy';

// Import only modules that declare production seams. Keeping this list explicit
// makes the dump deterministic and prevents a CLI inspection from booting the
// entire core barrel (which may discover credentials or external providers).
import '@agent/core/agent/agent-execution-port';
import '@agent/core/mesh/a2a-route-port';
import '@agent/core/actuator/actuator-forwarding-port';
import '@agent/core/actuator/actuator-op-registry';
import '@agent/core/agent/agent-exec-adapter-bridge';
import '@agent/core/agent/agent-pane-runtime-bridge';
import '@agent/core/voice/audio-bus-bridge';
import '@agent/core/governance/audit-forwarder';
import '@agent/core/browser/browser-automation-runtime-bridge';
import '@agent/core/meeting/calendar-provider-bridge';
import '@agent/core/camera-output-bridge';
import '@agent/core/video/video-filter';
import '@agent/core/provider/bundles/index';
import '@agent/core/actuator/deployment-adapter';
import '@agent/core/embedding-backend';
import '@agent/core/integrations/email-account-catalog';
import '@agent/core/knowledge/knowledge-adapter';
import '@agent/core/media/image-generation-bridge';
import '@agent/core/intent/intent-extractor';
import '@agent/core/question-resolver';
import '@agent/core/surface/surface-runtime-helpers';
import '@agent/core/reasoning/judgment-backend';
import '@agent/core/identity-context-bridge';
import '@agent/core/meeting/meeting-join-driver';
import '@agent/core/mission/mission-llm';
import '@agent/core/mission/mission-orchestration-worker-dispatch-port';
import '@agent/core/ocr-bridge';
import '@agent/core/ingress/public-ingress-seam';
import '@agent/core/reasoning/reasoning-backend';
import '@agent/core/risky-op-approval-port';
import '@agent/core/secret/secret-resolver';
import '@agent/core/voice/audio-playback';
import '@agent/core/provider/provider-backend-resolver';
import '@agent/core/voice/speech-to-text-bridge';
import '@agent/core/voice/streaming-stt-bridge';
import '@agent/core/voice/streaming-tts-bridge';
import '@agent/core/super-nerve-execution-port';
import '@agent/core/actuator/actuator-capability';
import '@agent/core/surface/surface-interaction-model';
import '@agent/core/task/task-plan-coordinator-port';
import '@agent/core/task/task-session';
import '@agent/core/surface/ui-element-detector';
import '@agent/core/virtual/virtual-camera-bridge';
import '@agent/core/virtual/screen-capture-bridge';
import '@agent/core/virtual/virtual-device-inventory-bridge';
import '@agent/core/voice/voice-bridge';
import '@agent/core/voice/vad-registry';
import '@agent/core/environment-capability';
import '@agent/core/build-readiness';
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
