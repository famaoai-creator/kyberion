import { readJsonIfPresent } from './json.js';
import { pathResolver } from '../path-resolver.js';

export interface FoundationEnvEntry {
  name: string;
  type: 'string' | 'boolean' | 'number' | 'enum' | 'path';
  enum?: string[];
}

const REGISTRY_PATH = pathResolver.rootResolve('knowledge/product/governance/env-registry.json');
let cachedEntries: FoundationEnvEntry[] | null = null;
let loadingEntries = false;

function entries(): FoundationEnvEntry[] {
  if (cachedEntries) return cachedEntries;
  // The registry is read through secure-io. secure-io itself consults the
  // registered environment while evaluating sensitive-path policy, so the
  // first lookup must fail open to raw values until the registry is loaded.
  if (loadingEntries) return [];
  loadingEntries = true;
  try {
    const parsed = readJsonIfPresent<{ entries?: FoundationEnvEntry[] }>(REGISTRY_PATH);
    // A secure-io import cycle may transiently make the registry unreadable
    // during module bootstrap. Do not permanently cache that provisional
    // miss; the next governed read can retry after initialization completes.
    if (parsed === null) return [];
    cachedEntries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    return cachedEntries;
  } finally {
    loadingEntries = false;
  }
}

export function getRegisteredEnv<T = string>(
  name: string,
  options: { env?: Record<string, string | undefined>; defaultValue?: T; strict?: boolean } = {}
): string | number | boolean | T | undefined {
  const raw = (options.env ?? process.env)[name];
  if (raw === undefined || raw === '') return options.defaultValue;
  const entry = entries().find((candidate) => candidate.name === name);
  if (!entry || entry.type === 'string' || entry.type === 'path') return raw;
  if (entry.type === 'boolean') {
    if (/^(1|true|yes|on)$/i.test(raw)) return true;
    if (/^(0|false|no|off)$/i.test(raw)) return false;
  } else if (entry.type === 'number') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  } else if (entry.type === 'enum' && entry.enum?.includes(raw)) {
    return raw;
  }
  if (options.strict) throw new Error(`Invalid value for registered environment variable ${name}`);
  return options.defaultValue;
}

/**
 * Read a registered setting using the string representation expected by
 * legacy call sites. Boolean registry values preserve the historical `1`/`0`
 * convention while numeric values remain parseable by existing callers.
 */
export function getRegisteredEnvText(name: string): string | undefined {
  const value = getRegisteredEnv(name);
  if (value === undefined) return undefined;
  return typeof value === 'boolean' ? (value ? '1' : '0') : String(value);
}

/**
 * Set or clear a registered environment value at an explicit boundary.
 * Runtime callers use this for scoped setup/restore; reads stay on the
 * validated accessors above so direct KYBERION env access cannot spread.
 */
export function setRegisteredEnv(
  name: string,
  value: string | undefined,
  env: Record<string, string | undefined> = process.env
): void {
  if (value === undefined) delete env[name];
  else env[name] = value;
}
