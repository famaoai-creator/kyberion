import { parseBlocks, terraformToTopologyIr } from './terraform-topology.js';
import type { TerraformBlock, TerraformTopologyIr } from './topology-ir.js';
import { collectIngressImpl, RESOURCE_RULES, type RuleCtx } from './terraform-asset-rules.js';
import {
  DATA_STORE_RE,
  DNS_RECORD_TYPES,
  isDynamicValue,
  makeSignal,
  nestedBlocks,
  parseList,
  providerKind,
  providerServiceName,
  recordServiceHints,
  topLevelAttrs,
  unquote,
} from './terraform-asset-primitives.js';
import * as path from 'node:path';

/**
 * Terraform → External Asset Inventory.
 *
 * Classifies Terraform blocks into an inventory model aligned with the
 * external-asset-inventory procedure (knowledge/public/procedures/system/
 * external-asset-inventory.md): provider-derived external services, publicly
 * exposed resource candidates, open-ingress findings, DNS-derived service
 * hints, data stores, module sources, and unresolved dynamic references.
 *
 * Design follows the attribute-granular evidence style used by Trivy (AVD-*)
 * and Checkov: every classification carries the attribute and observed value
 * that produced it, so downstream registry writing stays auditable.
 *
 * Layout: shared attribute/table primitives → terraform-asset-primitives.ts;
 * declarative classification rules → terraform-asset-rules.ts; this file keeps
 * the inventory types and the walk engine.
 *
 * Extension points:
 * - New resource-type exposure rules → append to RESOURCE_RULES in
 *   terraform-asset-rules.ts (declarative match/apply; no dispatcher edits).
 * - New providers → providerKind/PROVIDER_NAME_ALIASES tables (primitives).
 * - New CIDR/port attribute spellings → CIDR_ATTR_NAMES / PORT_ATTR_NAMES
 *   (rules).
 * - New IaC formats → produce IaCAssetInventory from another extractor op and
 *   share the generic sections (services/candidates/ingress/data_stores).
 */

export type ExposureConfidence = 'declared-public' | 'structurally-public' | 'indirect' | 'dynamic';
export type ExposureLevel = 'public' | 'public-candidate' | 'internal' | 'unknown';

export type ExposureSignal = {
  rule: string;
  attribute: string;
  value: string;
  confidence: ExposureConfidence;
  note?: string;
};

export type PublicCandidate = {
  resource: string;
  resource_type: string;
  exposure: ExposureLevel;
  signals: ExposureSignal[];
};

export type IngressFinding = {
  resource: string;
  rule_source: 'inline' | 'resource';
  open_to_world: boolean;
  cidrs: string[];
  protocol: string;
  ports: { from: number | null; to: number | null } | 'all' | 'dynamic' | 'unspecified';
  sensitive_ports: string[];
};

export type DnsRecordInfo = {
  resource: string;
  record_type: string;
  name: string;
  values: string[];
  service_hints: string[];
};

export type ExternalServiceCandidate = {
  service: string;
  kind: 'cloud' | 'saas' | 'platform' | 'utility';
  via: Array<'provider' | 'dns' | 'module'>;
  evidence: string[];
};

export type DataStoreInfo = {
  resource: string;
  resource_type: string;
  public_signals: ExposureSignal[];
};

export type BackendInfo = { backend: string; block_id: string; attributes: Record<string, string> };
export type ModuleSourceInfo = {
  module: string;
  source: string;
  source_kind: 'local' | 'registry' | 'git' | 'vcs' | 'object-store' | 'unknown';
  version?: string;
};
export type OutputInfo = { output: string; block_id: string; value: string; url_like: boolean };
export type ProviderSource = { name: string; source: string; version?: string; block_id: string };

/**
 * IaC-agnostic asset inventory. `external_services`, `public_candidates`,
 * `ingress_findings`, `dns_records` and `data_stores` are format-agnostic;
 * `backends`, `module_sources`, `required_providers` and `unresolved_refs`
 * are Terraform-derived. Other IaC extractors (CloudFormation, Pulumi state,
 * CDK synth) should produce the same IR so downstream ledger mapping is shared.
 */
export type IaCAssetInventory = {
  kind: 'terraform_asset_inventory';
  version: '1.0.0';
  source_kind: 'terraform';
  source_root: string;
  title: string;
  external_services: ExternalServiceCandidate[];
  public_candidates: PublicCandidate[];
  ingress_findings: IngressFinding[];
  dns_records: DnsRecordInfo[];
  data_stores: DataStoreInfo[];
  backends: BackendInfo[];
  module_sources: ModuleSourceInfo[];
  outputs: OutputInfo[];
  required_providers: ProviderSource[];
  unresolved_refs: string[];
  stats: {
    tf_files: number;
    blocks: number;
    provider_kinds: string[];
    resource_kinds: number;
  };
};

function classifyResource(
  block: TerraformBlock,
  unresolved: string[]
): { signals: ExposureSignal[]; ingress: IngressFinding[] } {
  const ctx = {} as RuleCtx;
  Object.assign(ctx, {
    block,
    t: block.type,
    attrs: topLevelAttrs(block.body),
    signals: [] as ExposureSignal[],
    ingress: [] as IngressFinding[],
    unresolved,
    markDynamic: (attr: string) => {
      if (isDynamicValue(ctx.attrs[attr])) ctx.unresolved.push(`${block.id}::${attr}`);
    },
    collectIngress: (srcBody: string, ruleSource: 'inline' | 'resource', label: string) => {
      collectIngressImpl(ctx, srcBody, ruleSource, label);
    },
  });
  for (const rule of RESOURCE_RULES) {
    const kinds = rule.kinds ?? ['resource'];
    if (!kinds.includes(block.kind as 'resource' | 'data')) continue;
    const m =
      typeof rule.match === 'string'
        ? rule.match === ctx.t
        : typeof rule.match === 'function'
          ? rule.match(ctx.t)
          : rule.match.test(ctx.t);
    if (m) rule.apply(ctx);
  }
  return { signals: ctx.signals, ingress: ctx.ingress };
}

function exposureLevel(signals: ExposureSignal[]): ExposureLevel {
  if (signals.some((s) => s.confidence === 'declared-public')) return 'public';
  const positive = signals.filter(
    (s) =>
      (s.confidence === 'structurally-public' || s.confidence === 'indirect') &&
      !/_INTERNAL$|_DISABLED$|_PRIVATE$|_IAM$/.test(s.rule)
  );
  if (positive.length > 0) return 'public-candidate';
  if (signals.some((s) => /_INTERNAL$|_DISABLED$|_PRIVATE$|_IAM$/.test(s.rule))) return 'internal';
  return 'unknown';
}

function dnsRecordInfo(
  block: TerraformBlock,
  spec: (typeof DNS_RECORD_TYPES)[number]
): DnsRecordInfo {
  const attrs = topLevelAttrs(block.body);
  const values = spec.valueAttrs.flatMap((a) => parseList(attrs[a]));
  const recordType = spec.typeAttr
    ? unquote(attrs[spec.typeAttr]).toUpperCase()
    : block.type
        .replace(/^azurerm_dns_/, '')
        .replace(/_record$/, '')
        .toUpperCase();
  return {
    resource: block.id,
    record_type: recordType || 'UNKNOWN',
    name: unquote(attrs[spec.nameAttr || 'name'] || ''),
    values,
    service_hints: recordServiceHints(recordType, values),
  };
}

function classifyModuleSource(source: string): ModuleSourceInfo['source_kind'] {
  if (/^\.\.?\//.test(source)) return 'local';
  if (/^git::|\.git$|github\.com|gitlab\.com|bitbucket\.org/.test(source)) return 'git';
  if (/^s3::|^gcs::/.test(source)) return 'object-store';
  if (/^[a-z0-9-]+\/[a-z0-9-]+\/(aws|azurerm|google|gcp|azure|oci)/i.test(source))
    return 'registry';
  if (/\//.test(source)) return 'registry';
  return 'unknown';
}

/** Backward-compatible name; canonical type is {@link IaCAssetInventory}. */
export type TerraformAssetInventory = IaCAssetInventory;

export function terraformIrToAssetInventory(ir: TerraformTopologyIr): IaCAssetInventory {
  const unresolved: string[] = [];
  const publicCandidates: PublicCandidate[] = [];
  const ingressFindings: IngressFinding[] = [];
  const dnsRecords: DnsRecordInfo[] = [];
  const dataStores: DataStoreInfo[] = [];
  const backends: BackendInfo[] = [];
  const pushBackend = (b: BackendInfo) => {
    // Same backend declared in sibling terraform blocks/files of one dir —
    // it is one logical backend, not two.
    if (!backends.some((x) => x.backend === b.backend && x.block_id === b.block_id))
      backends.push(b);
  };
  const moduleSources: ModuleSourceInfo[] = [];
  const outputs: OutputInfo[] = [];
  const requiredProviders: ProviderSource[] = [];
  const serviceEvidence = new Map<string, ExternalServiceCandidate>();
  const providerKinds = new Set<string>();

  const KIND_PRIORITY: ExternalServiceCandidate['kind'][] = [
    'cloud',
    'saas',
    'platform',
    'utility',
  ];
  const noteService = (
    service: string,
    kind: ExternalServiceCandidate['kind'],
    via: ExternalServiceCandidate['via'][number],
    evidence: string
  ) => {
    const cur = serviceEvidence.get(service) || { service, kind, via: [], evidence: [] };
    if (KIND_PRIORITY.indexOf(kind) < KIND_PRIORITY.indexOf(cur.kind)) cur.kind = kind;
    if (!cur.via.includes(via)) cur.via.push(via);
    if (!cur.evidence.includes(evidence)) cur.evidence.push(evidence);
    serviceEvidence.set(service, cur);
  };

  // allBlocks can contain the same file twice (module source dirs are
  // re-parsed on top of the recursive root scan). filePath may be relative or
  // absolute across the two passes, so dedupe on dir-qualified id + basename —
  // same file twice collapses, same-shaped blocks in sibling files survive.
  const seenBlockIds = new Set<string>();
  const blocks = ir.allBlocks.filter((b) => {
    const key = `${b.id}::${path.basename(b.filePath)}`;
    return seenBlockIds.has(key) ? false : (seenBlockIds.add(key), true);
  });

  // ---- cross-resource attachment joins ---------------------------------
  // A "guard" is a resource whose rules can be world-open (SG/NSG/firewall).
  // The join shape differs per provider:
  //   AWS:   rules reference `aws_security_group.<name>.id`; attachables list
  //          guards in security_groups/vpc_security_group_ids.
  //   Azure: standalone rules name the NSG via `network_security_group_name`
  //          (literal or `azurerm_network_security_group.<name>.name` ref);
  //          `*_security_group_association` resources bind NSGs to NICs/subnets.
  //   GCP:   firewall `target_tags` link to instance `tags`; a firewall with
  //          no target_tags applies to every instance in its network.
  const openGuards = new Set<string>(); // `${dir}::${type}.${name}`
  const openNsgLiteralNames = new Set<string>(); // `${dir}::${literalName}`
  const openFirewallSpecs: Array<{ dir: string; tags: string[]; network: string; id: string }> = [];
  const exposedAttachables = new Map<string, ExposureSignal[]>(); // block.id -> join signals

  const pushExpose = (
    targetId: string,
    rule: string,
    attribute: string,
    value: string,
    note: string
  ) => {
    const list = exposedAttachables.get(targetId) || [];
    list.push(makeSignal(rule, attribute, value, 'indirect', note));
    exposedAttachables.set(targetId, list);
  };

  const sgRuleTargetRe =
    /(aws_security_group|aws_default_security_group|azurerm_network_security_group)\.([\w-]+)\./g;
  for (const block of blocks) {
    if (block.kind !== 'resource') continue;
    const { signals } = classifyResource(block, unresolved);
    const hasOpen = signals.some((s) => s.rule === 'EXPOSURE_OPEN_INGRESS');
    if (!hasOpen) continue;
    const t = block.type;
    if (
      /^aws_(security_group|default_security_group)$/.test(t) ||
      t === 'azurerm_network_security_group'
    ) {
      openGuards.add(`${block.dir}::${t}.${block.name}`);
      continue;
    }
    if (t === 'aws_security_group_rule' || t === 'aws_vpc_security_group_ingress_rule') {
      // \b keeps `referenced_security_group_id`/`source_security_group_id`
      // (traffic *source* groups) from being mistaken for the rule's target SG.
      const sgRef = block.body.match(/\bsecurity_group_id\s*=\s*"?([^"\n]+)/);
      if (sgRef) {
        for (const m of sgRef[1].matchAll(sgRuleTargetRe)) {
          openGuards.add(`${block.dir}::${m[1]}.${m[2]}`);
        }
      }
      continue;
    }
    if (t === 'azurerm_network_security_rule') {
      const nsgName = topLevelAttrs(block.body)['network_security_group_name'] || '';
      const refMatch = [...nsgName.matchAll(sgRuleTargetRe)];
      if (refMatch.length > 0) {
        for (const m of refMatch) openGuards.add(`${block.dir}::${m[1]}.${m[2]}`);
      } else {
        const literal = unquote(nsgName);
        if (literal && literal !== nsgName.trim() && !isDynamicValue(nsgName)) {
          openNsgLiteralNames.add(`${block.dir}::${literal}`);
        }
      }
      continue;
    }
    if (t === 'google_compute_firewall') {
      const a = topLevelAttrs(block.body);
      openFirewallSpecs.push({
        dir: block.dir,
        tags: parseList(a['target_tags']),
        network: unquote(a['network'] || 'default'),
        id: block.id,
      });
    }
  }

  // Azure literal-name resolution: a standalone rule's `network_security_group_name`
  // string joins to the NSG resource whose `name` attr equals it (same dir).
  for (const block of blocks) {
    if (block.kind !== 'resource' || block.type !== 'azurerm_network_security_group') continue;
    const nameAttr = unquote(topLevelAttrs(block.body)['name'] || '');
    if (nameAttr && openNsgLiteralNames.has(`${block.dir}::${nameAttr}`)) {
      openGuards.add(`${block.dir}::azurerm_network_security_group.${block.name}`);
    }
  }

  // Attachables: AWS resource refs, Azure associations, GCP tag/network links.
  const SG_ATTACHABLE =
    /^aws_(instance|launch_configuration|launch_template|elb|lb|alb|db_instance|redshift_cluster|elasticache_cluster)$/;
  const AZURE_ASSOC = /^azurerm_(network_interface|subnet)_security_group_association$/;
  for (const block of blocks) {
    if (block.kind !== 'resource') continue;
    const t = block.type;
    const attrs = topLevelAttrs(block.body);

    if (SG_ATTACHABLE.test(t)) {
      const attachBlob = `${attrs['security_groups'] || ''} ${attrs['vpc_security_group_ids'] || ''}`;
      for (const m of attachBlob.matchAll(sgRuleTargetRe)) {
        if (openGuards.has(`${block.dir}::${m[1]}.${m[2]}`)) {
          pushExpose(
            block.id,
            'EXPOSURE_VIA_OPEN_SG',
            'security_groups',
            `${m[1]}.${m[2]}`,
            'attached security group allows world-open ingress'
          );
        }
      }
    }

    if (AZURE_ASSOC.test(t)) {
      const nsgRef = attrs['network_security_group_id'] || '';
      for (const m of nsgRef.matchAll(sgRuleTargetRe)) {
        if (!openGuards.has(`${block.dir}::${m[1]}.${m[2]}`)) continue;
        pushExpose(
          block.id,
          'EXPOSURE_VIA_OPEN_NSG',
          'network_security_group_id',
          `${m[1]}.${m[2]}`,
          'association binds a world-open NSG'
        );
        const targetRef = attrs['network_interface_id'] || attrs['subnet_id'] || '';
        const tm = targetRef.match(/(azurerm_[\w]+)\.([\w-]+)\.id/);
        if (tm) {
          pushExpose(
            `${block.dir}::resource.${tm[1]}.${tm[2]}`,
            'EXPOSURE_VIA_OPEN_NSG',
            'network_security_group_id',
            `${m[1]}.${m[2]}`,
            'attached NSG allows world-open ingress'
          );
        }
      }
    }

    if (/^google_compute_instance(_template)?$/.test(t)) {
      const tags = parseList(attrs['tags']);
      let instanceNet = 'default';
      for (const ni of nestedBlocks(block.body, 'network_interface')) {
        const nAttrs = topLevelAttrs(ni);
        const n = unquote(nAttrs['network'] || nAttrs['subnetwork'] || '');
        if (n) {
          instanceNet = n;
          break;
        }
      }
      for (const fw of openFirewallSpecs) {
        if (fw.dir !== block.dir) continue;
        const hit =
          fw.tags.length > 0
            ? fw.tags.some((tag) => tags.includes(tag))
            : fw.network === instanceNet;
        if (hit) {
          pushExpose(
            block.id,
            'EXPOSURE_VIA_OPEN_FIREWALL',
            'tags/network',
            fw.id,
            'attached firewall allows world-open ingress'
          );
        }
      }
    }
  }

  for (const block of blocks) {
    if (block.kind === 'provider') {
      providerKinds.add(block.type);
      noteService(providerServiceName(block.type), providerKind(block.type), 'provider', block.id);
      continue;
    }
    if (block.kind === 'data') {
      const provider = block.type.split('_')[0];
      providerKinds.add(provider);
      noteService(providerServiceName(provider), providerKind(provider), 'provider', block.id);
      if (block.type === 'terraform_remote_state') {
        const a = topLevelAttrs(block.body);
        const backendType = unquote(a['backend'] || 'unknown');
        const config = nestedBlocks(block.body, 'config').map(topLevelAttrs);
        pushBackend({
          backend: `remote-state:${backendType}`,
          block_id: block.id,
          attributes: Object.assign({}, ...config),
        });
      }
      // Data sources can carry policy content (aws_iam_policy_document) —
      // rules opt in via `kinds: ['resource', 'data']`.
      const { signals } = classifyResource(block, unresolved);
      if (signals.length > 0) {
        publicCandidates.push({
          resource: block.id,
          resource_type: block.type,
          exposure: exposureLevel(signals),
          signals,
        });
      }
      continue;
    }
    if (block.kind === 'resource') {
      const provider = block.type.split('_')[0];
      providerKinds.add(provider);
      noteService(providerServiceName(provider), providerKind(provider), 'provider', block.id);

      const { signals, ingress } = classifyResource(block, unresolved);

      // Attachment joins computed in the pre-pass (AWS SG / Azure NSG / GCP firewall).
      const attached = exposedAttachables.get(block.id);
      if (attached) signals.push(...attached);
      if (signals.length > 0) {
        publicCandidates.push({
          resource: block.id,
          resource_type: block.type,
          exposure: exposureLevel(signals),
          signals,
        });
      }
      ingressFindings.push(...ingress);

      const dnsSpec = DNS_RECORD_TYPES.find((d) => d.type.test(block.type));
      if (dnsSpec) {
        const rec = dnsRecordInfo(block, dnsSpec);
        dnsRecords.push(rec);
        for (const svc of rec.service_hints) noteService(svc, 'saas', 'dns', rec.resource);
      }
      if (DATA_STORE_RE.test(block.type)) {
        dataStores.push({ resource: block.id, resource_type: block.type, public_signals: signals });
      }
      continue;
    }
    if (block.kind === 'backend') {
      const attrs = Object.assign({}, ...nestedBlocks(block.body, 'backend').map(topLevelAttrs));
      pushBackend({ backend: block.type, block_id: block.id, attributes: attrs });
      continue;
    }
    if (block.kind === 'module') {
      const source = unquote(topLevelAttrs(block.body)['source'] || '');
      if (source) {
        const kind = classifyModuleSource(source);
        moduleSources.push({
          module: block.id,
          source,
          source_kind: kind,
          version: unquote(topLevelAttrs(block.body)['version'] || '') || undefined,
        });
        // Registry namespaces (terraform-aws-modules/vpc/aws) are not services;
        // only VCS/git hosts reveal an external service the org depends on.
        if (kind === 'git') {
          const hint = source
            .replace(/^(git::)?(https?:\/\/)?/, '')
            .split(/[/:]/)[0]
            .split('@')
            .pop()!
            .replace(/^www\./, '');
          if (
            /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(hint) &&
            !/^example\.(com|org|net)$|^localhost$/.test(hint)
          ) {
            noteService(hint.replace(/\.(com|io|net|org)$/, ''), 'saas', 'module', block.id);
          }
        }
      }
      continue;
    }
    if (block.kind === 'output') {
      const value = topLevelAttrs(block.body)['value'] || '';
      outputs.push({
        output: `output.${block.type}`,
        block_id: block.id,
        value,
        url_like: /https?:\/\/|[a-z0-9-]+\.(com|net|org|io|dev|app|co\.jp|jp)\b/i.test(value),
      });
      continue;
    }
    if (block.kind === 'terraform') {
      for (const cloud of nestedBlocks(block.body, 'cloud')) {
        pushBackend({
          backend: 'terraform-cloud',
          block_id: block.id,
          attributes: topLevelAttrs(cloud),
        });
        noteService('terraform-cloud', 'platform', 'provider', block.id);
      }
      for (const rp of nestedBlocks(block.body, 'required_providers')) {
        // topLevelAttrs keeps object values (`okta = { ... }`) distinct from
        // simple version strings (`aws = ">= 5.0"`).
        for (const [name, value] of Object.entries(topLevelAttrs(rp))) {
          const pushProvider = (source: string, version: string | undefined) => {
            // Same provider in sibling terraform blocks of the same dir is one
            // declaration; different dirs keep their own constraints.
            if (
              !requiredProviders.some(
                (p) => p.name === name && p.source === source && p.block_id === block.id
              )
            ) {
              requiredProviders.push({ name, source, version, block_id: block.id });
            }
          };
          if (value.startsWith('{')) {
            const src = (value.match(/source\s*=\s*"([^"]+)"/) || [])[1];
            const ver = (value.match(/version\s*=\s*"([^"]+)"/) || [])[1];
            pushProvider(src || `hashicorp/${name}`, ver);
            const svcName = (src || name).split('/').pop() || name;
            noteService(providerServiceName(svcName), providerKind(svcName), 'provider', block.id);
          } else {
            pushProvider(`hashicorp/${name}`, unquote(value));
            noteService(providerServiceName(name), providerKind(name), 'provider', block.id);
          }
        }
      }
    }
  }

  const externalServices = [...serviceEvidence.values()]
    .filter((s) => s.kind !== 'utility')
    .sort((a, b) => a.service.localeCompare(b.service));

  return {
    kind: 'terraform_asset_inventory',
    version: '1.0.0',
    source_kind: 'terraform',
    source_root: ir.source_root,
    title: ir.title,
    external_services: externalServices,
    public_candidates: publicCandidates.sort((a, b) => a.resource.localeCompare(b.resource)),
    ingress_findings: ingressFindings.sort((a, b) => a.resource.localeCompare(b.resource)),
    dns_records: dnsRecords.sort((a, b) => a.resource.localeCompare(b.resource)),
    data_stores: dataStores.sort((a, b) => a.resource.localeCompare(b.resource)),
    backends,
    module_sources: moduleSources,
    outputs,
    required_providers: requiredProviders,
    unresolved_refs: [...new Set(unresolved)].sort(),
    stats: {
      tf_files: ir.tfFiles.length,
      blocks: ir.allBlocks.length,
      provider_kinds: [...providerKinds].sort(),
      resource_kinds: new Set(ir.allBlocks.filter((b) => b.kind === 'resource').map((b) => b.type))
        .size,
    },
  };
}

export function terraformToAssetInventory(
  exampleRoot: string,
  options: { title?: string } = {}
): IaCAssetInventory {
  const ir = terraformToTopologyIr(exampleRoot, options);
  // `terraform {}` blocks (backend, required_providers) are intentionally kept
  // out of topology-ir's allBlocks; re-parse raw files to surface them here.
  const terraformBlocks = ir.tfFiles
    .flatMap((filePath) => parseBlocks(filePath, exampleRoot))
    .filter((b) => b.kind === 'terraform');
  return terraformIrToAssetInventory({ ...ir, allBlocks: [...ir.allBlocks, ...terraformBlocks] });
}
