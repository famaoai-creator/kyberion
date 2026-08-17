/** DH-03: inspect the runtime seam catalog without mutating provider state. */
import { coreSeamCatalog, type SeamBindingSnapshot } from '@agent/core/seam';

// Import only modules that declare production seams. Keeping this list explicit
// makes the dump deterministic and prevents a CLI inspection from booting the
// entire core barrel (which may discover credentials or external providers).
import '@agent/core/agent-execution-port';
import '@agent/core/actuator-forwarding-port';
import '@agent/core/audit-forwarder';
import '@agent/core/deployment-adapter';
import '@agent/core/embedding-backend';
import '@agent/core/email-account-catalog';
import '@agent/core/intent-extractor';
import '@agent/core/meeting-join-driver';
import '@agent/core/mission-llm';
import '@agent/core/reasoning-backend';
import '@agent/core/secret-resolver';
import '@agent/core/speech-to-text-bridge';
import '@agent/core/streaming-stt-bridge';
import '@agent/core/streaming-tts-bridge';
import '@agent/core/actuator-capability';
import '@agent/core/surface-interaction-model';
import '@agent/core/task-plan-coordinator-port';
import '@agent/core/task-session';
import '@agent/core/voice-bridge';
import '@agent/core/vad-registry';
import '@agent/core/environment-capability';

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

if (/(?:^|[/\\])bindings\.ts$/u.test(process.argv[1] ?? '')) {
  const dump = process.argv.includes('--dump');
  const json = process.argv.includes('--json');
  if (!dump) {
    console.error(usage());
    process.exitCode = 2;
  } else {
    const bindings = loadCoreSeamBindings();
    process.stdout.write(
      json ? `${JSON.stringify(bindings, null, 2)}\n` : `${renderHuman(bindings)}\n`
    );
  }
}
