import { describeServiceHarness } from '@agent/core/service-harness';
import { loadServicePresetsCatalog } from '@agent/core/service-preset-registry';
import { pathResolver } from '@agent/core/path-resolver';
import { withExecutionContext } from '@agent/core/authority';
import { defineGenerator, isDirectScript } from './lib/harness.js';

type ServiceHarnessRegistry = {
  version: '1.0.0';
  kind: 'service-harness-registry';
  services: Array<{
    service_id: string;
    display_name: string;
    description?: string;
    auth_strategy?: string;
    operation_count: number;
    detail_ref: string;
    operations: Array<{
      action: string;
      description?: string;
      kind: 'capture' | 'apply';
      risk: 'read' | 'write' | 'destructive';
      approval_required: boolean;
      idempotency: 'not_applicable' | 'recommended' | 'required';
    }>;
  }>;
};

const OUTPUT_PATH = pathResolver.knowledge('product/orchestration/service-harness-registry.json');

function buildRegistry(): ServiceHarnessRegistry {
  const presets = loadServicePresetsCatalog();
  const services = Object.keys(presets.services)
    .sort()
    .map((serviceId) => {
      const descriptor = describeServiceHarness(serviceId, { detail: false });
      return {
        service_id: descriptor.service_id,
        display_name: descriptor.display_name,
        ...(descriptor.description ? { description: descriptor.description } : {}),
        ...(descriptor.auth_strategy ? { auth_strategy: descriptor.auth_strategy } : {}),
        operation_count: descriptor.operation_count,
        detail_ref: `knowledge/product/orchestration/service-presets/${serviceId}.json`,
        operations: descriptor.operations.map((operation) => ({
          action: operation.action,
          ...(operation.description ? { description: operation.description } : {}),
          kind: operation.kind,
          risk: operation.risk,
          approval_required: operation.approval_required,
          idempotency: operation.idempotency,
        })),
      };
    });

  return {
    version: '1.0.0',
    kind: 'service-harness-registry',
    services,
  };
}

export const main = defineGenerator({
  id: 'service-harness-registry',
  outputs: [OUTPUT_PATH],
  render() {
    const content = withExecutionContext(
      'ecosystem_architect',
      () => `${JSON.stringify(buildRegistry(), null, 2)}\n`
    );
    return [{ path: OUTPUT_PATH, content }];
  },
});

if (
  isDirectScript(import.meta.url, 'generate_service_harness_registry.ts') ||
  isDirectScript(import.meta.url, 'generate_service_harness_registry.js')
)
  void main();
