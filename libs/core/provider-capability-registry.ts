/**
 * Provider Capability Registry — XP-01
 *
 * `provider-discovery.ts` answers "is the binary on PATH" (installed/healthy).
 * This module goes one step further: cheap, short-timeout probes per adapter
 * (`--version`/`--help`, auth-status subcommands where one exists cheaply)
 * that answer "is this provider actually *usable* right now" — authenticated,
 * headless-capable, structured-output-capable, which models it advertises.
 *
 * Results persist as a TTL-cached snapshot under
 * `active/shared/runtime/provider-capability-registry.json`, mirroring the
 * `{computed_at, ttl_ms, value}` envelope used by
 * `scripts/run_baseline_check.ts`'s `runtime/baseline-check-cache/*.json`.
 *
 * Fail-closed-for-routing, fail-open-for-the-probe-itself: a probe that
 * cannot determine a provider's state marks that provider unavailable
 * (`binary_found: false`) rather than throwing — callers (e.g.
 * `reasoning-bootstrap.ts`) must never crash because a CLI probe hiccuped.
 *
 * See docs/developer/improvement-plans-2026-07/CROSS_PROVIDER_EXECUTION_PLAN_2026-07-25.ja.md
 * §XP-01.
 */

import { logger } from './core.js';
import {
  safeExecResult,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
} from './secure-io.js';
import { pathResolver } from './path-resolver.js';
import { loadProviderCapabilityCatalog } from './provider-discovery.js';
import * as path from 'node:path';

export interface ProviderCapability {
  provider_id: string;
  binary_found: boolean;
  authenticated: boolean | 'unknown';
  headless: boolean;
  structured_output: boolean;
  models: string[];
  probed_at: string;
  probe_error?: string;
}

/** Result shape the exec seam must return — deliberately CLI-tool agnostic. */
export interface ProbeExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Injectable exec seam. Production default shells out via
 * `secure-io.safeExecResult` (governed exec policy, never throws on spawn
 * failure). Tests must always inject a fake — see `provider-capability-registry.test.ts`.
 */
export type ProbeExecFn = (
  command: string,
  args: string[],
  opts?: { timeoutMs?: number }
) => ProbeExecResult;

interface ProviderProbeSpec {
  /** Cheap existence/version probe. A non-zero exit or thrown error ⇒ binary_found=false. */
  binaryCommand: string;
  binaryArgs: string[];
  /** Cheap auth-status probe, only declared where one exists without a live LLM call. */
  authCommand?: string;
  authArgs?: string[];
  /** Declared (not probed — no cheap runtime signal exists) adapter capabilities. */
  headless: boolean;
  structuredOutput: boolean;
}

/**
 * Single declarative table of probe commands. `--help`/`--version` mirrors
 * the commands already vetted in this repo — `provider-discovery.ts`
 * (claude/gemini `--version`) and
 * `knowledge/product/governance/provider-capability-scan-policy.json`
 * (`--help` across providers, `gh copilot -- --help` for copilot). Auth
 * probes are declared only where a cheap, non-interactive subcommand exists;
 * `claude`/`codex`/`agy`/`gemini` have none known that don't make a live
 * call, so their `authenticated` field stays `'unknown'` unless the binary
 * itself is missing (then it is `false`).
 */
export const PROVIDER_PROBE_TABLE: Readonly<Record<string, ProviderProbeSpec>> = {
  claude: {
    binaryCommand: 'claude',
    binaryArgs: ['--version'],
    headless: true,
    structuredOutput: true,
  },
  codex: {
    binaryCommand: 'codex',
    binaryArgs: ['--help'],
    headless: true,
    structuredOutput: true,
  },
  agy: {
    binaryCommand: 'agy',
    binaryArgs: ['--help'],
    headless: true,
    structuredOutput: true,
  },
  gemini: {
    binaryCommand: 'gemini',
    binaryArgs: ['--version'],
    headless: true,
    structuredOutput: true,
  },
  copilot: {
    binaryCommand: 'gh',
    binaryArgs: ['copilot', '--', '--help'],
    authCommand: 'gh',
    authArgs: ['auth', 'status'],
    headless: true,
    structuredOutput: true,
  },
};

const DEFAULT_PROBE_TIMEOUT_MS = 5000;
const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes — cheap probes, but not free
const REGISTRY_CACHE_RELATIVE_PATH = 'runtime/provider-capability-registry.json';

function defaultProbeExec(
  command: string,
  args: string[],
  opts?: { timeoutMs?: number }
): ProbeExecResult {
  const result = safeExecResult(command, args, {
    timeoutMs: opts?.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout || '',
    stderr: result.stderr || result.error?.message || '',
  };
}

function modelsFor(providerId: string): string[] {
  try {
    return loadProviderCapabilityCatalog()[providerId]?.models ?? [];
  } catch {
    return [];
  }
}

function runProbe(
  exec: ProbeExecFn,
  command: string,
  args: string[],
  timeoutMs: number
): ProbeExecResult {
  try {
    return exec(command, args, { timeoutMs });
  } catch (err) {
    return { ok: false, stdout: '', stderr: err instanceof Error ? err.message : String(err) };
  }
}

function probeSingleProvider(
  providerId: string,
  exec: ProbeExecFn,
  timeoutMs: number,
  probedAt: string
): ProviderCapability {
  const spec = PROVIDER_PROBE_TABLE[providerId];
  if (!spec) {
    return {
      provider_id: providerId,
      binary_found: false,
      authenticated: false,
      headless: false,
      structured_output: false,
      models: [],
      probed_at: probedAt,
      probe_error: `no probe spec declared for provider '${providerId}'`,
    };
  }

  const versionResult = runProbe(exec, spec.binaryCommand, spec.binaryArgs, timeoutMs);
  const binaryFound = versionResult.ok;

  let authenticated: boolean | 'unknown' = 'unknown';
  let probeError: string | undefined;

  if (!binaryFound) {
    authenticated = false;
    probeError = versionResult.stderr.trim() || `${spec.binaryCommand} probe failed (non-fatal)`;
  } else if (spec.authCommand && spec.authArgs) {
    const authResult = runProbe(exec, spec.authCommand, spec.authArgs, timeoutMs);
    authenticated = authResult.ok;
    if (!authResult.ok) {
      probeError = authResult.stderr.trim() || `${spec.authCommand} auth probe reported failure`;
    }
  }

  return {
    provider_id: providerId,
    binary_found: binaryFound,
    authenticated,
    headless: spec.headless,
    structured_output: spec.structuredOutput,
    models: binaryFound ? modelsFor(providerId) : [],
    probed_at: probedAt,
    ...(probeError ? { probe_error: probeError } : {}),
  };
}

export interface ProbeProviderCapabilitiesOptions {
  /** Which providers to probe. Defaults to every provider in PROVIDER_PROBE_TABLE. */
  providerIds?: string[];
  /** Injectable exec seam. Production default calls out via secure-io. Tests MUST inject a fake. */
  exec?: ProbeExecFn;
  timeoutMs?: number;
  /** Injectable clock for deterministic `probed_at` in tests. */
  now?: () => Date;
}

/**
 * Run the declarative probe table against every (or a selected subset of)
 * provider. Never throws — a provider whose probe fails, times out, or is
 * denied by exec policy comes back `binary_found: false` with `probe_error`
 * set, so a bad probe degrades routing rather than crashing the caller.
 */
export function probeProviderCapabilities(
  opts: ProbeProviderCapabilitiesOptions = {}
): ProviderCapability[] {
  const exec = opts.exec ?? defaultProbeExec;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const providerIds = opts.providerIds ?? Object.keys(PROVIDER_PROBE_TABLE);
  const now = opts.now ?? (() => new Date());
  const probedAt = now().toISOString();

  return providerIds.map((providerId) => {
    try {
      return probeSingleProvider(providerId, exec, timeoutMs, probedAt);
    } catch (err) {
      // Belt-and-braces: probeSingleProvider already catches exec errors,
      // but nothing about the probe path may ever throw out to the caller.
      return {
        provider_id: providerId,
        binary_found: false,
        authenticated: false as const,
        headless: false,
        structured_output: false,
        models: [],
        probed_at: probedAt,
        probe_error: `probe threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });
}

interface RegistryEnvelope {
  computed_at: string;
  ttl_ms: number;
  value: ProviderCapability[];
}

function registryCachePath(): string {
  return pathResolver.shared(REGISTRY_CACHE_RELATIVE_PATH);
}

/**
 * Read the persisted registry snapshot without ever (re-)probing. Returns
 * `null` when no file exists, the file is malformed, or the cached snapshot
 * has aged past its own declared TTL — all three are "no opinion", not an
 * error, so callers can fail open.
 */
export function peekProviderCapabilityRegistry(
  opts: { now?: () => Date } = {}
): ProviderCapability[] | null {
  const now = opts.now ?? (() => new Date());
  const filePath = registryCachePath();
  try {
    if (!safeExistsSync(filePath)) return null;
    const raw = safeReadFile(filePath, { encoding: 'utf8' }) as string;
    const parsed = JSON.parse(raw) as RegistryEnvelope;
    if (!parsed || !Array.isArray(parsed.value)) return null;
    const computedAt = new Date(parsed.computed_at).getTime();
    if (!Number.isFinite(computedAt)) return null;
    const ageMs = now().getTime() - computedAt;
    if (ageMs > parsed.ttl_ms) return null;
    return parsed.value;
  } catch {
    return null;
  }
}

function writeRegistryCache(value: ProviderCapability[], ttlMs: number, now: () => Date): void {
  try {
    const filePath = registryCachePath();
    const dir = path.dirname(filePath);
    if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
    const envelope: RegistryEnvelope = {
      computed_at: now().toISOString(),
      ttl_ms: ttlMs,
      value,
    };
    safeWriteFile(filePath, JSON.stringify(envelope, null, 2), { encoding: 'utf8' });
  } catch (err) {
    logger.warn(
      `[provider-capability-registry] failed to persist snapshot (non-fatal): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export interface LoadProviderCapabilityRegistryOptions extends ProbeProviderCapabilitiesOptions {
  /** TTL to apply to a freshly (re-)probed snapshot, and to accept from cache. Default 15 min. */
  maxAgeMs?: number;
  /** Skip the cache and always re-probe. */
  forceRefresh?: boolean;
}

/**
 * Cached-or-reprobed provider capability snapshot. Reads a fresh-enough
 * cached snapshot when one exists; otherwise probes and persists. This is
 * the entry point for anything that wants an up-to-date view (ops tooling,
 * baseline-check). Routing call sites that must never trigger a synchronous
 * CLI spawn during install should use `peekProviderCapabilityRegistry`
 * instead (see `reasoning-bootstrap.ts`).
 */
export function loadProviderCapabilityRegistry(
  opts: LoadProviderCapabilityRegistryOptions = {}
): ProviderCapability[] {
  const ttlMs = opts.maxAgeMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? (() => new Date());

  if (!opts.forceRefresh) {
    const cached = peekProviderCapabilityRegistry({ now });
    if (cached) return cached;
  }

  const value = probeProviderCapabilities({
    providerIds: opts.providerIds,
    exec: opts.exec,
    timeoutMs: opts.timeoutMs,
    now,
  });
  writeRegistryCache(value, ttlMs, now);
  return value;
}
