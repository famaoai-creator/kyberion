const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const DIAGNOSTIC_STATUSES = new Set(['ok', 'incomplete', 'error']);

export type SetupService = { id: string; label: string; auth: string; configured: boolean };
export type SetupDiagnostic = {
  id: string;
  status: 'ok' | 'incomplete' | 'error';
  action?: { type: 'navigate'; target: string };
  command?: string;
};
export type Setup = {
  surface_roles: Array<{
    id: string;
    role_ja: string;
    tagline_ja: string;
    port: number;
    enabled: boolean;
  }>;
  active_surfaces: Array<{ id: string; port?: number; enabled: boolean }>;
  reasoning_mode: string;
  model_tiers: Record<string, string>;
  providers?: { priority?: string[]; default_models?: Record<string, string> };
  profile: {
    name: string;
    language: string;
    interaction_style: string;
    primary_domain: string;
    vision: string;
    agent_id: string;
    tenant_slug: string;
    onboarding_complete: boolean;
    avatar_registered: boolean;
    avatar_source?: string;
    voice_profiles: Array<{
      profile_id: string;
      display_name: string;
      sample_count: number;
      sample_refs?: string[];
    }>;
  };
  service_catalog: SetupService[];
  diagnostics: SetupDiagnostic[];
  capabilities: Array<{ id: string; label: string; status: string; href?: string }>;
  tenant: {
    active_slug: string;
    runtime_bound: boolean;
    catalog: Array<{
      tenant_slug: string;
      tenant_id: string;
      display_name: string;
      status: string;
      assigned_role: string;
    }>;
  };
  agent_management: {
    configured: {
      agent_id?: string;
      display_name?: string;
      provider?: string;
      model_id?: string;
    } | null;
    durable_identities: Array<{
      nhi_id: string;
      kind: string;
      display_name: string;
      lifecycle_status: string;
      organization_id: string;
      provider_hint: string;
      model_hint: string;
    }>;
  };
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasSafeTree(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(hasSafeTree);
  if (!isRecord(value)) return true;
  return Object.entries(value).every(
    ([key, nested]) => !DANGEROUS_KEYS.has(key) && hasSafeTree(nested)
  );
}

function stringField(record: JsonRecord, key: string): string | undefined {
  return typeof record[key] === 'string' ? record[key] : undefined;
}

function optionalString(record: JsonRecord, key: string): boolean {
  return record[key] === undefined || typeof record[key] === 'string';
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function stringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function parseSetup(value: unknown): Setup | undefined {
  if (!isRecord(value)) return undefined;
  const profile = value.profile;
  const tenant = value.tenant;
  const management = value.agent_management;
  if (!isRecord(profile) || !isRecord(tenant) || !isRecord(management)) return undefined;

  if (
    !Array.isArray(value.surface_roles) ||
    value.surface_roles.some(
      (entry) =>
        !isRecord(entry) ||
        !stringField(entry, 'id') ||
        !stringField(entry, 'role_ja') ||
        !stringField(entry, 'tagline_ja') ||
        !nonNegativeInteger(entry.port) ||
        typeof entry.enabled !== 'boolean'
    ) ||
    !Array.isArray(value.active_surfaces) ||
    value.active_surfaces.some(
      (entry) =>
        !isRecord(entry) ||
        !stringField(entry, 'id') ||
        (entry.port !== undefined && !nonNegativeInteger(entry.port)) ||
        typeof entry.enabled !== 'boolean'
    ) ||
    typeof value.reasoning_mode !== 'string' ||
    !stringRecord(value.model_tiers)
  ) {
    return undefined;
  }

  if (!isRecord(value.providers) && value.providers !== undefined) return undefined;
  if (
    isRecord(value.providers) &&
    ((value.providers.priority !== undefined && !stringArray(value.providers.priority)) ||
      (value.providers.default_models !== undefined &&
        !stringRecord(value.providers.default_models)))
  ) {
    return undefined;
  }

  if (
    !stringField(profile, 'name') ||
    !stringField(profile, 'language') ||
    !stringField(profile, 'interaction_style') ||
    !stringField(profile, 'primary_domain') ||
    !stringField(profile, 'vision') ||
    !stringField(profile, 'agent_id') ||
    !stringField(profile, 'tenant_slug') ||
    typeof profile.onboarding_complete !== 'boolean' ||
    typeof profile.avatar_registered !== 'boolean' ||
    !optionalString(profile, 'avatar_source') ||
    !Array.isArray(profile.voice_profiles) ||
    profile.voice_profiles.some(
      (entry) =>
        !isRecord(entry) ||
        !stringField(entry, 'profile_id') ||
        !stringField(entry, 'display_name') ||
        !nonNegativeInteger(entry.sample_count) ||
        (entry.sample_refs !== undefined && !stringArray(entry.sample_refs))
    )
  ) {
    return undefined;
  }

  if (
    !Array.isArray(value.service_catalog) ||
    value.service_catalog.some(
      (entry) =>
        !isRecord(entry) ||
        !stringField(entry, 'id') ||
        !stringField(entry, 'label') ||
        !stringField(entry, 'auth') ||
        typeof entry.configured !== 'boolean'
    ) ||
    !Array.isArray(value.diagnostics) ||
    value.diagnostics.some(
      (entry) =>
        !isRecord(entry) ||
        !stringField(entry, 'id') ||
        typeof entry.status !== 'string' ||
        !DIAGNOSTIC_STATUSES.has(entry.status) ||
        (entry.action !== undefined &&
          (!isRecord(entry.action) ||
            entry.action.type !== 'navigate' ||
            typeof entry.action.target !== 'string')) ||
        !optionalString(entry, 'command')
    ) ||
    !Array.isArray(value.capabilities) ||
    value.capabilities.some(
      (entry) =>
        !isRecord(entry) ||
        !stringField(entry, 'id') ||
        !stringField(entry, 'label') ||
        !stringField(entry, 'status') ||
        !optionalString(entry, 'href')
    )
  ) {
    return undefined;
  }

  if (
    !stringField(tenant, 'active_slug') ||
    typeof tenant.runtime_bound !== 'boolean' ||
    !Array.isArray(tenant.catalog) ||
    tenant.catalog.some(
      (entry) =>
        !isRecord(entry) ||
        !stringField(entry, 'tenant_slug') ||
        !stringField(entry, 'tenant_id') ||
        !stringField(entry, 'display_name') ||
        !stringField(entry, 'status') ||
        !stringField(entry, 'assigned_role')
    )
  ) {
    return undefined;
  }

  const configured = management.configured;
  if (
    configured !== null &&
    (!isRecord(configured) ||
      !optionalString(configured, 'agent_id') ||
      !optionalString(configured, 'display_name') ||
      !optionalString(configured, 'provider') ||
      !optionalString(configured, 'model_id'))
  ) {
    return undefined;
  }
  if (
    !Array.isArray(management.durable_identities) ||
    management.durable_identities.some(
      (entry) =>
        !isRecord(entry) ||
        !stringField(entry, 'nhi_id') ||
        !stringField(entry, 'kind') ||
        !stringField(entry, 'display_name') ||
        !stringField(entry, 'lifecycle_status') ||
        !stringField(entry, 'organization_id') ||
        !stringField(entry, 'provider_hint') ||
        !stringField(entry, 'model_hint')
    )
  ) {
    return undefined;
  }

  return value as Setup;
}

export function parseSetupResponse(value: unknown): Setup | undefined {
  if (!isRecord(value) || value.ok !== true || !hasSafeTree(value)) return undefined;
  return parseSetup(value.setup);
}
