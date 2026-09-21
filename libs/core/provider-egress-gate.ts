/**
 * Provider Egress Gate — XP-03 (tier x egress gate on the delegation face)
 *
 * §2 constraint 4 of CROSS_PROVIDER_EXECUTION_PLAN_2026-07-25.ja.md: every
 * provider declaration carries an egress label (`external-api` /
 * `local-only`), and the provisioning entry point must cross-check that
 * label against the highest data tier in what is about to be handed to that
 * provider. A mismatch is refused *before* delegation, with a reason.
 *
 * This is a different axis from the two existing egress controls in this
 * repo, not a replacement for either:
 * - `egress-policy.ts` (SA-04) gates *network requests to a URL* by
 *   tenant-approved domain.
 * - `reasoning-egress-scope.ts` gates *reasoning-backend HTTP sends* by the
 *   backend's declared vendor endpoint, via an ambient AsyncLocalStorage
 *   scope that wraps a whole call.
 * Neither knows about *provider identity* as a first-class thing (a
 * provider CLI is not a URL, and the ambient scope is opt-in per call, not
 * anchored at the shared knowledge-provisioning entry point). This module
 * adds that: `checkProviderEgress({ provider, dataTier })` is a synchronous,
 * explicit check callers invoke at the exact point they are
 * about to attach tiered material to a delegation (KP-01's
 * `provisionTaskKnowledge`, and the two KP-02 lower-level call sites).
 *
 * Policy: `knowledge/product/governance/provider-egress-policy.json`,
 * schema-validated against
 * `knowledge/product/schemas/provider-egress-policy.schema.json`. Default
 * posture (also the fail-closed posture when the policy file is missing or
 * invalid):
 * - `public` — every provider allowed. This is NOT overridable by the
 *   policy file and does not require the file to exist or be valid — a
 *   broken/missing policy must never block ordinary public-tier work.
 * - `confidential` and `personal` — external providers must be declared
 *   `training_use: none`, or be covered by a tenant attestation for the
 *   purchased plan. `approved_providers` remains an explicit operator
 *   exception. Local-only providers are always safe for these tiers.
 *
 * See docs/developer/improvement-plans-2026-07/
 * CROSS_PROVIDER_EXECUTION_PLAN_2026-07-25.ja.md §XP-03.
 */
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync } from './secure-io.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { detectTier, TIERS } from './tier-guard.js';
import type { TierLevel } from './types.js';
import { sendOpsAlert } from './ops-alert.js';
import { createLogger } from './logger.js';
import { resolveTenant } from './tenant-registry.js';
import { resolveIdentityContext, withExecutionContext } from './authority.js';
import { getRegisteredEnvText } from './foundation/env.js';

const logger = createLogger('provider-egress-gate');

export type ProviderEgressLabel = 'external-api' | 'local-only';

/**
 * Whether the vendor trains on material sent to this provider.
 *
 * This is the property the tier rule is actually about: material above
 * confidential never leaves the machine, and confidential may leave it only
 * for a provider that does not train on it. `unknown` is treated as `used` —
 * an undeclared provider fails closed rather than being assumed benign.
 */
export type ProviderTrainingUse = 'none' | 'used' | 'unknown';

export interface ProviderEgressPolicyFile {
  version: string;
  /** Default lifetime of a tenant provider attestation, in days. */
  attestation_ttl_days?: number;
  providers: Record<
    string,
    {
      egress: ProviderEgressLabel;
      training_use?: ProviderTrainingUse;
      plan?: string;
      basis?: string;
      /** Hosts this provider sends payloads to; empty for local-only. */
      endpoint_domains?: string[];
    }
  >;
  tier_policy: {
    confidential: { mode: 'approved-only'; approved_providers: string[] };
    personal: { mode: 'local-only-or-approved'; approved_providers: string[] };
  };
}

const DEFAULT_POLICY_PATH = pathResolver.knowledge(
  'product/governance/provider-egress-policy.json'
);
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/provider-egress-policy.schema.json');

type PolicyLoadResult =
  | { status: 'ok'; policy: ProviderEgressPolicyFile }
  | { status: 'missing' }
  | { status: 'invalid'; reason: string };

let cachedPolicyPath: string | null = null;
let cachedResult: PolicyLoadResult | null = null;

function policyPath(): string {
  const configured =
    getRegisteredEnvText('KYBERION_PROVIDER_EGRESS_POLICY_PATH')?.trim() || DEFAULT_POLICY_PATH;
  return assertSafeRepositoryPath(configured, { allowMissingLeaf: true });
}

const policyCatalog = defineCatalog<ProviderEgressPolicyFile>({
  id: 'provider-egress-policy',
  path: policyPath,
  schema: SCHEMA_PATH,
});

/** Test-only: force the next `loadProviderEgressPolicy` to re-read + re-validate. */
export function _resetProviderEgressPolicyCacheForTests(): void {
  cachedPolicyPath = null;
  cachedResult = null;
  policyCatalog.reset();
}

/**
 * Load + schema-validate the policy file, caching the result per path (like
 * `loadEgressPolicy` in egress-policy.ts). Never throws: a missing or
 * malformed file is reported as `{status: 'missing' | 'invalid'}` so
 * `checkProviderEgress` can fail closed for confidential/personal without
 * crashing the caller.
 */
export function loadProviderEgressPolicy(): PolicyLoadResult {
  let filePath: string;
  try {
    filePath = policyPath();
  } catch (error) {
    cachedPolicyPath = null;
    cachedResult = {
      status: 'invalid',
      reason: error instanceof Error ? error.message : String(error),
    };
    return cachedResult;
  }
  if (cachedResult && cachedPolicyPath === filePath) return cachedResult;
  cachedPolicyPath = filePath;

  if (!safeExistsSync(filePath)) {
    cachedResult = { status: 'missing' };
    return cachedResult;
  }
  try {
    cachedResult = { status: 'ok', policy: policyCatalog.load() };
    return cachedResult;
  } catch (err) {
    cachedResult = {
      status: 'invalid',
      reason: err instanceof Error ? err.message : String(err),
    };
    return cachedResult;
  }
}

/**
 * Hosts a provider sends payloads to, as declared next to the provider.
 *
 * The network gate (egress-policy.ts) approves tenants by provider id and
 * resolves the hosts here, so a provider's domains are written once, with
 * the provider, rather than copied into every tenant's allowlist. An unknown
 * provider or an unreadable policy resolves to no hosts — which the network
 * gate treats as nothing approved.
 */
export function providerEndpointDomains(provider: string): string[] {
  const loaded = loadProviderEgressPolicy();
  if (loaded.status !== 'ok') return [];
  const declaration = loaded.policy.providers[String(provider || '').trim()];
  return Array.isArray(declaration?.endpoint_domains) ? [...declaration.endpoint_domains] : [];
}

export interface ProviderEgressCheckInput {
  /** Provider id, e.g. 'claude' | 'codex' | 'agy' | 'gemini' | 'copilot'. */
  provider: string;
  /** Highest data tier represented in the payload about to be handed to `provider`. */
  dataTier: TierLevel;
  /**
   * Tenant profile upper bound; it can only narrow global policy. When an
   * active identity already has a tenant scope, this value must match it.
   */
  tenant_slug?: string;
  /** Alternate repository root used by hermetic tenant registries. */
  tenant_registry_root_dir?: string;
}

/**
 * Deliberately a single shape (`reason` optional) rather than a
 * `{allowed:true}|{allowed:false,reason}` discriminated union: this repo's
 * root `tsconfig.json` runs with `strictNullChecks: false`, under which TS's
 * control-flow narrowing on a boolean-literal discriminant does not apply
 * (confirmed empirically; `tier-guard.ts`'s analogous `allowed`-shaped
 * results use the same single-shape convention for the same reason).
 */
export interface ProviderEgressCheckResult {
  allowed: boolean;
  reason?: string;
}

const DENY_PREFIX = '[PROVIDER_EGRESS_DENIED]';

function denyAndAlert(
  input: ProviderEgressCheckInput,
  reason: string
): { allowed: false; reason: string } {
  const fullReason = `${DENY_PREFIX} ${reason}`;
  logger.warn(
    `blocked ${input.dataTier} material from reaching provider='${input.provider || '(unknown)'}': ${reason}`
  );
  try {
    sendOpsAlert({
      severity: 'warning',
      title: `Provider egress denied: ${input.provider || '(unknown)'} / ${input.dataTier}`,
      context: { provider: input.provider, data_tier: input.dataTier },
      recommendation:
        'If this provider should receive this tier, add it to provider-egress-policy.json' +
        ' (tier_policy.<tier>.approved_providers), record a tenant provider attestation with ' +
        "'pnpm tenant attest-provider', or mark it 'local-only' if it truly never leaves this machine.",
      dedupe_key: `provider-egress-denied:${input.provider || 'unknown'}:${input.dataTier}`,
    });
  } catch (err) {
    // Ops-alert delivery must never turn an already-denied check into a thrown error.
    logger.warn(
      `ops-alert emission failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return { allowed: false, reason: fullReason };
}

/**
 * Tier x egress gate. Pure with respect to control flow (never throws);
 * emits a log line + ops-alert on every denial as a side effect so denials
 * are observable without every call site re-implementing that (XP-03
 * acceptance criterion 3).
 */
export type TenantProviderAttestationStatus = 'valid' | 'expired' | 'absent';

export interface ResolvedTenantProviderAttestation {
  status: TenantProviderAttestationStatus;
  training_use: 'none' | 'used' | 'unknown';
  expires_at?: string;
}

type TenantPolicyInput = Pick<
  ReturnType<typeof resolveTenant>['profile'],
  'allowed_reasoning_backends' | 'provider_attestations'
>;

/** Default lifetime of an attestation when the policy declares none. */
export const DEFAULT_ATTESTATION_TTL_DAYS = 180;

/**
 * Resolve a tenant's provider attestation, honouring its expiry.
 *
 * An attestation is a statement about a purchased plan, and plans get
 * downgraded, migrated and re-negotiated without anyone touching this
 * repository. A claim nobody re-verifies is not evidence, so it expires and
 * the gate falls back to `unknown` — which fails closed.
 */
export function resolveTenantProviderAttestation(input: {
  profile?: {
    provider_attestations?: Record<
      string,
      {
        training_use: 'none' | 'used' | 'unknown';
        attested_at: string;
        expires_at?: string;
      }
    >;
  };
  provider: string;
  ttlDays?: number;
  now?: Date;
}): ResolvedTenantProviderAttestation {
  const attestation = input.profile?.provider_attestations?.[input.provider];
  if (!attestation) return { status: 'absent', training_use: 'unknown' };

  const now = input.now ?? new Date();
  const ttlDays =
    typeof input.ttlDays === 'number' && input.ttlDays > 0
      ? input.ttlDays
      : DEFAULT_ATTESTATION_TTL_DAYS;
  let expiresAt: Date | null = null;
  if (attestation.expires_at) {
    const parsed = new Date(attestation.expires_at);
    if (Number.isNaN(parsed.getTime())) {
      // An explicit expiry that cannot be parsed is not evidence. Do not
      // silently replace it with the default TTL and extend a malformed claim.
      return { status: 'expired', training_use: 'unknown' };
    }
    expiresAt = parsed;
  }
  if (!expiresAt) {
    const attestedAt = new Date(attestation.attested_at);
    if (Number.isNaN(attestedAt.getTime())) {
      // An attestation we cannot date cannot be trusted to still hold.
      return { status: 'expired', training_use: 'unknown' };
    }
    expiresAt = new Date(attestedAt.getTime() + ttlDays * 24 * 60 * 60 * 1000);
  }
  if (expiresAt.getTime() <= now.getTime()) {
    return { status: 'expired', training_use: 'unknown', expires_at: expiresAt.toISOString() };
  }
  return {
    status: 'valid',
    training_use: attestation.training_use,
    expires_at: expiresAt.toISOString(),
  };
}

/**
 * Read a tenant profile as policy input to this gate.
 *
 * Tenant profiles are durable authority and live on the personal tier, which
 * an ordinary worker persona cannot read. Without this the gate would fail to
 * resolve the tenant on every tenant-scoped call and deny it — safe, but it
 * also means the tenant's `allowed_reasoning_backends` and its provider
 * attestations would never be consulted at runtime, which makes both inert.
 *
 * The elevation is narrow on purpose: it covers one synchronous read, the
 * gate extracts only what it needs to decide, and it returns allow/deny to
 * the caller — never the profile. `mission_controller` is the narrowest
 * existing authority role with `knowledge/personal/` read access; its
 * governed writes do not include the tenant profile directory, so this read
 * cannot modify the attestation.
 */
function readTenantProfileAsPolicyInput(
  slug: string,
  provider: string,
  rootDir?: string
): TenantPolicyInput {
  const profile = withExecutionContext(
    'mission_controller',
    () => resolveTenant(slug, { ...(rootDir ? { rootDir } : {}) }),
    undefined,
    slug
  ).profile;
  // Keep the policy seam narrow: the gate needs the tenant allowlist and the
  // one provider's attestation, not a capability to hand the whole profile to
  // a caller or downstream reasoning path.
  return {
    ...(profile.allowed_reasoning_backends
      ? { allowed_reasoning_backends: [...profile.allowed_reasoning_backends] }
      : {}),
    ...(profile.provider_attestations?.[provider]
      ? { provider_attestations: { [provider]: profile.provider_attestations[provider] } }
      : {}),
  };
}

export function checkProviderEgress(input: ProviderEgressCheckInput): ProviderEgressCheckResult {
  const provider = String(input.provider || '').trim();
  const dataTier = input.dataTier;

  // Public always fails open, independent of policy file health — a broken
  // or absent policy must never block ordinary public-tier work.
  if (dataTier === 'public') return { allowed: true };

  if (!provider) {
    return denyAndAlert(input, `no provider identified for a ${dataTier} payload; fail-closed.`);
  }

  const requestedTenantSlug = input.tenant_slug?.trim();
  let activeTenantSlug: string | undefined;
  try {
    activeTenantSlug = resolveIdentityContext().tenantSlug?.trim();
  } catch (error) {
    return denyAndAlert(
      input,
      `active tenant scope could not be resolved: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (requestedTenantSlug && activeTenantSlug && requestedTenantSlug !== activeTenantSlug) {
    return denyAndAlert(
      input,
      `tenant '${requestedTenantSlug}' conflicts with the active tenant scope '${activeTenantSlug}'.`
    );
  }
  const tenantSlug = requestedTenantSlug || activeTenantSlug;
  let tenantPolicyInput: TenantPolicyInput | undefined;
  if (tenantSlug) {
    try {
      const policyInput = readTenantProfileAsPolicyInput(
        tenantSlug,
        provider,
        input.tenant_registry_root_dir
      );
      tenantPolicyInput = policyInput;
      const allowed = policyInput.allowed_reasoning_backends;
      if (allowed?.length && !allowed.includes(provider)) {
        return denyAndAlert(
          input,
          `tenant '${input.tenant_slug}' does not allow provider '${provider}'.`
        );
      }
    } catch (error) {
      return denyAndAlert(
        input,
        `tenant '${input.tenant_slug}' could not be resolved: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const loaded = loadProviderEgressPolicy();
  if (loaded.status === 'missing') {
    return denyAndAlert(
      input,
      `provider-egress-policy.json not found; ${dataTier} egress fails closed until it is provisioned.`
    );
  }
  if (loaded.status === 'invalid') {
    return denyAndAlert(
      input,
      `provider-egress-policy.json is invalid (${loaded.reason}); ${dataTier} egress fails closed until it is repaired.`
    );
  }

  const { policy } = loaded;
  // Confidential and personal ask the same question — is this material used to
  // train the model? — because that is the harm both are protecting against.
  // Personal is not held to "never leaves the machine": personal work has real
  // uses that need a model (trip research, say), and a rule that forbids them
  // is a rule that gets worked around.
  const declaration = policy.providers[provider];
  const exceptions =
    dataTier === 'confidential'
      ? policy.tier_policy.confidential.approved_providers
      : policy.tier_policy.personal.approved_providers;
  // Local inference never leaves the machine, so training use cannot apply.
  if (declaration?.egress === 'local-only') return { allowed: true };

  // The tenant's own attestation wins over the repository default: it is the
  // one that knows which plan was actually purchased. The shipped policy
  // deliberately declares every provider `unknown`, because contracts differ
  // per installation and this file is public.
  const attestation = resolveTenantProviderAttestation({
    profile: tenantPolicyInput,
    provider,
    ttlDays: policy.attestation_ttl_days,
  });
  if (
    attestation.status === 'valid' &&
    attestation.training_use === 'none' &&
    (declaration || exceptions.includes(provider))
  ) {
    return { allowed: true };
  }
  if (attestation.status === 'expired') {
    return denyAndAlert(
      input,
      `'${provider}' attestation for tenant '${tenantSlug}' expired on ${attestation.expires_at}; re-verify the plan's training-use terms before sending ${dataTier} material.`
    );
  }
  if (attestation.status === 'valid' && attestation.training_use !== 'none') {
    return denyAndAlert(
      input,
      `tenant '${tenantSlug}' attests training_use '${attestation.training_use}' for '${provider}'.`
    );
  }

  if (declaration?.training_use === 'none') return { allowed: true };
  // An operator may still allow a provider whose terms are not declared. That
  // is an exception, named as one in reports rather than reading like a
  // derived approval.
  if (exceptions.includes(provider)) return { allowed: true };

  if (!declaration) {
    return denyAndAlert(
      input,
      `'${provider}' is not declared in provider-egress-policy.json; a tenant attestation alone cannot establish its egress identity.`
    );
  }

  const trainingUse = declaration.training_use ?? 'unknown';
  return denyAndAlert(
    input,
    `'${provider}' has training_use '${trainingUse}'; ${dataTier} material may only go to a provider attested 'none' (or an explicit approved_providers exception).`
  );
}

export class ProviderEgressDeniedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ProviderEgressDeniedError';
  }
}

/** Throwing variant of `checkProviderEgress`, for call sites that want to abort rather than branch. */
export function assertProviderEgress(input: ProviderEgressCheckInput): void {
  const result = checkProviderEgress(input);
  if (!result.allowed) {
    throw new ProviderEgressDeniedError(result.reason || 'provider egress denied');
  }
}

/**
 * Highest tier represented across a set of knowledge/hint paths, using the
 * existing path-prefix taxonomy in `tier-guard.ts` (`detectTier` +
 * `TIERS` weight map: personal=4 > confidential=3 > public=1) rather than a
 * second implementation of the same rule. Used by call sites that only know
 * *which files* were delivered (KP-02: background-review-runner.ts,
 * adf-repair-agent.ts), not a mission's declared tier.
 */
export function highestTierForPaths(paths: string[]): TierLevel {
  let highest: TierLevel = 'public';
  for (const p of paths) {
    const tier = detectTier(p);
    if (TIERS[tier] > TIERS[highest]) highest = tier;
  }
  return highest;
}

/**
 * Best-effort mode/backend-name -> provider-id mapping for the five CLI
 * providers this plan (and provider-capability-registry.ts's
 * `PROVIDER_PROBE_TABLE`) is scoped to. Covers both `ReasoningBackendMode`
 * values (`reasoning-bootstrap.ts`) and live `ReasoningBackend.name` values
 * (`shell-claude-cli-backend.ts` etc.) because the two spaces overlap for
 * CLI-backed modes and callers hold whichever one is convenient.
 *
 * This intentionally duplicates in miniature the private
 * `providerForReasoningMode` switch in `reasoning-bootstrap.ts`: that
 * function is not exported, and reasoning-bootstrap.ts is out of scope for
 * this change (owned by a different track this wave; see the XP-03 task
 * brief). If the two ever drift, the effect is limited to this resolver
 * mis-identifying (or failing to identify) a provider for the *default*,
 * unset-provider path — callers that know their provider should always pass
 * it explicitly, which bypasses this table entirely.
 */
const REASONING_IDENTIFIER_TO_PROVIDER_ID: Readonly<Record<string, string>> = {
  'claude-cli': 'claude',
  'claude-agent': 'claude',
  'shell-claude-cli': 'claude',
  'codex-cli': 'codex',
  'agy-cli': 'agy',
  'gemini-cli': 'gemini',
  gemini: 'gemini',
  copilot: 'copilot',
  'copilot-acp': 'copilot',
  'grok-cli': 'grok',
  'shell-grok-cli': 'grok',
  'grok-api': 'grok',
  grok: 'grok',
  'cursor-cli': 'cursor',
  cursor: 'cursor',
  'opencode-cli': 'opencode',
  opencode: 'opencode',
};

/** Map a reasoning mode or backend name to a provider id known to the egress policy, when possible. */
export function providerIdForReasoningIdentifier(
  identifier: string | undefined | null
): string | undefined {
  if (!identifier) return undefined;
  return REASONING_IDENTIFIER_TO_PROVIDER_ID[identifier];
}
