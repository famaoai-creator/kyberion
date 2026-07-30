/**
 * Provider Backend Resolver — XP-07 close-out (`best-of-providers.ts`'s
 * "real per-provider backend resolver so `runBestOfProviders` can actually
 * delegate").
 *
 * `best-of-providers.ts` needs a way to turn a provider id ('claude' /
 * 'codex' / 'agy' / 'grok') into something that satisfies its minimal
 * `{ delegateTask(instruction, context?): Promise<string> }` structural
 * interface. This module is that resolver. It is deliberately standalone —
 * it does NOT import `best-of-providers.ts` (avoids a cycle; the return
 * type is declared independently here, structurally identical to
 * `BestOfProviderBackend`, so it satisfies that interface with no adapter,
 * the same trick `best-of-providers.ts` itself uses for `ReasoningBackend`).
 *
 * Per-provider constructor choice (see `DEFAULT_CONSTRUCTORS` below):
 *
 *   - 'claude' → `ShellClaudeCliBackend` (`shell-claude-cli-backend.ts`),
 *     built from `buildClaudeCliOptionsFromEnv` directly — NOT from
 *     `buildShellClaudeCliBackendFromEnv`, whose default probe
 *     (`probeShellClaudeCliAvailability`) shells out synchronously
 *     (`spawnSync('claude', ['-p', ...])`) to check availability. Calling
 *     that at *resolve* time would violate this module's "never spawn at
 *     resolve time" contract, so availability is instead read from the
 *     XP-01 cached capability registry (`peekProviderCapabilityRegistry`,
 *     never live-probes) and construction just builds the options object
 *     and instantiates the class. Chosen over `ClaudeAgentReasoningBackend`
 *     (in-process Agent SDK) because the sibling 'codex'/'agy' providers
 *     are both shell-CLI backends, not in-process SDK clients — using the
 *     shell CLI backend for 'claude' too keeps the CLI providers uniform
 *     under best-of-providers' concurrent CLI fan-out.
 *   - 'codex' → `CodexCliReasoningBackend` (`codex-cli-reasoning-backend.ts`),
 *     options built by this module's own `readCodexOptionsWithoutSpawn`
 *     rather than the exported `buildCodexCliQueryOptionsFromEnv`
 *     (`codex-cli-query.ts`), which falls back to `resolveCodexBinary()` —
 *     on non-darwin platforms, when `KYBERION_CODEX_CLI_BIN` is unset, that
 *     shells out to `which codex`. This module leaves `bin` unset in that
 *     case instead; `CodexCliQuery`'s own constructor resolves it lazily,
 *     at actual `delegateTask()` (spawn) time, which is fine — only
 *     *resolve*-time spawning is disallowed.
 *   - 'agy' → `buildAgyCliBackendFromEnv` (`agy-cli-backend.ts`) used as-is:
 *     it only parses env vars and constructs `AgyCliBackend`, no probe/spawn.
 *   - 'grok' → `ShellGrokCliBackend` with environment-derived options. The
 *     resolver deliberately does not call Grok's availability probe here;
 *     capability gating is handled by the cached registry just like the
 *     other providers.
 *
 * Availability gate: before constructing, this module peeks the XP-01
 * provider capability registry (`peekProviderCapabilityRegistry` — cached
 * snapshot only, never live-probes). An explicit `binary_found: false` entry
 * resolves to `null` (definitely unavailable). A missing snapshot, or no
 * entry for the provider, is treated as "no opinion" (fails open — matches
 * `peekProviderCapabilityRegistry`'s own documented semantics) so an
 * explicitly-requested provider isn't blocked just because the registry
 * cache hasn't been populated yet; a genuinely missing binary still fails
 * safely later, as a per-candidate soft failure in `runBestOfProviders`'s
 * try/catch, never a thrown error here.
 *
 * Caching: resolved backends (including `null`) are cached per normalized
 * provider id for the life of the process — `resolveProviderBackend` is
 * meant to be cheap to call repeatedly (e.g. once per `runBestOfProviders`
 * candidate). `resetProviderBackendResolverCacheForTests` clears it.
 *
 * Never throws: `resolveProviderBackend` catches any construction error
 * and resolves to `null` instead (logged as a non-fatal warning) — callers
 * (namely `best-of-providers.ts`'s per-candidate try/catch) already treat a
 * `null` backend as "no backend available", so this never needs to surface
 * as a thrown error.
 */
import { logger } from './core.js';
import { ShellClaudeCliBackend, buildClaudeCliOptionsFromEnv } from './shell-claude-cli-backend.js';
import { CodexCliReasoningBackend } from './codex-cli-reasoning-backend.js';
import type { CodexCliQueryOptions } from './codex-cli-query.js';
import { AgyCliBackend, buildAgyCliBackendFromEnv } from './agy-cli-backend.js';
import { ShellGrokCliBackend, buildGrokCliOptionsFromEnv } from './shell-grok-cli-backend.js';
import {
  peekProviderCapabilityRegistry,
  type ProviderCapability,
} from './provider-capability-registry.js';
import { providerIdForReasoningIdentifier } from './provider-egress-gate.js';

/**
 * Minimal structural shape returned by this resolver — declared
 * independently of `best-of-providers.ts`'s `BestOfProviderBackend` (same
 * shape) so this module never imports that file (see header). Real
 * `ShellClaudeCliBackend` / `CodexCliReasoningBackend` / `AgyCliBackend` /
 * `ShellGrokCliBackend`
 * instances all satisfy this with no adapter (they implement the wider
 * `ReasoningBackend` interface, which is a superset).
 */
export interface ProviderBackendHandle {
  delegateTask(instruction: string, context?: string): Promise<string>;
}

const KNOWN_PROVIDERS = ['claude', 'codex', 'agy', 'grok'] as const;
type KnownProvider = (typeof KNOWN_PROVIDERS)[number];

function isKnownProvider(value: string): value is KnownProvider {
  return (KNOWN_PROVIDERS as readonly string[]).includes(value);
}

/** Same env parsing as `buildCodexCliQueryOptionsFromEnv`, minus its `which codex` spawn fallback (see module header). */
function readCodexOptionsWithoutSpawn(env: NodeJS.ProcessEnv): CodexCliQueryOptions {
  const bin = env.KYBERION_CODEX_CLI_BIN?.trim();
  const model = env.KYBERION_CODEX_CLI_MODEL?.trim();
  const timeoutRaw = env.KYBERION_CODEX_CLI_TIMEOUT_MS?.trim();
  const timeoutMs = timeoutRaw ? parseInt(timeoutRaw, 10) : undefined;
  const extraRaw = env.KYBERION_CODEX_CLI_EXTRA_ARGS?.trim();
  const extraArgs = extraRaw ? extraRaw.split(/\s+/).filter(Boolean) : undefined;
  return {
    ...(bin ? { bin } : {}),
    ...(model ? { model } : {}),
    ...(timeoutMs && !Number.isNaN(timeoutMs) ? { timeoutMs } : {}),
    ...(extraArgs ? { extraArgs } : {}),
  };
}

type ProviderConstructor = (env: NodeJS.ProcessEnv) => ProviderBackendHandle | null;

const DEFAULT_CONSTRUCTORS: Readonly<Record<KnownProvider, ProviderConstructor>> = {
  claude: (env) => new ShellClaudeCliBackend(buildClaudeCliOptionsFromEnv(env)),
  codex: (env) => new CodexCliReasoningBackend(readCodexOptionsWithoutSpawn(env)),
  agy: (env) => buildAgyCliBackendFromEnv(env) as AgyCliBackend | null,
  grok: (env) => new ShellGrokCliBackend(buildGrokCliOptionsFromEnv(env)),
};

export interface ProviderBackendResolverOptions {
  /** Default: `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Default: `peekProviderCapabilityRegistry` (XP-01 cached snapshot; never live-probes). */
  registrySnapshot?: () => ProviderCapability[] | null;
  /** Per-provider construction override — test seam so no real config/binary access happens. */
  construct?: Partial<Record<KnownProvider, ProviderConstructor>>;
}

const backendCache = new Map<KnownProvider, ProviderBackendHandle | null>();

function isProviderAvailable(
  provider: KnownProvider,
  registrySnapshot: (() => ProviderCapability[] | null) | undefined
): boolean {
  const snapshotFn = registrySnapshot ?? peekProviderCapabilityRegistry;
  let snapshot: ProviderCapability[] | null;
  try {
    snapshot = snapshotFn();
  } catch {
    snapshot = null;
  }
  if (!snapshot) return true; // no cached opinion — fail open (see module header)
  const entry = snapshot.find((candidate) => candidate.provider_id === provider);
  if (!entry) return true; // provider not represented in the snapshot — fail open
  return entry.binary_found !== false;
}

/**
 * Resolve a lazily-constructed, cached, delegate-capable backend for a
 * provider id ('claude' / 'codex' / 'agy' / 'grok', or a known reasoning
 * mode/backend-name alias per `providerIdForReasoningIdentifier` — e.g.
 * 'shell-claude-cli'). Returns `null` for unknown or (per the XP-01
 * registry) unavailable providers. Never throws. Constructs only — never
 * spawns a process (see module header for the per-provider detail).
 */
export function resolveProviderBackend(
  provider: string,
  options: ProviderBackendResolverOptions = {}
): ProviderBackendHandle | null {
  const raw = String(provider || '').trim();
  if (!raw) return null;
  const normalized = providerIdForReasoningIdentifier(raw) ?? raw;
  if (!isKnownProvider(normalized)) return null;

  if (backendCache.has(normalized)) {
    return backendCache.get(normalized) ?? null;
  }

  if (!isProviderAvailable(normalized, options.registrySnapshot)) {
    backendCache.set(normalized, null);
    return null;
  }

  const env = options.env ?? process.env;
  let backend: ProviderBackendHandle | null = null;
  try {
    const constructFn = options.construct?.[normalized] ?? DEFAULT_CONSTRUCTORS[normalized];
    backend = constructFn(env) ?? null;
  } catch (err) {
    logger.warn(
      `[provider-backend-resolver] failed to construct backend for provider '${normalized}' (non-fatal, resolves to null): ${err instanceof Error ? err.message : String(err)}`
    );
    backend = null;
  }

  backendCache.set(normalized, backend);
  return backend;
}

/** Test-only: clear the per-provider construction cache. */
export function resetProviderBackendResolverCacheForTests(): void {
  backendCache.clear();
}
