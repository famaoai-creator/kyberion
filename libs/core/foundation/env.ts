export interface FoundationEnvEntry {
  name: string;
  type: 'string' | 'boolean' | 'number' | 'enum' | 'path';
  enum?: string[];
}

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
  options: {
    env?: Record<string, string | undefined>;
    defaultValue?: T;
    strict?: boolean;
    preserveEmpty?: boolean;
  } = {}
): string | number | boolean | T | undefined {
  const raw = (options.env ?? process.env)[name];
  if (raw === undefined || (raw === '' && !options.preserveEmpty)) return options.defaultValue;
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
export function getRegisteredEnvText(
  name: string,
  options: {
    env?: Record<string, string | undefined>;
    strict?: boolean;
    preserveEmpty?: boolean;
  } = {}
): string | undefined {
  const value = getRegisteredEnv(name, options);
  if (value === undefined) return undefined;
  return typeof value === 'boolean' ? (value ? '1' : '0') : String(value);
}

/**
 * Detect the Vitest runtime without loading the repository environment
 * registry. Test workers deliberately repoint the repository root to fixture
 * directories, while the registry reader is backed by secure-io and expects
 * the real catalog tree. The marker is test infrastructure rather than an
 * operator setting, so it must remain a raw, side-effect-free process check.
 */
export function isVitestProcess(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.VITEST);
}

/**
 * Detect a CI runner, mirroring `isVitestProcess`'s raw-env contract: `CI` is
 * the conventional marker every major CI provider sets (GitHub Actions,
 * GitLab, CircleCI, …) and is not a `KYBERION_*` registry entry, so it is
 * read the same side-effect-free way rather than through the registry.
 */
export function isCiProcess(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.CI);
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
  // Test-run markers (see SAFE_EXEC_ENV_ALLOWLIST): keep children of a test in its sandbox.
  'VITEST',
  'VITEST_POOL_ID',
  'KYBERION_VITEST_RUN_ID',
  'NVM_DIR',
  'NVM_BIN',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'KYBERION_GEMINI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'XAI_API_KEY',
  'KYBERION_GROK_API_KEY',
  'MISSION_ID',
  'MISSION_ROLE',
  'KYBERION_PERSONA',
  'CODEX_HOME',
  'AGY_PROFILE',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  // Proxy vars: added by buildProxyPassthroughEnv (loopback-guarded).
] as const;

/**
 * Proxy env vars a child may inherit. The single source for every child-env
 * allowlist (secure-io buildSafeExecEnv, provider child env, ACP mediator,
 * safeChildEnv, the credential relay's upstream hop) — pass them only through
 * {@link buildProxyPassthroughEnv} so the loopback guard below always applies.
 */
export const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
] as const;

export type ProxyEnvKey = (typeof PROXY_ENV_KEYS)[number];

/** Hosts a child must always reach directly, never via a proxy. */
export const LOOPBACK_NO_PROXY_HOSTS: readonly string[] = ['127.0.0.1', 'localhost', '::1'];

const PROXY_URL_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'] as const;

/** Append `hosts` to a NO_PROXY list: existing entries kept, case-insensitive dedupe. */
export function appendNoProxyHosts(current: string | undefined, hosts: readonly string[]): string {
  const entries = (current ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const present = new Set(entries.map((entry) => entry.toLowerCase()));
  for (const host of hosts) {
    if (present.has(host.toLowerCase())) continue;
    present.add(host.toLowerCase());
    entries.push(host);
  }
  return entries.join(',');
}

/**
 * Return `env` with the loopback hosts appended to both NO_PROXY and
 * no_proxy (existing entries kept, no duplicates). A child that honors
 * HTTP(S)_PROXY would otherwise send its request for a loopback service (the
 * credential relay, a local surface) to the proxy, which cannot reach the
 * parent's 127.0.0.1.
 */
export function withLoopbackNoProxy<T extends Record<string, string | undefined>>(env: T): T {
  return {
    ...env,
    NO_PROXY: appendNoProxyHosts(env.NO_PROXY, LOOPBACK_NO_PROXY_HOSTS),
    no_proxy: appendNoProxyHosts(env.no_proxy, LOOPBACK_NO_PROXY_HOSTS),
  };
}

/** A proxy URL var (HTTP(S)_PROXY, either case) is set to a non-empty value. */
export function hasProxyEnv(env: Record<string, string | undefined>): boolean {
  return PROXY_URL_ENV_KEYS.some((key) => Boolean(env[key]?.trim()));
}

/**
 * The proxy subset of `source` a child may inherit. Whenever a proxy URL is
 * passed, the loopback hosts are appended to NO_PROXY and no_proxy, so a
 * child never routes a loopback URL it was handed through the proxy.
 * No proxy URL ⇒ only the non-empty NO_PROXY vars pass through, unchanged.
 */
export function buildProxyPassthroughEnv(
  source: Record<string, string | undefined>
): Partial<Record<ProxyEnvKey, string>> {
  const picked: Partial<Record<ProxyEnvKey, string>> = {};
  for (const key of PROXY_ENV_KEYS) {
    const value = source[key];
    if (typeof value === 'string' && value.trim() !== '') picked[key] = value;
  }
  return hasProxyEnv(picked) ? withLoopbackNoProxy(picked) : picked;
}

/** Opt-in loopback credential relay flag (provider/provider-credential-relay.ts). */
export const PROVIDER_CREDENTIAL_RELAY_ENV_VAR = 'KYBERION_PROVIDER_CREDENTIAL_RELAY';

/**
 * API-key vars whose raw value must never reach a child while the relay flag
 * is on: only relay-aware launch sites (`buildDelegationSpawnEnvWithRelay`)
 * may hand the child a placeholder instead.
 */
export const RELAY_MANAGED_CREDENTIAL_ENV_KEYS: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
];

/** Relay flag is on in `env` (or, fail closed, in this process's env). */
export function isProviderCredentialRelayEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  const on = (source: Record<string, string | undefined>) =>
    getRegisteredEnvBool(PROVIDER_CREDENTIAL_RELAY_ENV_VAR, {
      env: source,
      defaultValue: false,
    }) === true;
  return on(env) || (env !== process.env && on(process.env));
}

/**
 * Fail closed for launch sites that cannot start a relay: with the relay flag
 * on, drop the relay-managed raw API keys from `childEnv` (the child then
 * uses its own login, or fails to authenticate). Flag off ⇒ returned as is.
 */
export function withoutRelayManagedCredentials<T extends Record<string, string | undefined>>(
  childEnv: T,
  flagEnv: Record<string, string | undefined> = process.env
): T {
  if (!isProviderCredentialRelayEnabled(flagEnv)) return childEnv;
  if (!RELAY_MANAGED_CREDENTIAL_ENV_KEYS.some((key) => childEnv[key] !== undefined)) {
    return childEnv;
  }
  const out = { ...childEnv };
  for (const key of RELAY_MANAGED_CREDENTIAL_ENV_KEYS) delete out[key];
  return out;
}

/**
 * Build the least-privilege environment passed to provider child processes.
 * With the credential relay flag on, the relay-managed raw API keys are
 * dropped (these launch sites start no relay).
 */
export function safeChildEnv(
  env: Record<string, string | undefined> = process.env
): Record<string, string> {
  const childEnv: Record<string, string> = { FORCE_COLOR: '0', TERM: 'dumb' };
  for (const key of CHILD_PROCESS_ENV_KEYS) {
    const value = env[key];
    if (value) childEnv[key] = value;
  }
  Object.assign(childEnv, buildProxyPassthroughEnv(env));
  return withoutRelayManagedCredentials(childEnv, env);
}
