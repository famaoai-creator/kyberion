import { getSubagentCapabilityProfile } from './subagent-capability-profiles.js';
import {
  getActiveSandboxPolicy,
  requireSandboxEnforcement,
  resolveSandboxPolicy,
  type SandboxPolicy,
} from './sandbox-policy.js';

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
 * agy = sandbox flag, grok = permission-mode / always-approve) — so
 * "explorer is read-only" is a structural guarantee instead of something
 * every backend has to remember to encode on its own.
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
 * agy-cli-backend.ts / shell-grok-cli-backend.ts, each of which accepts an
 * optional KD-05 profile on its invocation path and calls
 * `resolveProviderPermissionArgs` to project it onto that provider's CLI
 * argv (e.g. agy's previously-unconditional
 * `--dangerously-skip-permissions` is now only used when no profile is
 * given — see each backend's `resolvePermissionArgs` helper).
 */

export type ProviderId = 'claude' | 'codex' | 'agy' | 'grok' | 'gemini' | 'cursor' | 'opencode';

export const PROVIDER_IDS: readonly ProviderId[] = [
  'claude',
  'codex',
  'agy',
  'grok',
  'gemini',
  'cursor',
  'opencode',
] as const;

/**
 * Project the ambient provider-neutral sandbox into one of the existing
 * provider permission profiles. The ambient policy is authoritative when a
 * reasoning call runs inside `withSandboxPolicy`; an explicit profile may
 * narrow the call further, but can never widen a read-only policy.
 *
 * Providers are resolved again when the ambient policy was created for a
 * different provider (for example, after failover). This keeps the requested
 * mode while re-evaluating whether the new provider can enforce it.
 */
export function resolveEffectiveProviderPermissionProfile(
  provider: ProviderId,
  requested?: ProviderPermissionProfileName
): ProviderPermissionProfileName | undefined {
  const active = getActiveSandboxPolicy();
  if (!active) return requested;

  const policy: SandboxPolicy =
    active.provider === provider
      ? active
      : resolveSandboxPolicy({
          provider,
          mode: active.mode,
          networkAccess: active.networkAccess,
          ...(active.writableRoots ? { writableRoots: active.writableRoots } : {}),
        });
  requireSandboxEnforcement(policy);

  if (policy.mode === 'read-only') {
    // Planner is stricter than explorer and must remain planner. Otherwise
    // force the read-only projection even when the caller omitted a profile
    // or requested implementer.
    return requested === 'planner' ? 'planner' : 'explorer';
  }
  if (policy.mode === 'workspace-write') return requested ?? 'implementer';
  // `requireSandboxEnforcement` rejects danger-full-access above. Keep an
  // explicit branch so future modes cannot silently widen access.
  throw new Error(`[SANDBOX_POLICY_PARTIAL] unsupported sandbox mode: ${policy.mode}`);
}

/** Resolve the active policy directly to provider argv, or return undefined
 * when no ambient policy is installed so legacy callers remain byte-stable. */
export function resolveActiveProviderPermissionArgs(
  provider: ProviderId
): readonly string[] | undefined {
  const profile = resolveEffectiveProviderPermissionProfile(provider);
  if (!profile) return undefined;
  const resolution = resolveProviderPermissionArgs(profile, provider);
  if (resolution.kind === 'refused') {
    throw new Error(
      `[${provider}-adapter] permission profile "${profile}" refused: ${resolution.reason}`
    );
  }
  return resolution.args;
}

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
    grok: ok(
      ['--permission-mode', 'bypassPermissions'],
      'Grok Build full auto-approve path for implementer-tier write/exec work.'
    ),
    gemini: ok(
      ['--sandbox', '--approval-mode', 'yolo'],
      'Gemini CLI yolo mode remains inside its provider sandbox for workspace-write work.'
    ),
    cursor: ok(
      ['--force', '--sandbox', 'enabled'],
      'Cursor Agent CLI force-allows tools inside its sandbox for implementer-tier write/exec work.'
    ),
    opencode: ok(
      ['--agent', 'build'],
      'OpenCode CLI implementer tier runs on the build agent with the full tool set.'
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
    grok: ok(
      [
        '--permission-mode',
        'default',
        '--disallowed-tools',
        'run_terminal_command,write,search_replace',
      ],
      'Read-leaning: deny shell/write tools; remaining read/search tools stay available under default permission mode.'
    ),
    gemini: ok(
      ['--sandbox', '--approval-mode', 'plan'],
      'Gemini CLI plan mode is the provider read-only projection.'
    ),
    cursor: ok(['--mode', 'plan'], 'Cursor Agent plan mode is read-only planning without edits.'),
    opencode: ok(
      ['--agent', 'plan'],
      'OpenCode CLI explorer tier runs on the read-only-leaning plan agent.'
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
    grok: ok(
      ['--permission-mode', 'plan'],
      'Grok Build plan mode produces a plan without executing tools.'
    ),
    gemini: ok(
      ['--sandbox', '--approval-mode', 'plan'],
      'Gemini CLI plan mode is the provider no-write projection.'
    ),
    cursor: ok(
      ['--mode', 'ask'],
      'Cursor Agent ask mode is Q&A-only and does not execute mutating tools.'
    ),
    opencode: ok(
      ['--agent', 'plan'],
      'OpenCode CLI planner tier runs on the plan agent without --auto approval.'
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
    Readonly<Record<ProviderId, ProviderPermissionResolution>> | undefined;
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
  // DH-11: an advertised CLI flag is not enough to claim a full sandbox.
  // agy has no verified read-only filesystem mode, so its explorer mapping
  // must refuse rather than silently presenting a partial policy as safe.
  if (profile.name === 'explorer' && provider === 'agy' && resolution.kind === 'ok') {
    const policy = resolveSandboxPolicy({ provider: 'agy', mode: 'read-only' });
    if (policy.enforcement !== 'full') {
      return refused(
        `Provider "agy" cannot satisfy the explorer read-only sandbox contract: ${policy.enforcement_reason}`
      );
    }
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
  // OAuth session for Grok Build typically lives under ~/.grok; no extra config
  // home override is required for headless -p invocations.
  grok: [],
  gemini: [],
  cursor: [],
  // OpenCode authenticates via its own login session (opencode auth login);
  // no extra config home override is required for headless run invocations.
  opencode: [],
};

/**
 * Each provider's OWN credential env var(s) — the only `*_API_KEY` /
 * `*_TOKEN`-shaped vars that provider's child process may receive.
 */
const PROVIDER_CREDENTIAL_ENV_KEYS: Readonly<Record<ProviderId, readonly string[]>> = {
  claude: ['ANTHROPIC_API_KEY'],
  codex: ['OPENAI_API_KEY'],
  agy: [],
  // Grok Build primarily uses OAuth via `grok login`; optional direct API key
  // still allowed through when present.
  grok: ['XAI_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  cursor: ['CURSOR_API_KEY'],
  // OpenCode primarily uses its login session; no provider API key passes through.
  opencode: [],
};

/**
 * Kyberion's own config vars — always needed by a child kyberion-aware
 * process. Deliberately EXCLUDES `MISSION_ROLE` / `SYSTEM_ROLE` (SO-03):
 * those are authority signals `resolveRole()` (authority.ts) reads to
 * decide whether the CURRENT process is the mission owner/orchestrator
 * (see orchestrator-session.ts's fail-closed gate). If the calling process
 * is itself running under `MISSION_ROLE=mission_controller` (e.g. inside a
 * surface OrchestratorSession's execution context) and that value passed
 * through unchanged to a spawned provider CLI delegation, the delegation's
 * own in-process code (or anything it shells back out to) would inherit
 * mission-owner authority it was never granted — the exact leak the
 * multi-provider co-execution contract's "owner authority is never
 * projected into worker delegations" invariant forbids. A delegation that
 * legitimately needs a role tag must have one assigned to it explicitly on
 * its own path, never inherited from its parent's env.
 */
const KYBERION_PREFIX = 'KYBERION_';
const ADDITIONAL_KYBERION_STYLE_KEYS = ['MISSION_ID'] as const;

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
