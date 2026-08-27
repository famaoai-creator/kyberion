/** DH-03: inspect the runtime seam catalog without mutating provider state. */
import { coreSeamCatalog, type SeamBindingSnapshot } from '../libs/core/seam.js';

// Import only modules that declare production seams. Keeping this list explicit
// makes the dump deterministic and prevents a CLI inspection from booting the
// entire core barrel (which may discover credentials or external providers).
import '../libs/core/agent-execution-port.js';
import '../libs/core/actuator-forwarding-port.js';
import '../libs/core/audit-forwarder.js';
import '../libs/core/deployment-adapter.js';
import '../libs/core/embedding-backend.js';
import '../libs/core/email-account-catalog.js';
import '../libs/core/intent-extractor.js';
import '../libs/core/meeting-join-driver.js';
import '../libs/core/mission-llm.js';
import '../libs/core/reasoning-backend.js';
import '../libs/core/secret-resolver.js';
import '../libs/core/speech-to-text-bridge.js';
import '../libs/core/streaming-stt-bridge.js';
import '../libs/core/streaming-tts-bridge.js';
import '../libs/core/src/actuator-capability.js';
import '../libs/core/surface-interaction-model.js';
import '../libs/core/task-plan-coordinator-port.js';
import '../libs/core/task-session.js';
import '../libs/core/voice-bridge.js';
import '../libs/core/vad-registry.js';
import '../libs/core/environment-capability.js';
import { defineScript, isDirectScript } from './lib/harness.js';

export function loadCoreSeamBindings(): SeamBindingSnapshot[] {
  return coreSeamCatalog.list();
}

function usage(): string {
  return 'Usage: pnpm bindings --dump [--json]';
}

function renderHuman(bindings: SeamBindingSnapshot[]): string {
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
    lines.push(`- ${binding.key} (${binding.multiplicity}): ${providers}`);
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
