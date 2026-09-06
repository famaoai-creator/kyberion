const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const INPUT_TYPES = new Set(['string', 'enum', 'boolean', 'secret']);
const PLUGIN_STATUSES = new Set([
  'activatable',
  'pending_approval',
  'blocked_broken_manifest',
  'not_loadable',
]);

export type NotificationChannelOption = { surface: string; display_name: string; status: string };
export type NotificationTarget = { surface: string; target: string };
export type PluginEntry = {
  id: string;
  trust: string;
  status: string;
  source: string;
  requested_by?: string;
  approval_status?: string;
  approval?: { id: string; channel: string };
};
export type ConfigPresetInput = {
  key: string;
  type: 'string' | 'enum' | 'boolean' | 'secret';
  description: string;
  required: boolean;
  values?: string[];
  default?: string;
};
export type ConfigPreset = {
  id: string;
  category: string;
  description: string;
  inputs: ConfigPresetInput[];
  write_target_count: number;
};
export type ConfigMissionItem = {
  id: string;
  preset: string;
  tenant: string;
  status: string;
  created_at: string;
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

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function optionalString(record: JsonRecord, key: string): boolean {
  return record[key] === undefined || typeof record[key] === 'string';
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function parseNotificationPreferencesResponse(value: unknown):
  | {
      preferences: { default_channel: NotificationTarget | null };
      channels: NotificationChannelOption[];
    }
  | undefined {
  if (!isRecord(value) || value.ok !== true || !hasSafeTree(value)) return undefined;
  if (!isRecord(value.preferences) || !Array.isArray(value.channels)) return undefined;
  const current = value.preferences.default_channel;
  if (
    current !== null &&
    (!isRecord(current) ||
      typeof current.surface !== 'string' ||
      typeof current.target !== 'string')
  ) {
    return undefined;
  }
  const channels = value.channels.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.surface !== 'string' ||
      typeof entry.display_name !== 'string' ||
      typeof entry.status !== 'string'
    ) {
      return undefined;
    }
    return {
      surface: entry.surface,
      display_name: entry.display_name,
      status: entry.status,
    };
  });
  if (channels.some((entry) => !entry)) return undefined;
  return {
    preferences: {
      default_channel:
        current === null
          ? null
          : { surface: current.surface as string, target: current.target as string },
    },
    channels: channels as NotificationChannelOption[],
  };
}

export function parsePluginListResponse(value: unknown): PluginEntry[] | undefined {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    !hasSafeTree(value) ||
    !Array.isArray(value.plugins)
  ) {
    return undefined;
  }
  const plugins = value.plugins.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.id !== 'string' ||
      typeof entry.trust !== 'string' ||
      typeof entry.status !== 'string' ||
      !PLUGIN_STATUSES.has(entry.status) ||
      typeof entry.source !== 'string' ||
      !optionalString(entry, 'requested_by') ||
      !optionalString(entry, 'approval_status')
    ) {
      return undefined;
    }
    if (
      entry.approval !== undefined &&
      (!isRecord(entry.approval) ||
        typeof entry.approval.id !== 'string' ||
        typeof entry.approval.channel !== 'string')
    ) {
      return undefined;
    }
    return {
      id: entry.id,
      trust: entry.trust,
      status: entry.status,
      source: entry.source,
      ...(entry.requested_by === undefined ? {} : { requested_by: entry.requested_by as string }),
      ...(entry.approval_status === undefined
        ? {}
        : { approval_status: entry.approval_status as string }),
      ...(entry.approval === undefined
        ? {}
        : {
            approval: {
              id: (entry.approval as JsonRecord).id as string,
              channel: (entry.approval as JsonRecord).channel as string,
            },
          }),
    };
  });
  return plugins.some((entry) => !entry) ? undefined : (plugins as PluginEntry[]);
}

function parseConfigPreset(value: unknown): ConfigPreset | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.id !== 'string' ||
    typeof value.category !== 'string' ||
    typeof value.description !== 'string' ||
    !nonNegativeInteger(value.write_target_count) ||
    !Array.isArray(value.inputs)
  ) {
    return undefined;
  }
  const inputs = value.inputs.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.key !== 'string' ||
      typeof entry.type !== 'string' ||
      !INPUT_TYPES.has(entry.type) ||
      typeof entry.description !== 'string' ||
      typeof entry.required !== 'boolean' ||
      (entry.values !== undefined && !stringArray(entry.values)) ||
      !optionalString(entry, 'default')
    ) {
      return undefined;
    }
    return {
      key: entry.key,
      type: entry.type as ConfigPresetInput['type'],
      description: entry.description,
      required: entry.required,
      ...(entry.values === undefined ? {} : { values: entry.values as string[] }),
      ...(entry.default === undefined ? {} : { default: entry.default as string }),
    };
  });
  if (inputs.some((entry) => !entry)) return undefined;
  return {
    id: value.id,
    category: value.category,
    description: value.description,
    inputs: inputs as ConfigPresetInput[],
    write_target_count: value.write_target_count,
  };
}

export function parseConfigMissionsResponse(value: unknown):
  | {
      tenants: string[];
      presets: ConfigPreset[];
      recent: ConfigMissionItem[];
    }
  | undefined {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    !hasSafeTree(value) ||
    !stringArray(value.tenants) ||
    !Array.isArray(value.presets) ||
    !Array.isArray(value.recent)
  ) {
    return undefined;
  }
  const presets = value.presets.map(parseConfigPreset);
  if (presets.some((preset) => !preset)) return undefined;
  const recent = value.recent.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.id !== 'string' ||
      typeof entry.preset !== 'string' ||
      typeof entry.tenant !== 'string' ||
      typeof entry.status !== 'string' ||
      typeof entry.created_at !== 'string'
    ) {
      return undefined;
    }
    return {
      id: entry.id,
      preset: entry.preset,
      tenant: entry.tenant,
      status: entry.status,
      created_at: entry.created_at,
    };
  });
  if (recent.some((entry) => !entry)) return undefined;
  return {
    tenants: value.tenants,
    presets: presets as ConfigPreset[],
    recent: recent as ConfigMissionItem[],
  };
}
