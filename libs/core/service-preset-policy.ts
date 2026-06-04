import type { ServicePresetRecord } from './service-preset-registry.js';

export interface ServicePresetPolicy {
  auth_strategy?: string;
  setup_hint?: string;
  allow_unsafe_cli?: boolean;
  allow_local_network?: boolean;
  fallback_strategy?: string;
  headers?: Record<string, string>;
}

export function getServicePresetPolicy(preset: Pick<ServicePresetRecord, keyof ServicePresetPolicy> | null | undefined): ServicePresetPolicy {
  if (!preset || typeof preset !== 'object') return {};
  return {
    auth_strategy: typeof preset.auth_strategy === 'string' ? preset.auth_strategy : undefined,
    setup_hint: typeof preset.setup_hint === 'string' ? preset.setup_hint : undefined,
    allow_unsafe_cli: typeof preset.allow_unsafe_cli === 'boolean' ? preset.allow_unsafe_cli : undefined,
    allow_local_network: typeof preset.allow_local_network === 'boolean' ? preset.allow_local_network : undefined,
    fallback_strategy: typeof preset.fallback_strategy === 'string' ? preset.fallback_strategy : undefined,
    headers: preset.headers && typeof preset.headers === 'object' ? preset.headers : undefined,
  };
}

export function getServicePresetOperationMap(preset: Pick<ServicePresetRecord, 'operations'> | null | undefined): Record<string, unknown> {
  if (!preset || typeof preset !== 'object') return {};
  return preset.operations && typeof preset.operations === 'object' ? preset.operations : {};
}

export function collectServicePresetCliFallbacks(preset: Pick<ServicePresetRecord, 'operations'> | null | undefined): string[] {
  const commands = new Set<string>();
  for (const op of Object.values(getServicePresetOperationMap(preset))) {
    const record = op as Record<string, unknown>;
    const alternatives = Array.isArray(record.alternatives)
      ? record.alternatives
      : [{ ...record, type: record.type || 'api' }];
    for (const alt of alternatives) {
      const alternative = alt as Record<string, unknown>;
      if (alternative.type === 'cli' && alternative.command) {
        commands.add(String(alternative.command));
      }
    }
  }
  return [...commands].sort();
}
