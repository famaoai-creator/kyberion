/** DH-03: inspect the runtime seam catalog without mutating provider state. */
import { coreSeamCatalog, type SeamBindingSnapshot } from '../libs/core/seam.js';
import { peekProviderDiscovery, type ProviderInfo } from '../libs/core/provider-discovery.js';
import { resolveReasoningBackendSelectionFromContext } from '../libs/core/reasoning-backend-policy.js';

// Import only modules that declare production seams. Keeping this list explicit
// makes the dump deterministic and prevents a CLI inspection from booting the
// entire core barrel (which may discover credentials or external providers).
import '../libs/core/agent-execution-port.js';
import '../libs/core/a2a-route-port.js';
import '../libs/core/actuator-forwarding-port.js';
import '../libs/core/audit-forwarder.js';
import '../libs/core/deployment-adapter.js';
import '../libs/core/embedding-backend.js';
import '../libs/core/email-account-catalog.js';
import '../libs/core/intent-extractor.js';
import '../libs/core/identity-context-bridge.js';
import '../libs/core/meeting-join-driver.js';
import '../libs/core/mission-llm.js';
import '../libs/core/mission-orchestration-worker-dispatch-port.js';
import '../libs/core/reasoning-backend.js';
import '../libs/core/risky-op-approval-port.js';
import '../libs/core/secret-resolver.js';
import '../libs/core/speech-to-text-bridge.js';
import '../libs/core/streaming-stt-bridge.js';
import '../libs/core/streaming-tts-bridge.js';
import '../libs/core/super-nerve-execution-port.js';
import '../libs/core/src/actuator-capability.js';
import '../libs/core/surface-interaction-model.js';
import '../libs/core/task-plan-coordinator-port.js';
import '../libs/core/task-session.js';
import '../libs/core/voice-bridge.js';
import '../libs/core/vad-registry.js';
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
    process.stdout.write(
      json ? `${JSON.stringify(bindings, null, 2)}\n` : `${renderHuman(bindings)}\n`
    );
  },
});

if (
  isDirectScript(import.meta.url, 'bindings.ts') ||
  isDirectScript(import.meta.url, 'bindings.js')
)
  void runBindings();
