import { parseSafeJsonObjectValue } from '@agent/core/foundation';

export interface NexusBrainProfile {
  name?: string;
  cmd: string;
  args: string[];
  env?: Record<string, string>;
  description?: string;
}

export interface NexusBrainProfileRegistry {
  default_profile: string;
  profiles: Record<string, NexusBrainProfile>;
}

export interface NexusSessionMetadata {
  stimulus_id: string;
  ts?: string;
}

const PROFILE_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;

function optionalString(record: Record<string, unknown>, key: string): string | undefined | null {
  const value = record[key];
  if (value === undefined) return undefined;
  return typeof value === 'string' && value.trim() ? value : null;
}

function parseStringMap(value: unknown): Record<string, string> | undefined | null {
  if (value === undefined) return undefined;
  try {
    const record = parseSafeJsonObjectValue(value, 'Nexus brain profile env');
    const entries = Object.entries(record);
    if (entries.some(([key, entry]) => !key.trim() || typeof entry !== 'string')) return null;
    return Object.fromEntries(entries) as Record<string, string>;
  } catch {
    return null;
  }
}

function parseBrainProfile(value: unknown): NexusBrainProfile | null {
  try {
    const record = parseSafeJsonObjectValue(value, 'Nexus brain profile');
    const cmd = optionalString(record, 'cmd');
    const args = record.args;
    const name = optionalString(record, 'name');
    const description = optionalString(record, 'description');
    const env = parseStringMap(record.env);
    if (
      cmd === undefined ||
      cmd === null ||
      name === null ||
      description === null ||
      env === null ||
      !Array.isArray(args) ||
      args.some((arg) => typeof arg !== 'string')
    ) {
      return null;
    }
    return {
      ...(name === undefined ? {} : { name }),
      cmd,
      args: [...args],
      ...(env === undefined ? {} : { env }),
      ...(description === undefined ? {} : { description }),
    };
  } catch {
    return null;
  }
}

export function parseNexusBrainProfileRegistry(value: unknown): NexusBrainProfileRegistry | null {
  try {
    const root = parseSafeJsonObjectValue(value, 'Nexus brain profile registry');
    const defaultProfile = optionalString(root, 'default_profile');
    const profilesValue = parseSafeJsonObjectValue(root.profiles, 'Nexus brain profiles');
    if (defaultProfile === undefined || defaultProfile === null) return null;

    const profiles: Record<string, NexusBrainProfile> = {};
    for (const [key, value] of Object.entries(profilesValue)) {
      if (!PROFILE_KEY_PATTERN.test(key)) continue;
      const profile = parseBrainProfile(value);
      if (profile) profiles[key] = profile;
    }
    if (!Object.hasOwn(profiles, defaultProfile)) return null;
    return { default_profile: defaultProfile, profiles };
  } catch {
    return null;
  }
}

export function parseNexusSessionMetadata(value: unknown): NexusSessionMetadata | null {
  try {
    const record = parseSafeJsonObjectValue(value, 'Nexus session metadata');
    const stimulusId = optionalString(record, 'stimulus_id');
    const ts = optionalString(record, 'ts');
    if (stimulusId === undefined || stimulusId === null || ts === null) return null;
    if (ts !== undefined && !Number.isFinite(Date.parse(ts))) return null;
    return { stimulus_id: stimulusId, ...(ts === undefined ? {} : { ts }) };
  } catch {
    return null;
  }
}

export function parseNexusSessionResponse(value: unknown): Record<string, unknown> | null {
  try {
    const root = parseSafeJsonObjectValue(value, 'Nexus session response');
    const data = parseSafeJsonObjectValue(root.data, 'Nexus session response data');
    if (root.status !== undefined && typeof root.status !== 'string') return null;
    if (root.sessionId !== undefined && typeof root.sessionId !== 'string') return null;
    if (root.metadata !== undefined)
      parseSafeJsonObjectValue(root.metadata, 'Nexus response metadata');
    return data;
  } catch {
    return null;
  }
}
