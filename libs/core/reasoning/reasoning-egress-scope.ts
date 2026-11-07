import { AsyncLocalStorage } from 'node:async_hooks';
import { createLogger } from '../logger.js';
import { evaluateEgressPolicy } from '../egress-policy.js';
import {
  findActiveCharter,
  loadCharterUsage,
} from '../governance/accountability-charter-registry.js';
import { evaluateInformationFlow } from '../governance/accountability-charter.js';
import { isLocalOnlyReasoningBackend } from './backend-capability-profile.js';
import { assertSandboxNetworkAllowed } from '../shell/sandbox-policy.js';
import {
  isLocalReasoningEndpoint,
  resolveReasoningProviderDescriptor,
} from './reasoning-provider-registry.js';
import {
  custodyAttestationRequestCommand,
  evaluateProviderEgress,
  lookupCustodyProviderAttestation,
  personConsentNoTrainingEvidenceGap,
  providerIdForReasoningIdentifier,
  resolveProviderEgressCustody,
} from '../provider/provider-egress-gate.js';
import {
  CustodyOwnerConflictError,
  custodyOwnerLabel,
  deriveCustodyOwner,
  type CustodyOwner,
} from '../custody-owner.js';

/**
 * Tier context for reasoning-backend sends.
 *
 * `secureFetch` carries the tier-aware egress gate (SA-04 Task 2), but
 * reasoning backends talk to their providers through each SDK's own HTTP
 * client and never pass through it. That leaves the single highest-risk
 * outbound path — whole documents and rendered pages going to a model —
 * outside the control that exists precisely for it.
 *
 * This module closes that path. A caller that knows it is holding tenant
 * material wraps the work in `withReasoningPayloadScope`, and every send made
 * inside that scope is checked against the same policy.
 *
 * Async-local rather than env-var based on purpose: reasoning calls run
 * concurrently behind a semaphore, and an env var set around one call would be
 * visible to every other call in flight.
 */

const logger = createLogger('reasoning-egress');

export type ReasoningTrainingUse =
  'local_only' | 'no_training' | 'zero_retention' | 'training_eligible';

interface ReasoningPayloadScopeBase {
  /** Tenant the material belongs to, when above public. */
  tenant_slug?: string;
  /**
   * Who is accountable for the material (custody-owner.ts). Derived when
   * omitted: `tenant_slug` → tenant, personal tier without a tenant → person,
   * otherwise system. An explicit value may only restate the scope (e.g. name
   * the person behind tenantless material); a contradiction with
   * `tenant_slug` is denied before anything is sent.
   */
  custody?: CustodyOwner;
  /** What is being sent, recorded on denial. */
  purpose?: string;
  /** Deterministic categories supplied by the caller; absent facts become `unknown`. */
  categories?: Array<'routine_business' | 'personal_data' | 'sensitive_business' | 'unknown'>;
  /** Number of attached inputs; required for explicitly scoped processors. */
  attachment_count?: number;
  external_egress?: 'allow' | 'deny';
  allowed_reasoning_backends?: readonly string[];
}

/**
 * Public material. An omitted `training_use` means `training_eligible`:
 * public material may be used for provider training (decided 2026-11-05).
 */
export interface PublicReasoningPayloadScope extends ReasoningPayloadScopeBase {
  /** Most sensitive tier represented in what will be sent. */
  tier: 'public';
  /** Maximum provider data-use posture. Defaults to training_eligible. */
  training_use?: ReasoningTrainingUse;
}

/**
 * Tenant or personal material: `training_use` is REQUIRED. An omitted posture
 * defaults to `local_only` in the gate, which denies every external backend
 * (claude-cli included) — callers then reported that as a generic backend
 * failure. Declaring it at the type level makes the posture a deliberate
 * choice; a caller that truly needs local-only says `'local_only'` explicitly.
 * `tests/reasoning-payload-scope-training-use.test.ts` backstops untyped and
 * dynamic call sites.
 */
/**
 * The posture a scope gets when it declares none. Public material may be used
 * for training; anything above public keeps the fail-closed `local_only`
 * (typed callers must declare it; this default only covers untyped callers).
 */
export function defaultReasoningTrainingUse(tier: string | undefined): ReasoningTrainingUse {
  return tier === 'public' ? 'training_eligible' : 'local_only';
}

/** The posture the gate applies: the declared one, else the tier default. */
export function effectiveReasoningTrainingUse(scope: {
  tier?: string;
  training_use?: ReasoningTrainingUse;
}): ReasoningTrainingUse {
  return scope.training_use ?? defaultReasoningTrainingUse(scope.tier);
}

export interface NonPublicReasoningPayloadScope extends ReasoningPayloadScopeBase {
  /** Most sensitive tier represented in what will be sent. */
  tier: 'confidential' | 'personal';
  /** Maximum provider data-use posture, declared explicitly. */
  training_use: ReasoningTrainingUse;
}

export type ReasoningPayloadScope = PublicReasoningPayloadScope | NonPublicReasoningPayloadScope;
export type ReasoningPayloadTier = ReasoningPayloadScope['tier'];

const scopeStorage = new AsyncLocalStorage<ReasoningPayloadScope>();

/** Run `fn` with every reasoning send inside it governed by this scope. */
export function withReasoningPayloadScope<T>(scope: ReasoningPayloadScope, fn: () => T): T {
  return scopeStorage.run(scope, fn);
}

export function getReasoningPayloadScope(): ReasoningPayloadScope | undefined {
  return scopeStorage.getStore();
}

export function isLocalReasoningBackend(backendName: string): boolean {
  return isLocalOnlyReasoningBackend(backendName);
}

function reasoningDataPolicy(backendName: string): ReasoningTrainingUse {
  return isLocalReasoningBackend(backendName) ? 'local_only' : 'training_eligible';
}

/**
 * Where a named backend sends data.
 *
 * RS-01: the destination is the provider descriptor's `endpoint`
 * (`reasoning-providers/*.json`), resolved from a mode, a runtime backend
 * alias, or a provider id. An unrecognized backend — or one without a static
 * endpoint (configurable adapters use the endpoint-aware check below) —
 * resolves to an invalid placeholder host, which the tenant rule denies: the
 * safe direction when an unknown provider would be handed tenant material.
 */
export function reasoningBackendEndpoint(backendName: string): string {
  return (
    resolveReasoningProviderDescriptor(backendName)?.endpoint ??
    `https://${backendName}.unknown-provider.invalid`
  );
}

export class ReasoningEgressDeniedError extends Error {
  constructor(reason: string) {
    super(`[REASONING_EGRESS_DENIED] ${reason}`);
    this.name = 'ReasoningEgressDeniedError';
  }
}

/**
 * True when `error` — or a failover/wrapper error whose message embeds one —
 * is a reasoning egress denial rather than a backend fault. Failover chains
 * fold candidate errors into a plain Error, so the message tag is the stable
 * signal, not the class.
 */
export function isReasoningEgressDenial(error: unknown): boolean {
  if (error instanceof ReasoningEgressDeniedError) return true;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /\[REASONING_EGRESS_(?:DENIED|SCOPE_REQUIRED)\]/u.test(message);
}

/** The `next: …` step a denial message carries, when it carries one. */
export function reasoningEgressDenialNext(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error ?? '');
  // Split instead of a regex: an overlapping `\s*` / `[^|]+?` pattern backtracks
  // polynomially on long whitespace runs in untrusted provider error text.
  // The first segment precedes any `|`, so it can never be the `next:` field.
  const segment = message
    .split('|')
    .slice(1)
    .map((part) => part.trim())
    .find((part) => part.startsWith('next:') && part.length > 'next:'.length);
  return segment;
}

let tenantRegistryRootForTests: string | undefined;

/** Test-only: point the attestation lookup at a hermetic tenant registry root. */
export function _setReasoningTenantRegistryRootForTests(rootDir: string | undefined): void {
  tenantRegistryRootForTests = rootDir;
}

/**
 * `no_training` toward an external backend needs a no-training basis that
 * applies to the material's custody owner (custody-owner.ts):
 *
 * - confidential / personal material is decided by `evaluateProviderEgress`
 *   — the same side-effect-free evaluator behind `checkProviderEgress` on the
 *   delegation face — called with the same custody, so identical inputs give
 *   identical answers on both faces (SM-01). That covers the custody owner's
 *   own attestation (tenant profile, or the system / person store), the
 *   tenant's `allowed_reasoning_backends`, the provider-declared rule, and
 *   every expiry / `used` denial. One basis the evaluator accepts is refused
 *   here: `approved-providers-exception` lets an operator delegate to a
 *   provider whose terms are undeclared, which is not evidence that it does
 *   not train (decided 2026-11-05);
 * - public material has no tier rule to apply, so only a valid custody
 *   attestation of `training_use: 'none'` establishes the no-training claim
 *   (for person custody that attestation is the person's consent, which also
 *   needs the installation's attestation or a policy declaration).
 *
 * Anything else keeps the fail-closed denial, and the next step names the
 * attestation command for the custody owner that is missing one.
 */
function assertNoTrainingAttested(backendName: string, scope: ReasoningPayloadScope): void {
  const fallbackNext =
    "next: record one with 'pnpm onboarding llm attest --request-approval' (--tenant <slug> for tenant material, --custody system|person otherwise), or declare training_use 'training_eligible' explicitly";
  const deny = (why: string, evidence: string, next = fallbackNext): never => {
    throw new ReasoningEgressDeniedError(
      `backend ${backendName} has no no-training declaration — ${why} | ${next} | ${evidence}`
    );
  };
  const provider = providerIdForReasoningIdentifier(backendName);
  if (!provider) {
    deny(
      'the backend maps to no egress provider id, so no provider attestation can cover it',
      `backend=${backendName}`
    );
  }
  const resolved = resolveProviderEgressCustody({
    dataTier: scope.tier,
    ...(scope.tenant_slug ? { tenant_slug: scope.tenant_slug } : {}),
    ...(scope.custody ? { custody: scope.custody } : {}),
  });
  if (resolved.error || !resolved.custody) {
    deny(
      `the custody owner could not be resolved: ${resolved.error ?? 'unknown'}`,
      `provider=${provider} tier=${scope.tier}`
    );
  }
  const custody = resolved.custody!;
  // Person custody needs two records (decided 2026-11-05): the installation's
  // no-training attestation, and the person's own consent.
  const attestationSteps =
    custody.kind === 'person'
      ? `the installation's no-training attestation with '${custodyAttestationRequestCommand({ kind: 'system' }, provider)}' and the person's own consent with '${custodyAttestationRequestCommand(custody, provider)}' (decided by that person)`
      : `one with '${custodyAttestationRequestCommand(custody, provider)}'`;
  const next = `next: record ${attestationSteps}, or declare training_use 'training_eligible' explicitly`;
  const subject =
    custody.kind === 'tenant'
      ? `tenant '${custody.tenant_slug}'`
      : custody.kind === 'person'
        ? `person custody (${custodyOwnerLabel(custody)})`
        : 'the installation (system custody)';
  const attestation = lookupCustodyProviderAttestation({
    custody,
    provider,
    ...(tenantRegistryRootForTests ? { tenant_registry_root_dir: tenantRegistryRootForTests } : {}),
  });
  const evidence = [
    `custody=${custodyOwnerLabel(custody)}`,
    ...(custody.kind === 'tenant' ? [`tenant=${custody.tenant_slug}`] : []),
    `provider=${provider}`,
    `attestation=${attestation.status}`,
  ].join(' ');
  // Why the custody owner's own statement does not settle it (empty when it is a valid 'none').
  const attestationGap = attestation.error
    ? `the ${custody.kind} attestation lookup failed: ${attestation.error}`
    : attestation.status === 'absent'
      ? `${subject} has no attestation for provider '${provider}'`
      : attestation.status === 'expired'
        ? `${subject} attestation for provider '${provider}' expired${attestation.expires_at ? ` on ${attestation.expires_at}` : ''}`
        : attestation.training_use !== 'none'
          ? `${subject} attests training_use '${attestation.training_use}' for provider '${provider}'`
          : '';

  if (scope.tier === 'public') {
    if (attestationGap) {
      deny(
        attestationGap,
        attestation.status === 'valid'
          ? `${evidence} training_use=${attestation.training_use}`
          : evidence,
        next
      );
    }
    // A person's attestation is their consent; the no-training fact still
    // needs the installation's attestation or a policy declaration.
    const evidenceGap =
      custody.kind === 'person' ? personConsentNoTrainingEvidenceGap(provider!) : '';
    if (evidenceGap) {
      deny(
        `${subject} consents to '${provider}', but its consent is not evidence that the provider does not train and ${evidenceGap}`,
        evidence,
        next
      );
    }
    return;
  }

  // One evaluator for both faces: the delegation gate's own rule, with the
  // same custody, decides confidential / personal material.
  const decision = evaluateProviderEgress({
    provider,
    dataTier: scope.tier,
    custody,
    ...(resolved.tenant_slug ? { tenant_slug: resolved.tenant_slug } : {}),
    ...(tenantRegistryRootForTests ? { tenant_registry_root_dir: tenantRegistryRootForTests } : {}),
  });
  if (!decision.allowed) {
    const policyWhy = `the provider egress policy denies ${scope.tier} material: ${decision.reason ?? 'denied'}`;
    deny(
      attestationGap ? `${attestationGap}; ${policyWhy}` : policyWhy,
      `${evidence} tier=${scope.tier}`,
      next
    );
  }
  // An approved_providers entry is an operator exception for a provider whose
  // terms are undeclared — it keeps delegation working, but it is no evidence
  // that the provider does not train, which is what `no_training` claims.
  if (decision.basis === 'approved-providers-exception') {
    deny(
      `${attestationGap ? `${attestationGap}; ` : ''}the provider egress policy allows ${scope.tier} material to '${provider}' only through the tier_policy.${scope.tier}.approved_providers exception, which is an operator exception, not evidence that the provider does not train`,
      `${evidence} tier=${scope.tier} basis=approved-providers-exception`,
      `next: declare providers.${provider}.training_use 'none' in provider-egress-policy.json, or record ${attestationSteps}`
    );
  }
}

/**
 * Fail closed on a custody declaration that contradicts the scope (e.g.
 * `custody: system` on material that names a tenant). Checked before any
 * send, whatever the training_use, so a contradiction never reaches a model.
 */
function assertScopeCustodyConsistent(scope: ReasoningPayloadScope | undefined): void {
  if (!scope?.custody) return;
  try {
    deriveCustodyOwner({
      tier: scope.tier,
      ...(scope.tenant_slug ? { tenant_slug: scope.tenant_slug } : {}),
      custody: scope.custody,
    });
  } catch (error) {
    if (error instanceof CustodyOwnerConflictError) {
      throw new ReasoningEgressDeniedError(error.message);
    }
    throw error;
  }
}

function assertCharterProcessorScope(
  backendName: string,
  endpoint: string,
  scope: ReasoningPayloadScope
): void {
  if (!scope.tenant_slug) return;
  const rootDir = tenantRegistryRootForTests;
  const charter = findActiveCharter(
    { kind: 'organization', tenant_slug: scope.tenant_slug },
    new Date(),
    rootDir ? { rootDir } : {}
  );
  const flow = charter?.envelope.information_flow;
  // Older charters with no processor declaration retain the existing provider
  // egress rules. Once processors are explicitly scoped, this additional
  // restriction is mandatory and cannot be inferred from an attestation.
  if (!flow || flow.processor_ids === undefined) return;
  const provider = providerIdForReasoningIdentifier(backendName);
  const usage = loadCharterUsage(charter!, new Date(), rootDir ? { rootDir } : {});
  if (usage.tripwires_hit.length) {
    throw new ReasoningEgressDeniedError(
      `active charter stop tripwire(s): ${usage.tripwires_hit.join(', ')}`
    );
  }
  const descriptorEndpoint = resolveReasoningProviderDescriptor(backendName)?.endpoint;
  try {
    if (!descriptorEndpoint || new URL(endpoint).origin !== new URL(descriptorEndpoint).origin) {
      throw new Error('endpoint does not match the provider descriptor');
    }
  } catch {
    throw new ReasoningEgressDeniedError(
      `active charter cannot bind processor ${provider ?? '(unmapped)'} to endpoint ${endpoint}`
    );
  }
  const categories: NonNullable<ReasoningPayloadScope['categories']> = scope.categories?.length
    ? scope.categories
    : ['unknown'];
  const violations = evaluateInformationFlow(charter!.envelope, {
    purpose: scope.purpose ?? '',
    processor_id: provider ?? '',
    categories,
    // Missing attachment facts must not silently become an attachment-free request.
    attachment_count: scope.attachment_count ?? -1,
  });
  if (violations.length) throw new ReasoningEgressDeniedError(violations.join('; '));
}

/**
 * Throw if the ambient scope forbids sending to this backend.
 *
 * Without an ambient scope, local endpoints and explicitly allowlisted public
 * endpoints remain usable. Unknown public destinations are denied until the
 * caller declares a payload scope, so a missing scope cannot silently turn
 * into unrestricted external egress.
 */
function assertTaskBackendPolicy(backendName: string, local: boolean): void {
  const scope = getReasoningPayloadScope();
  assertScopeCustodyConsistent(scope);
  if (scope?.allowed_reasoning_backends && !scope.allowed_reasoning_backends.includes(backendName))
    throw new ReasoningEgressDeniedError(
      `[REASONING_EGRESS_DENIED] Backend ${backendName} is outside the task allowlist`
    );
  if (scope?.external_egress === 'deny' && !local)
    throw new ReasoningEgressDeniedError(
      `[REASONING_EGRESS_DENIED] Task forbids external backend ${backendName}`
    );
}

export function assertReasoningEgressAllowed(backendName: string): void {
  assertTaskBackendPolicy(backendName, isLocalReasoningBackend(backendName));
  assertSandboxNetworkAllowed(reasoningBackendEndpoint(backendName));
  // This overload has no endpoint information. The endpoint-aware path below
  // is the enforcement point for configurable adapters; preserve the
  // name-only local declaration for callers that only have a backend id.
  if (isLocalReasoningBackend(backendName)) return;
  assertReasoningEgressAllowedAtEndpoint(backendName, reasoningBackendEndpoint(backendName));
}

/** Apply the same gate when an adapter has a configurable provider endpoint. */
export function assertReasoningEgressAllowedAtEndpoint(
  backendName: string,
  endpoint: string
): void {
  assertTaskBackendPolicy(backendName, isLocalReasoningEndpoint(endpoint));
  assertSandboxNetworkAllowed(endpoint);
  const localEndpoint = isLocalReasoningEndpoint(endpoint);
  if (isLocalReasoningBackend(backendName) && !localEndpoint) {
    throw new ReasoningEgressDeniedError(
      `[REASONING_EGRESS_DENIED] Local-only backend ${backendName} must use a local endpoint: ${endpoint}`
    );
  }
  const scope = getReasoningPayloadScope();
  if (!scope) {
    // A missing scope is treated as public only after the destination itself
    // is approved. This preserves ordinary public prompts while preventing a
    // forgotten scope declaration from becoming an unrestricted exfiltration
    // path to arbitrary endpoints.
    if (localEndpoint) return;
    const decision = evaluateEgressPolicy(endpoint, { tier: 'public' });
    if (decision.verdict !== 'allow') {
      throw new ReasoningEgressDeniedError(
        `[REASONING_EGRESS_SCOPE_REQUIRED] ${backendName} endpoint is not approved without an explicit payload scope: ${decision.reason}`
      );
    }
    return;
  }
  // A local endpoint is safe even when the adapter uses a provider-neutral
  // runtime name such as `openai-compatible`.
  if (localEndpoint) return;
  if (effectiveReasoningTrainingUse(scope) === 'local_only') {
    // Untyped or dynamic callers can still omit training_use. The gate keeps
    // the fail-closed default but says so, so the denial is diagnosable.
    const declared = scope.training_use !== undefined;
    const tenant = scope.tenant_slug?.trim();
    const provider = providerIdForReasoningIdentifier(backendName) ?? '<id>';
    throw new ReasoningEgressDeniedError(
      `training_use 'local_only' forbids sending ${scope.tier} material to external backend ${backendName} — ` +
        (declared
          ? 'the payload scope declares local_only, so only a local backend may receive it'
          : 'the payload scope declares no training_use, which defaults to local_only') +
        ` | next: declare training_use explicitly on the payload scope ('no_training' for tenant material sent to an attested provider), use a local backend, or attest the tenant via 'pnpm onboarding llm attest --tenant ${tenant || '<slug>'} --provider ${provider} --training-use none --request-approval'` +
        ` | evidence: tier=${scope.tier} tenant=${tenant || '(none)'} backend=${backendName} training_use=${declared ? 'local_only' : 'local_only(default)'}${scope.purpose ? ` purpose=${scope.purpose}` : ''}`
    );
  }
  if (scope.training_use === 'zero_retention') {
    throw new ReasoningEgressDeniedError(
      `zero_retention requires independent retention evidence; a training_use: 'none' attestation only proves that ${backendName} does not train on this data`
    );
  }
  if (
    scope.training_use === 'no_training' &&
    reasoningDataPolicy(backendName) === 'training_eligible'
  ) {
    assertNoTrainingAttested(backendName, scope);
  }
  assertCharterProcessorScope(backendName, endpoint, scope);
  if (scope.tier === 'public') return;

  const decision = evaluateEgressPolicy(endpoint, {
    tier: scope.tier,
    tenant_slug: scope.tenant_slug,
    purpose: scope.purpose ?? 'reasoning backend call',
  });
  if (decision.verdict === 'deny') {
    logger.warn(
      `[EGRESS] blocked a ${scope.tier} payload from reaching ${backendName}: ${decision.reason}`
    );
    throw new ReasoningEgressDeniedError(decision.reason);
  }
}
