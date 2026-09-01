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
 *
 * Importing this module triggers `installCoreEnvironmentProbes()` for
 * its side effect; tests that reset the probe registry can re-arm by
 * calling that exported function again.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { logger } from './core.js';
import * as pathResolver from './path-resolver.js';
import { readJson } from './foundation/json.js';
import { safeExistsSync, safeReadFile, safeReaddir, safeStat, safeExec } from './secure-io.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { parseSafeJsonInput } from './foundation/safe-json.js';
import { normalizePersistedAuditEntry } from './audit-chain.js';

function kyberionEnv(name: string): string | undefined {
  return getRegisteredEnvText(name);
}
import {
  hasEnvironmentCapabilityProbe,
  registerEnvironmentCapabilityProbe,
  type RegisteredProbe,
} from './environment-capability.js';
import { probeShellClaudeCliAvailability } from './shell-claude-cli-backend.js';
import {
  probeNemotronBackendAvailability,
  probeOpenAiCompatibleBackendAvailability,
  probeOllamaBackendAvailability,
  probeVllmBackendAvailability,
  probeLmStudioBackendAvailability,
  probeLlamaCppBackendAvailability,
  probeMlxBackendAvailability,
  probeLocalAiBackendAvailability,
} from './openai-compatible-backend.js';
import { probeOpenRouterBackendAvailability } from './openrouter-backend.js';
import { probeGeminiApiBackendAvailability } from './gemini-api-backend.js';
import { probeGrokApiBackendAvailability } from './grok-api-backend.js';
import { probeAnthropicApiBackendAvailability } from './anthropic-api-probe.js';
import {
  normalizeReasoningBackendMode,
  type ReasoningBackendMode,
} from './reasoning-backend-policy.js';

export function installCoreEnvironmentProbes(): void {
  const coreProbes: Array<[string, RegisteredProbe]> = [
    ['reasoning-backend.any-real', probeReasoningBackend],
    ['audit-chain.integrity', probeAuditChain],
    ['repo-build.receipt', probeRepoBuild],
    ['node-version.floor', probeNodeVersionFloor],
    ['playwright.chromium-browser', probePlaywrightChromium],
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
  deps: {
    binaryProbe?: (command: string, args: readonly string[]) => boolean;
    claudeProbe?: () => { available: boolean; reason?: string };
    anthropicProbe?: (env: NodeJS.ProcessEnv) => Promise<{ available: boolean; reason?: string }>;
  } = {}
): Promise<{ available: boolean; reason?: string }> {
  const binaryProbe = deps.binaryProbe ?? binaryAvailable;
  const claudeProbe = deps.claudeProbe ?? (() => probeShellClaudeCliAvailability(env));
  const anthropicProbe =
    deps.anthropicProbe ?? ((selectedEnv) => probeAnthropicApiBackendAvailability(selectedEnv));
  const backend = normalizeReasoningBackendMode(backendRaw as ReasoningBackendMode);

  const unavailable = (detail: string): { available: boolean; reason: string } => ({
    available: false,
    reason: `KYBERION_REASONING_BACKEND=${backendRaw} is set but that backend is not reachable: ${detail}`,
  });

  switch (backend) {
    case 'stub':
      return {
        available: false,
        reason:
          'KYBERION_REASONING_BACKEND=stub is explicitly selected — deterministic placeholders only. Configure a real backend (see `pnpm reasoning:setup`) to clear this.',
      };
    case 'claude-cli': {
      // claude-cli is a shell backend; an API key does not make the CLI
      // executable. Probe the selected runtime rather than short-circuiting
      // on a credential intended for the Agent/API mode.
      const probe = claudeProbe();
      return probe.available
        ? { available: true }
        : unavailable(probe.reason ?? 'claude CLI probe failed');
    }
    case 'claude-agent': {
      if (env.CLAUDE_API_KEY?.trim()) return { available: true };
      const probe = claudeProbe();
      return probe.available
        ? { available: true }
        : unavailable(probe.reason ?? 'claude CLI probe failed');
    }
    case 'codex-cli':
      return binaryProbe('codex', ['--version'])
        ? { available: true }
        : unavailable('`codex --version` failed');
    case 'gemini-cli':
      return binaryProbe('gemini', ['--version'])
        ? { available: true }
        : unavailable('`gemini --version` failed');
    case 'agy-cli':
      return binaryProbe('agy', ['--version'])
        ? { available: true }
        : unavailable('`agy --version` failed');
    case 'grok-cli':
      return binaryProbe('grok', ['--version'])
        ? { available: true }
        : unavailable('`grok --version` failed');
    case 'grok-api': {
      const probe = await probeGrokApiBackendAvailability(env);
      return probe.available
        ? { available: true }
        : unavailable(probe.reason ?? 'xAI Grok API probe failed');
    }
    case 'copilot':
      return binaryProbe('gh', ['copilot', '--', '--help'])
        ? { available: true }
        : unavailable('`gh copilot -- --help` failed');
    case 'anthropic': {
      const probe = await anthropicProbe(env);
      return probe.available
        ? { available: true }
        : unavailable(probe.reason ?? 'Anthropic API probe failed');
    }
    case 'gemini-api': {
      const probe = await probeGeminiApiBackendAvailability(env);
      return probe.available
        ? { available: true }
        : unavailable(probe.reason ?? 'Gemini API probe failed');
    }
    case 'openrouter': {
      const probe = await probeOpenRouterBackendAvailability(env);
      return probe.available
        ? { available: true }
        : unavailable(probe.reason ?? 'OpenRouter probe failed');
    }
    case 'ollama': {
      const probe = await probeOllamaBackendAvailability(env);
      return probe.available
        ? { available: true }
        : unavailable(probe.reason ?? 'Ollama probe failed');
    }
    case 'vllm': {
      const probe = await probeVllmBackendAvailability(env);
      return probe.available
        ? { available: true }
        : unavailable(probe.reason ?? 'vLLM probe failed');
    }
    case 'lmstudio': {
      const probe = await probeLmStudioBackendAvailability(env);
      return probe.available
        ? { available: true }
        : unavailable(probe.reason ?? 'LM Studio probe failed');
    }
    case 'llamacpp': {
      const probe = await probeLlamaCppBackendAvailability(env);
      return probe.available
        ? { available: true }
        : unavailable(probe.reason ?? 'llama.cpp probe failed');
    }
    case 'mlx': {
      const probe = await probeMlxBackendAvailability(env);
      return probe.available
        ? { available: true }
        : unavailable(probe.reason ?? 'MLX probe failed');
    }
    case 'localai': {
      const probe = await probeLocalAiBackendAvailability(env);
      return probe.available
        ? { available: true }
        : unavailable(probe.reason ?? 'LocalAI probe failed');
    }
    case 'local': {
      const probe = await probeOpenAiCompatibleBackendAvailability(env);
      return probe.available
        ? { available: true }
        : unavailable(probe.reason ?? 'local OpenAI-compatible probe failed');
    }
    case 'nemotron-api': {
      const probe = await probeNemotronBackendAvailability(env);
      return probe.available
        ? { available: true }
        : unavailable(probe.reason ?? 'Nemotron probe failed');
    }
    default:
      return unavailable(
        'unknown backend mode. See knowledge/product/governance/reasoning-backend-policy.json (allowed_modes) for the catalog.'
      );
  }
}

async function probeReasoningBackend(): Promise<{ available: boolean; reason?: string }> {
  // An explicitly selected backend is probed specifically — a working
  // *different* backend must not mask a broken selection.
  const explicit = kyberionEnv('KYBERION_REASONING_BACKEND')?.trim();
  if (explicit) {
    return probeExplicitReasoningBackend(explicit, process.env);
  }
  if (binaryAvailable('codex', ['--version'])) {
    return { available: true };
  }
  if (binaryAvailable('gemini', ['--version'])) {
    return { available: true };
  }
  if (binaryAvailable('agy', ['--version'])) {
    return { available: true };
  }
  if (binaryAvailable('grok', ['--version'])) {
    return { available: true };
  }
  if (process.env.CLAUDE_API_KEY !== undefined || probeShellClaudeCliAvailability().available) {
    return { available: true };
  }
  if (Boolean(process.env.ANTHROPIC_API_KEY)) {
    return { available: true };
  }
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
    const geminiProbe = await probeGeminiApiBackendAvailability(process.env);
    if (geminiProbe.available) return { available: true };
  }
  if (process.env.XAI_API_KEY || kyberionEnv('KYBERION_GROK_API_KEY')) {
    const grokApiProbe = await probeGrokApiBackendAvailability(process.env);
    if (grokApiProbe.available) return { available: true };
  }
  if (process.env.OPENROUTER_API_KEY || kyberionEnv('KYBERION_OPENROUTER_KEY')) {
    const openrouterProbe = await probeOpenRouterBackendAvailability(process.env);
    if (openrouterProbe.available) return { available: true };
  }
  if (Boolean(kyberionEnv('KYBERION_OLLAMA_URL')) || Boolean(process.env.OLLAMA_HOST)) {
    const ollamaProbe = await probeOllamaBackendAvailability(process.env);
    if (ollamaProbe.available) return { available: true };
  }
  if (Boolean(kyberionEnv('KYBERION_VLLM_URL'))) {
    const vllmProbe = await probeVllmBackendAvailability(process.env);
    if (vllmProbe.available) return { available: true };
  }
  if (
    Boolean(kyberionEnv('KYBERION_LMSTUDIO_URL')) ||
    Boolean(kyberionEnv('KYBERION_LM_STUDIO_URL'))
  ) {
    const lmstudioProbe = await probeLmStudioBackendAvailability(process.env);
    if (lmstudioProbe.available) return { available: true };
  }
  if (Boolean(kyberionEnv('KYBERION_LLAMACPP_URL'))) {
    const llamacppProbe = await probeLlamaCppBackendAvailability(process.env);
    if (llamacppProbe.available) return { available: true };
  }
  if (Boolean(kyberionEnv('KYBERION_MLX_URL'))) {
    const mlxProbe = await probeMlxBackendAvailability(process.env);
    if (mlxProbe.available) return { available: true };
  }
  if (Boolean(kyberionEnv('KYBERION_LOCALAI_URL'))) {
    const localaiProbe = await probeLocalAiBackendAvailability(process.env);
    if (localaiProbe.available) return { available: true };
  }
  if (Boolean(kyberionEnv('KYBERION_LOCAL_LLM_URL'))) {
    const localProbe = await probeOpenAiCompatibleBackendAvailability(process.env);
    if (localProbe.available) return { available: true };
  }
  if (Boolean(kyberionEnv('KYBERION_NEMOTRON_URL'))) {
    const nemotronProbe = await probeNemotronBackendAvailability(process.env);
    if (nemotronProbe.available) return { available: true };
  }
  return {
    available: false,
    reason:
      'no real reasoning backend reachable. Authenticate one of: claude CLI, codex CLI, gemini CLI, agy CLI, grok CLI (Grok Build), xAI Grok API key (XAI_API_KEY or KYBERION_GROK_API_KEY), Google AI Studio API key (GEMINI_API_KEY or GOOGLE_API_KEY), Anthropic API key (ANTHROPIC_API_KEY), OpenRouter API key (OPENROUTER_API_KEY or KYBERION_OPENROUTER_KEY), Ollama URL (KYBERION_OLLAMA_URL), vLLM URL (KYBERION_VLLM_URL), LM Studio URL (KYBERION_LMSTUDIO_URL), llama.cpp URL (KYBERION_LLAMACPP_URL), MLX URL (KYBERION_MLX_URL), LocalAI URL (KYBERION_LOCALAI_URL), Nemotron API URL (KYBERION_NEMOTRON_URL), or local LLM URL (KYBERION_LOCAL_LLM_URL). Or set KYBERION_REASONING_BACKEND=stub to acknowledge stub-only mode.',
  };
}

async function probeAuditChain(): Promise<{ available: boolean; reason?: string }> {
  const chainPath = pathResolver.rootResolve('active/shared/state/audit-chain.jsonl');
  if (!safeExistsSync(chainPath)) {
    // First run / fresh checkout — creating it later is normal.
    return { available: true };
  }
  let lineNumber = 0;
  try {
    const text = safeReadFile(chainPath, { encoding: 'utf8' }) as string;
    for (const raw of text.split('\n')) {
      lineNumber += 1;
      const line = raw.trim();
      if (!line) continue;
      const entry = parseSafeJsonInput(line, 'environment audit entry');
      normalizePersistedAuditEntry(entry);
    }
    return { available: true };
  } catch (err: any) {
    return {
      available: false,
      reason: `audit-chain parse failed at line ${lineNumber}: ${err?.message ?? err}`,
    };
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
  try {
    const pkgPath = pathResolver.rootResolve('package.json');
    if (!safeExistsSync(pkgPath)) return null;
    const pkg = readJson<{ engines?: { node?: unknown } }>(pkgPath);
    const range = pkg.engines?.node;
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
    reason:
      `Node ${current} does not satisfy package.json engines "${range}". ` +
      `Fix: \`nvm install ${major} && nvm use ${major}\` (or \`mise install node@${major}\`), then rerun. ` +
      `/ 実行中の Node ${current} は engines "${range}" を満たしていません。` +
      `\`nvm install ${major} && nvm use ${major}\`(または \`mise install node@${major}\`)でアップグレードしてから再実行してください。`,
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
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Caches', 'ms-playwright');
  if (process.platform === 'win32') {
    return path.join(env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'ms-playwright');
  }
  return path.join(env.XDG_CACHE_HOME ?? path.join(home, '.cache'), 'ms-playwright');
}

async function probePlaywrightChromium(): Promise<{ available: boolean; reason?: string }> {
  const dir = playwrightBrowsersDir();
  if (safeExistsSync(dir)) return { available: true };
  return {
    available: false,
    reason:
      `no Playwright browser cache at ${dir} — browser features (first-win screenshot, browser:goto) ` +
      `will silently fall back to text. Fix: \`pnpm exec playwright install chromium\`. ` +
      `/ Playwright ブラウザ未導入です。\`pnpm exec playwright install chromium\` を実行してください。`,
  };
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
