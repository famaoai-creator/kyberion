import { getSubagentCapabilityProfile } from './subagent-capability-profiles.js';

/**
 * Provider-neutral permission projection + child-process env minimization
 * (XP-02, see docs/developer/improvement-plans-2026-07/
 * CROSS_PROVIDER_EXECUTION_PLAN_2026-07-25.ja.md §XP-02).
 *
 * KD-05's capability tiers (`subagent-capability-profiles.ts`) are the
 * provider-neutral source of truth for "what may this delegation do."
 * This module is the single place that projects each tier onto the
 * provider-specific permission mechanism each CLI actually understands
 * (claude = tool allow/deny + permission-mode flags, codex = sandbox mode,
 * agy = sandbox flag) — so "explorer is read-only" is a structural
 * guarantee instead of something every backend has to remember to encode
 * on its own.
 *
 * Registration ceremony: to declare a profile × provider permission
 * mapping, add ONE entry to {@link PROVIDER_PERMISSION_MATRIX} below.
 * Undefined combinations fail closed: {@link resolveProviderPermissionArgs}
 * returns a typed {@link ProviderPermissionRefusal} rather than throwing or
 * silently granting full access.
 *
 * Scope note: this module is the declarative SSoT for the mapping and is
 * consumed by {@link buildProviderChildEnv} for env minimization, and (XP-02
 * follow-up) by shell-claude-cli-backend.ts / codex-cli-query.ts /
 * agy-cli-backend.ts, each of which accepts an optional KD-05 profile on
 * its invocation path and calls `resolveProviderPermissionArgs` to project
 * it onto that provider's CLI argv (e.g. agy's previously-unconditional
 * `--dangerously-skip-permissions` is now only used when no profile is
 * given — see each backend's `resolvePermissionArgs` helper).
 */

export type ProviderId = 'claude' | 'codex' | 'agy';

export const PROVIDER_IDS: readonly ProviderId[] = ['claude', 'codex', 'agy'] as const;

/** KD-05 tier names this module has a permission projection for. */
export type ProviderPermissionProfileName = 'implementer' | 'explorer' | 'planner';

export interface ProviderPermissionGrant {
  readonly kind: 'ok';
  /**
   * CLI args to add for this (profile, provider) pair. Declarative —
   * see the "Scope note" above for wiring status per backend.
   */
  readonly args: readonly string[];
  readonly notes?: string;
}

export interface ProviderPermissionRefusal {
  readonly kind: 'refused';
  readonly reason: string;
}

export type ProviderPermissionResolution = ProviderPermissionGrant | ProviderPermissionRefusal;

function ok(args: readonly string[], notes?: string): ProviderPermissionGrant {
  return notes !== undefined ? { kind: 'ok', args, notes } : { kind: 'ok', args };
}

function refused(reason: string): ProviderPermissionRefusal {
  return { kind: 'refused', reason };
}

/** Claude CLI tools a read-only delegation may use (mirrors explorer's file:read* + network:fetch allowlist). */
const CLAUDE_READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'WebFetch'] as const;
/** Claude CLI tools that mutate state or execute — never granted below `implementer`. */
const CLAUDE_WRITE_EXEC_TOOLS = ['Write', 'Edit', 'NotebookEdit', 'Bash', 'KillShell'] as const;

/**
 * Single-module mapping table: KD-05 profile × provider → provider
 * permission projection. Every cell is either an explicit grant or an
 * explicit refusal — there is no implicit "undefined means allow."
 */
export const PROVIDER_PERMISSION_MATRIX: Readonly<
  Record<ProviderPermissionProfileName, Readonly<Record<ProviderId, ProviderPermissionResolution>>>
> = {
  implementer: {
    claude: ok(
      ['--permission-mode', 'bypassPermissions'],
      'Full read/write/exec tier: no tool restriction beyond what the CLI session already grants.'
    ),
    codex: ok(
      ['--sandbox', 'workspace-write'],
      'Full read/write tier within the workspace sandbox.'
    ),
    agy: ok(
      ['--sandbox'],
      'agy always runs sandboxed; implementer gets the full sandboxed tool set.'
    ),
  },
  explorer: {
    claude: ok(
      [
        '--permission-mode',
        'default',
        '--allowedTools',
        ...CLAUDE_READ_ONLY_TOOLS,
        '--disallowedTools',
        ...CLAUDE_WRITE_EXEC_TOOLS,
      ],
      'Read-only: only Read/Glob/Grep/WebFetch allowed, Write/Edit/NotebookEdit/Bash/KillShell explicitly denied.'
    ),
    codex: ok(
      ['--sandbox', 'read-only'],
      'codex read-only sandbox forbids filesystem writes for the duration of the delegation.'
    ),
    agy: ok(
      ['--sandbox'],
      'agy sandbox flag is the closest read-only-leaning primitive this CLI exposes.'
    ),
  },
  planner: {
    claude: ok(
      ['--permission-mode', 'plan'],
      'plan mode produces a plan without executing any tool — matches "no tool execution at all."'
    ),
    codex: refused(
      'codex CLI has no text-only / no-exec headless mode: even --sandbox read-only still lets the ' +
        "model run shell commands, which would violate the planner tier's no-exec invariant. Refusing " +
        'delegation rather than granting an under-restricted approximation.'
    ),
    agy: refused(
      'agy CLI headless invocations always pass --dangerously-skip-permissions and have no verified ' +
        'no-exec mode. Refusing delegation rather than granting an under-restricted approximation.'
    ),
  },
} as const;

/**
 * Resolve the provider-specific permission projection for a KD-05 tier.
 *
 * Throws only if `profileName` is not a registered KD-05 tier at all (a
 * caller bug, delegated to {@link getSubagentCapabilityProfile}'s existing
 * error). A *known* tier with no defined mapping for `provider` — or one
 * this module explicitly refuses (see `planner` × codex/agy above) — never
 * throws; it returns a typed {@link ProviderPermissionRefusal} so callers
 * can surface a clean "delegation refused" outcome instead of crashing.
 */
export function resolveProviderPermissionArgs(
  profileName: string,
  provider: ProviderId
): ProviderPermissionResolution {
  // Validates the tier exists at all; throws SUBAGENT_PROFILE_UNKNOWN otherwise.
  const profile = getSubagentCapabilityProfile(profileName);
  const row = (PROVIDER_PERMISSION_MATRIX as Record<string, unknown>)[profile.name] as
    | Readonly<Record<ProviderId, ProviderPermissionResolution>>
    | undefined;
  if (!row) {
    return refused(
      `No provider permission mapping is registered for KD-05 tier "${profile.name}". ` +
        'Fail-closed: refusing delegation until a mapping is added to PROVIDER_PERMISSION_MATRIX.'
    );
  }
  const resolution = row[provider];
  if (!resolution) {
    return refused(
      `No provider permission mapping is registered for tier "${profile.name}" × provider "${provider}". ` +
        'Fail-closed: refusing delegation until a mapping is added to PROVIDER_PERMISSION_MATRIX.'
    );
  }
  return resolution;
}

// --------------------------------------------------------------------------
// Child-process env minimization (HA-04 type, generalized across providers)
// --------------------------------------------------------------------------

/**
 * Env vars every provider CLI child process may see regardless of provider.
 * Mirrors secure-io.ts's SAFE_EXEC_ENV_ALLOWLIST base (PATH/HOME/locale/
 * shell/tmp/proxy plumbing) — duplicated here rather than imported because
 * that list is private to secure-io.ts and this module's allowlist is
 * provider-keyed, not a generic exec allowlist.
 */
const ALWAYS_ALLOWED_ENV_KEYS: readonly string[] = [
  'PATH',
  'HOME',
  'LANG',
  'TERM',
  'LC_ALL',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'PWD',
  'SHLVL',
  'NODE_ENV',
  // Proxy/TLS plumbing: without these, CLIs running behind a corporate
  // proxy or custom CA cannot reach their provider API at all — this is
  // the same load-bearing set secure-io.ts's buildSafeExecEnv carries.
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
];

/**
 * Non-credential, provider-specific config vars that are always safe to
 * pass through when present (e.g. codex's config-directory override).
 */
const PROVIDER_REQUIRED_ENV_KEYS: Readonly<Record<ProviderId, readonly string[]>> = {
  claude: [],
  codex: ['CODEX_HOME'],
  agy: [],
};

/**
 * Each provider's OWN credential env var(s) — the only `*_API_KEY` /
 * `*_TOKEN`-shaped vars that provider's child process may receive.
 */
const PROVIDER_CREDENTIAL_ENV_KEYS: Readonly<Record<ProviderId, readonly string[]>> = {
  claude: ['ANTHROPIC_API_KEY'],
  codex: ['OPENAI_API_KEY'],
  agy: [],
};

/** Kyberion's own config vars — always needed by a child kyberion-aware process. */
const KYBERION_PREFIX = 'KYBERION_';
const ADDITIONAL_KYBERION_STYLE_KEYS = ['MISSION_ID', 'MISSION_ROLE'] as const;

/** Matches `*_API_KEY` / `*_TOKEN`-shaped credential env vars (case-insensitive). */
const CREDENTIAL_ENV_PATTERN = /(?:^|_)(API_KEY|TOKEN)$/i;

export const PROVIDER_ENV_ALLOWLIST_ESCAPE_HATCH_VAR = 'KYBERION_PROVIDER_ENV_ALLOWLIST';

function isProviderEnvAllowlistDisabled(env: NodeJS.ProcessEnv): boolean {
  return env[PROVIDER_ENV_ALLOWLIST_ESCAPE_HATCH_VAR] === '0';
}

export interface BuildProviderChildEnvInput {
  readonly provider: ProviderId;
  /** Defaults to `process.env`. */
  readonly baseEnv?: NodeJS.ProcessEnv;
}

/**
 * Build a minimal, allowlisted env for spawning `provider`'s CLI.
 *
 * Always includes PATH/HOME/LANG/TERM (+ the rest of
 * {@link ALWAYS_ALLOWED_ENV_KEYS}) and any KYBERION_* / MISSION_* vars a
 * child kyberion-aware process needs, plus that provider's own declared
 * required + credential vars. Any OTHER provider's credential-shaped var
 * (`*_API_KEY` / `*_TOKEN`) is dropped even if it happens to also be
 * present under an allowlisted-looking name — this is the
 * cross-provider-leak fix XP-02 calls for.
 *
 * Escape hatch: set `KYBERION_PROVIDER_ENV_ALLOWLIST=0` on `baseEnv` to
 * return `baseEnv` unchanged (full inheritance), default is allowlisting ON.
 */
export function buildProviderChildEnv({
  provider,
  baseEnv = process.env,
}: BuildProviderChildEnvInput): NodeJS.ProcessEnv {
  if (isProviderEnvAllowlistDisabled(baseEnv)) {
    return { ...baseEnv };
  }

  const allowedBaseKeys = new Set<string>([
    ...ALWAYS_ALLOWED_ENV_KEYS,
    ...PROVIDER_REQUIRED_ENV_KEYS[provider],
  ]);
  const ownCredentialKeys = new Set<string>(PROVIDER_CREDENTIAL_ENV_KEYS[provider]);

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;

    if (CREDENTIAL_ENV_PATTERN.test(key)) {
      // Deny-list: only this provider's own declared credential vars may
      // pass through, regardless of what else matches below.
      if (ownCredentialKeys.has(key)) {
        result[key] = value;
      }
      continue;
    }

    const isKyberionStyleKey =
      key.startsWith(KYBERION_PREFIX) ||
      (ADDITIONAL_KYBERION_STYLE_KEYS as readonly string[]).includes(key);

    if (allowedBaseKeys.has(key) || isKyberionStyleKey) {
      result[key] = value;
    }
  }

  return result as NodeJS.ProcessEnv;
}
