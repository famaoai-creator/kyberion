import { AsyncLocalStorage } from 'node:async_hooks';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { loadServiceEndpointsCatalog } from './service-endpoint-registry.js';
import type { ProvenanceTaint } from './cloudflare-os-control-plane.js';
import { isValidTenantSlug } from './entity-scope.js';

export type EgressPolicyMode = 'warn' | 'enforce';

export interface EgressPolicyFile {
  version?: string;
  mode?: EgressPolicyMode;
  manual_allowed_domains?: string[];
  blocked_domains?: string[];
  /**
   * SA-04 Task 2: per-tenant destinations approved for confidential/personal
   * material. Keyed by tenant slug; `*` applies to every tenant. Empty by
   * default — tenant data has nowhere approved to go until someone says so.
   */
  tenant_allowed_domains?: Record<string, string[]>;
  /**
   * QM-11: operator policy for LINKS SHARED IN MESSAGES — deliberately
   * separate from the network-egress allowlist above (mentioning a URL to a
   * customer must not require widening actual network egress). Absent =
   * the operator imposes no link restriction.
   */
  link_allowed_domains?: string[];
}

export interface EgressPolicyDecision {
  verdict: 'allow' | 'warn' | 'deny';
  hostname: string;
  reason: string;
  matchedDomain?: string;
  mode: EgressPolicyMode;
  /** Tier the decision was made for, when the caller declared one. */
  tier?: 'public' | 'confidential' | 'personal';
}

const DEFAULT_POLICY_PATH = pathResolver.knowledge('product/governance/egress-policy.json');
const SECURITY_POLICY_PATH = pathResolver.knowledge('product/governance/security-policy.json');

let cachedPolicyPath: string | null = null;
let cachedPolicy: EgressPolicyFile | null = null;
let cachedAllowedDomains: string[] | null = null;
const egressContextStorage = new AsyncLocalStorage<EgressPayloadContext>();

export function resetEgressPolicyCache(): void {
  cachedPolicyPath = null;
  cachedPolicy = null;
  cachedAllowedDomains = null;
}

// ---------------------------------------------------------------------------
// QM-11: audience egress floor (ported from qm's audience-floor).
// A shared conversation's egress is NOT the room's own setting: a host is
// reachable only if EVERY participant's policy allows it (allow-intersection)
// and NO participant denies it (deny-union). ~matches qm src/resolution/
// audience-floor.ts semantics; participants here are policy holders such as
// the tenant and the operator, not a per-user identity system (roadmap
// non-goal).
// ---------------------------------------------------------------------------

export interface EgressParticipantPolicy {
  participant: string;
  allowed_domains: string[];
  blocked_domains?: string[];
}

export interface AudienceEgressFloor {
  participants: string[];
  /** Intersection of every participant's normalized allow set. */
  allowed_domains: string[];
  /** Union of every participant's normalized deny set. */
  blocked_domains: string[];
}

export function normalizeEgressHost(host: string): string {
  return String(host || '')
    .trim()
    .toLowerCase()
    .replace(/^\*\./, '')
    .replace(/\.$/, '');
}

export function composeAudienceFloor(policies: EgressParticipantPolicy[]): AudienceEgressFloor {
  const participants = policies.map((policy) => policy.participant);
  const blocked = new Set<string>();
  for (const policy of policies) {
    for (const host of policy.blocked_domains ?? []) {
      const normalized = normalizeEgressHost(host);
      if (normalized) blocked.add(normalized);
    }
  }
  // A participant whose allow set contains '*' imposes no restriction of its
  // own — it joins the audience without narrowing the intersection. If every
  // participant is unrestricted, the floor allows all (denials still apply).
  let allowed: Set<string> | null = null;
  let sawUnrestricted = false;
  for (const policy of policies) {
    const own = new Set(
      policy.allowed_domains.map(normalizeEgressHost).filter((host) => host.length > 0)
    );
    if (own.has('*')) {
      sawUnrestricted = true;
      continue;
    }
    if (allowed === null) {
      allowed = own;
    } else {
      allowed = new Set([...allowed].filter((host) => own.has(host)));
    }
  }
  if (allowed === null && sawUnrestricted) allowed = new Set(['*']);
  return {
    participants,
    allowed_domains: [...(allowed ?? new Set<string>())].sort(),
    blocked_domains: [...blocked].sort(),
  };
}

function hostCoveredBy(hostname: string, domain: string): boolean {
  if (domain === '*') return true;
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

export interface AudienceEgressDecision {
  verdict: 'allow' | 'deny';
  hostname: string;
  reason: string;
}

/** Deny wins over allow; an empty audience permits nothing. */
export function evaluateAudienceEgress(
  hostname: string,
  floor: AudienceEgressFloor
): AudienceEgressDecision {
  const host = normalizeEgressHost(hostname);
  if (!host) {
    return { verdict: 'deny', hostname: host, reason: 'empty hostname' };
  }
  const blockedBy = floor.blocked_domains.find((domain) => hostCoveredBy(host, domain));
  if (blockedBy) {
    return {
      verdict: 'deny',
      hostname: host,
      reason: `denied by a participant policy (${blockedBy}) — one participant's denial denies everyone`,
    };
  }
  const allowedBy = floor.allowed_domains.find((domain) => hostCoveredBy(host, domain));
  if (allowedBy) {
    return {
      verdict: 'allow',
      hostname: host,
      reason: `allowed by every participant (${allowedBy})`,
    };
  }
  return {
    verdict: 'deny',
    hostname: host,
    reason: 'not in the audience floor — a host is reachable only when every participant allows it',
  };
}

export function loadEgressPolicy(): EgressPolicyFile {
  const policyPath = process.env.KYBERION_EGRESS_POLICY_PATH?.trim() || DEFAULT_POLICY_PATH;
  if (cachedPolicy && cachedPolicyPath === policyPath) return cachedPolicy;
  if (!safeExistsSync(policyPath)) {
    cachedPolicyPath = policyPath;
    cachedPolicy = {
      version: 'missing-policy',
      mode: 'warn',
      manual_allowed_domains: [],
      blocked_domains: [],
      tenant_allowed_domains: {},
    };
    return cachedPolicy;
  }
  const raw = safeReadFile(policyPath, { encoding: 'utf8' }) as string;
  const parsed = JSON.parse(raw) as EgressPolicyFile;
  const modeOverride = process.env.KYBERION_EGRESS_POLICY?.trim();
  cachedPolicyPath = policyPath;
  cachedPolicy = {
    version: parsed.version || '1',
    mode:
      modeOverride === 'enforce'
        ? 'enforce'
        : modeOverride === 'warn'
          ? 'warn'
          : parsed.mode === 'enforce'
            ? 'enforce'
            : 'warn',
    manual_allowed_domains: Array.isArray(parsed.manual_allowed_domains)
      ? parsed.manual_allowed_domains
      : [],
    blocked_domains: Array.isArray(parsed.blocked_domains) ? parsed.blocked_domains : [],
    tenant_allowed_domains:
      parsed.tenant_allowed_domains && typeof parsed.tenant_allowed_domains === 'object'
        ? parsed.tenant_allowed_domains
        : {},
    ...(Array.isArray(parsed.link_allowed_domains)
      ? { link_allowed_domains: parsed.link_allowed_domains }
      : {}),
  };
  return cachedPolicy;
}

export function loadAllowedEgressDomains(): string[] {
  if (cachedAllowedDomains) return cachedAllowedDomains;

  const domains = new Set<string>();
  const addDomain = (value: string | undefined | null) => {
    const normalized = normalizeDomain(value);
    if (normalized) domains.add(normalized);
  };

  try {
    const securityPolicy = JSON.parse(
      safeReadFile(SECURITY_POLICY_PATH, { encoding: 'utf8' }) as string
    ) as {
      network_guardrails?: { allowed_domains?: string[] };
    };
    for (const domain of securityPolicy.network_guardrails?.allowed_domains ?? []) {
      addDomain(domain);
    }
  } catch {
    /* fall through */
  }

  try {
    const catalog = loadServiceEndpointsCatalog();
    for (const record of Object.values(catalog.services || {})) {
      for (const domain of extractDomainsFromEndpointRecord(record.base_url)) {
        addDomain(domain);
      }
    }
  } catch {
    /* fall through */
  }

  const policy = loadEgressPolicy();
  for (const domain of policy.manual_allowed_domains ?? []) {
    addDomain(domain);
  }

  cachedAllowedDomains = Array.from(domains).sort();
  return cachedAllowedDomains;
}

/**
 * SA-04 Task 2: what tier of material this request carries, and for whom.
 *
 * Supplied by callers that knowingly move tenant data outward. Absent it the
 * evaluation behaves exactly as before, so existing callers are unaffected.
 */
export interface EgressPayloadContext {
  /** Most sensitive tier represented in the payload. */
  tier?: 'public' | 'confidential' | 'personal';
  /** Tenant the material belongs to, when tier is above public. */
  tenant_slug?: string;
  /** Short description of what is being sent, for the audit trail. */
  purpose?: string;
  /** Observation-derived taint; when present it is stricter than tier alone. */
  provenance?: ProvenanceTaint;
}

/**
 * Carry a trusted egress context through SDK/preset calls that eventually use
 * secureFetch. An explicit secureFetch context still wins for fields it sets,
 * while the ambient provenance is retained when the caller only adds a tier.
 */
export function withEgressPayloadContext<T>(context: EgressPayloadContext, fn: () => T): T {
  return egressContextStorage.run(context, fn);
}

export function getEgressPayloadContext(): EgressPayloadContext | undefined {
  return egressContextStorage.getStore();
}

export function resolveEgressPayloadContext(
  explicit?: EgressPayloadContext
): EgressPayloadContext | undefined {
  const ambient = getEgressPayloadContext();
  if (!ambient) return explicit;
  if (!explicit) return ambient;
  return {
    ...ambient,
    ...explicit,
    ...(explicit.tier === undefined ? { tier: ambient.tier } : {}),
    ...(explicit.tenant_slug === undefined ? { tenant_slug: ambient.tenant_slug } : {}),
    ...(explicit.purpose === undefined ? { purpose: ambient.purpose } : {}),
    ...(explicit.provenance === undefined ? { provenance: ambient.provenance } : {}),
  };
}

export function evaluateEgressPolicy(
  url: string,
  context?: EgressPayloadContext
): EgressPolicyDecision {
  const policy = loadEgressPolicy();
  const hostname = safeHostname(url);
  if (!hostname) {
    return {
      verdict: 'deny',
      hostname: '',
      reason: 'Missing or invalid URL for egress policy.',
      mode: policy.mode || 'warn',
    };
  }

  if (context?.tenant_slug && !isValidTenantSlug(context.tenant_slug)) {
    return {
      verdict: 'deny',
      hostname,
      reason: `[TENANT_SCOPE_INVALID] '${context.tenant_slug}' is not a valid tenant slug.`,
      mode: policy.mode || 'warn',
      tier: context.tier,
    };
  }

  const blocked = new Set(
    (policy.blocked_domains ?? [])
      .map((domain) => normalizeDomain(domain))
      .filter(Boolean) as string[]
  );
  if ([...blocked].some((domain) => matchesDomain(hostname, domain))) {
    const matchedDomain = [...blocked].find((domain) => matchesDomain(hostname, domain));
    return {
      verdict: 'deny',
      hostname,
      matchedDomain,
      reason: `Egress to blocked domain is denied: ${matchedDomain || hostname}`,
      mode: policy.mode || 'warn',
    };
  }

  // Confidential and personal material is denied unless the destination is
  // explicitly allowed for that tenant. This gate is intentionally independent
  // of `policy.mode`: the warn mode exists so an unlisted *public* host does
  // not break a workflow, and letting it also soften tenant data leaving the
  // box would defeat the point of having tiers at all.
  const tier = context?.tier;
  const provenance = context?.provenance;
  if (provenance) {
    const provenanceRank: Record<'public' | 'confidential' | 'personal', number> = {
      public: 0,
      confidential: 1,
      personal: 2,
    };
    const requestedTier = tier || provenance.highestTier;
    const wrongTenant = Boolean(
      provenance.tenants.length > 0 &&
      (!context?.tenant_slug || !provenance.tenants.includes(context.tenant_slug))
    );
    if (
      provenance.prohibitExternal ||
      wrongTenant ||
      provenanceRank[requestedTier] < provenanceRank[provenance.highestTier]
    ) {
      return {
        verdict: 'deny',
        hostname,
        reason: `[PROVENANCE_EGRESS_DENIED] ${provenance.prohibitExternal ? 'non-public provenance cannot leave the governed context' : wrongTenant ? 'target tenant is outside provenance scope' : 'payload tier is broader than provenance taint'}`,
        mode: policy.mode || 'warn',
        tier: requestedTier,
      };
    }
  }
  if (tier === 'confidential' || tier === 'personal') {
    const tenantDomains = loadTenantEgressDomains(policy, context?.tenant_slug);
    const matched = tenantDomains.find((domain) => matchesDomain(hostname, domain));
    if (!matched) {
      return {
        verdict: 'deny',
        hostname,
        reason: `[TIER_EGRESS_DENIED] ${tier} material${
          context?.tenant_slug ? ` for tenant ${context.tenant_slug}` : ''
        } may not be sent to ${hostname}. Add the host to that tenant's allowed egress domains if this is intended.`,
        mode: policy.mode || 'warn',
        tier,
      };
    }
    return {
      verdict: 'allow',
      hostname,
      matchedDomain: matched,
      reason: `Egress of ${tier} material allowed to tenant-approved host ${matched}`,
      mode: policy.mode || 'warn',
      tier,
    };
  }

  const allowedDomains = loadAllowedEgressDomains();
  const matchedDomain = allowedDomains.find((domain) => matchesDomain(hostname, domain));
  if (matchedDomain) {
    return {
      verdict: 'allow',
      hostname,
      matchedDomain,
      reason: `Egress allowed for ${matchedDomain}`,
      mode: policy.mode || 'warn',
    };
  }

  return {
    verdict: policy.mode === 'enforce' ? 'deny' : 'warn',
    hostname,
    reason: `Egress host is not allowlisted: ${hostname}. Add it to egress-policy.json or security-policy.json.`,
    mode: policy.mode || 'warn',
  };
}

/**
 * Destinations approved for a tenant's confidential material.
 *
 * Deliberately does NOT fall back to the general allowlist: a host being fine
 * for public traffic says nothing about whether a tenant's confidential deck
 * may be sent there.
 */
function loadTenantEgressDomains(policy: EgressPolicyFile, tenantSlug?: string): string[] {
  const table = policy.tenant_allowed_domains ?? {};
  const domains = new Set<string>();
  for (const domain of table['*'] ?? []) {
    const normalized = normalizeDomain(domain);
    if (normalized) domains.add(normalized);
  }
  if (tenantSlug && isValidTenantSlug(tenantSlug)) {
    const tenantDomains = Object.prototype.hasOwnProperty.call(table, tenantSlug)
      ? table[tenantSlug]
      : [];
    for (const domain of tenantDomains ?? []) {
      const normalized = normalizeDomain(domain);
      if (normalized) domains.add(normalized);
    }
  }
  return Array.from(domains);
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function normalizeDomain(domain: string | undefined | null): string {
  return String(domain || '')
    .trim()
    .toLowerCase()
    .replace(/^\.+/, '');
}

function matchesDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function extractDomainsFromEndpointRecord(baseUrl?: string): string[] {
  if (!baseUrl || typeof baseUrl !== 'string') return [];
  const rewritten = baseUrl.replace(/\{\{[^}]+\}\}/g, 'placeholder');
  try {
    const hostname = new URL(rewritten).hostname.toLowerCase();
    const parts = hostname.split('.').filter(Boolean);
    const domains = new Set<string>();
    if (parts.length >= 2) {
      domains.add(parts.slice(-2).join('.'));
    }
    domains.add(hostname);
    return Array.from(domains);
  } catch {
    return [];
  }
}
