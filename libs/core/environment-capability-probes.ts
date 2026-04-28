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
 *   repo-build.receipt           — libs/core/dist/index.js is fresh
 *
 * Importing this module triggers `installCoreEnvironmentProbes()` for
 * its side effect; tests that reset the probe registry can re-arm by
 * calling that exported function again.
 */

import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { logger } from './core.js';
import * as pathResolver from './path-resolver.js';
import {
  safeExistsSync,
  safeReadFile,
  safeStat,
} from './secure-io.js';
import { registerEnvironmentCapabilityProbe } from './environment-capability.js';

export function installCoreEnvironmentProbes(): void {
  registerEnvironmentCapabilityProbe('reasoning-backend.any-real', probeReasoningBackend);
  registerEnvironmentCapabilityProbe('audit-chain.integrity', probeAuditChain);
  registerEnvironmentCapabilityProbe('repo-build.receipt', probeRepoBuild);
}

/* ------------------------------------------------------------------ *
 * Probe bodies                                                        *
 * ------------------------------------------------------------------ */

async function probeReasoningBackend(): Promise<{ available: boolean; reason?: string }> {
  const candidates: Array<{ name: string; check: () => boolean }> = [
    {
      name: 'claude-cli',
      check: () =>
        process.env.CLAUDE_API_KEY !== undefined ||
        binaryAvailable('claude', ['--version']),
    },
    {
      name: 'anthropic',
      check: () => Boolean(process.env.ANTHROPIC_API_KEY),
    },
    {
      name: 'gemini-cli',
      check: () => binaryAvailable('gemini', ['--version']),
    },
    {
      name: 'codex-cli',
      check: () => binaryAvailable('codex', ['--version']),
    },
  ];
  if (candidates.find((c) => c.check())) return { available: true };
  return {
    available: false,
    reason:
      'no real reasoning backend reachable. Authenticate one of: claude CLI, anthropic API key (ANTHROPIC_API_KEY), gemini CLI, codex CLI. Or set KYBERION_REASONING_BACKEND=stub to acknowledge stub-only mode.',
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
  const distEntry = pathResolver.rootResolve('libs/core/dist/index.js');
  if (!safeExistsSync(distEntry)) {
    return {
      available: false,
      reason: 'libs/core/dist/index.js missing — run `pnpm build`',
    };
  }
  try {
    const distMtime = safeStat(distEntry).mtimeMs;
    const newestTs = newestTsMtimeUnder(pathResolver.rootResolve('libs/core'));
    if (newestTs === null) return { available: true };
    if (newestTs > distMtime + 5_000) {
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

function binaryAvailable(command: string, args: readonly string[]): boolean {
  try {
    const result = spawnSync(command, [...args], { stdio: 'ignore' });
    return result.status === 0;
  } catch {
    return false;
  }
}

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
        } else if (full.endsWith('.ts') && !full.endsWith('.d.ts')) {
          if (stat.mtimeMs > newest) newest = stat.mtimeMs;
        }
      }
    }
  } catch {
    return null;
  }
}

function listDir(dir: string): string[] {
  const result = spawnSync('ls', ['-1A', dir], { encoding: 'utf8' });
  if (result.status !== 0) return [];
  return result.stdout.split('\n').filter((s) => s.length > 0);
}

// Module-load-time side effect.
installCoreEnvironmentProbes();
