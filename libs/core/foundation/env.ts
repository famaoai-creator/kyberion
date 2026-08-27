import { pathResolver } from '../path-resolver.js';

export interface FoundationEnvEntry {
  name: string;
  type: 'string' | 'boolean' | 'number' | 'enum' | 'path';
  enum?: string[];
}

const REGISTRY_PATH = pathResolver.rootResolve('knowledge/product/governance/env-registry.json');
let cachedEntries: FoundationEnvEntry[] | null = null;
let registryReader: (() => { entries?: FoundationEnvEntry[] } | null) | undefined;
let loadingRegistry = false;

/**
 * Install the governed registry reader from the secure-io boundary.
 *
 * Keeping this callback in the foundation module avoids the former
 * `secure-io -> foundation/env -> foundation/json -> secure-io` import cycle:
 * the foundation accessor owns coercion, while secure-io owns the actual file
 * read. Direct foundation consumers remain deterministic until the boundary
 * is installed, and no raw file I/O is introduced here.
 */
export function registerEnvironmentRegistryReader(
  reader: () => { entries?: FoundationEnvEntry[] } | null
): void {
  registryReader = reader;
  cachedEntries = null;
}

function entries(): FoundationEnvEntry[] {
  if (cachedEntries) return cachedEntries;
  // secure-io installs the reader, and its path policy itself consults this
  // accessor. During that first guarded read, return the uncached empty view
  // to break the bootstrap recursion; the outer read then fills the cache.
  if (loadingRegistry) return [];
  loadingRegistry = true;
  try {
    const parsed = registryReader?.() ?? null;
    cachedEntries = Array.isArray(parsed?.entries) ? parsed.entries : [];
  } finally {
    loadingRegistry = false;
  }
  return cachedEntries;
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

/** Read a registered boolean without converting it to the legacy text form. */
export function getRegisteredEnvBool(
  name: string,
  options: {
    env?: Record<string, string | undefined>;
    defaultValue?: boolean;
    strict?: boolean;
  } = {}
): boolean | undefined {
  const value = getRegisteredEnv<boolean | string>(name, options);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (/^(1|true|yes|on)$/i.test(value)) return true;
    if (/^(0|false|no|off)$/i.test(value)) return false;
  }
  return options.defaultValue;
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

const CHILD_PROCESS_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LANG',
  'TERM',
  'NODE_ENV',
  'NVM_DIR',
  'NVM_BIN',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'XAI_API_KEY',
  'KYBERION_GROK_API_KEY',
  'MISSION_ID',
  'MISSION_ROLE',
  'KYBERION_PERSONA',
  'CODEX_HOME',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
] as const;

/** Build the least-privilege environment passed to provider child processes. */
export function safeChildEnv(
  env: Record<string, string | undefined> = process.env
): Record<string, string> {
  const childEnv: Record<string, string> = { FORCE_COLOR: '0', TERM: 'dumb' };
  for (const key of CHILD_PROCESS_ENV_KEYS) {
    const value = env[key];
    if (value) childEnv[key] = value;
  }
  return childEnv;
}
