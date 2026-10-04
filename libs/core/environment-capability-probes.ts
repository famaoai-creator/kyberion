/**
 * Plug-in capability probes that the shipped manifests reference.
 *
 * The `EnvironmentCapability` schema lets a manifest declare
 * `probe: { kind: 'probe', probe_id: '...' }` and resolve it at
 * runtime via `registerEnvironmentCapabilityProbe(probe_id, fn)`.
 * This file wires the probes for the standard Kyberion-environment
 * manifests:
 *
 *   reasoning-backend.any-real   — at least one non-stub backend usable
 *   audit-chain.integrity        — audit-chain hashes verify
 *   repo-build.receipt           — libs/core/dist/ is fresh enough
 *   node-version.floor           — running Node satisfies package.json engines
 *   playwright.chromium-browser  — a Playwright browser cache is present
 *   public-ingress.any-ready     — a live public-ingress provider is ready
 *
 * Importing this module triggers `installCoreEnvironmentProbes()` for
 * its side effect; tests that reset the probe registry can re-arm by
 * calling that exported function again.
 */

import * as os from 'node:os';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { t } from './t.js';
import { logger } from './core.js';
import * as pathResolver from './path-resolver.js';
import { parseSafeJsonObjectValue, readJson, readJsonLines } from './foundation/json.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeReaddir,
  safeStat,
  safeExec,
} from './secure-io.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { isMacOS, isWindows } from './platform.js';
import { normalizePersistedAuditEntry } from './governance/audit-chain.js';

function kyberionEnv(name: string): string | undefined {
  return getRegisteredEnvText(name);
}
import {
  hasEnvironmentCapabilityProbe,
  registerEnvironmentCapabilityProbe,
  type RegisteredProbe,
} from './environment-capability.js';
import { probeShellClaudeCliAvailability } from './shell/shell-claude-cli-backend.js';
import {
  probeReasoningProviderReadiness,
  type ReasoningProviderReadinessDeps,
} from './reasoning/reasoning-provider-readiness.js';
import {
  getReasoningProviderDescriptor,
  listReasoningProviderDescriptors,
  resolveReasoningProviderEnvironment,
} from './reasoning/reasoning-provider-registry.js';
import {
  normalizeReasoningBackendMode,
  type ReasoningBackendMode,
} from './reasoning/reasoning-backend-policy.js';

export function installCoreEnvironmentProbes(): void {
  const coreProbes: Array<[string, RegisteredProbe]> = [
    ['reasoning-backend.any-real', probeReasoningBackend],
    ['audit-chain.integrity', probeAuditChain],
    ['repo-build.receipt', probeRepoBuild],
    ['node-version.floor', probeNodeVersionFloor],
    ['playwright.chromium-browser', probePlaywrightChromium],
    ['public-ingress.any-ready', probePublicIngress],
  ];
  for (const [probeId, probe] of coreProbes) {
    if (!hasEnvironmentCapabilityProbe(probeId)) registerEnvironmentCapabilityProbe(probeId, probe);
  }
}

/* ------------------------------------------------------------------ *
 * Probe bodies                                                        *
 * ------------------------------------------------------------------ */

/**
 * Probe exactly the backend named by `KYBERION_REASONING_BACKEND` (aliases
 * normalized via the reasoning-backend policy — the canonical catalog lives
 * in `reasoning-backend-policy.ts` / `knowledge/product/governance/
 * reasoning-backend-policy.json`). Exported for hermetic unit tests: the
 * CLI-spawning checks are injectable via `deps`.
 */
export async function probeExplicitReasoningBackend(
  backendRaw: string,
  env: NodeJS.ProcessEnv = process.env,
  deps: ReasoningProviderReadinessDeps = {}
): Promise<{ available: boolean; reason?: string }> {
  const backend = normalizeReasoningBackendMode(backendRaw as ReasoningBackendMode);

  const unavailable = (detail: string): { available: boolean; reason: string } => ({
    available: false,
    reason: `KYBERION_REASONING_BACKEND=${backendRaw} is set but that backend is not reachable: ${detail}`,
  });

  // RS-01: the probe is chosen by the governed descriptor's adapter (CLI
  // binary/version args come from the descriptor), never by a per-mode switch.
  const descriptor = getReasoningProviderDescriptor(backend);
  if (!descriptor) {
    return unavailable(
      'unknown backend mode. See knowledge/product/governance/reasoning-backend-policy.json (allowed_modes) for the catalog.'
    );
  }
  if (descriptor.adapter === 'stub') {
    return {
      available: false,
      reason: `KYBERION_REASONING_BACKEND=${backendRaw} is explicitly selected — deterministic placeholders only. Configure a real backend (see \`pnpm reasoning:setup\`) to clear this.`,
    };
  }
  const probe = await probeReasoningProviderReadiness(descriptor, env, {
    binaryProbe: deps.binaryProbe ?? binaryAvailable,
    ...(deps.claudeProbe ? { claudeProbe: deps.claudeProbe } : {}),
    ...(deps.anthropicProbe ? { anthropicProbe: deps.anthropicProbe } : {}),
  });
  return probe.available ? { available: true } : unavailable(probe.reason ?? 'probe failed');
}

/** Adapters whose readiness is a local binary/CLI check rather than a configured credential. */
const LOCAL_RUNTIME_ADAPTERS = new Set(['provider-cli', 'claude-cli', 'claude-agent-sdk']);

async function probeReasoningBackend(): Promise<{ available: boolean; reason?: string }> {
  // An explicitly selected backend is probed specifically — a working
  // *different* backend must not mask a broken selection.
  const explicit = kyberionEnv('KYBERION_REASONING_BACKEND')?.trim();
  if (explicit) {
    return probeExplicitReasoningBackend(explicit, process.env);
  }
  // RS-01: walk the governed registry. Local CLI runtimes are probed first
  // (cheap, no credential); hosted/local-server adapters only when one of
  // their declared env_keys is configured. The claude shell probe is shared
  // by the two claude adapters.
  let claudeResult: { available: boolean; reason?: string } | undefined;
  const deps: ReasoningProviderReadinessDeps = {
    binaryProbe: binaryAvailable,
    claudeProbe: () => (claudeResult ??= probeShellClaudeCliAvailability()),
  };
  const descriptors = listReasoningProviderDescriptors().filter(
    (descriptor) => descriptor.adapter !== 'stub'
  );
  const local = descriptors.filter((descriptor) => LOCAL_RUNTIME_ADAPTERS.has(descriptor.adapter));
  const configured = descriptors.filter(
    (descriptor) =>
      !LOCAL_RUNTIME_ADAPTERS.has(descriptor.adapter) &&
      descriptor.env_keys.some((key) =>
        Boolean(kyberionEnv(key) || resolveReasoningProviderEnvironment(descriptor)[key])
      )
  );
  for (const descriptor of [...local, ...configured]) {
    if ((await probeReasoningProviderReadiness(descriptor, process.env, deps)).available) {
      return { available: true };
    }
  }
  const options = descriptors.map((descriptor) =>
    descriptor.cli
      ? `${descriptor.mode} (\`${descriptor.cli.binary}\`)`
      : `${descriptor.mode} (${descriptor.env_keys.join(' or ') || 'see setup'})`
  );
  return {
    available: false,
    reason: `no real reasoning backend reachable. Authenticate or configure one of: ${options.join(', ')}. Or set KYBERION_REASONING_BACKEND=stub to acknowledge stub-only mode.`,
  };
}

async function probeAuditChain(): Promise<{ available: boolean; reason?: string }> {
  const chainPath = pathResolver.rootResolve('active/shared/state/audit-chain.jsonl');
  if (!safeExistsSync(chainPath)) {
    // First run / fresh checkout — creating it later is normal.
    return { available: true };
  }
  if (!isRegularAuditChainPath(chainPath)) {
    return { available: false, reason: 'audit-chain path is not a regular file' };
  }
  let lineNumber = 0;
  try {
    readJsonLines(chainPath, {
      map: (entry, currentLine) => {
        lineNumber = currentLine;
        return normalizePersistedAuditEntry(entry);
      },
      onMalformed: (error, currentLine) => {
        lineNumber = currentLine;
        throw error;
      },
    });
    return { available: true };
  } catch (err: any) {
    return {
      available: false,
      reason: `audit-chain parse failed at line ${lineNumber}: ${err?.message ?? err}`,
    };
  }
}

export function isRegularAuditChainPath(filePath: string): boolean {
  if (!safeExistsSync(filePath)) return false;
  try {
    return safeLstat(filePath).isFile();
  } catch {
    return false;
  }
}

async function probeRepoBuild(): Promise<{ available: boolean; reason?: string }> {
  const distDir = pathResolver.rootResolve('libs/core/dist');
  if (!safeExistsSync(distDir)) {
    return {
      available: false,
      reason: 'libs/core/dist missing — run `pnpm build`',
    };
  }
  try {
    const distMtime = newestOutputMtimeUnder(distDir);
    const newestTs = newestTsMtimeUnder(pathResolver.rootResolve('libs/core'));
    if (newestTs === null) return { available: true };
    if (distMtime !== null && newestTs > distMtime + 5_000) {
      return {
        available: false,
        reason: `libs/core has TypeScript newer than the dist build by ${((newestTs - distMtime) / 1000).toFixed(0)}s — run \`pnpm build\``,
      };
    }
    return { available: true };
  } catch (err: any) {
    logger.warn(`[env-probes] repo-build.receipt probe error: ${err?.message ?? err}`);
    return { available: true };
  }
}

/* ------------------------------------------------------------------ *
 * Node version floor (package.json engines)                           *
 * ------------------------------------------------------------------ */

/**
 * Parse the minimum Node version out of an engines-style range like
 * `>=24.0.0`. Returns null when no `>=` floor is declared.
 */
export function parseEnginesNodeFloor(range: string): [number, number, number] | null {
  const match = /(?:>=|\^)\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(range);
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

/** True when `current` (e.g. `v24.1.0` or `24.1.0`) >= `floor`. */
export function nodeVersionSatisfiesFloor(
  current: string,
  floor: readonly [number, number, number]
): boolean {
  const parts = current.replace(/^v/, '').split('.');
  const cur: [number, number, number] = [
    Number(parts[0] ?? 0) || 0,
    Number(parts[1] ?? 0) || 0,
    Number(parts[2] ?? 0) || 0,
  ];
  for (let i = 0; i < 3; i += 1) {
    if (cur[i] > floor[i]) return true;
    if (cur[i] < floor[i]) return false;
  }
  return true;
}

function readRootEnginesNodeRange(): string | null {
  return readNodeEnginesRangeFromFile(pathResolver.rootResolve('package.json'));
}

export function readNodeEnginesRangeFromFile(filePath: string): string | null {
  try {
    const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
    if (!safeExistsSync(safePath) || !safeLstat(safePath).isFile()) return null;
    return parseNodeEnginesRange(readJson<unknown>(safePath));
  } catch {
    return null;
  }
}

export function parseNodeEnginesRange(value: unknown): string | null {
  try {
    const pkg = parseSafeJsonObjectValue(value, 'package.json');
    const engines =
      pkg.engines === undefined
        ? null
        : parseSafeJsonObjectValue(pkg.engines, 'package.json engines');
    const range = engines?.node;
    return typeof range === 'string' && range.trim() !== '' ? range : null;
  } catch {
    return null;
  }
}

async function probeNodeVersionFloor(): Promise<{ available: boolean; reason?: string }> {
  const range = readRootEnginesNodeRange();
  if (!range) return { available: true };
  const floor = parseEnginesNodeFloor(range);
  if (!floor) return { available: true };
  if (nodeVersionSatisfiesFloor(process.versions.node, floor)) {
    return { available: true };
  }
  const major = floor[0];
  const current = `v${process.versions.node}`;
  return {
    available: false,
    reason: t('status:probe_node_engines_unmet', { current, range, major }),
  };
}

/* ------------------------------------------------------------------ *
 * Playwright browser cache                                            *
 * ------------------------------------------------------------------ */

/**
 * Where Playwright keeps downloaded browsers on this host. Mirrors the
 * playwright-core registry defaults; `PLAYWRIGHT_BROWSERS_PATH` wins,
 * and the special value `0` means "inside node_modules".
 */
export function playwrightBrowsersDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PLAYWRIGHT_BROWSERS_PATH;
  if (override && override !== '0') return override;
  if (override === '0') {
    return pathResolver.rootResolve('node_modules/playwright-core/.local-browsers');
  }
  const home = os.homedir();
  if (isMacOS()) return path.join(home, 'Library', 'Caches', 'ms-playwright');
  if (isWindows()) {
    return path.join(env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'ms-playwright');
  }
  return path.join(env.XDG_CACHE_HOME ?? path.join(home, '.cache'), 'ms-playwright');
}

/**
 * Browser directories the installed playwright-core launches
 * (`chromium-<rev>`, `chromium_headless_shell-<rev>`), or null when
 * playwright is not resolvable from the repository root.
 */
export function requiredPlaywrightChromiumDirs(): string[] | null {
  try {
    const rootRequire = createRequire(pathResolver.rootResolve('package.json'));
    const corePackage = createRequire(rootRequire.resolve('playwright/package.json')).resolve(
      'playwright-core/package.json'
    );
    const manifest = readJson<{ browsers?: Array<{ name?: string; revision?: string }> }>(
      path.join(path.dirname(corePackage), 'browsers.json')
    );
    const dirNames: Record<string, string> = {
      chromium: 'chromium',
      'chromium-headless-shell': 'chromium_headless_shell',
    };
    return (manifest.browsers ?? []).flatMap((browser) =>
      browser.name && browser.revision && dirNames[browser.name]
        ? [`${dirNames[browser.name]}-${browser.revision}`]
        : []
    );
  } catch {
    return null;
  }
}

async function probePlaywrightChromium(): Promise<{ available: boolean; reason?: string }> {
  const dir = playwrightBrowsersDir();
  if (!safeExistsSync(dir)) {
    return {
      available: false,
      reason: t('status:probe_playwright_missing', { dir }),
    };
  }
  // A cache from an older playwright holds other revisions; launch would fail.
  const missing = (requiredPlaywrightChromiumDirs() ?? []).filter(
    (name) => !safeExistsSync(path.join(dir, name))
  );
  if (missing.length === 0) return { available: true };
  return {
    available: false,
    reason: t('status:probe_playwright_revision_missing', { dir, revisions: missing.join(', ') }),
  };
}

/**
 * At least one live public-ingress provider is ready. Loaded lazily: the
 * ingress service pulls in surface/approval modules this file must not load
 * at import time.
 */
async function probePublicIngress(): Promise<{ available: boolean; reason?: string }> {
  const { probeAnyPublicIngressReady } = await import('./ingress/public-ingress-service.js');
  return probeAnyPublicIngressReady();
}

/* ------------------------------------------------------------------ *
 * Helpers                                                             *
 * ------------------------------------------------------------------ */

function newestTsMtimeUnder(dir: string): number | null {
  try {
    if (!safeExistsSync(dir)) return null;
    let newest = 0;
    walk(dir);
    return newest === 0 ? null : newest;

    function walk(current: string): void {
      const entries = listDir(current);
      for (const name of entries) {
        if (name === 'dist' || name === 'node_modules' || name === '.git') continue;
        const full = path.join(current, name);
        const stat = safeStat(full);
        if (stat.isDirectory()) {
          walk(full);
        } else if (isBuildRelevantTsFile(full)) {
          if (stat.mtimeMs > newest) newest = stat.mtimeMs;
        }
      }
    }
  } catch {
    return null;
  }
}

function newestOutputMtimeUnder(dir: string): number | null {
  try {
    if (!safeExistsSync(dir)) return null;
    let newest = 0;
    walk(dir);
    return newest === 0 ? null : newest;

    function walk(current: string): void {
      const entries = listDir(current);
      for (const name of entries) {
        if (name === 'node_modules' || name === '.git') continue;
        const full = path.join(current, name);
        const stat = safeStat(full);
        if (stat.isDirectory()) {
          walk(full);
        } else if (/\.(js|cjs|mjs|d\.ts|map)$/.test(full)) {
          if (stat.mtimeMs > newest) newest = stat.mtimeMs;
        }
      }
    }
  } catch {
    return null;
  }
}

function isBuildRelevantTsFile(full: string): boolean {
  if (!full.endsWith('.ts') || full.endsWith('.d.ts')) return false;
  return !/(\.test|\.spec)\.ts$/.test(full);
}

function listDir(dir: string): string[] {
  try {
    return safeReaddir(dir);
  } catch {
    return [];
  }
}

function binaryAvailable(command: string, args: readonly string[]): boolean {
  try {
    safeExec(command, [...args], { timeoutMs: 5_000, maxOutputMB: 1 });
    return true;
  } catch {
    return false;
  }
}

// Module-load-time side effect.
installCoreEnvironmentProbes();
