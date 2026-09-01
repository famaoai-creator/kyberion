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
 * Binary discovery is fail-closed for routing, while auth probe errors remain
 * explicitly uncertain (`probe_error`) so a transient keyring/network failure
 * cannot strand a provider until the snapshot TTL expires. Callers (e.g.
 * `reasoning-bootstrap.ts`) must never crash because a CLI probe hiccuped.
 *
 * See docs/developer/improvement-plans-2026-07/CROSS_PROVIDER_EXECUTION_PLAN_2026-07-25.ja.md
 * §XP-01.
 */

import { logger } from './core.js';
import {
  assertSafeRepositoryPath,
  safeExecResult,
  safeExistsSync,
  safeMkdir,
  safeWriteFile,
} from './secure-io.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
import { loadProviderCapabilityCatalog } from './provider-discovery.js';
import { isClaudeCliAuthenticated } from './claude-cli-auth-status.js';
import {
  isClaudeCliPlaceholderFailure,
  resolveClaudeCliFallbackCandidates,
} from './claude-cli-resolution.js';
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
  /** Help-output flag evidence only; this is not an OS-level enforcement proof. */
  sandbox_probe?: SandboxFlagProbeResult;
}

export interface SandboxFlagProbeResult {
  status: 'supported' | 'unsupported' | 'unknown';
  method: 'help-flag';
  command: string;
  args: string[];
  expected_flags: string[];
  evidence?: string;
  error?: string;
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
  /** Safe, non-model probe for provider-advertised sandbox/approval flags. */
  sandboxProbe?: {
    command: string;
    args: string[];
    expectedFlags: string[];
  };
}

/**
 * Single declarative table of probe commands. `--help`/`--version` mirrors
 * the commands already vetted in this repo — `provider-discovery.ts`
 * (claude/gemini `--version`) and
 * `knowledge/product/governance/provider-capability-scan-policy.json`
 * (`--help` across providers, `gh copilot -- --help` for copilot). Auth
 * probes are declared only where a cheap, non-interactive subcommand exists;
 * `codex`/`agy`/`grok`/`gemini` have none known that don't make a live call,
 * so their `authenticated` field stays `'unknown'` unless the binary itself
 * is missing (then it is `false`). Claude Code exposes the cheap
 * `claude auth status` probe, so Claude can report its actual login state.
 */
export const PROVIDER_PROBE_TABLE: Readonly<Record<string, ProviderProbeSpec>> = {
  claude: {
    binaryCommand: 'claude',
    binaryArgs: ['--version'],
    authCommand: 'claude',
    authArgs: ['auth', 'status'],
    headless: true,
    structuredOutput: true,
    sandboxProbe: {
      command: 'claude',
      args: ['--help'],
      expectedFlags: ['--permission-mode'],
    },
  },
  codex: {
    binaryCommand: 'codex',
    binaryArgs: ['--help'],
    headless: true,
    structuredOutput: true,
    sandboxProbe: {
      command: 'codex',
      args: ['--help'],
      expectedFlags: ['--sandbox'],
    },
  },
  agy: {
    binaryCommand: 'agy',
    binaryArgs: ['--help'],
    headless: true,
    structuredOutput: true,
    sandboxProbe: {
      command: 'agy',
      args: ['--help'],
      expectedFlags: ['--sandbox'],
    },
  },
  grok: {
    binaryCommand: 'grok',
    binaryArgs: ['--version'],
    headless: true,
    structuredOutput: true,
    sandboxProbe: {
      command: 'grok',
      args: ['--help'],
      expectedFlags: ['--allow', '--deny'],
    },
  },
  gemini: {
    binaryCommand: 'gemini',
    binaryArgs: ['--version'],
    headless: true,
    structuredOutput: true,
    sandboxProbe: {
      command: 'gemini',
      args: ['--help'],
      expectedFlags: ['--sandbox', '--approval-mode'],
    },
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
// Exported so callers that want to state an explicit `maxAgeMs` (e.g.
// `run_baseline_check.ts`'s population job) can stay consistent with this
// module's own default instead of duplicating the magic number.
export const DEFAULT_PROVIDER_CAPABILITY_TTL_MS = 15 * 60 * 1000; // 15 minutes — cheap probes, but not free
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

function probeSandboxFlags(
  providerId: string,
  spec: ProviderProbeSpec,
  exec: ProbeExecFn,
  timeoutMs: number,
  resolvedBinaryCommand: string
): SandboxFlagProbeResult | undefined {
  const sandboxProbe = spec.sandboxProbe;
  if (!sandboxProbe) return undefined;

  const command =
    sandboxProbe.command === spec.binaryCommand ? resolvedBinaryCommand : sandboxProbe.command;
  const result = runProbe(exec, command, sandboxProbe.args, timeoutMs);
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  const missingFlags = sandboxProbe.expectedFlags.filter(
    (flag) => !output.includes(flag.toLowerCase())
  );
  if (!result.ok) {
    return {
      status: 'unknown',
      method: 'help-flag',
      command,
      args: sandboxProbe.args,
      expected_flags: sandboxProbe.expectedFlags,
      ...(result.stderr.trim() ? { error: result.stderr.trim() } : {}),
    };
  }
  if (missingFlags.length > 0) {
    return {
      status: 'unsupported',
      method: 'help-flag',
      command,
      args: sandboxProbe.args,
      expected_flags: sandboxProbe.expectedFlags,
      evidence: `missing advertised flags: ${missingFlags.join(', ')}`,
    };
  }
  return {
    status: 'supported',
    method: 'help-flag',
    command,
    args: sandboxProbe.args,
    expected_flags: sandboxProbe.expectedFlags,
    evidence: `${providerId} help output advertises ${sandboxProbe.expectedFlags.join(', ')}`,
  };
}

function probeSingleProvider(
  providerId: string,
  exec: ProbeExecFn,
  timeoutMs: number,
  probedAt: string,
  claudeFallbackCandidates: () => string[]
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

  let binaryCommand = spec.binaryCommand;
  let versionResult = runProbe(exec, binaryCommand, spec.binaryArgs, timeoutMs);
  if (
    providerId === 'claude' &&
    !versionResult.ok &&
    isClaudeCliPlaceholderFailure(versionResult.stderr)
  ) {
    for (const candidate of claudeFallbackCandidates()) {
      const fallbackResult = runProbe(exec, candidate, spec.binaryArgs, timeoutMs);
      if (fallbackResult.ok) {
        binaryCommand = candidate;
        versionResult = fallbackResult;
        break;
      }
    }
  }
  const binaryFound = versionResult.ok;

  let authenticated: boolean | 'unknown' = 'unknown';
  let probeError: string | undefined;

  if (!binaryFound) {
    authenticated = false;
    probeError = versionResult.stderr.trim() || `${spec.binaryCommand} probe failed (non-fatal)`;
  } else if (spec.authCommand && spec.authArgs) {
    const authResult = runProbe(exec, binaryCommand, spec.authArgs, timeoutMs);
    authenticated = providerId === 'claude' ? isClaudeCliAuthenticated(authResult) : authResult.ok;
    if (!authenticated) {
      probeError = authResult.stderr.trim() || `${spec.authCommand} auth probe reported failure`;
    }
  }

  const sandboxProbe = binaryFound
    ? probeSandboxFlags(providerId, spec, exec, timeoutMs, binaryCommand)
    : undefined;

  return {
    provider_id: providerId,
    binary_found: binaryFound,
    authenticated,
    headless: spec.headless,
    structured_output: spec.structuredOutput,
    models: binaryFound ? modelsFor(providerId) : [],
    probed_at: probedAt,
    ...(probeError ? { probe_error: probeError } : {}),
    ...(sandboxProbe ? { sandbox_probe: sandboxProbe } : {}),
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
  /** Injectable Claude fallback resolver for hermetic tests. */
  resolveClaudeCliFallbackCandidates?: () => string[];
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
  const claudeFallbackCandidates =
    opts.resolveClaudeCliFallbackCandidates ?? (() => resolveClaudeCliFallbackCandidates());

  return providerIds.map((providerId) => {
    try {
      return probeSingleProvider(providerId, exec, timeoutMs, probedAt, claudeFallbackCandidates);
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
  return assertSafeRepositoryPath(pathResolver.shared(REGISTRY_CACHE_RELATIVE_PATH), {
    allowMissingLeaf: true,
  });
}

const providerCapabilityRegistryCatalog = defineCatalog<RegistryEnvelope>({
  id: 'provider-capability-registry',
  path: registryCachePath,
  schema: pathResolver.knowledge('product/schemas/provider-capability-registry.schema.json'),
});

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
  try {
    const parsed = providerCapabilityRegistryCatalog.load();
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
  const ttlMs = opts.maxAgeMs ?? DEFAULT_PROVIDER_CAPABILITY_TTL_MS;
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
