/** DH-07: generate the declaration/provider/consumer seam graph. */
import { loadCoreSeamBindings } from './bindings.js';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeReadFile } from '@agent/core/secure-io';
import { defineGenerator, isDirectScript } from './lib/harness.js';

interface SeamRoleEntry {
  declaration: string;
  consumers: string[];
}

const SEAM_ROLES: Record<string, SeamRoleEntry> = {
  'actuator.capability-probe': {
    declaration: 'libs/core/src/actuator-capability.ts',
    consumers: ['libs/core/src/actuator-capability.ts'],
  },
  'actuator-forwarding-port': {
    declaration: 'libs/core/actuator-forwarding-port.ts',
    consumers: ['libs/actuators/wisdom-actuator/src/compatibility/cross-actuator-forwarders.ts'],
  },
  'agent-execution-port': {
    declaration: 'libs/core/agent-execution-port.ts',
    consumers: ['libs/actuators/agent-actuator/src/agent-actuator-helpers.ts'],
  },
  'audit-forwarder': {
    declaration: 'libs/core/audit-forwarder.ts',
    consumers: ['libs/core/audit-chain.ts'],
  },
  'deployment-adapter': {
    declaration: 'libs/core/deployment-adapter.ts',
    consumers: ['libs/actuators/deployment-actuator/src/deployment-actuator-helpers.ts'],
  },
  'embedding-backend': {
    declaration: 'libs/core/embedding-backend.ts',
    consumers: ['libs/core/src/knowledge-index.ts'],
  },
  'email-account-provider': {
    declaration: 'libs/core/email-account-catalog.ts',
    consumers: ['libs/core/adapter-default-selection.ts', 'scripts/email-workflow.ts'],
  },
  'environment.capability-probe': {
    declaration: 'libs/core/environment-capability.ts',
    consumers: ['libs/core/environment-capability.ts'],
  },
  'intent-extractor': {
    declaration: 'libs/core/intent-extractor.ts',
    consumers: ['libs/core/mission-orchestration-worker.ts', 'libs/core/reasoning-bootstrap.ts'],
  },
  'meeting-join-driver': {
    declaration: 'libs/core/meeting-join-driver.ts',
    consumers: ['libs/core/in-room-meeting-driver.ts'],
  },
  'reasoning-backend': {
    declaration: 'libs/core/reasoning-backend.ts',
    consumers: ['libs/core/reasoning-bootstrap.ts'],
  },
  'secret-resolver': {
    declaration: 'libs/core/secret-resolver.ts',
    consumers: ['libs/core/service-secret-resolver.ts'],
  },
  'structured-runner': {
    declaration: 'libs/core/mission-llm.ts',
    consumers: ['libs/core/mission-llm.ts'],
  },
  'surface-provider': {
    declaration: 'libs/core/surface-interaction-model.ts',
    consumers: ['libs/core/surface-interaction-model.ts'],
  },
  'task-intent-builder': {
    declaration: 'libs/core/task-session.ts',
    consumers: ['libs/core/task-session.ts'],
  },
  'speech-to-text-bridge': {
    declaration: 'libs/core/speech-to-text-bridge.ts',
    consumers: ['libs/actuators/voice-actuator/src/index.ts'],
  },
  'streaming-stt-bridge': {
    declaration: 'libs/core/streaming-stt-bridge.ts',
    consumers: ['libs/actuators/voice-actuator/src/index.ts'],
  },
  'streaming-tts-bridge': {
    declaration: 'libs/core/streaming-tts-bridge.ts',
    consumers: ['libs/core/streaming-tts-bridge.ts'],
  },
  'task-plan-coordinator': {
    declaration: 'libs/core/task-plan-coordinator-port.ts',
    consumers: ['libs/core/task-executor.ts'],
  },
  'voice-bridge': {
    declaration: 'libs/core/voice-bridge.ts',
    consumers: ['libs/actuators/meeting-actuator/src/meeting-intelligence-ops.ts'],
  },
  'voice.vad-backend': {
    declaration: 'libs/core/vad-registry.ts',
    consumers: ['libs/core/ten-vad-bridge.ts', 'libs/core/silero-vad-bridge.ts'],
  },
};

const OUTPUT_PATH = pathResolver.rootResolve('docs/developer/CAPABILITY_SEAMS.md');

function source(relativePath: string): string {
  return String(safeReadFile(pathResolver.rootResolve(relativePath), { encoding: 'utf8' }));
}

function validateRoles(bindings: ReturnType<typeof loadCoreSeamBindings>): string[] {
  const findings: string[] = [];
  const bindingKeys = new Set(bindings.map((binding) => binding.key));
  for (const binding of bindings) {
    const role = SEAM_ROLES[binding.key];
    if (!role) {
      findings.push(`${binding.key}: no declaration/consumer role entry`);
      continue;
    }
    const declarationSource = source(role.declaration);
    if (!declarationSource.includes('createSeam') && !declarationSource.includes('defineSeam')) {
      findings.push(`${binding.key}: declaration has no createSeam call (${role.declaration})`);
    }
    if (role.consumers.length === 0) findings.push(`${binding.key}: consumer list is empty`);
    for (const consumer of role.consumers) {
      if (!safeExistsSync(pathResolver.rootResolve(consumer))) {
        findings.push(`${binding.key}: consumer file is missing (${consumer})`);
      }
    }
  }
  for (const key of Object.keys(SEAM_ROLES)) {
    if (!bindingKeys.has(key))
      findings.push(`${key}: role entry has no runtime seam catalog entry`);
  }
  return findings;
}

function esc(value: string): string {
  return value.replaceAll('`', '\\`').replaceAll('|', '\\|');
}

function render(bindings: ReturnType<typeof loadCoreSeamBindings>): string {
  const lines = [
    '# Capability seam bindings',
    '',
    '> Generated by `pnpm generate:capability-seams`. Do not edit manually.',
    '',
    'This graph is the DH-07 backstop for the seams currently migrated to `defineSeam`.',
    'The absence of a provider in this snapshot is valid for optional/runtime-probed seams;',
    'the declaration and consumer roles must still be present.',
    '',
    '```mermaid',
    'flowchart LR',
  ];
  for (const binding of bindings) {
    const role = SEAM_ROLES[binding.key];
    const seamId = `seam_${binding.key.replace(/[^A-Za-z0-9_]/gu, '_')}`;
    lines.push(`  ${seamId}["${binding.key}\\n${binding.multiplicity}"]`);
    lines.push(`  declaration_${seamId}["declaration\\n${role.declaration}"] --> ${seamId}`);
    for (const consumer of role.consumers) {
      const consumerId = `consumer_${seamId}_${Math.abs(hash(consumer))}`;
      lines.push(`  ${seamId} --> ${consumerId}["consumer\\n${consumer}"]`);
    }
    for (const provider of binding.providers) {
      const providerId = `provider_${seamId}_${Math.abs(hash(provider.id))}`;
      lines.push(`  ${providerId}["provider\\n${provider.id}"] --> ${seamId}`);
    }
  }
  lines.push(
    '```',
    '',
    '## Runtime binding table',
    '',
    '| Seam | Multiplicity | Declaration | Providers | Consumers |',
    '| --- | --- | --- | --- | --- |'
  );
  for (const binding of bindings) {
    const role = SEAM_ROLES[binding.key];
    const providers = binding.providers.length
      ? binding.providers
          .map((provider) => `${provider.id} (${provider.metadata.provenance})`)
          .join('<br>')
      : 'none observed';
    lines.push(
      `| ${esc(binding.key)} | ${binding.multiplicity} | ${role.declaration} | ${providers} | ${role.consumers.join('<br>')} |`
    );
  }
  lines.push(
    '',
    '## Completeness rule',
    '',
    '- Every catalog seam has one declaration and at least one consumer entry.',
    '- Provider provenance is emitted by the runtime catalog and is never inferred from the document.',
    ''
  );
  return lines.join('\n');
}

function hash(value: string): number {
  let result = 0;
  for (const char of value) result = (result * 31 + char.charCodeAt(0)) | 0;
  return result;
}

function normalizeGeneratedDocument(document: string): string {
  return document
    .split('\n')
    .map((line) => {
      if (!line.trimStart().startsWith('|')) return line;
      const cells = line
        .trim()
        .split('|')
        .map((cell) => cell.trim());
      if (cells.length < 3) return line.trimEnd();
      if (cells.slice(1, -1).every((cell) => /^-+$/u.test(cell))) {
        return `| ${cells
          .slice(1, -1)
          .map(() => '---')
          .join(' | ')} |`;
      }
      return `| ${cells.slice(1, -1).join(' | ')} |`;
    })
    .join('\n');
}

export const main = defineGenerator({
  id: 'capability-seams',
  outputs: [OUTPUT_PATH],
  normalize: normalizeGeneratedDocument,
  render() {
    const bindings = loadCoreSeamBindings();
    const findings = validateRoles(bindings);
    if (findings.length > 0) {
      throw new Error(`FAILED\n${findings.map((finding) => `- ${finding}`).join('\n')}`);
    }
    return [{ path: OUTPUT_PATH, content: render(bindings) }];
  },
});

if (
  isDirectScript(import.meta.url, 'generate_capability_seams.ts') ||
  isDirectScript(import.meta.url, 'generate_capability_seams.js')
)
  void main();
