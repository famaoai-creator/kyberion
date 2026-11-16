/**
 * Claude CLI launch isolation under a task credential binding (design:
 * CLAUDE_CLI_TENANT_CREDENTIAL_DESIGN_2026-11-16 §4).
 *
 * A bound (tenant) `claude` child never reads the operator's settings, hooks,
 * MCP servers, plugins or login: settings sources are closed, MCP is strict
 * and empty, hooks are disabled, the cwd is a fresh tenant scratch directory
 * (no repository `.claude/` or CLAUDE.md is discovered), HOME and
 * CLAUDE_CONFIG_DIR come from the bound isolated provider HOME, and the only
 * credential the child sees is the one the binding carries for its kind:
 *
 *   api_key            → `--bare` + ANTHROPIC_API_KEY
 *   subscription_token → CLAUDE_CODE_OAUTH_TOKEN (no `--bare`: it ignores the token)
 *
 * A binding without a credential kind or without the matching secret fails
 * closed before any spawn. Unbound (operator) runs never reach this module's
 * argv/env changes.
 */

import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import {
  credentialExecutionIdentity,
  hasTaskCredentialBinding,
  resolveTaskClaudeSubscriptionToken,
  resolveTaskCredential,
  resolveTaskCredentialKind,
  resolveTaskProviderEnvironment,
  type TaskCredentialKind,
} from '../foundation/credential-binding.js';
import { classifyStorageFloorPath, resolveStorageFloor } from '../storage-layout.js';
import { safeMkdir, safeRmSync, buildSafeExecEnv } from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';
import { PROXY_ENV_KEYS } from '../foundation/env.js';
import type { ScopeContext } from '../foundation/scope-context-validation.js';
import { providerAuthHomeRelativePath } from './provider-auth-home.js';

/** Provider-environment key of the claude family (design §3 `providerEnvironments.claude`). */
export const CLAUDE_PROVIDER_ENVIRONMENT = 'claude';

/**
 * Closed settings / MCP / hooks surface applied to every bound claude path.
 * The prompted-tools path uses the same tuple for every run (operator too).
 */
export const CLAUDE_TENANT_ISOLATION_ARGS: readonly string[] = [
  '--strict-mcp-config',
  '--mcp-config',
  '{"mcpServers":{}}',
  '--setting-sources',
  '',
  '--settings',
  '{"disableAllHooks":true}',
];

/** Non-secret env every bound claude child receives. */
export const CLAUDE_TENANT_ISOLATION_ENV: Readonly<Record<string, string>> = {
  DISABLE_AUTOUPDATER: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
};

/** The single secret env var each credential kind passes to the child. */
export const CLAUDE_CREDENTIAL_KIND_ENV_KEY: Readonly<Record<TaskCredentialKind, string>> = {
  api_key: 'ANTHROPIC_API_KEY',
  subscription_token: 'CLAUDE_CODE_OAUTH_TOKEN',
};

/** Every claude credential-bearing env var; all but the kind's own key are dropped. */
const CLAUDE_CREDENTIAL_ENV_KEYS: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
];

const denied = (detail: string): Error =>
  new Error(`[CREDENTIAL_PROVIDER_DENIED] ${detail} — the bound claude CLI is not started`);

function isCredentialKind(value: unknown): value is TaskCredentialKind {
  return value === 'api_key' || value === 'subscription_token';
}

/**
 * The credential kind of the current bound claude launch, or null for an
 * operator (unbound) run. Throws `[CREDENTIAL_PROVIDER_DENIED]` when a binding
 * is present but declares no kind or lacks the kind's secret, and for personal
 * claims (which admit no provider environment).
 */
export function resolveClaudeBoundCredentialKind(): TaskCredentialKind | null {
  if (!hasTaskCredentialBinding()) return null;
  if (credentialExecutionIdentity().personalClaim)
    throw denied('Personal claims admit no claude provider environment');
  const kind = resolveTaskCredentialKind();
  if (!isCredentialKind(kind)) throw denied('No claude credential kind is bound');
  if (!boundClaudeSecret(kind)) throw denied(`The bound ${kind} credential is missing`);
  return kind;
}

/**
 * Argv for a bound launch: `args` plus the isolation flags (not repeated when
 * the caller already closed the surface, as the prompted-tools path does)
 * and `--bare` for API keys.
 */
export function withClaudeTenantIsolationArgs(
  args: readonly string[],
  kind: TaskCredentialKind
): string[] {
  const out = [...args];
  const isolation = CLAUDE_TENANT_ISOLATION_ARGS;
  const alreadyClosed = out.some((_, index) =>
    isolation.every((token, offset) => out[index + offset] === token)
  );
  if (!alreadyClosed) out.push(...isolation);
  for (const flag of claudeCredentialKindArgs(kind)) if (!out.includes(flag)) out.push(flag);
  return out;
}

/** Kind-specific flags: `--bare` (no Keychain/OAuth) for API keys; none for tokens it would ignore. */
export function claudeCredentialKindArgs(kind: TaskCredentialKind): string[] {
  return kind === 'api_key' ? ['--bare'] : [];
}

/**
 * The non-allowlist part of a bound claude child env: isolation flags, HOME,
 * CLAUDE_CONFIG_DIR and — only when given — the kind's single credential.
 * Shared by the bound spawn and the `claude-tenant-isolation` doctor canary.
 */
export function claudeIsolatedLaunchEnv(input: {
  home: string;
  configDir: string;
  kind: TaskCredentialKind;
  secret?: string;
}): Record<string, string> {
  return {
    ...CLAUDE_TENANT_ISOLATION_ENV,
    HOME: input.home,
    CLAUDE_CONFIG_DIR: input.configDir,
    ...(input.secret ? { [CLAUDE_CREDENTIAL_KIND_ENV_KEY[input.kind]]: input.secret } : {}),
  };
}

/**
 * Overlay the bound claude credential onto an already-allowlisted child env
 * built from the bound provider environment `bound`. `operatorPath` fills
 * PATH only when the bound environment carries none (PATH is not a
 * credential; the CLI needs it to start).
 */
export function applyClaudeTenantIsolationEnv(
  env: Record<string, string>,
  bound: NodeJS.ProcessEnv,
  operatorPath: string | undefined
): Record<string, string> {
  const kind = resolveClaudeBoundCredentialKind();
  if (!kind) throw denied('No trusted binding is installed');
  const home = bound.HOME;
  if (!home || !path.isAbsolute(home)) throw denied('The bound provider HOME is missing');
  const configDir = bound.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const below = path.relative(home, configDir);
  if (
    !path.isAbsolute(configDir) ||
    !below ||
    below === '..' ||
    below.startsWith('..' + path.sep) ||
    path.isAbsolute(below)
  )
    throw denied('CLAUDE_CONFIG_DIR must stay inside the bound HOME');
  for (const key of CLAUDE_CREDENTIAL_ENV_KEYS) delete env[key];
  const secret = boundClaudeSecret(kind);
  if (!secret) throw denied(`The bound ${kind} credential is missing`);
  if (!env.PATH && operatorPath) env.PATH = operatorPath;
  return Object.assign(env, claudeIsolatedLaunchEnv({ home, configDir, kind, secret }));
}

/**
 * The bound secret of a claude launch. A subscription token is not a generic
 * task secret (credential-binding: resolveTaskCredential never returns it);
 * only this spawn path reads it, through its dedicated accessor.
 */
function boundClaudeSecret(kind: TaskCredentialKind): string | null | undefined {
  return kind === 'subscription_token'
    ? resolveTaskClaudeSubscriptionToken()
    : resolveTaskCredential(CLAUDE_CREDENTIAL_KIND_ENV_KEY[kind]);
}

/**
 * Secret values captured when a bound child was launched (review S5): output
 * redaction must keep masking them for the child's whole lifetime, even after
 * a mid-run revocation makes the binding refuse to resolve them again.
 * Released by the launch's dispose().
 */
const launchRedactions = new Map<string, readonly string[]>();

/** Values to redact from bound claude output. Never throws. */
export function boundClaudeCredentialValues(): string[] {
  const values = new Set<string>();
  for (const captured of launchRedactions.values()) for (const value of captured) values.add(value);
  try {
    if (hasTaskCredentialBinding()) {
      const kind = resolveTaskCredentialKind();
      const value = isCredentialKind(kind) ? boundClaudeSecret(kind) : undefined;
      if (typeof value === 'string' && value.length > 8) values.add(value);
    }
  } catch {
    // A binding that no longer validates still has its launch-time capture above.
  }
  return [...values];
}

export interface ClaudeTenantWorkspace {
  readonly cwd: string;
  dispose(): void;
}

/**
 * A fresh, empty working directory on the tenant's scratch floor
 * (`active/shared/tmp/<tier>/<tenant>/claude-cli/<id>`), same tier as the
 * bound provider HOME. The child cannot discover repository settings,
 * hooks or agent instructions from it. Removed on dispose (idempotent); the
 * scratch-floor TTL sweep is the backstop.
 */
export function openClaudeTenantWorkspace(): ClaudeTenantWorkspace {
  const tenant = credentialExecutionIdentity().tenantSlug;
  if (!tenant) throw denied('Runtime tenant is missing');
  const bound = resolveTaskProviderEnvironment('claude');
  const floor = bound?.HOME ? classifyStorageFloorPath(bound.HOME) : null;
  if (
    !floor ||
    floor.partition.kind !== 'tier' ||
    floor.partition.tenant !== tenant ||
    floor.partition.tier === 'public'
  )
    throw denied('The bound provider HOME is not on a private tenant floor');
  const cwd = resolveStorageFloor(
    'scratch',
    { kind: 'tier', tier: floor.partition.tier, tenant },
    'claude-cli',
    randomUUID()
  );
  safeMkdir(cwd, { recursive: true });
  let disposed = false;
  return {
    cwd,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      try {
        safeRmSync(cwd, { recursive: true, force: true });
      } catch {
        // The scratch-floor TTL sweep reclaims a directory a dispose could not remove.
      }
    },
  };
}

export interface ClaudeBoundLaunch {
  readonly kind: TaskCredentialKind;
  readonly args: string[];
  readonly cwd: string;
  dispose(): void;
}

/**
 * Resolve the bound launch for `args`, or null for an operator run (argv
 * unchanged, no cwd). Fails closed before any spawn when the binding cannot
 * supply the kind's credential.
 */
export function prepareClaudeBoundLaunch(args: readonly string[]): ClaudeBoundLaunch | null {
  const kind = resolveClaudeBoundCredentialKind();
  if (!kind) return null;
  const workspace = openClaudeTenantWorkspace();
  const launchId = randomUUID();
  const secret = boundClaudeSecret(kind);
  if (typeof secret === 'string' && secret.length > 8) launchRedactions.set(launchId, [secret]);
  return {
    kind,
    args: withClaudeTenantIsolationArgs(args, kind),
    cwd: workspace.cwd,
    dispose: () => {
      launchRedactions.delete(launchId);
      workspace.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Isolated claude environment (design §3)
// ---------------------------------------------------------------------------

/**
 * Non-secret network plumbing the isolated claude child still needs behind a
 * corporate proxy / custom CA (a bound child gets ONLY its bound env), from the
 * operator's safe exec env: CA bundle paths and proxy routing. A proxy value
 * carrying userinfo (`user:pass@host`, with or without a scheme) is a
 * credential and is never passed.
 */
export const CLAUDE_NETWORK_PASSTHROUGH_ENV_KEYS: readonly string[] = [
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  ...PROXY_ENV_KEYS,
];
export function claudeNetworkPassthroughEnv(
  source: NodeJS.ProcessEnv = buildSafeExecEnv()
): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const key of CLAUDE_NETWORK_PASSTHROUGH_ENV_KEYS) {
    const value = source[key];
    if (typeof value !== 'string' || !value.trim()) continue;
    if (/_proxy$/i.test(key) && /^(?:[a-z][a-z0-9+.-]*:\/\/)?[^/@\s,]*@/iu.test(value.trim()))
      continue;
    picked[key] = value;
  }
  return picked;
}

/** Isolated claude HOME for this borrower and credential; never holds the value. */
export function claudeProviderEnvironment(
  tier: ScopeContext['tier'],
  tenant: string,
  credentialRef: string
): NodeJS.ProcessEnv {
  const home = pathResolver.rootResolve(
    providerAuthHomeRelativePath(tier, tenant, CLAUDE_PROVIDER_ENVIRONMENT, credentialRef)
  );
  const configDir = `${home}/.claude`;
  try {
    safeMkdir(configDir, { recursive: true });
  } catch {
    throw new Error(
      '[CREDENTIAL_HOME_REQUIRED] Could not prepare the isolated claude HOME for this tenant credential'
    );
  }
  return { ...claudeNetworkPassthroughEnv(), HOME: home, CLAUDE_CONFIG_DIR: configDir };
}
