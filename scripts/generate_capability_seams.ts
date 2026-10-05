/** DH-07: generate the declaration/provider/consumer seam graph. */
import { loadCoreSeamBindings } from './bindings.js';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeLstat } from '@agent/core/secure-io';
import { defineGenerator, isDirectScript } from './lib/harness.js';

interface SeamRoleEntry {
  declaration: string;
  consumers: string[];
}

const SEAM_ROLES: Record<string, SeamRoleEntry> = {
  'screen.capture-backend': {
    declaration: 'libs/core/virtual/screen-capture-bridge.ts',
    consumers: ['libs/core/virtual/screen-capture-bridge.ts'],
  },
  'virtual-device-inventory': {
    declaration: 'libs/core/virtual/virtual-device-inventory-bridge.ts',
    consumers: ['libs/core/virtual/virtual-device-inventory-bridge.ts'],
  },
  'intent:param-extract': {
    declaration: 'libs/core/intent/intent-resolution.ts',
    consumers: ['libs/core/intent/intent-resolution.ts'],
  },
  'question-profile-provider': {
    declaration: 'libs/core/question-resolver.ts',
    consumers: ['libs/core/question-resolver.ts'],
  },
  'surface-task-reply-section': {
    declaration: 'libs/core/surface/surface-runtime-helpers.ts',
    consumers: ['libs/core/surface/surface-runtime-helpers.ts'],
  },
  'a2a-route': {
    declaration: 'libs/core/mesh/a2a-route-port.ts',
    consumers: ['libs/core/mesh/a2a-bridge.ts'],
  },
  'camera-output-bridge': {
    declaration: 'libs/core/camera-output-bridge.ts',
    consumers: ['libs/actuators/voice-actuator/src/voice-media-output-helpers.ts'],
  },
  'cli-provider-bundle': {
    declaration: 'libs/core/cli-provider-bundle.ts',
    consumers: [
      'libs/core/reasoning/reasoning-cli-provider.ts',
      'libs/core/reasoning/reasoning-bootstrap.ts',
    ],
  },
  'voice.audio-playback': {
    declaration: 'libs/core/voice/audio-playback.ts',
    consumers: ['libs/core/voice/audio-playback.ts'],
  },
  'provider-backend-constructor': {
    declaration: 'libs/core/provider/provider-backend-resolver.ts',
    consumers: ['libs/core/provider/provider-backend-resolver.ts'],
  },
  'actuator.capability-probe': {
    declaration: 'libs/core/actuator/actuator-capability.ts',
    consumers: ['libs/core/actuator/actuator-capability.ts'],
  },
  'actuator-forwarding-port': {
    declaration: 'libs/core/actuator/actuator-forwarding-port.ts',
    consumers: ['libs/actuators/wisdom-actuator/src/compatibility/cross-actuator-forwarders.ts'],
  },
  'agent-execution-port': {
    declaration: 'libs/core/agent/agent-execution-port.ts',
    consumers: ['libs/actuators/agent-actuator/src/agent-actuator-helpers.ts'],
  },
  'agent-runtime-ensurer': {
    declaration: 'libs/core/agent/agent-runtime-port.ts',
    consumers: ['libs/core/agent/agent-runtime-supervisor.ts'],
  },
  'agent-pane-runtime-bridge': {
    declaration: 'libs/core/agent/agent-pane-runtime-bridge.ts',
    consumers: ['libs/core/agent/agent-lifecycle.ts', 'libs/core/mesh/a2a-bridge.ts'],
  },
  'agent-exec-adapter-bridge': {
    declaration: 'libs/core/agent/agent-exec-adapter-bridge.ts',
    consumers: ['libs/core/agent/agent-lifecycle.ts'],
  },
  'audio-bus-bridge': {
    declaration: 'libs/core/voice/audio-bus-bridge.ts',
    consumers: [
      'libs/core/voice/audio-bus-resolver.ts',
      'libs/actuators/voice-actuator/src/voice-action-helpers.ts',
    ],
  },
  'ocr-provider': {
    declaration: 'libs/core/ocr-bridge.ts',
    consumers: ['libs/core/ocr-bridge.ts'],
  },
  'public-ingress-provider': {
    declaration: 'libs/core/ingress/public-ingress-seam.ts',
    consumers: [
      'libs/core/ingress/public-ingress-provider-registry.ts',
      'libs/core/ingress/public-ingress-service.ts',
    ],
  },
  'image-generation-provider': {
    declaration: 'libs/core/media/image-generation-bridge.ts',
    consumers: ['libs/core/media/image-generation-bridge.ts'],
  },
  'risky-approval-override': {
    declaration: 'libs/core/risky-op-approval-port.ts',
    consumers: ['libs/core/risky-op-approval-port.ts'],
  },
  'scenario-op-override': {
    declaration: 'libs/core/actuator/actuator-op-registry.ts',
    consumers: [
      'libs/core/actuator/actuator-op-registry.ts',
      'scripts/pipeline-execution-part-control.ts',
    ],
  },
  'virtual-camera-capture': {
    declaration: 'libs/core/virtual/virtual-camera-bridge.ts',
    consumers: ['libs/core/virtual/virtual-camera-bridge.ts'],
  },
  'calendar-provider': {
    declaration: 'libs/core/meeting/calendar-provider-bridge.ts',
    consumers: ['libs/core/meeting/calendar-workflow.ts'],
  },
  'browser-automation-runtime': {
    declaration: 'libs/core/browser/browser-automation-runtime-bridge.ts',
    consumers: ['libs/actuators/browser-actuator/src/browser-runtime-helpers.ts'],
  },
  'audit-forwarder': {
    declaration: 'libs/core/governance/audit-forwarder.ts',
    consumers: ['libs/core/governance/audit-chain.ts'],
  },
  'deployment-adapter': {
    declaration: 'libs/core/actuator/deployment-adapter.ts',
    consumers: ['libs/actuators/deployment-actuator/src/deployment-actuator-helpers.ts'],
  },
  'embedding-backend': {
    declaration: 'libs/core/embedding-backend.ts',
    consumers: ['libs/core/knowledge/knowledge-index.ts'],
  },
  'knowledge-adapter': {
    declaration: 'libs/core/knowledge/knowledge-adapter.ts',
    consumers: ['libs/core/knowledge/knowledge-adapter.ts'],
  },
  'identity-context-resolver': {
    declaration: 'libs/core/identity-context-bridge.ts',
    consumers: ['libs/core/authority.ts', 'libs/core/tier-guard.ts'],
  },
  'email-account-provider': {
    declaration: 'libs/core/integrations/email-account-catalog.ts',
    consumers: ['libs/core/actuator/adapter-default-selection.ts', 'scripts/email-workflow.ts'],
  },
  'environment.capability-probe': {
    declaration: 'libs/core/environment-capability.ts',
    consumers: ['libs/core/environment-capability.ts'],
  },
  'intent-extractor': {
    declaration: 'libs/core/intent/intent-extractor.ts',
    consumers: [
      'libs/core/mission/mission-orchestration-worker.ts',
      'libs/core/reasoning/reasoning-bootstrap.ts',
    ],
  },
  'judgment-backend': {
    declaration: 'libs/core/reasoning/judgment-backend.ts',
    consumers: ['libs/core/organization/organization-operating-model-persistence.ts'],
  },
  'meeting-join-driver': {
    declaration: 'libs/core/meeting/meeting-join-driver.ts',
    consumers: ['libs/core/in-room-meeting-driver.ts'],
  },
  'mission-worker-core-dispatcher': {
    declaration: 'libs/core/mission/mission-orchestration-worker-dispatch-port.ts',
    consumers: ['libs/core/mission/mission-orchestration-worker-part-core.ts'],
  },
  'provider-health-resolver': {
    declaration: 'libs/core/provider/provider-health-view.ts',
    consumers: ['libs/core/provider/provider-health-registry.ts'],
  },
  'reasoning-backend': {
    declaration: 'libs/core/reasoning/reasoning-backend.ts',
    consumers: ['libs/core/reasoning/reasoning-bootstrap.ts'],
  },
  'risky-approval-handler': {
    declaration: 'libs/core/risky-op-approval-port.ts',
    consumers: ['libs/core/risky-op-registry.ts', 'libs/core/mesh/acp-mediator.ts'],
  },
  'secret-resolver': {
    declaration: 'libs/core/secret/secret-resolver.ts',
    consumers: ['libs/core/service/service-secret-resolver.ts'],
  },
  'structured-runner': {
    declaration: 'libs/core/mission/mission-llm.ts',
    consumers: ['libs/core/mission/mission-llm.ts'],
  },
  'super-nerve-executor': {
    declaration: 'libs/core/super-nerve-execution-port.ts',
    consumers: ['libs/actuators/orchestrator-actuator/src/super-nerve/index.ts'],
  },
  'surface-provider': {
    declaration: 'libs/core/surface/surface-interaction-model.ts',
    consumers: ['libs/core/surface/surface-interaction-model.ts'],
  },
  'task-intent-builder': {
    declaration: 'libs/core/task/task-session.ts',
    consumers: ['libs/core/task/task-session.ts'],
  },
  'speech-to-text-bridge': {
    declaration: 'libs/core/voice/speech-to-text-bridge.ts',
    consumers: ['libs/actuators/voice-actuator/src/index.ts'],
  },
  'streaming-stt-bridge': {
    declaration: 'libs/core/voice/streaming-stt-bridge.ts',
    consumers: ['libs/actuators/voice-actuator/src/index.ts'],
  },
  'streaming-tts-bridge': {
    declaration: 'libs/core/voice/streaming-tts-bridge.ts',
    consumers: ['libs/core/voice/streaming-tts-bridge.ts'],
  },
  'task-plan-coordinator': {
    declaration: 'libs/core/task/task-plan-coordinator-port.ts',
    consumers: ['libs/core/task/task-executor.ts'],
  },
  'ui-element-detector': {
    declaration: 'libs/core/surface/ui-element-detector.ts',
    consumers: ['libs/actuators/vision-actuator/src/mark-elements.ts'],
  },
  'voice-bridge': {
    declaration: 'libs/core/voice/voice-bridge.ts',
    consumers: ['libs/actuators/meeting-actuator/src/meeting-intelligence-ops.ts'],
  },
  'voice.vad-backend': {
    declaration: 'libs/core/voice/vad-registry.ts',
    consumers: ['libs/core/ten-vad-bridge.ts', 'libs/core/silero-vad-bridge.ts'],
  },
};

const OUTPUT_PATH = pathResolver.rootResolve('docs/developer/CAPABILITY_SEAMS.md');

export function readCapabilitySeamsTextFile(filePath: string): string {
  if (!safeExistsSync(filePath) || !safeLstat(filePath).isFile()) {
    throw new Error(`${filePath} must be a regular file`);
  }
  return readTextFile(filePath);
}

function source(relativePath: string): string {
  return readCapabilitySeamsTextFile(pathResolver.rootResolve(relativePath));
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
    '> Generated by `pnpm kyberion generate capability-seams`. Do not edit manually.',
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
