import { isRecord } from '@agent/core/foundation';

export interface PresetInputSpec {
  key: string;
  type: 'string' | 'enum' | 'boolean' | 'secret';
  description: string;
  required: boolean;
  values?: string[];
  default?: string;
}

export interface PresetSummary {
  id: string;
  category: string;
  description: string;
  inputs: PresetInputSpec[];
  write_target_count: number;
  write_targets: string[];
}

export interface ConfigMissionBrief {
  instance_id: string;
  preset_id: string;
  tenant: string;
  status: 'draft' | 'applying' | 'applied' | 'failed';
  created_at: string;
}

const INPUT_TYPES = ['string', 'enum', 'boolean', 'secret'] as const;
const BRIEF_STATUSES = ['draft', 'applying', 'applied', 'failed'] as const;

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function scalarString(value: unknown): string | null {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : null;
}

export function parseConfigMissionPreset(value: unknown): PresetSummary | null {
  if (!isRecord(value) || value.type !== 'config_mission' || !nonEmptyString(value.preset_id)) {
    return null;
  }
  if (value.inputs !== undefined && !isRecord(value.inputs)) return null;
  if (value.write_targets !== undefined && !Array.isArray(value.write_targets)) return null;

  const inputs: PresetInputSpec[] = [];
  for (const [key, rawSpec] of Object.entries(value.inputs ?? {})) {
    if (!isRecord(rawSpec) || !INPUT_TYPES.includes(rawSpec.type as (typeof INPUT_TYPES)[number])) {
      return null;
    }
    if (rawSpec.description !== undefined && !nonEmptyString(rawSpec.description)) return null;
    if (rawSpec.required !== undefined && typeof rawSpec.required !== 'boolean') return null;
    if (rawSpec.values !== undefined) {
      if (!Array.isArray(rawSpec.values) || !rawSpec.values.every(nonEmptyString)) return null;
    }
    const defaultValue =
      rawSpec.default === undefined ? undefined : (scalarString(rawSpec.default) ?? undefined);
    if (rawSpec.default !== undefined && defaultValue === undefined) return null;
    inputs.push({
      key,
      type: rawSpec.type as PresetInputSpec['type'],
      description: rawSpec.description === undefined ? '' : rawSpec.description,
      required: rawSpec.required !== false && rawSpec.default === undefined,
      ...(Array.isArray(rawSpec.values) ? { values: [...rawSpec.values] } : {}),
      ...(defaultValue !== undefined ? { default: defaultValue } : {}),
    });
  }

  const writeTargets = value.write_targets ?? [];
  if (!writeTargets.every(nonEmptyString)) return null;
  return {
    id: value.preset_id,
    category: nonEmptyString(value.category) ? value.category : '',
    description: nonEmptyString(value.description) ? value.description : '',
    inputs,
    write_target_count: writeTargets.length,
    write_targets: [...writeTargets],
  };
}

export function parseConfigMissionBrief(value: unknown): ConfigMissionBrief | null {
  if (!isRecord(value)) return null;
  if (
    !nonEmptyString(value.instance_id) ||
    !nonEmptyString(value.preset_id) ||
    !nonEmptyString(value.tenant) ||
    !BRIEF_STATUSES.includes(value.status as (typeof BRIEF_STATUSES)[number]) ||
    !nonEmptyString(value.created_at)
  ) {
    return null;
  }
  return {
    instance_id: value.instance_id,
    preset_id: value.preset_id,
    tenant: value.tenant,
    status: value.status as ConfigMissionBrief['status'],
    created_at: value.created_at,
  };
}
