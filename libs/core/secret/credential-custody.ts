/**
 * Credential custody, kind and lending (CLAUDE_CLI_TENANT_CREDENTIAL_DESIGN_2026-11-16 §2, §3).
 *
 * The data owner of a task (its tenant) and the custody owner of the reasoning
 * credential it uses are separate. A credential is held by a person or a tenant
 * (`CustodyOwnerKind` from contracts/custody-owner.ts — the same vocabulary as
 * provider attestations) and may be LENT, under the owner's approval, to the
 * work of another tenant (the borrower). Its kind decides how far it may be
 * lent: an API key (commercial terms) to any attested borrower; a subscription
 * token (`claude setup-token`) only to the owner's own work.
 *
 * Pure module: the registry lookups the eligibility rule needs are injected
 * (`CredentialEligibilityDeps`); `defaultCredentialEligibilityDeps` wires the
 * canonical member registry, tenant registry and provider attestation.
 */
import { createHash } from 'node:crypto';
import type { CustodyOwnerKind } from '../contracts/custody-owner.js';
import { isValidMemberId, isValidTenantSlug } from '../foundation/scope.js';
import { calendarDateInZone, zonedWallTimeToInstant } from '../temporal/business-calendar.js';
import { installationTimezone } from '../temporal/temporal-context.js';

/** Who holds a lendable credential. `system` custody never lends a credential. */
export type CredentialCustody = Extract<CustodyOwnerKind, 'person' | 'tenant'>;
export type CredentialKind = 'api_key' | 'subscription_token';
export type CredentialTerms = 'commercial' | 'consumer';
export type CredentialPlan = 'api' | 'team' | 'enterprise' | 'pro' | 'max' | 'ultra';

export const CREDENTIAL_PLANS: readonly CredentialPlan[] = [
  'api',
  'team',
  'enterprise',
  'pro',
  'max',
  'ultra',
];

/** A lendable credential service: what kind of material it holds and who may consume it. */
export interface CredentialServiceSpec {
  readonly service: string;
  readonly kind: CredentialKind;
  /** Secret key of the connection document (secret-identity: `<service>/<KEY>`). */
  readonly secretKey: string;
  /** Connection-document field holding the value (secret-identity connectionField). */
  readonly connectionField: string;
  /** Env name the binding fills in `secrets`. */
  readonly envKey: string;
  /** Provider id of the egress policy / attestation (design §5: the business, not the runtime). */
  readonly egressProvider: string;
  /** Reasoning backends (modes) that may consume it. */
  readonly backends: readonly string[];
  readonly plans: readonly CredentialPlan[];
  /** Canonical backend recorded as the grant's credential_provider. */
  readonly primaryBackend: string;
  /** Operator-facing hint for minting a fresh value (remediation text; e.g. "run `x setup-token"`). */
  readonly obtainHint: string;
}

/**
 * The lendable credential services. `anthropic` is the Console API key (the
 * reasoning provider descriptor `anthropic` owns its API proof);
 * `claude-subscription` is a `claude setup-token` OAuth token, which has no
 * API proof and is consumed only by the claude CLI. `openai` / `gemini` /
 * `grok` are the API keys of those providers — each feeds both its API-proof
 * backend and its CLI backend (which reads the key from its env). Service
 * ids match the providers' `secret_refs.service_id`, so the same
 * `secret introduce <service> API_KEY` registration feeds either path.
 */
export const CREDENTIAL_SERVICES: Readonly<Record<string, CredentialServiceSpec>> = Object.freeze({
  anthropic: Object.freeze({
    service: 'anthropic',
    kind: 'api_key',
    secretKey: 'API_KEY',
    connectionField: 'api_key',
    envKey: 'ANTHROPIC_API_KEY',
    egressProvider: 'claude',
    backends: Object.freeze(['anthropic', 'claude-cli']),
    plans: Object.freeze(['api', 'team', 'enterprise'] as CredentialPlan[]),
    primaryBackend: 'anthropic',
    obtainHint: 'issue a new Anthropic Console API key',
  }),
  openai: Object.freeze({
    service: 'openai',
    kind: 'api_key',
    secretKey: 'API_KEY',
    connectionField: 'api_key',
    envKey: 'OPENAI_API_KEY',
    egressProvider: 'codex',
    backends: Object.freeze(['openai-api', 'codex-cli']),
    plans: Object.freeze(['api', 'team', 'enterprise'] as CredentialPlan[]),
    primaryBackend: 'openai-api',
    obtainHint: 'issue a new OpenAI API key',
  }),
  gemini: Object.freeze({
    service: 'gemini',
    kind: 'api_key',
    secretKey: 'API_KEY',
    connectionField: 'api_key',
    envKey: 'GEMINI_API_KEY',
    egressProvider: 'gemini',
    // The same Gemini API key also feeds Antigravity CLI (gemini-cli's
    // successor), which reads it via modelProvider "gemini" settings.
    backends: Object.freeze(['gemini-api', 'gemini-cli', 'agy-cli']),
    plans: Object.freeze(['api', 'team', 'enterprise'] as CredentialPlan[]),
    primaryBackend: 'gemini-api',
    obtainHint: 'issue a new Gemini API key',
  }),
  grok: Object.freeze({
    service: 'grok',
    kind: 'api_key',
    secretKey: 'API_KEY',
    connectionField: 'api_key',
    envKey: 'XAI_API_KEY',
    egressProvider: 'grok',
    backends: Object.freeze(['grok-api', 'grok-cli']),
    plans: Object.freeze(['api', 'team', 'enterprise'] as CredentialPlan[]),
    primaryBackend: 'grok-api',
    obtainHint: 'issue a new xAI API key',
  }),
  'claude-subscription': Object.freeze({
    service: 'claude-subscription',
    kind: 'subscription_token',
    secretKey: 'OAUTH_TOKEN',
    connectionField: 'oauth_token',
    envKey: 'CLAUDE_CODE_OAUTH_TOKEN',
    egressProvider: 'claude',
    backends: Object.freeze(['claude-cli']),
    plans: Object.freeze(['pro', 'max', 'ultra', 'team', 'enterprise'] as CredentialPlan[]),
    primaryBackend: 'claude-cli',
    obtainHint: 'run `claude setup-token`',
  }),
});

/** Days before `token_expires_at` the owner is reminded (design §2.4). */
export const SUBSCRIPTION_TOKEN_REMINDER_DAYS = 30;
/** Default subscription token lifetime when the owner does not enter one (design §2.1). */
export const SUBSCRIPTION_TOKEN_DEFAULT_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

export function requireCredentialService(service: string): CredentialServiceSpec {
  const spec = Object.hasOwn(CREDENTIAL_SERVICES, service) ? CREDENTIAL_SERVICES[service] : null;
  if (!spec)
    throw new Error(
      `[CREDENTIAL_SERVICE_UNKNOWN] '${service}' is not a lendable credential service (${Object.keys(CREDENTIAL_SERVICES).join(', ')})`
    );
  return spec;
}

/** Backends any lendable credential service can feed (reasoning allocation admission). */
export function credentialServiceBackends(): string[] {
  return [...new Set(Object.values(CREDENTIAL_SERVICES).flatMap((spec) => spec.backends))];
}

/** api_key is commercial by definition; a subscription follows its plan (Pro/Max/Ultra consumer). */
export function credentialTermsOf(kind: CredentialKind, plan: CredentialPlan): CredentialTerms {
  if (kind === 'api_key') return 'commercial';
  return plan === 'team' || plan === 'enterprise' ? 'commercial' : 'consumer';
}

// ---------------------------------------------------------------------------
// credential_ref: <custody>:<owner>:<service>[:<label>]
// ---------------------------------------------------------------------------

export interface ParsedCredentialRef {
  custody: CredentialCustody;
  /** person: member id (principal `user:<owner>`); tenant: tenant slug. */
  owner: string;
  service: string;
  label?: string;
}

const LABEL_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/u;

export function parseCredentialRef(value: string): ParsedCredentialRef {
  const parts = String(value ?? '').split(':');
  const [custody, owner, service, label, ...rest] = parts;
  const invalid = (why: string) =>
    new Error(
      `[CREDENTIAL_REF_INVALID] '${value}' ${why}; expected <person|tenant>:<owner>:<service>[:<label>]`
    );
  if (rest.length || parts.length < 3) throw invalid('has the wrong number of segments');
  if (custody !== 'person' && custody !== 'tenant') throw invalid('names no custody');
  if (custody === 'person' ? !isValidMemberId(owner!) : !isValidTenantSlug(owner!))
    throw invalid('names an invalid owner');
  requireCredentialService(service!);
  if (label !== undefined && !LABEL_PATTERN.test(label)) throw invalid('has an invalid label');
  return { custody, owner: owner!, service: service!, ...(label ? { label } : {}) };
}

export function formatCredentialRef(ref: ParsedCredentialRef): string {
  return [ref.custody, ref.owner, ref.service, ...(ref.label ? [ref.label] : [])].join(':');
}

/** Principal of a person owner (member actor id) — the approver of its lending. */
export function personPrincipal(memberId: string): string {
  return `user:${memberId}`;
}

/** Member id named by a principal (`user:<id>` or a bare id), or undefined. */
export function memberIdOfPrincipal(principal: string): string | undefined {
  const id = principal.startsWith('user:') ? principal.slice(5) : principal;
  return isValidMemberId(id) ? id : undefined;
}

/** Repo-relative connection document of a credential (design §2.1 storage). */
export function credentialConnectionPath(ref: ParsedCredentialRef): string {
  const file = `${ref.service}${ref.label ? `.${ref.label}` : ''}.json`;
  return ref.custody === 'person'
    ? `knowledge/personal/connections/${file}`
    : `knowledge/confidential/${ref.owner}/connections/${file}`;
}

/** The non-secret registered record beside the connection (`<service>[.<label>].record.json`). */
export function credentialRecordPath(ref: ParsedCredentialRef): string {
  return credentialConnectionPath(ref).replace(/\.json$/u, '.record.json');
}

/** sha256 of the credential value: binds approvals to the exact value (never the value itself). */
export function credentialValueFingerprint(value: string): string {
  return `sha256:${createHash('sha256').update(value.trim()).digest('hex')}`;
}
const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/u;

// ---------------------------------------------------------------------------
// The registered credential record (design §2.1) — the ONLY source of
// kind / plan / terms / token_expires_at / contract_tenant.
// ---------------------------------------------------------------------------

export interface CredentialRecord {
  schema_version: 'credential-record.v1';
  credential_ref: string;
  custody: CredentialCustody;
  owner: string;
  service: string;
  kind: CredentialKind;
  terms: CredentialTerms;
  plan: CredentialPlan;
  /** subscription_token only (ISO date-time). */
  token_expires_at?: string;
  /** Commercial seat (Team/Enterprise subscription): the contracting tenant the seat belongs to. */
  contract_tenant?: string;
  value_fingerprint: string;
  registered_at: string;
  registered_by: string;
}

export function buildCredentialRecord(input: {
  credentialRef: string;
  value: string;
  plan?: CredentialPlan;
  tokenExpiresAt?: string;
  contractTenant?: string;
  registeredBy: string;
  now?: Date;
}): CredentialRecord {
  const ref = parseCredentialRef(input.credentialRef);
  const spec = requireCredentialService(ref.service);
  const plan = input.plan ?? (spec.kind === 'api_key' ? 'api' : undefined);
  if (!plan || !spec.plans.includes(plan))
    throw new Error(
      `[CREDENTIAL_PLAN_INVALID] ${ref.service} requires --plan ${spec.plans.join('|')}`
    );
  const now = input.now ?? new Date();
  let tokenExpiresAt: string | undefined;
  if (spec.kind === 'subscription_token') {
    // The default is aligned to a local business day (the installation
    // timezone — the OS zone the budget month uses too), so a request and its
    // approved apply describe the same record; the overwrite approval also
    // carries the computed value for the apply to repeat.
    const timeZone = installationTimezone();
    const localDayStart = zonedWallTimeToInstant(
      calendarDateInZone(now, timeZone),
      '00:00',
      timeZone
    ).getTime();
    const parsed = input.tokenExpiresAt
      ? Date.parse(input.tokenExpiresAt)
      : localDayStart + SUBSCRIPTION_TOKEN_DEFAULT_DAYS * DAY_MS;
    if (!Number.isFinite(parsed))
      throw new Error('[CREDENTIAL_TOKEN_EXPIRY_INVALID] --token-expires must be YYYY-MM-DD');
    tokenExpiresAt = new Date(parsed).toISOString();
  } else if (input.tokenExpiresAt) {
    throw new Error('[CREDENTIAL_TOKEN_EXPIRY_INVALID] only a subscription token has an expiry');
  }
  const terms = credentialTermsOf(spec.kind, plan);
  // Review 3 (decision): a person-held credential never has a contract-tenant path;
  // company use of a seat goes through TENANT custody, whose contract tenant is the owner.
  if (input.contractTenant !== undefined) {
    if (ref.custody === 'person')
      throw new Error(
        `[CREDENTIAL_REF_INVALID] a person-held credential has no contract tenant; register the company seat under tenant custody: --custody tenant --owner ${input.contractTenant}`
      );
    if (input.contractTenant !== ref.owner)
      throw new Error(
        '[CREDENTIAL_REF_INVALID] a tenant-held seat is contracted by its owner tenant'
      );
  }
  const contractTenant =
    ref.custody === 'tenant' && spec.kind === 'subscription_token' && terms === 'commercial'
      ? ref.owner
      : undefined;
  if (typeof input.value !== 'string' || input.value.trim().length < 8)
    throw new Error('[CREDENTIAL_VALUE_INVALID] empty or truncated credential value');
  return {
    schema_version: 'credential-record.v1',
    credential_ref: formatCredentialRef(ref),
    custody: ref.custody,
    owner: ref.owner,
    service: ref.service,
    kind: spec.kind,
    terms,
    plan,
    ...(tokenExpiresAt ? { token_expires_at: tokenExpiresAt } : {}),
    ...(contractTenant ? { contract_tenant: contractTenant } : {}),
    value_fingerprint: credentialValueFingerprint(input.value),
    registered_at: now.toISOString(),
    registered_by: input.registeredBy,
  };
}

/** Structural check of a stored record; a record failing it lends nothing. */
export function credentialRecordErrors(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return ['credential record must be an object'];
  const record = value as CredentialRecord;
  const errors: string[] = [];
  if (record.schema_version !== 'credential-record.v1') errors.push('unknown record version');
  errors.push(...termErrors(record, 'record'));
  if (typeof record.registered_by !== 'string' || !record.registered_by)
    errors.push('record.registered_by is required');
  return errors;
}

// ---------------------------------------------------------------------------
// The lending scope stored on a credential.use grant (design §2.2): a copy of
// the registered record's terms + value fingerprint, approval-bound.
// ---------------------------------------------------------------------------

export interface CredentialLendingScope {
  credential_ref: string;
  custody: CredentialCustody;
  owner: string;
  service: string;
  kind: CredentialKind;
  terms: CredentialTerms;
  plan: CredentialPlan;
  allowed_backends: string[];
  budget_monthly_usd?: number;
  token_expires_at?: string;
  contract_tenant?: string;
  /** Fingerprint of the exact value the owner approved lending; a changed value is refused. */
  value_fingerprint: string;
}

/** Fields that must agree between the registered record and a lending grant. */
export const RECORD_BOUND_LENDING_FIELDS = [
  'credential_ref',
  'custody',
  'owner',
  'service',
  'kind',
  'terms',
  'plan',
  'token_expires_at',
  'contract_tenant',
  'value_fingerprint',
] as const;

/**
 * Lending terms from the REGISTERED record (never from assign flags). Flags
 * the operator passes are only checked for consistency with the record.
 */
export function lendingFromRecord(
  record: CredentialRecord,
  input: {
    backends?: readonly string[];
    budgetMonthlyUsd?: number;
    expect?: { plan?: string; tokenExpiresAt?: string; contractTenant?: string };
  } = {}
): CredentialLendingScope {
  const recordErrors = credentialRecordErrors(record);
  if (recordErrors.length)
    throw new Error(`[CREDENTIAL_RECORD_INVALID] ${recordErrors.join('; ')}`);
  const spec = requireCredentialService(record.service);
  const expect = input.expect ?? {};
  const mismatch = [
    expect.plan !== undefined && expect.plan !== record.plan ? `plan ${record.plan}` : '',
    expect.tokenExpiresAt !== undefined &&
    (!record.token_expires_at ||
      new Date(Date.parse(expect.tokenExpiresAt)).toISOString() !== record.token_expires_at)
      ? `token_expires_at ${record.token_expires_at ?? '(none)'}`
      : '',
    expect.contractTenant !== undefined && expect.contractTenant !== record.contract_tenant
      ? `contract_tenant ${record.contract_tenant ?? '(none)'}`
      : '',
  ].filter(Boolean);
  if (mismatch.length)
    throw new Error(
      `[CREDENTIAL_RECORD_MISMATCH] ${record.credential_ref} is registered with ${mismatch.join(', ')}; re-register it to change these terms`
    );
  const backends = [...new Set(input.backends?.length ? input.backends : spec.backends)].sort();
  const foreign = backends.filter((backend) => !spec.backends.includes(backend));
  if (foreign.length)
    throw new Error(
      `[CREDENTIAL_BACKEND_INVALID] ${record.service} (${spec.kind}) cannot feed ${foreign.join(', ')}; allowed: ${spec.backends.join(', ')}`
    );
  const budget = input.budgetMonthlyUsd;
  if (budget !== undefined && (!Number.isFinite(budget) || budget <= 0 || budget > 1_000_000))
    throw new Error('[CREDENTIAL_BUDGET_INVALID] --budget-usd must be a positive number');
  return {
    credential_ref: record.credential_ref,
    custody: record.custody,
    owner: record.owner,
    service: record.service,
    kind: record.kind,
    terms: record.terms,
    plan: record.plan,
    allowed_backends: backends,
    ...(budget !== undefined ? { budget_monthly_usd: budget } : {}),
    ...(record.token_expires_at ? { token_expires_at: record.token_expires_at } : {}),
    ...(record.contract_tenant ? { contract_tenant: record.contract_tenant } : {}),
    value_fingerprint: record.value_fingerprint,
  };
}

/** The lending grant still describes the registered record (re-read at bind / validate). */
export function lendingMatchesRecord(
  lending: CredentialLendingScope,
  record: CredentialRecord
): boolean {
  return RECORD_BOUND_LENDING_FIELDS.every(
    (field) => JSON.stringify(lending[field]) === JSON.stringify(record[field])
  );
}

function termErrors(scope: Partial<CredentialLendingScope>, label: string): string[] {
  const errors: string[] = [];
  let ref: ParsedCredentialRef;
  try {
    ref = parseCredentialRef(String(scope.credential_ref));
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  const spec = requireCredentialService(ref.service);
  if (scope.custody !== ref.custody || scope.owner !== ref.owner || scope.service !== ref.service)
    errors.push(`${label} custody/owner/service must agree with credential_ref`);
  if (scope.kind !== spec.kind) errors.push(`${label}.kind must be ${spec.kind}`);
  if (!scope.plan || !spec.plans.includes(scope.plan)) errors.push(`${label}.plan is invalid`);
  else if (scope.terms !== credentialTermsOf(spec.kind, scope.plan))
    errors.push(`${label}.terms is not canonical`);
  if ((spec.kind === 'subscription_token') !== Boolean(scope.token_expires_at))
    errors.push(`${label}.token_expires_at is required exactly for subscription tokens`);
  if (scope.token_expires_at && !Number.isFinite(Date.parse(scope.token_expires_at)))
    errors.push(`${label}.token_expires_at is invalid`);
  if (
    scope.contract_tenant !== undefined &&
    (scope.custody !== 'tenant' || scope.contract_tenant !== scope.owner)
  )
    errors.push(`${label}.contract_tenant is only the owner tenant of a tenant-held seat`);
  if (!FINGERPRINT_PATTERN.test(String(scope.value_fingerprint)))
    errors.push(`${label}.value_fingerprint is required`);
  return errors;
}

/** Structural check of a stored lending scope (the grant validator calls it). */
export function credentialLendingErrors(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return ['credential_lending must be an object'];
  const scope = value as CredentialLendingScope;
  const errors = termErrors(scope, 'credential_lending');
  const spec = Object.hasOwn(CREDENTIAL_SERVICES, String(scope.service))
    ? CREDENTIAL_SERVICES[scope.service]
    : undefined;
  if (
    !Array.isArray(scope.allowed_backends) ||
    !scope.allowed_backends.length ||
    scope.allowed_backends.some((backend) => !spec?.backends.includes(backend)) ||
    JSON.stringify([...new Set(scope.allowed_backends)].sort()) !==
      JSON.stringify(scope.allowed_backends)
  )
    errors.push('credential_lending.allowed_backends is invalid');
  if (
    scope.budget_monthly_usd !== undefined &&
    !(Number.isFinite(scope.budget_monthly_usd) && scope.budget_monthly_usd > 0)
  )
    errors.push('credential_lending.budget_monthly_usd is invalid');
  return errors;
}

/**
 * Backward compatibility (design §2.2): a pre-lending `credential.use` grant
 * reads as person custody of an API key held by the operator who approved it.
 */
export function legacyCredentialLending(grant: {
  scope: { credential_provider?: string; credential_ref?: string };
  granted_by: { actor_id: string };
}): Omit<CredentialLendingScope, 'value_fingerprint'> | undefined {
  const provider = grant.scope.credential_provider;
  const service = grant.scope.credential_ref?.split('/')[0];
  if (!provider || !service || !Object.hasOwn(CREDENTIAL_SERVICES, service)) return undefined;
  const owner = memberIdOfPrincipal(grant.granted_by.actor_id) ?? 'owner';
  return {
    credential_ref: `person:${owner}:${service}`,
    custody: 'person',
    owner,
    service,
    kind: 'api_key',
    terms: 'commercial',
    plan: 'api',
    allowed_backends: [provider],
  };
}

// ---------------------------------------------------------------------------
// Eligibility (design §2.3) — enforced at request, approval AND every use
// ---------------------------------------------------------------------------

export type CredentialEligibilityCode =
  | 'CREDENTIAL_KIND_NOT_ELIGIBLE'
  | 'CREDENTIAL_ATTESTATION_REQUIRED'
  | 'CREDENTIAL_TOKEN_EXPIRED'
  | 'CREDENTIAL_CUSTODY_PERSON_MISMATCH';

export type CredentialEligibility =
  { ok: true } | { ok: false; code: CredentialEligibilityCode; message: string };

export interface CredentialEligibilityDeps {
  /**
   * The tenant's explicit `personal_owner` principal (`user:<member>`), set only
   * through the governed, owner-approved `pnpm kyberion tenant personal-owner`.
   * Member-registry roles and `assigned_role` never count (both are bootstrapped).
   */
  personalOwnerOf(tenant: string): string | undefined;
  /** Member id of the installation person who owns `knowledge/personal/` (person custody). */
  installationPerson(): string | undefined;
  /** Does the borrower hold a valid provider attestation for this egress provider? */
  borrowerAttested(tenant: string, egressProvider: string, now: Date): boolean;
}

export class CredentialEligibilityError extends Error {
  constructor(
    readonly code: CredentialEligibilityCode,
    detail: string
  ) {
    super(`[${code}] ${detail}`);
    this.name = 'CredentialEligibilityError';
  }
}

export function assessCredentialEligibility(
  lending: Pick<
    CredentialLendingScope,
    | 'credential_ref'
    | 'custody'
    | 'owner'
    | 'service'
    | 'kind'
    | 'terms'
    | 'plan'
    | 'token_expires_at'
    | 'contract_tenant'
  >,
  borrowerTenant: string,
  now: Date,
  deps: CredentialEligibilityDeps
): CredentialEligibility {
  const spec = requireCredentialService(lending.service);
  const deny = (code: CredentialEligibilityCode, message: string): CredentialEligibility => ({
    ok: false,
    code,
    message,
  });
  if (lending.custody === 'person') {
    // S1: knowledge/personal/ belongs to one person; a ref naming another member is a confused deputy.
    const person = deps.installationPerson();
    if (!person || person !== lending.owner)
      return deny(
        'CREDENTIAL_CUSTODY_PERSON_MISMATCH',
        `${lending.credential_ref} names person '${lending.owner}', but this installation's personal store belongs to '${person ?? '(unknown)'}' | next: use person:${person ?? '<member>'}:${lending.service}, or register the credential under tenant custody`
      );
  }
  const personallyOwned =
    lending.custody === 'person' &&
    deps.personalOwnerOf(borrowerTenant) === personPrincipal(lending.owner);
  if (lending.kind === 'subscription_token') {
    // Remediation names an actual api_key service from the registry rather than
    // a literal one — a second registered service does not falsify the hint.
    const apiKeyService = Object.values(CREDENTIAL_SERVICES).find((s) => s.kind === 'api_key');
    const lendKey = apiKeyService
      ? `use an API key instead: pnpm kyberion reasoning credentials register --custody tenant --owner ${borrowerTenant} --service ${apiKeyService.service} --plan ${apiKeyService.plans[0]}, then pnpm kyberion reasoning credentials assign --tenant ${borrowerTenant} --credential tenant:${borrowerTenant}:${apiKeyService.service} --backends ${apiKeyService.backends.join(',')} --purpose "<why>"`
      : 'lend a commercial-terms (api_key) credential to this tenant instead (no api_key service is registered)';
    const markOwn = `if ${borrowerTenant} really is ${lending.custody === 'person' ? personPrincipal(lending.owner) : 'the holder'}'s own tenant: pnpm kyberion tenant personal-owner --tenant ${borrowerTenant} --person ${lending.custody === 'person' ? personPrincipal(lending.owner) : '<user:member>'}`;
    // Review 3: a person-held token (any plan) serves only the holder's verified
    // personal tenants; a tenant-held seat only its own (contracting) tenant.
    const eligible =
      lending.custody === 'person' ? personallyOwned : lending.owner === borrowerTenant;
    if (!eligible)
      return deny(
        'CREDENTIAL_KIND_NOT_ELIGIBLE',
        `${lending.credential_ref} is a ${lending.plan} subscription token (${lending.terms} terms); it serves only ${lending.custody === 'person' ? "its holder's verified personal tenants (tenant personal_owner)" : 'its own owner tenant'}, and ${borrowerTenant} is not one | next: ${lendKey}; or, ${markOwn}`
      );
    if (lending.token_expires_at && Date.parse(lending.token_expires_at) <= now.getTime())
      return deny(
        'CREDENTIAL_TOKEN_EXPIRED',
        `${lending.credential_ref} expired at ${lending.token_expires_at} | next: ${spec.obtainHint}, then pnpm kyberion reasoning credentials register --custody ${lending.custody}${lending.custody === 'tenant' ? ` --owner ${lending.owner}` : ''} --service ${lending.service} --plan ${lending.plan} --token-expires <YYYY-MM-DD>`
      );
  }
  if (!deps.borrowerAttested(borrowerTenant, spec.egressProvider, now))
    return deny(
      'CREDENTIAL_ATTESTATION_REQUIRED',
      `tenant ${borrowerTenant} has no valid provider attestation for '${spec.egressProvider}', so its data may not be sent with ${lending.credential_ref} | next: pnpm onboarding llm attest --tenant ${borrowerTenant} --provider ${spec.egressProvider} --training-use <none|used|unknown> | evidence: knowledge/personal/tenants/${borrowerTenant}.json provider_attestations`
    );
  return { ok: true };
}

export function assertCredentialEligible(
  lending: Parameters<typeof assessCredentialEligibility>[0],
  borrowerTenant: string,
  now: Date,
  deps: CredentialEligibilityDeps
): void {
  const result = assessCredentialEligibility(lending, borrowerTenant, now, deps);
  if ('code' in result) throw new CredentialEligibilityError(result.code, result.message);
}

/** Classified eligibility / budget / value refusals (dot pre-check maps these to credential_grant). */
export const CREDENTIAL_LENDING_REFUSAL =
  /^\[(?:CREDENTIAL_KIND_NOT_ELIGIBLE|CREDENTIAL_ATTESTATION_REQUIRED|CREDENTIAL_TOKEN_EXPIRED|CREDENTIAL_BUDGET_EXCEEDED|CREDENTIAL_CUSTODY_PERSON_MISMATCH|CREDENTIAL_VALUE_CHANGED|CREDENTIAL_RECORD_MISMATCH)\]/u;
export function isCredentialLendingRefusal(error: unknown): boolean {
  return error instanceof Error && CREDENTIAL_LENDING_REFUSAL.test(error.message);
}

/** Whole days until a subscription token expires (negative once expired). */
export function subscriptionTokenDaysLeft(
  lending: Pick<CredentialLendingScope, 'kind' | 'token_expires_at'>,
  now: Date
): number | undefined {
  if (lending.kind !== 'subscription_token' || !lending.token_expires_at) return undefined;
  return Math.floor((Date.parse(lending.token_expires_at) - now.getTime()) / DAY_MS);
}

// Isolated provider HOMEs live under `provider-auth/<provider>/<hash>/home`
// (provider-auth-home.ts `providerAuthHomeRelativePath`); custody records only
// name the credential, never the launch layout.
