import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
import type { ConfigChangeEnvelope, ConfigChangeTargetKind } from './config-change.js';

export interface ConfigMissionPresetInput {
  type: 'string' | 'enum' | 'boolean' | 'secret';
  description: string;
  required?: boolean;
  values?: string[];
  default?: unknown;
}

export interface ConfigMissionPreset {
  preset_id: string;
  type: 'config_mission';
  category: string;
  description: string;
  inputs: Record<string, ConfigMissionPresetInput>;
  pipeline: string;
  write_targets: string[];
  authority_role: string;
  target_kind?: ConfigChangeTargetKind;
  scope_kind?: 'system' | 'tenant' | 'organization' | 'project' | 'mission' | 'task';
  tier?: 'public' | 'confidential' | 'personal';
  notes?: string;
}

export interface ConfigMissionBrief {
  instance_id: string;
  preset_id: string;
  tenant: string;
  inputs: Record<string, string>;
  status: 'draft' | 'applying' | 'applied' | 'failed';
  created_at: string;
  applied_at?: string;
  error?: string;
  change: ConfigChangeEnvelope;
}

const PRESET_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/config-mission-preset.schema.json'
);
const BRIEF_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/config-mission-brief.schema.json'
);

/** Load a config-mission preset through its canonical schema boundary. */
export function loadConfigMissionPresetAtPath(filePath: string): ConfigMissionPreset {
  return defineCatalog<ConfigMissionPreset>({
    id: 'config-mission-preset',
    path: filePath,
    schema: PRESET_SCHEMA_PATH,
  }).load();
}

/**
 * Load a persisted config-mission brief and enforce bindings that JSON Schema
 * cannot express: the directory tenant and change identity must agree with
 * the persisted envelope before it can be displayed or applied.
 */
export function loadConfigMissionBriefAtPath(filePath: string): ConfigMissionBrief {
  const brief = defineCatalog<ConfigMissionBrief>({
    id: 'config-mission-brief',
    path: filePath,
    schema: BRIEF_SCHEMA_PATH,
  }).load();
  if (brief.change.change_id !== brief.instance_id) {
    throw new Error(
      `[CONFIG_MISSION_INVALID] change_id '${brief.change.change_id}' does not match instance_id '${brief.instance_id}'`
    );
  }
  if (
    brief.change.scope.scope_kind !== 'system' &&
    brief.change.scope.tenant_slug !== brief.tenant
  ) {
    throw new Error(
      `[CONFIG_MISSION_INVALID] scope tenant '${brief.change.scope.tenant_slug || ''}' does not match brief tenant '${brief.tenant}'`
    );
  }
  return brief;
}
