import {
  describeServiceHarness,
  loadServicePresetsCatalog,
  pathResolver,
  safeReadFile,
  safeWriteFile,
  withExecutionContext,
} from '@agent/core';

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

function main(): void {
  const expected = withExecutionContext(
    'ecosystem_architect',
    () => `${JSON.stringify(buildRegistry(), null, 2)}\n`
  );
  if (process.argv.includes('--check')) {
    const actual = withExecutionContext('ecosystem_architect', () =>
      String(safeReadFile(OUTPUT_PATH, { encoding: 'utf8' }) || '')
    );
    if (actual !== expected) {
      console.error('[service-harness-registry] registry is out of date');
      process.exit(1);
    }
    console.log('[service-harness-registry] registry is up to date');
    return;
  }

  withExecutionContext('ecosystem_architect', () => safeWriteFile(OUTPUT_PATH, expected));
  console.log(`[service-harness-registry] wrote ${OUTPUT_PATH}`);
}

if (process.argv[1] && /generate_service_harness_registry\.(ts|js)$/.test(process.argv[1])) {
  main();
}
