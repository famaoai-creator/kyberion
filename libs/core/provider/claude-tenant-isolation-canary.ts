/**
 * `claude-tenant-isolation` doctor canary (CLAUDE_CLI_TENANT_CREDENTIAL_DESIGN
 * §4): start the real `claude` with the bound-launch env shape — an isolated
 * HOME / CLAUDE_CONFIG_DIR on the system scratch floor, the same kind flags,
 * and no credential — and require that it reports "not logged in". If it
 * reports a login, a tenant launch would silently run on the operator's own
 * login (Keychain / ~/.claude), so the check fails.
 *
 * It runs `claude [--bare] auth status --json` only: no model request is ever
 * made, whether isolation holds or not. Skipped (satisfied) when no claude
 * CLI is installed.
 */

import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { logger } from '../core.js';
import { getRegisteredEnvText, isVitestProcess } from '../foundation/env.js';
import { parseSafeJsonInput } from '../foundation/safe-json.js';
import type { TaskCredentialKind } from '../foundation/credential-binding.js';
import { safeExecResult, safeMkdir, safeRmSync } from '../secure-io.js';
import { resolveStorageFloor, SYSTEM_PARTITION } from '../storage-layout.js';
import { resolveProviderCliCommand } from './provider-managed-env.js';
import {
  claudeCredentialKindArgs,
  claudeIsolatedLaunchEnv,
} from './claude-cli-tenant-isolation.js';

export const CLAUDE_TENANT_ISOLATION_PROBE_ID = 'claude-tenant-isolation';

type ExecResult = { stdout: string; stderr: string; status: number | null; error?: Error };

export interface ClaudeTenantIsolationCanaryDeps {
  /** Test seam; defaults to the governed `safeExecResult`. */
  exec?: (
    command: string,
    args: string[],
    options: Parameters<typeof safeExecResult>[2]
  ) => ExecResult;
  bin?: string;
}

const KINDS: readonly TaskCredentialKind[] = ['api_key', 'subscription_token'];

function loggedInOf(stdout: string): boolean | undefined {
  try {
    const parsed = parseSafeJsonInput(stdout, 'claude auth status') as { loggedIn?: unknown };
    return typeof parsed?.loggedIn === 'boolean' ? parsed.loggedIn : undefined;
  } catch {
    return undefined;
  }
}

export async function probeClaudeTenantIsolation(
  deps: ClaudeTenantIsolationCanaryDeps = {}
): Promise<{ available: boolean; reason?: string }> {
  // Hermetic: a test run never starts the real CLI unless it injects `exec`.
  if (!deps.exec && isVitestProcess())
    return { available: true, reason: 'skipped: real claude CLI is not started under Vitest' };
  const exec = deps.exec ?? safeExecResult;
  const bin =
    deps.bin ||
    getRegisteredEnvText('KYBERION_CLAUDE_CLI_BIN')?.trim() ||
    resolveProviderCliCommand('claude');
  const version = exec(bin, ['--version'], { timeoutMs: 10_000 });
  if (version.error || version.status !== 0) {
    logger.info(
      `[claude-tenant-isolation] skipped — no runnable claude CLI (${bin}) | next: none needed until claude is installed | evidence: ${version.error?.message ?? `exit ${version.status}`}`
    );
    return { available: true, reason: `skipped: claude CLI not installed (${bin})` };
  }
  const root = resolveStorageFloor(
    'scratch',
    SYSTEM_PARTITION,
    'claude-tenant-isolation',
    randomUUID()
  );
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'cwd');
  try {
    safeMkdir(path.join(home, '.claude'), { recursive: true });
    safeMkdir(cwd, { recursive: true });
    for (const kind of KINDS) {
      const result = exec(bin, [...claudeCredentialKindArgs(kind), 'auth', 'status', '--json'], {
        timeoutMs: 20_000,
        cwd,
        // No credential: the env carries only the isolated HOME/config dir and flags.
        env: claudeIsolatedLaunchEnv({ home, configDir: path.join(home, '.claude'), kind }),
      });
      const loggedIn = loggedInOf(result.stdout);
      if (loggedIn === true) {
        return {
          available: false,
          reason: `isolation broken: claude reports a login with no bound credential (kind=${kind}) — a tenant run would use the operator's login. Check CLAUDE_CONFIG_DIR handling and the installed CLI version.`,
        };
      }
      // Only an explicit "not logged in" answer proves isolation. An unparseable
      // answer — including a non-zero exit (crash, unknown flag, network) — is unknown.
      if (loggedIn !== false) {
        return {
          available: false,
          reason: `could not confirm isolation (kind=${kind}): \`claude auth status --json\` gave no explicit "not logged in" answer (exit ${result.status ?? 'none'})`,
        };
      }
    }
    return { available: true };
  } finally {
    try {
      safeRmSync(root, { recursive: true, force: true });
    } catch {
      // The scratch-floor TTL sweep reclaims it.
    }
  }
}
