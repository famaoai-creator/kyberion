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
 * adds that: `checkProviderEgress({ provider, dataTier })` is a pure,
 * synchronous, explicit check callers invoke at the exact point they are
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
 * - `confidential` — only providers on `tier_policy.confidential
 *   .approved_providers`.
 * - `personal` — providers declared `local-only` in `providers`, or on
 *   `tier_policy.personal.approved_providers`.
 *
 * See docs/developer/improvement-plans-2026-07/
 * CROSS_PROVIDER_EXECUTION_PLAN_2026-07-25.ja.md §XP-03.
 */
import AjvModule, { type ValidateFunction } from 'ajv';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { compileSchemaFromPath } from './schema-loader.js';
import { detectTier, TIERS } from './tier-guard.js';
import type { TierLevel } from './types.js';
import { sendOpsAlert } from './ops-alert.js';
import { createLogger } from './logger.js';

const Ajv = (AjvModule as any).default ?? AjvModule;

const logger = createLogger('provider-egress-gate');

export type ProviderEgressLabel = 'external-api' | 'local-only';

export interface ProviderEgressPolicyFile {
  version: string;
  providers: Record<string, { egress: ProviderEgressLabel }>;
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

let cachedValidator: ValidateFunction | null = null;
let cachedPolicyPath: string | null = null;
let cachedResult: PolicyLoadResult | null = null;

function policyPath(): string {
  return process.env.KYBERION_PROVIDER_EGRESS_POLICY_PATH?.trim() || DEFAULT_POLICY_PATH;
}

function ensureValidator(): ValidateFunction {
  if (cachedValidator) return cachedValidator;
  const ajv = new Ajv({ allErrors: true });
  cachedValidator = compileSchemaFromPath(ajv, SCHEMA_PATH);
  return cachedValidator;
}

/** Test-only: force the next `loadProviderEgressPolicy` to re-read + re-validate. */
export function resetProviderEgressPolicyCache(): void {
  cachedPolicyPath = null;
  cachedResult = null;
}

/**
 * Load + schema-validate the policy file, caching the result per path (like
 * `loadEgressPolicy` in egress-policy.ts). Never throws: a missing or
 * malformed file is reported as `{status: 'missing' | 'invalid'}` so
 * `checkProviderEgress` can fail closed for confidential/personal without
 * crashing the caller.
 */
export function loadProviderEgressPolicy(): PolicyLoadResult {
  const filePath = policyPath();
  if (cachedResult && cachedPolicyPath === filePath) return cachedResult;
  cachedPolicyPath = filePath;

  if (!safeExistsSync(filePath)) {
    cachedResult = { status: 'missing' };
    return cachedResult;
  }
  try {
    const raw = safeReadFile(filePath, { encoding: 'utf8' }) as string;
    const parsed = JSON.parse(raw);
    const validate = ensureValidator();
    if (!validate(parsed)) {
      cachedResult = {
        status: 'invalid',
        reason: `schema violation: ${validate.errors?.map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ') || 'unknown'}`,
      };
      return cachedResult;
    }
    cachedResult = { status: 'ok', policy: parsed as ProviderEgressPolicyFile };
    return cachedResult;
  } catch (err) {
    cachedResult = {
      status: 'invalid',
      reason: err instanceof Error ? err.message : String(err),
    };
    return cachedResult;
  }
}

export interface ProviderEgressCheckInput {
  /** Provider id, e.g. 'claude' | 'codex' | 'agy' | 'gemini' | 'copilot'. */
  provider: string;
  /** Highest data tier represented in the payload about to be handed to `provider`. */
  dataTier: TierLevel;
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
        " (tier_policy.<tier>.approved_providers), or mark it 'local-only' if it truly never" +
        ' leaves this machine.',
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
export function checkProviderEgress(input: ProviderEgressCheckInput): ProviderEgressCheckResult {
  const provider = String(input.provider || '').trim();
  const dataTier = input.dataTier;

  // Public always fails open, independent of policy file health — a broken
  // or absent policy must never block ordinary public-tier work.
  if (dataTier === 'public') return { allowed: true };

  if (!provider) {
    return denyAndAlert(input, `no provider identified for a ${dataTier} payload; fail-closed.`);
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
  if (dataTier === 'confidential') {
    if (policy.tier_policy.confidential.approved_providers.includes(provider)) {
      return { allowed: true };
    }
    return denyAndAlert(
      input,
      `'${provider}' is not on tier_policy.confidential.approved_providers.`
    );
  }

  // personal
  const label = policy.providers[provider]?.egress;
  if (label === 'local-only') return { allowed: true };
  if (policy.tier_policy.personal.approved_providers.includes(provider)) {
    return { allowed: true };
  }
  return denyAndAlert(
    input,
    `'${provider}' is neither declared 'local-only' nor on tier_policy.personal.approved_providers.`
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
};

/** Map a reasoning mode or backend name to a provider id known to the egress policy, when possible. */
export function providerIdForReasoningIdentifier(
  identifier: string | undefined | null
): string | undefined {
  if (!identifier) return undefined;
  return REASONING_IDENTIFIER_TO_PROVIDER_ID[identifier];
}
