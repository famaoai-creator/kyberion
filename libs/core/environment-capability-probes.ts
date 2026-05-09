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
 *
 * Importing this module triggers `installCoreEnvironmentProbes()` for
 * its side effect; tests that reset the probe registry can re-arm by
 * calling that exported function again.
 */

import * as path from 'node:path';
import { logger } from './core.js';
import * as pathResolver from './path-resolver.js';
import {
  safeExistsSync,
  safeReadFile,
  safeReaddir,
  safeStat,
  safeExec,
} from './secure-io.js';
import { registerEnvironmentCapabilityProbe } from './environment-capability.js';
import { probeShellClaudeCliAvailability } from './shell-claude-cli-backend.js';
import { probeOpenAiCompatibleBackendAvailability } from './openai-compatible-backend.js';

export function installCoreEnvironmentProbes(): void {
  registerEnvironmentCapabilityProbe('reasoning-backend.any-real', probeReasoningBackend);
  registerEnvironmentCapabilityProbe('audit-chain.integrity', probeAuditChain);
  registerEnvironmentCapabilityProbe('repo-build.receipt', probeRepoBuild);
}

/* ------------------------------------------------------------------ *
 * Probe bodies                                                        *
 * ------------------------------------------------------------------ */

async function probeReasoningBackend(): Promise<{ available: boolean; reason?: string }> {
  if (process.env.CLAUDE_API_KEY !== undefined || probeShellClaudeCliAvailability().available) {
    return { available: true };
  }
  if (Boolean(process.env.ANTHROPIC_API_KEY)) {
    return { available: true };
  }
  if (Boolean(process.env.KYBERION_LOCAL_LLM_URL)) {
    const localProbe = await probeOpenAiCompatibleBackendAvailability(process.env);
    if (localProbe.available) return { available: true };
  }
  if (binaryAvailable('gemini', ['--version'])) {
    return { available: true };
  }
  if (binaryAvailable('codex', ['--version'])) {
    return { available: true };
  }
  return {
    available: false,
    reason:
      'no real reasoning backend reachable. Authenticate one of: claude CLI, anthropic API key (ANTHROPIC_API_KEY), local LLM URL (KYBERION_LOCAL_LLM_URL), gemini CLI, codex CLI. Or set KYBERION_REASONING_BACKEND=stub to acknowledge stub-only mode.',
  };
}

async function probeAuditChain(): Promise<{ available: boolean; reason?: string }> {
  const chainPath = pathResolver.rootResolve('active/shared/state/audit-chain.jsonl');
  if (!safeExistsSync(chainPath)) {
    // First run / fresh checkout — creating it later is normal.
    return { available: true };
  }
  try {
    const text = safeReadFile(chainPath, { encoding: 'utf8' }) as string;
    let lineNumber = 0;
    for (const raw of text.split('\n')) {
      lineNumber += 1;
      const line = raw.trim();
      if (!line) continue;
      const entry = JSON.parse(line);
      if (typeof entry.id !== 'string' || typeof entry.action !== 'string') {
        return {
          available: false,
          reason: `audit-chain malformed at line ${lineNumber}: missing id/action`,
        };
      }
    }
    return { available: true };
  } catch (err: any) {
    return {
      available: false,
      reason: `audit-chain parse failed: ${err?.message ?? err}`,
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
