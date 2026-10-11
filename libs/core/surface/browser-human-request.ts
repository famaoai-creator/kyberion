/** Request-only bridge from verified browser authentication to canonical human ownership. */
import { verifiedBrowserSessionIdentity } from '../authn-providers.js';
import type { ResolvedPrincipal } from '../authn-principal-resolver.js';
import { auditChain } from '../governance/audit-chain.js';
import type { SurfaceViewerScope } from './surface-viewer-scope-contract.js';
import {
  denyVerifiedHumanIdentity,
  denyVerifiedHumanScope,
} from './verified-human-request-contract.js';
import {
  resolveVerifiedBrowserHumanRequestIdentity,
  type HumanRequestNarrowing,
  type VerifiedHumanRequestResolution,
} from './verified-human-request-identity.js';
import type { HumanRequestRuntimeConfig } from './human-request-runtime-config.js';
import type { MemberRegistryPathOptions } from '../organization/member-registry.js';

function intersect(
  allowed: readonly string[] | 'all',
  restriction: readonly string[] | 'all'
): string[] | 'all' {
  if (allowed === 'all') return restriction === 'all' ? 'all' : [...restriction];
  return restriction === 'all'
    ? [...allowed]
    : allowed.filter((item) => restriction.includes(item));
}

/** Undefined means an unchanged legacy path. A selected canonical path never falls back on error. */
export function resolveBrowserHumanRequestIdentity(
  viewer: SurfaceViewerScope & { principal?: ResolvedPrincipal },
  config: HumanRequestRuntimeConfig,
  narrowing: HumanRequestNarrowing = {},
  dependencies: { memberRegistry?: MemberRegistryPathOptions; now?: number } = {}
): VerifiedHumanRequestResolution | undefined {
  if (config.browser?.enabled !== true || viewer.principal?.provider !== 'browser-session')
    return undefined;
  const proof = verifiedBrowserSessionIdentity(viewer.principal);
  if (!proof || !config.policy || !config.browser.operationScopes) denyVerifiedHumanIdentity();
  // Authentication restrictions and selected viewer scope remain authoritative.
  // In particular, canonical ownership must not recover tenants/tier access removed earlier.
  const tenants = intersect(config.policy.tenantSlugs, viewer.tenantSlugs);
  if (tenants === 'all') denyVerifiedHumanScope();
  const result = resolveVerifiedBrowserHumanRequestIdentity({
    enabled: true,
    proof,
    now: dependencies.now,
    memberRegistry: dependencies.memberRegistry,
    oauthScopes: config.browser.operationScopes,
    narrowing,
    policy: {
      authorityNamespace: config.policy.authorityNamespace,
      tenantSlugs: tenants,
      organizationIds: intersect(config.policy.organizationIds, viewer.organizationIds),
      projectIds: intersect(config.policy.projectIds, viewer.projectIds),
      tierAccess: config.policy.tierAccess.filter((tier) => viewer.tierAccess.includes(tier)),
    },
  });
  if (
    viewer.memberId !== result.viewer.memberId ||
    viewer.principal.memberId !== result.viewer.memberId
  )
    denyVerifiedHumanIdentity();
  return result;
}

export interface BrowserHumanRequestAudit {
  operation: 'receive' | 'result' | 'history';
  memberId: string;
  issuer: string;
  subject: string;
  tenant: string;
  requestId?: string;
  transport: 'browser-session';
}
function defaultAudit(event: BrowserHumanRequestAudit): void {
  auditChain.record({
    agentId: 'user:' + event.memberId,
    action: 'browser_human_request',
    operation: event.operation,
    result: 'allowed',
    correlationId: event.requestId,
    tenantSlug: event.tenant,
    metadata: { ...event },
  });
}

/** Permission and audit must succeed before any request/history operation. No best-effort fallback. */
export function authorizeBrowserHumanRequest(
  identity: VerifiedHumanRequestResolution,
  operation: BrowserHumanRequestAudit['operation'],
  requestId?: string,
  audit: (event: BrowserHumanRequestAudit) => void = defaultAudit
): void {
  const needed = operation === 'receive' ? 'surface.headless.write' : 'surface.headless.read';
  const tenants = identity.viewer.tenantSlugs;
  if (!identity.permissions.includes(needed) || tenants === 'all' || tenants.length !== 1)
    denyVerifiedHumanScope();
  audit({
    operation,
    memberId: identity.viewer.memberId!,
    issuer: identity.transportEvidence.issuer,
    subject: identity.transportEvidence.subject,
    tenant: tenants[0],
    requestId,
    transport: 'browser-session',
  });
}
