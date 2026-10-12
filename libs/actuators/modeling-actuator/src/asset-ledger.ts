import type { IaCAssetInventory, PublicCandidate } from './terraform-asset-inventory.js';

/**
 * IaCAssetInventory → External Asset Ledger draft.
 *
 * Maps the evidence-carrying inventory IR onto the canonical ledger schema
 * defined in `knowledge/public/procedures/system/external-asset-inventory.md`
 * (Phase 2). The output is a *draft* — IaC can prove existence and exposure
 * signals, but cannot establish owner, contract, MFA, or data classification,
 * so every entry arrives `review_status: 'pending'` and `shadow` flags follow
 * the procedure's rule (unknown owner / no contract / shadow-only sources).
 * A governed facade or human review promotes drafts into the tenant-scoped
 * registry; this mapper never writes confidential state.
 */

export type LedgerCategory =
  | 'saas'
  | 'cloud'
  | 'vpn'
  | 'published-app'
  | 'api-integration'
  | 'data-store'
  /** Exposure findings on network controls (SG/NSG/firewall), not apps. */
  | 'network-control'
  /** Identity documents with privilege/trust risk (IAM policies/roles). */
  | 'identity';
export type LedgerExposure = 'public' | 'partner-restricted' | 'internal-only' | 'unknown';
export type LedgerReviewStatus = 'pending' | 'verified';

export interface LedgerProvenance {
  /** Operation that produced the inventory (e.g. `modeling:terraform_asset_inventory`). */
  source_op: string;
  /** Block ids / dns record ids that evidence the entry. */
  evidence: string[];
  /** Signal rule ids that motivated the entry (e.g. EXPOSURE_OPEN_INGRESS). */
  signal_rules: string[];
  /** Discovery path kinds reported by the inventory (provider/module/dns/...). */
  via: string[];
  /** Unresolved dynamic references attached to this entry's resource. */
  unresolved_refs: string[];
}

export interface ExternalAssetLedgerEntry {
  /** Normalized unique id (slug). `svc:` = external service, `asset:` = managed resource. */
  service_id: string;
  name: string;
  vendor?: string;
  category: LedgerCategory;
  endpoints: string[];
  exposure: LedgerExposure;
  data_classification: 'personal' | 'confidential' | 'public' | 'unknown';
  auth_method: 'sso' | 'local-password' | 'api-key' | 'federated' | 'unknown';
  mfa_status: 'enforced' | 'optional' | 'unavailable' | 'unknown';
  log_access: string;
  account_admin: string;
  owner?: string;
  department?: string;
  contract_ref: string;
  discovery_sources: string[];
  last_verified: string;
  shadow: boolean;
  review_status: LedgerReviewStatus;
  provenance: LedgerProvenance;
}

export interface ExternalAssetLedgerDraft {
  kind: 'external_asset_ledger_draft';
  version: '1.0.0';
  generated_from: { source_op: string; source_root: string; source_kind: string };
  as_of: string;
  entries: ExternalAssetLedgerEntry[];
  stats: {
    entries: number;
    services: number;
    published_apps: number;
    data_stores: number;
    network_controls: number;
    identities: number;
    shadow: number;
    pending: number;
  };
}

export interface LedgerDraftOptions {
  /** ISO date for `last_verified`/`as_of`; defaults to 'unverified'. */
  asOf?: string;
  /** Caller-supplied defaults when an org knows them (e.g. team owner). */
  owner?: string;
  department?: string;
  contractRef?: string;
  /** Discovery-source ids to record; defaults to ['S-8'] (IaC source). */
  discoverySources?: string[];
}

function slug(input: string): string {
  return input
    .toLowerCase()
    .replace(/::resource\./g, '.')
    .replace(/::/g, '.')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function resourceShortName(blockId: string): string {
  const m = blockId.match(/resource\.([\w-]+)\.([\w-]+)/);
  return m ? `${m[1]}.${m[2]}` : blockId;
}

function resourceDir(blockId: string): string {
  return blockId.split('::')[0] || '.';
}

function candidateToExposure(candidate: PublicCandidate): LedgerExposure {
  if (candidate.exposure === 'public') return 'public';
  if (candidate.exposure === 'internal') return 'internal-only';
  // public-candidate keeps honest doubt: evidence exists but unverified.
  return 'unknown';
}

/**
 * Transform an IaCAssetInventory into ledger draft entries.
 * Deterministic and side-effect free — safe for unit tests and pipelines.
 */
export function iacInventoryToLedgerDraft(
  inv: IaCAssetInventory,
  opts: LedgerDraftOptions = {}
): ExternalAssetLedgerDraft {
  const asOf = opts.asOf || 'unverified';
  const discoverySources = opts.discoverySources?.length ? opts.discoverySources : ['S-8'];
  const entries = new Map<string, ExternalAssetLedgerEntry>();

  // Same-dir url_like outputs become endpoint candidates for that dir's apps.
  const urlByDir = new Map<string, string[]>();
  // Outputs that reference endpoint-shaped resource attributes
  // (`${aws_elb.x.dns_name}` etc.) become endpoints on that resource's entry.
  const resourceEndpoints = new Map<string, string[]>();
  // Endpoint-shaped attribute names — `arn` is deliberately absent: it is an
  // identifier, not a network endpoint.
  const ENDPOINT_ATTR_RE =
    /^(dns_name|public_ip|public_ipv4|endpoint|domain|domain_name|fqdn|url|invoke_url|address|hostname)$/i;
  for (const o of inv.outputs) {
    const value = o.value.replace(/^"|"$/g, '');
    for (const m of value.matchAll(/([a-z_][a-z0-9_]*)\.([a-zA-Z0-9_-]+)\.([a-z_][a-z0-9_]*)/g)) {
      if (!ENDPOINT_ATTR_RE.test(m[3])) continue;
      const key = `${resourceDir(o.block_id)}::resource.${m[1]}.${m[2]}`;
      const list = resourceEndpoints.get(key) || [];
      if (!list.includes(value)) list.push(value);
      resourceEndpoints.set(key, list);
    }
    if (!o.url_like) continue;
    const dir = resourceDir(o.block_id);
    const list = urlByDir.get(dir) || [];
    if (!list.includes(value)) list.push(value);
    urlByDir.set(dir, list);
  }
  // DNS record names are public hostnames — endpoint evidence per dir.
  // Record values (CNAME targets etc.) attach to matching svc: entries below.
  const svcEndpoints = new Map<string, string[]>();
  for (const rec of inv.dns_records) {
    const dir = resourceDir(rec.resource);
    const name = rec.name || '';
    if (name) {
      const list = urlByDir.get(dir) || [];
      if (!list.includes(name)) list.push(name);
      urlByDir.set(dir, list);
    }
    for (const hint of rec.service_hints) {
      const list = svcEndpoints.get(`svc:${slug(hint)}`) || [];
      for (const v of rec.values) if (!list.includes(v)) list.push(v);
      svcEndpoints.set(`svc:${slug(hint)}`, list);
    }
  }

  const baseEntry = (
    id: string,
    name: string,
    category: LedgerCategory
  ): ExternalAssetLedgerEntry => ({
    service_id: id,
    name,
    category,
    endpoints: [],
    exposure: 'unknown',
    data_classification: 'unknown',
    auth_method: 'unknown',
    mfa_status: 'unknown',
    log_access: 'unknown',
    account_admin: 'unknown',
    ...(opts.owner ? { owner: opts.owner } : {}),
    ...(opts.department ? { department: opts.department } : {}),
    contract_ref: opts.contractRef || 'none',
    discovery_sources: [...discoverySources],
    last_verified: asOf,
    shadow: !(opts.owner && opts.contractRef),
    review_status: 'pending',
    provenance: {
      source_op:
        inv.kind === 'terraform_asset_inventory'
          ? 'modeling:terraform_asset_inventory'
          : `modeling:${inv.kind}`,
      evidence: [],
      signal_rules: [],
      via: [],
      unresolved_refs: [],
    },
  });

  const unresolvedByResource = new Map<string, string[]>();
  for (const ref of inv.unresolved_refs) {
    const blockId = ref.split('::').slice(0, -1).join('::');
    const list = unresolvedByResource.get(blockId) || [];
    list.push(ref);
    unresolvedByResource.set(blockId, list);
  }

  // External services → svc: entries.
  for (const svc of inv.external_services) {
    const entry = baseEntry(
      `svc:${slug(svc.service)}`,
      svc.service,
      svc.kind === 'cloud' ? 'cloud' : 'saas'
    );
    entry.vendor = svc.service;
    entry.exposure = 'unknown';
    entry.endpoints = [...(svcEndpoints.get(entry.service_id) || [])];
    entry.provenance.evidence.push(...svc.evidence);
    entry.provenance.via.push(...svc.via);
    entries.set(entry.service_id, entry);
  }

  // Terraform state backends: they hold the full infrastructure state, so
  // each one is a data-store entry that absolutely belongs on the ledger.
  for (const backend of inv.backends) {
    const entry = baseEntry(
      `asset:backend-${slug(backend.block_id)}`,
      `backend:${backend.backend}`,
      'data-store'
    );
    entry.endpoints = [];
    entry.provenance.evidence.push(backend.block_id);
    entries.set(entry.service_id, entry);
  }

  // Public candidates and data stores → asset: entries (merged on same resource).
  const NETWORK_CONTROL_RE =
    /security_group|network_security|compute_firewall|security_group_association|prefix_list|network_acl/;
  const IDENTITY_RE =
    /aws_iam_(policy|role|role_policy|user_policy|group_policy)|iam_policy|role_assignment/;
  const dataStoreIds = new Set(inv.data_stores.map((d) => d.resource));
  for (const candidate of inv.public_candidates) {
    const isDataStore = dataStoreIds.has(candidate.resource);
    const category: LedgerCategory = isDataStore
      ? 'data-store'
      : NETWORK_CONTROL_RE.test(candidate.resource_type)
        ? 'network-control'
        : IDENTITY_RE.test(candidate.resource_type)
          ? 'identity'
          : 'published-app';
    const entry = baseEntry(
      `asset:${slug(candidate.resource)}`,
      resourceShortName(candidate.resource),
      category
    );
    entry.exposure = candidateToExposure(candidate);
    entry.endpoints = [
      ...new Set([
        ...(urlByDir.get(resourceDir(candidate.resource)) || []),
        ...(resourceEndpoints.get(candidate.resource) || []),
      ]),
    ];
    entry.provenance.evidence.push(candidate.resource);
    entry.provenance.signal_rules.push(...candidate.signals.map((s) => s.rule));
    entry.provenance.unresolved_refs.push(...(unresolvedByResource.get(candidate.resource) || []));
    entries.set(entry.service_id, entry);
  }
  for (const ds of inv.data_stores) {
    const id = `asset:${slug(ds.resource)}`;
    if (entries.has(id)) continue; // merged above
    const entry = baseEntry(id, resourceShortName(ds.resource), 'data-store');
    entry.endpoints = [...(urlByDir.get(resourceDir(ds.resource)) || [])];
    entry.provenance.evidence.push(ds.resource);
    entries.set(id, entry);
  }

  const list = [...entries.values()].sort((a, b) => a.service_id.localeCompare(b.service_id));
  return {
    kind: 'external_asset_ledger_draft',
    version: '1.0.0',
    generated_from: {
      source_op:
        inv.kind === 'terraform_asset_inventory'
          ? 'modeling:terraform_asset_inventory'
          : `modeling:${inv.kind}`,
      source_root: inv.source_root,
      source_kind: inv.source_kind,
    },
    as_of: asOf,
    entries: list,
    stats: {
      entries: list.length,
      services: list.filter((e) => e.service_id.startsWith('svc:')).length,
      published_apps: list.filter((e) => e.category === 'published-app').length,
      data_stores: list.filter((e) => e.category === 'data-store').length,
      network_controls: list.filter((e) => e.category === 'network-control').length,
      identities: list.filter((e) => e.category === 'identity').length,
      shadow: list.filter((e) => e.shadow).length,
      pending: list.filter((e) => e.review_status === 'pending').length,
    },
  };
}
