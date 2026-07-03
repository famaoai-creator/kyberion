import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { loadServiceEndpointsCatalog } from './service-endpoint-registry.js';

export type EgressPolicyMode = 'warn' | 'enforce';

export interface EgressPolicyFile {
  version?: string;
  mode?: EgressPolicyMode;
  manual_allowed_domains?: string[];
  blocked_domains?: string[];
}

export interface EgressPolicyDecision {
  verdict: 'allow' | 'warn' | 'deny';
  hostname: string;
  reason: string;
  matchedDomain?: string;
  mode: EgressPolicyMode;
}

const DEFAULT_POLICY_PATH = pathResolver.knowledge('product/governance/egress-policy.json');
const SECURITY_POLICY_PATH = pathResolver.knowledge('product/governance/security-policy.json');

let cachedPolicyPath: string | null = null;
let cachedPolicy: EgressPolicyFile | null = null;
let cachedAllowedDomains: string[] | null = null;

export function resetEgressPolicyCache(): void {
  cachedPolicyPath = null;
  cachedPolicy = null;
  cachedAllowedDomains = null;
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

export function evaluateEgressPolicy(url: string): EgressPolicyDecision {
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
