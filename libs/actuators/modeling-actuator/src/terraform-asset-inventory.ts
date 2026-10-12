import { findMatchingBrace, parseBlocks, terraformToTopologyIr } from './terraform-topology.js';
import type { TerraformBlock, TerraformTopologyIr } from './topology-ir.js';
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
 * Extension points:
 * - New resource-type exposure rules → append to RESOURCE_RULES (declarative
 *   match/apply entries; no dispatcher edits).
 * - New providers → providerKind/PROVIDER_NAME_ALIASES tables.
 * - New CIDR/port attribute spellings → CIDR_ATTR_NAMES / PORT_ATTR_NAMES.
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

/* ------------------------------------------------------------------ */
/* HCL-ish attribute helpers (same brace-scan style as topology parser) */
/* ------------------------------------------------------------------ */

const ATTR_NAME_RE = /^([A-Za-z_][\w-]*)\s*=(?![=>])\s*/;

/**
 * Remove `#`/`//` line comments. `//` inside URLs (`https://`) is preserved by
 * requiring start-of-line or whitespace before the comment marker.
 */
function stripComments(text: string): string {
  return text.replace(/(^|[ \t])#[^\n]*/gm, '$1').replace(/(^|[ \t])\/\/[^\n]*/gm, '$1');
}

/** Extract `name = value` pairs at brace-depth 0 of `body`. Values are raw text. */
function topLevelAttrs(body: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const text = stripComments(body);
  const n = text.length;
  let i = 0;
  let depth = 0;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      i += 1;
      while (i < n && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      i += 1;
      continue;
    }
    // Skip `#` and `//` line comments (they never carry real attributes).
    if (c === '#' || (c === '/' && text[i + 1] === '/')) {
      while (i < n && text[i] !== '\n') i += 1;
      continue;
    }
    if (c === '{' || c === '[' || c === '(') {
      depth += 1;
      i += 1;
      continue;
    }
    if (c === '}' || c === ']' || c === ')') {
      depth = Math.max(0, depth - 1);
      i += 1;
      continue;
    }
    if (depth === 0) {
      const m = text.slice(i).match(ATTR_NAME_RE);
      if (m) {
        const valueStart = i + m[0].length;
        let j = valueStart;
        let vDepth = 0;
        let inStr = false;
        while (j < n) {
          const vc = text[j];
          if (inStr) {
            if (vc === '"' && text[j - 1] !== '\\') inStr = false;
          } else if (vc === '"') inStr = true;
          else if (vc === '[' || vc === '{' || vc === '(') vDepth += 1;
          else if (vc === ']' || vc === '}' || vc === ')') {
            if (vDepth === 0) break;
            vDepth -= 1;
          } else if (vDepth === 0) {
            if (vc === '\n') break;
            // `{ a = 1 b = 2 }` — same-line attributes are legal HCL: stop the
            // value when whitespace is followed by the next `name =` pair.
            if (
              (vc === ' ' || vc === '\t') &&
              /^\s+[A-Za-z_][\w-]*\s*=(?![=>])/.test(text.slice(j))
            )
              break;
          }
          j += 1;
        }
        if (!(m[1] in attrs)) attrs[m[1]] = text.slice(valueStart, j).trim();
        i = j + 1;
        continue;
      }
    }
    i += 1;
  }
  return attrs;
}

/** Extract inner bodies of nested `name { ... }` / `name "label" { ... }` blocks. */
function nestedBlocks(body: string, name: string): string[] {
  const stripped = stripComments(body);
  const out: string[] = [];
  // Matches `name {`, `name "label" {`, and the `dynamic "name" {` idiom.
  const re = new RegExp(
    `(?:^|[\\s,{])(?:${name}\\s*(?:"[^"]*"\\s*)*\\{|dynamic\\s+"${name}"\\s*\\{)`,
    'g'
  );
  for (const m of stripped.matchAll(re)) {
    const openIndex = (m.index || 0) + m[0].length - 1;
    const closeIndex = findMatchingBrace(stripped, openIndex);
    out.push(stripped.slice(openIndex + 1, closeIndex));
  }
  return out;
}

/** First raw value of `name = ...` anywhere in body (incl. nested). */
function attrAnywhere(body: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=(?![=>])\\s*(\\[[^\\]]*\\]|"[^"]*"|[^\\s,}\\n]+)`);
  const m = stripComments(body).match(re);
  return m ? m[1].trim() : undefined;
}

const REF_RE = /\b(?:var|local|data|module|each|count|self)\.[A-Za-z_]/;
const PUBLIC_CIDR_RE = /0\.0\.0\.0\/0|::\/0/;
const TRUTHY = /^\s*"?true"?\s*$/;
const FALSY = /^\s*"?false"?\s*$/;

function isDynamicValue(value: string | undefined): boolean {
  return value !== undefined && REF_RE.test(value);
}

/**
 * An attribute value that still contains an unquoted `type.name` reference
 * after quoted literals are removed — e.g. `[aws_vpc.main.cidr_block]` or a
 * mixed `["10.0.0.0/8", aws_x.y]` list that parseList only half-resolves.
 */
function containsUnquotedRef(value: string | undefined): boolean {
  if (!value) return false;
  const unquoted = value.replace(/"[^"]*"/g, '');
  return /\b[a-zA-Z_][\w-]*\.[a-zA-Z_][\w.-]*/.test(unquoted);
}

function unquote(value: string | undefined): string {
  if (!value) return '';
  return value.replace(/^"|"$/g, '');
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return [...value.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
}

/* -------------------------------------------------- */
/* Provider / service classification tables           */
/* -------------------------------------------------- */

const UTILITY_PROVIDERS = new Set([
  'null',
  'local',
  'random',
  'time',
  'archive',
  'template',
  'external',
  'http',
  'tls',
  'dns',
  'cloudinit',
  'assert',
  'localfile',
  'hashicorp',
]);

const PLATFORM_PROVIDERS = new Set([
  'kubernetes',
  'helm',
  'kubectl',
  'kustomize',
  'kustomization',
  'argocd',
  'flux',
  'docker',
  'consul',
  'vault',
  'nomad',
  'boundary',
  'tfe',
  'hcp',
  'terraform',
  'rancher2',
  'kind',
  'k3s',
]);

const CLOUD_PROVIDERS = new Set([
  'aws',
  'awscc',
  'azurerm',
  'azapi',
  'azuread',
  'azurestack',
  'google',
  'google-beta',
  'googleworkspace',
  'oci',
  'oraclepaas',
  'alicloud',
  'tencentcloud',
  'huaweicloud',
  'baiducloud',
  'jdcloud',
  'ucloud',
  'openstack',
  'scaleway',
  'vultr',
  'linode',
  'hcloud',
  'digitalocean',
  'exoscale',
  'ovh',
  'upcloud',
  'ionos',
  'equinix',
  'metal',
  'ibm',
  'yandex',
  'stackit',
  'sakuracloud',
  'nifcloud',
  'ecloud',
]);

function providerKind(name: string): ExternalServiceCandidate['kind'] {
  const base = name.toLowerCase().replace(/-beta$/, '');
  if (UTILITY_PROVIDERS.has(base)) return 'utility';
  if (PLATFORM_PROVIDERS.has(base)) return 'platform';
  if (CLOUD_PROVIDERS.has(base)) return 'cloud';
  return 'saas';
}

const PROVIDER_NAME_ALIASES: Record<string, string> = {
  azurerm: 'azure',
  azapi: 'azure',
  azurestack: 'azure',
  azuread: 'azure-ad',
  awscc: 'aws',
  'google-beta': 'google',
  googleworkspace: 'google-workspace',
  tfe: 'terraform-cloud',
  hcp: 'hashicorp-cloud-platform',
  oci: 'oracle-cloud',
  alicloud: 'alibaba-cloud',
  tencentcloud: 'tencent-cloud',
  huaweicloud: 'huawei-cloud',
  hcloud: 'hetzner',
};

function providerServiceName(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/-beta$/, '')
    .replace(/_/g, '-');
  return PROVIDER_NAME_ALIASES[base] || base;
}

/* -------------------------------------------------- */
/* Sensitive ports (conservative, scanner-informed)   */
/* -------------------------------------------------- */

const SENSITIVE_PORTS = new Map<number, string>([
  [21, 'ftp'],
  [22, 'ssh'],
  [23, 'telnet'],
  [25, 'smtp'],
  [111, 'rpcbind'],
  [135, 'msrpc'],
  [139, 'smb'],
  [389, 'ldap'],
  [445, 'smb'],
  [161, 'snmp'],
  [636, 'ldaps'],
  [1433, 'mssql'],
  [1521, 'oracle'],
  [2049, 'nfs'],
  [2375, 'docker'],
  [2376, 'docker-tls'],
  [2379, 'etcd'],
  [2380, 'etcd'],
  [3306, 'mysql'],
  [3389, 'rdp'],
  [4444, 'remote-shell'],
  [4505, 'salt'],
  [4506, 'salt'],
  [5432, 'postgres'],
  [5601, 'kibana'],
  [5900, 'vnc'],
  [5901, 'vnc'],
  [5985, 'winrm'],
  [5986, 'winrm-https'],
  [6379, 'redis'],
  [6443, 'kubernetes-api'],
  [8000, 'admin-common'],
  [8080, 'admin-proxy'],
  [8443, 'admin-tls'],
  [8888, 'jupyter'],
  [9000, 'sonarqube'],
  [9042, 'cassandra'],
  [9090, 'prometheus'],
  [9200, 'elasticsearch'],
  [9300, 'elasticsearch'],
  [10250, 'kubelet'],
  [10255, 'kubelet-ro'],
  [11211, 'memcached'],
  [15672, 'rabbitmq-admin'],
  [27017, 'mongodb'],
  [27018, 'mongodb'],
  [28015, 'rethinkdb'],
  [50070, 'hdfs'],
  [61616, 'activemq'],
]);

function portInRange(port: number, from: number, to: number): boolean {
  return port >= from && port <= to;
}

type PortSpec = { from: number; to: number } | 'all' | 'dynamic' | 'unspecified';

/** Parse one port token (`"22"`, `"80-443"`, `*`, `-1`) into a range or marker. */
function parsePortToken(
  raw: string
): { from: number; to: number } | 'all' | 'dynamic' | 'unspecified' {
  const v = raw.replace(/^"|"$/g, '').trim();
  if (v === '') return 'unspecified';
  if (v === '*' || /^-1$/.test(v) || /^all$/i.test(v)) return 'all';
  if (REF_RE.test(v)) return 'dynamic';
  const m = v.match(/^(\d+)(?:-(\d+))?$/);
  if (!m) return 'unspecified';
  const from = Number(m[1]);
  return { from, to: m[2] ? Number(m[2]) : from };
}

/** Merge port tokens from one or more raw attribute values (scalar or list). */
function parsePortAttrs(values: Array<string | undefined>): PortSpec {
  const tokens: string[] = [];
  let sawDynamic = false;
  for (const value of values) {
    if (value === undefined) continue;
    if (isDynamicValue(value)) sawDynamic = true;
    const list = parseList(value);
    tokens.push(...(list.length > 0 ? list : [value]));
  }
  if (tokens.length === 0) return sawDynamic ? 'dynamic' : 'unspecified';
  let min: number | null = null;
  let max: number | null = null;
  for (const token of tokens) {
    const p = parsePortToken(token);
    if (p === 'all') return 'all';
    if (p === 'dynamic') sawDynamic = true;
    else if (p !== 'unspecified') {
      min = min === null ? p.from : Math.min(min, p.from);
      max = max === null ? p.to : Math.max(max, p.to);
    }
  }
  if (min !== null && max !== null) return { from: min, to: max };
  return sawDynamic ? 'dynamic' : 'unspecified';
}

function sensitivePortsFor(ports: PortSpec, protocol: string): string[] {
  const sensitive = new Set<string>();
  if (/^"?-1"?$|^"?all"?$|^\*$/i.test(protocol) || ports === 'all') {
    sensitive.add('all-ports');
  } else if (typeof ports === 'object') {
    for (const [p, name] of SENSITIVE_PORTS) {
      if (portInRange(p, ports.from, ports.to)) sensitive.add(`${p}/${name}`);
    }
  }
  return [...sensitive].sort();
}

/* -------------------------------------------------- */
/* DNS record → external service hint tables          */
/* -------------------------------------------------- */

const DOMAIN_HINTS: Array<[RegExp, string]> = [
  [/herokuapp\.com/i, 'heroku'],
  [/vercel\.app|vercel-dns/i, 'vercel'],
  [/netlify/i, 'netlify'],
  [/github\.io/i, 'github-pages'],
  [/azurewebsites\.net/i, 'azure-app-service'],
  [/cloudapp\.net|azurecontainer\.io/i, 'azure'],
  [/trafficmanager\.net/i, 'azure-traffic-manager'],
  [/azurefd\.net|afdverify/i, 'azure-frontdoor'],
  [/cloudfront\.net/i, 'aws-cloudfront'],
  [/elb[.-].*\.amazonaws\.com|elb\.amazonaws\.com/i, 'aws-elb'],
  [/amazonaws\.com/i, 'aws'],
  [/googlehosted\.com|googleusercontent/i, 'google'],
  [/wpengine/i, 'wpengine'],
  [/myshopify\.com/i, 'shopify'],
  [/fastly\.net|fastlylb/i, 'fastly'],
  [/akamaiedge|akamai/i, 'akamai'],
  [/workers\.dev|cdn-cgi|cloudflare/i, 'cloudflare'],
  [/pages\.dev/i, 'cloudflare-pages'],
  [/fly\.dev/i, 'fly-io'],
  [/onrender\.com/i, 'render'],
  [/railway\.app/i, 'railway'],
  [/zendesk\.com|zd-hq/i, 'zendesk'],
  [/statuspage\.io/i, 'statuspage'],
  [/force\.com|salesforce/i, 'salesforce'],
  [/hubspot|hs-sites/i, 'hubspot'],
  [/squarespace/i, 'squarespace'],
  [/wixdns|wix\.com/i, 'wix'],
  [/webflow\.io/i, 'webflow'],
];

const TXT_HINTS: Array<[RegExp, string]> = [
  [/google-site-verification/i, 'google'],
  [/\bMS=ms\d+/i, 'microsoft-365'],
  [/atlassian/i, 'atlassian'],
  [/github-challenge|_github/i, 'github'],
  [/docker-verification/i, 'docker'],
  [/apple-domain-verification/i, 'apple'],
  [/facebook-domain-verification|workplace-domain/i, 'meta'],
  [/adobe-idp-site-verification|adobe-sign/i, 'adobe'],
  [/zoho/i, 'zoho'],
  [/stripe/i, 'stripe'],
  [/docu-sign|docusign/i, 'docusign'],
  [/cisco-ci-domain-verification|cisco/i, 'cisco'],
  [/knowbe4/i, 'knowbe4'],
];

const SPF_INCLUDE_HINTS: Array<[RegExp, string]> = [
  [/include:_spf\.google\.com/i, 'google-workspace'],
  [/include:spf\.protection\.outlook\.com/i, 'microsoft-365'],
  [/include:sendgrid\.net/i, 'sendgrid'],
  [/include:mailgun\.org/i, 'mailgun'],
  [/include:amazonses\.com/i, 'amazon-ses'],
  [/include:servers\.mcsv\.net/i, 'mailchimp'],
  [/include:mandrillapp\.com/i, 'mandrill'],
  [/include:spf\.mtasv\.net|include:.*postmark/i, 'postmark'],
  [/include:.*zendesk\.com/i, 'zendesk-mail'],
  [/include:_spf\.salesforce\.com|include:.*salesforce/i, 'salesforce-mail'],
  [/include:.*hubspot|include:.*hscampaigns/i, 'hubspot-mail'],
];

const MX_HINTS: Array<[RegExp, string]> = [
  [/google\.com|googlemail|aspmx/i, 'google-workspace'],
  [/mail\.protection\.outlook\.com|outlook\.com/i, 'microsoft-365'],
  [/mimecast/i, 'mimecast'],
  [/pphosted|proofpoint/i, 'proofpoint'],
  [/amazonses|inbound-smtp/i, 'amazon-ses'],
];

function recordServiceHints(recordType: string, values: string[]): string[] {
  const hints = new Set<string>();
  const blob = values.join(' ');
  if (recordType === 'TXT' || recordType === 'SPF') {
    for (const [re, svc] of TXT_HINTS) if (re.test(blob)) hints.add(svc);
    for (const [re, svc] of SPF_INCLUDE_HINTS) if (re.test(blob)) hints.add(svc);
  }
  if (recordType === 'MX') {
    for (const [re, svc] of MX_HINTS) if (re.test(blob)) hints.add(svc);
  }
  for (const [re, svc] of DOMAIN_HINTS) if (re.test(blob)) hints.add(svc);
  return [...hints].sort();
}

/* -------------------------------------------------- */
/* Resource-type exposure tables                      */
/* -------------------------------------------------- */

/** Types that are public-facing by resource semantics (LB/EIP/edge endpoints). */
const PUBLIC_BY_DEFAULT = new Map<string, string>([
  ['aws_eip', 'elastic IP is a public address'],
  ['aws_eip_association', 'associates a public IP'],
  ['aws_internet_gateway', 'provides public internet routing'],
  ['aws_nat_gateway', 'allocates a public EIP'],
  ['aws_apigatewayv2_api', 'API Gateway v2 endpoints are public by default'],
  ['aws_apigatewayv2_stage', 'API Gateway v2 stage is publicly reachable'],
  ['aws_cloudfront_distribution', 'CDN distribution is a public edge endpoint'],
  ['aws_app_runner_service', 'App Runner services get a public HTTPS endpoint by default'],
  ['aws_elastic_beanstalk_environment', 'Beanstalk environments expose a public endpoint'],
  ['aws_lightsail_instance', 'Lightsail instances receive a public IP'],
  ['aws_lightsail_static_ip', 'static public IP'],
  ['aws_amplify_app', 'Amplify hosts a public web endpoint'],
  ['azurerm_public_ip', 'Azure public IP resource'],
  ['azurerm_lb', 'Azure LB may hold a public frontend IP'],
  ['azurerm_application_gateway', 'Application Gateway frontend may be public'],
  ['azurerm_frontdoor', 'Front Door is a public edge service'],
  ['azurerm_cdn_frontdoor_profile', 'Front Door CDN profile is a public edge'],
  ['google_compute_address', 'GCP external static IP'],
  ['google_compute_global_address', 'GCP global external IP'],
  ['google_compute_global_forwarding_rule', 'global forwarding rule targets a public IP'],
  ['google_compute_forwarding_rule', 'external forwarding rule targets a public IP'],
  ['digitalocean_droplet', 'Droplets receive public IPs by default'],
  ['digitalocean_loadbalancer', 'public load balancer'],
  ['digitalocean_floating_ip', 'public floating IP'],
  ['heroku_app', 'Heroku apps expose public endpoints'],
  ['vercel_deployment', 'Vercel deployments are public endpoints'],
  ['netlify_site', 'Netlify sites are public endpoints'],
]);

/** Simple top-level/nested attribute rules: attr truthy → declared-public. */
const TRUTHY_PUBLIC_ATTRS: Array<{
  types: RegExp;
  attr: string;
  rule: string;
  note?: string;
  internalWhenFalse?: boolean;
}> = [
  {
    types: /^aws_(db_instance|rds_cluster_instance|redshift_cluster|docdb_cluster_instance)$/,
    attr: 'publicly_accessible',
    rule: 'EXPOSURE_PUBLICLY_ACCESSIBLE',
    note: 'DB instance marked publicly accessible',
  },
  {
    types: /^aws_instance$/,
    attr: 'associate_public_ip_address',
    rule: 'EXPOSURE_INSTANCE_PUBLIC_IP',
    note: 'instance requests a public IP',
  },
  {
    types:
      /^azurerm_(postgresql|mysql|mssql|mariadb|cosmosdb|storage_account|redis_cache)[a-z_]*$|^azurerm_storage_account$/,
    attr: 'public_network_access_enabled',
    rule: 'EXPOSURE_AZURE_PUBLIC_NETWORK',
    note: 'Azure resource allows public network access',
    internalWhenFalse: true,
  },
  {
    types: /^aws_emr_cluster$/,
    attr: 'visible_to_all_users',
    rule: 'EXPOSURE_EMR_PUBLIC',
    note: 'EMR cluster instances visible to all users (public subnet/IP)',
  },
  {
    types: /^google_sql_database_instance$/,
    attr: 'ipv4_enabled',
    rule: 'EXPOSURE_GCP_SQL_IPV4',
    note: 'Cloud SQL public IPv4 enabled',
  },
];

const DNS_RECORD_TYPES: Array<{
  type: RegExp;
  typeAttr?: string;
  valueAttrs: string[];
  nameAttr?: string;
}> = [
  { type: /^aws_route53_record$/, typeAttr: 'type', valueAttrs: ['records'], nameAttr: 'name' },
  {
    type: /^cloudflare_record$|^cloudflare_dns_record$/,
    typeAttr: 'type',
    valueAttrs: ['content', 'value', 'data'],
    nameAttr: 'name',
  },
  { type: /^google_dns_record_set$/, typeAttr: 'type', valueAttrs: ['rrdatas'], nameAttr: 'name' },
  {
    type: /^azurerm_dns_(a|aaaa|cname|mx|txt|ns|srv|caa|ptr)_record$/,
    valueAttrs: ['records', 'record'],
    nameAttr: 'name',
  },
];

const DATA_STORE_RE =
  /s3_bucket|db_instance|rds|dynamodb|redshift|elasticache|docdb|neptune|storage_account|storage_bucket|sql_database|cosmosdb|firestore|bigquery|snowflake|mongodb|elasticsearch|opensearch|cassandra|influxdb|qldb|timestream|keyspaces|memorydb|efs|ebs_volume|filestore|fsx/i;

/* -------------------------------------------------- */
/* Classification                                     */
/* -------------------------------------------------- */

function makeSignal(
  rule: string,
  attribute: string,
  value: string,
  confidence: ExposureConfidence,
  note?: string
): ExposureSignal {
  return { rule, attribute, value, confidence, ...(note ? { note } : {}) };
}

/**
 * Declarative resource-classification engine.
 *
 * Each ResourceRule matches a resource type and emits evidence signals /
 * ingress findings via the RuleCtx. New providers or resource types are added
 * by appending a rule — no edits to the dispatcher. Rules run in declaration
 * order; signal order follows rule order.
 */
interface RuleCtx {
  block: TerraformBlock;
  t: string;
  attrs: Record<string, string>;
  signals: ExposureSignal[];
  ingress: IngressFinding[];
  unresolved: string[];
  markDynamic: (attr: string) => void;
  collectIngress: (srcBody: string, ruleSource: 'inline' | 'resource', label: string) => void;
}

type RuleMatcher = string | RegExp | ((t: string) => boolean);

interface ResourceRule {
  id: string;
  match: RuleMatcher;
  /** Block kinds the rule applies to. Defaults to `['resource']`. */
  kinds?: Array<'resource' | 'data'>;
  apply: (ctx: RuleCtx) => void;
}

/** Source-CIDR attribute names across AWS/Azure/GCP security-rule forms. */
const CIDR_ATTR_NAMES = [
  'cidr_blocks',
  'ipv6_cidr_blocks',
  'cidr_ipv4',
  'cidr_ipv6',
  'source_address_prefix',
  'source_address_prefixes',
  'source_ranges',
  'prefix_list_ids',
] as const;

/** Port attribute names across AWS/Azure/GCP security-rule forms. */
const PORT_ATTR_NAMES = [
  'from_port',
  'to_port',
  'destination_port_range',
  'destination_port_ranges',
  'port_range',
  'port_ranges',
  'ports',
] as const;

function collectIngressImpl(
  ctx: RuleCtx,
  srcBody: string,
  ruleSource: 'inline' | 'resource',
  label: string
): void {
  const a = topLevelAttrs(srcBody);
  for (const attrName of CIDR_ATTR_NAMES) {
    const raw = a[attrName];
    if (raw === undefined) continue;
    // Unresolvable CIDR sources: var/data/module refs, resource references
    // (`[aws_vpc.main.cidr_block]`), expressions — anything without a quoted
    // literal list. Flag them instead of silently skipping the rule.
    const emptyNonLiteral = parseList(raw).length === 0 && raw.trim() !== '[]';
    if (isDynamicValue(raw) || emptyNonLiteral || containsUnquotedRef(raw)) {
      ctx.unresolved.push(`${label}::${attrName}`);
    }
  }
  if (a['for_each'] !== undefined && isDynamicValue(a['for_each'])) {
    ctx.unresolved.push(`${label}::for_each`);
  }
  const cidrValues = [
    ...parseList(a['cidr_blocks']),
    ...parseList(a['ipv6_cidr_blocks']),
    ...(a['cidr_ipv4'] ? [unquote(a['cidr_ipv4'])] : []),
    ...(a['cidr_ipv6'] ? [unquote(a['cidr_ipv6'])] : []),
    ...(a['source_address_prefix'] ? [unquote(a['source_address_prefix'])] : []),
    ...parseList(a['source_address_prefixes']),
    ...parseList(a['source_ranges']),
    ...parseList(a['prefix_list_ids']),
  ];
  const open =
    cidrValues.some((c) => PUBLIC_CIDR_RE.test(c)) ||
    cidrValues.includes('*') ||
    cidrValues.includes('Internet');
  if (!open && cidrValues.length === 0) return;
  // `access` (Azure Allow/Deny) is deliberately NOT a protocol fallback —
  // a Deny rule must never reach this point as an open ingress, and 'Allow'
  // is not a protocol. Callers filter access before collecting.
  const proto = unquote(a['protocol'] || a['ip_protocol'] || '');
  // An all-protocols marker (-1/all/*) makes explicit ports irrelevant.
  for (const attrName of PORT_ATTR_NAMES) {
    const raw = a[attrName];
    if (raw !== undefined && (isDynamicValue(raw) || containsUnquotedRef(raw))) {
      ctx.unresolved.push(`${label}::${attrName}`);
    }
  }
  const ports = /^-1$|^all$|^\*$/i.test(proto)
    ? 'all'
    : parsePortAttrs(PORT_ATTR_NAMES.map((attrName) => a[attrName]));
  const sensitive = open ? sensitivePortsFor(ports, proto) : [];
  if (open) {
    ctx.ingress.push({
      resource: label,
      rule_source: ruleSource,
      open_to_world: true,
      cidrs: cidrValues,
      protocol: proto || 'unspecified',
      ports,
      sensitive_ports: sensitive,
    });
    ctx.signals.push(
      makeSignal(
        'EXPOSURE_OPEN_INGRESS',
        'cidr_blocks',
        cidrValues.join(','),
        'declared-public',
        sensitive.length > 0
          ? `open to world incl. sensitive ports: ${sensitive.join(', ')}`
          : 'ingress open to the world'
      )
    );
  }
}

const RESOURCE_RULES: ResourceRule[] = [
  {
    id: 'resource-type.public-by-default',
    match: (t) => PUBLIC_BY_DEFAULT.has(t),
    apply: (ctx) => {
      ctx.signals.push(
        makeSignal(
          'EXPOSURE_PUBLIC_BY_DEFAULT',
          '(resource-type)',
          ctx.t,
          'structurally-public',
          PUBLIC_BY_DEFAULT.get(ctx.t)
        )
      );
    },
  },
  {
    // aws_lb/aws_alb/aws_elb: `internal` absent or false → internet-facing.
    id: 'aws.lb-internal',
    match: /^aws_(lb|alb|elb)$/,
    apply: (ctx) => {
      const internal = ctx.attrs['internal'];
      if (internal !== undefined && FALSY.test(internal)) {
        ctx.signals.push(
          makeSignal(
            'EXPOSURE_LB_INTERNET_FACING',
            'internal',
            internal,
            'declared-public',
            'internal=false means internet-facing'
          )
        );
      } else if (internal !== undefined && TRUTHY.test(internal)) {
        ctx.signals.push(
          makeSignal(
            'EXPOSURE_LB_INTERNAL',
            'internal',
            internal,
            'structurally-public',
            'internal=true means internal LB'
          )
        );
      } else if (internal === undefined) {
        ctx.signals.push(
          makeSignal(
            'EXPOSURE_LB_DEFAULT_PUBLIC',
            'internal',
            '(unset)',
            'structurally-public',
            'aws_lb defaults to internet-facing when internal is unset'
          )
        );
      } else if (isDynamicValue(internal)) {
        ctx.markDynamic('internal');
        ctx.signals.push(
          makeSignal(
            'EXPOSURE_LB_DYNAMIC',
            'internal',
            internal,
            'dynamic',
            'exposure cannot be resolved statically'
          )
        );
      }
    },
  },
  {
    id: 'attr.truthy-public',
    match: (t) => TRUTHY_PUBLIC_ATTRS.some((r) => r.types.test(t)),
    apply: (ctx) => {
      for (const r of TRUTHY_PUBLIC_ATTRS) {
        if (!r.types.test(ctx.t)) continue;
        const value = attrAnywhere(ctx.block.body, r.attr);
        if (value !== undefined && TRUTHY.test(value)) {
          ctx.signals.push(makeSignal(r.rule, r.attr, value, 'declared-public', r.note));
        } else if (value !== undefined && FALSY.test(value) && r.internalWhenFalse) {
          ctx.signals.push(
            makeSignal(
              `${r.rule}_DISABLED`,
              r.attr,
              value,
              'structurally-public',
              'public network access disabled'
            )
          );
        } else if (value !== undefined && isDynamicValue(value)) {
          ctx.unresolved.push(`${ctx.block.id}::${r.attr}`);
        }
      }
    },
  },
  {
    id: 'aws.apigw-endpoint',
    match: 'aws_api_gateway_rest_api',
    apply: (ctx) => {
      const cfgBlocks = nestedBlocks(ctx.block.body, 'endpoint_configuration');
      const types =
        cfgBlocks.length > 0 ? parseList(attrAnywhere(cfgBlocks.join('\n'), 'types')) : [];
      if (types.includes('PRIVATE')) {
        ctx.signals.push(
          makeSignal(
            'EXPOSURE_APIGW_PRIVATE',
            'endpoint_configuration.types',
            types.join(','),
            'structurally-public',
            'private API endpoint'
          )
        );
      } else if (types.length > 0) {
        ctx.signals.push(
          makeSignal(
            'EXPOSURE_APIGW_PUBLIC',
            'endpoint_configuration.types',
            types.join(','),
            'declared-public',
            'regional/edge API endpoint'
          )
        );
      } else {
        ctx.signals.push(
          makeSignal(
            'EXPOSURE_APIGW_DEFAULT',
            'endpoint_configuration',
            '(unset)',
            'structurally-public',
            'defaults to EDGE endpoint (public)'
          )
        );
      }
    },
  },
  {
    id: 'aws.lambda-function-url',
    match: 'aws_lambda_function_url',
    apply: (ctx) => {
      const auth = unquote(ctx.attrs['authorization_type']);
      if (auth === 'NONE') {
        ctx.signals.push(
          makeSignal(
            'EXPOSURE_LAMBDA_URL_PUBLIC',
            'authorization_type',
            auth,
            'declared-public',
            'unauthenticated function URL'
          )
        );
      } else if (auth === 'AWS_IAM') {
        ctx.signals.push(
          makeSignal(
            'EXPOSURE_LAMBDA_URL_IAM',
            'authorization_type',
            auth,
            'structurally-public',
            'IAM-gated function URL'
          )
        );
      }
    },
  },
  {
    // endpoint_public_access defaults to true when unset.
    id: 'aws.eks-endpoint',
    match: 'aws_eks_cluster',
    apply: (ctx) => {
      const pub = attrAnywhere(ctx.block.body, 'endpoint_public_access');
      if (pub !== undefined && TRUTHY.test(pub)) {
        ctx.signals.push(
          makeSignal(
            'EXPOSURE_EKS_PUBLIC_ENDPOINT',
            'endpoint_public_access',
            pub,
            'declared-public',
            'EKS API endpoint publicly accessible'
          )
        );
      } else if (pub === undefined) {
        ctx.signals.push(
          makeSignal(
            'EXPOSURE_EKS_DEFAULT_PUBLIC',
            'endpoint_public_access',
            '(unset)',
            'structurally-public',
            'EKS endpoint_public_access defaults to true'
          )
        );
      } else if (isDynamicValue(pub))
        ctx.unresolved.push(`${ctx.block.id}::endpoint_public_access`);
    },
  },
  {
    // MSK: public_access.type = SERVICE_PROVIDED_EIPS makes brokers reachable.
    id: 'aws.msk-public-access',
    match: 'aws_msk_cluster',
    apply: (ctx) => {
      for (const pa of nestedBlocks(ctx.block.body, 'public_access')) {
        const type = unquote(topLevelAttrs(pa)['type'] || '');
        if (/SERVICE_PROVIDED_EIPS/i.test(type)) {
          ctx.signals.push(
            makeSignal(
              'EXPOSURE_MSK_PUBLIC',
              'public_access.type',
              type,
              'declared-public',
              'MSK brokers publicly reachable via EIPs'
            )
          );
        }
      }
    },
  },
  {
    // AKS: public API endpoint unless private_cluster_enabled = true.
    id: 'azure.aks-private',
    match: 'azurerm_kubernetes_cluster',
    apply: (ctx) => {
      const priv = attrAnywhere(ctx.block.body, 'private_cluster_enabled');
      if (priv !== undefined && TRUTHY.test(priv)) {
        ctx.signals.push(
          makeSignal(
            'EXPOSURE_AKS_PRIVATE',
            'private_cluster_enabled',
            priv,
            'structurally-public',
            'private AKS cluster'
          )
        );
      } else if (priv === undefined || FALSY.test(priv)) {
        ctx.signals.push(
          makeSignal(
            'EXPOSURE_AKS_PUBLIC',
            'private_cluster_enabled',
            priv === undefined ? '(unset)' : priv,
            'declared-public',
            'AKS API server is publicly accessible'
          )
        );
      } else if (isDynamicValue(priv))
        ctx.unresolved.push(`${ctx.block.id}::private_cluster_enabled`);
    },
  },
  {
    // GKE: public control-plane endpoint unless private_cluster_config blocks it.
    id: 'gcp.gke-endpoint',
    match: /^google_container_cluster$/,
    apply: (ctx) => {
      const privEp = attrAnywhere(ctx.block.body, 'enable_private_endpoint');
      const privNodes = attrAnywhere(ctx.block.body, 'enable_private_nodes');
      if (privEp !== undefined && TRUTHY.test(privEp)) {
        ctx.signals.push(
          makeSignal(
            'EXPOSURE_GKE_PRIVATE',
            'enable_private_endpoint',
            privEp,
            'structurally-public',
            'private GKE endpoint'
          )
        );
      } else if (privEp === undefined && (privNodes === undefined || FALSY.test(privNodes))) {
        ctx.signals.push(
          makeSignal(
            'EXPOSURE_GKE_DEFAULT_PUBLIC',
            'private_cluster_config',
            '(unset)',
            'structurally-public',
            'GKE cluster defaults to a public endpoint'
          )
        );
      }
      if (privEp !== undefined && isDynamicValue(privEp))
        ctx.unresolved.push(`${ctx.block.id}::enable_private_endpoint`);
      if (privNodes !== undefined && isDynamicValue(privNodes))
        ctx.unresolved.push(`${ctx.block.id}::enable_private_nodes`);
    },
  },
  {
    // GCP access_config block assigns an ephemeral public IP.
    id: 'gcp.access-config',
    match: /^google_compute_instance(_template)?$/,
    apply: (ctx) => {
      if (nestedBlocks(ctx.block.body, 'access_config').length > 0) {
        ctx.signals.push(
          makeSignal(
            'EXPOSURE_GCE_ACCESS_CONFIG',
            'access_config',
            '(present)',
            'declared-public',
            'access_config assigns a public IP'
          )
        );
      }
    },
  },
  {
    id: 'k8s.lb-service',
    match: /^kubernetes_service/,
    apply: (ctx) => {
      for (const spec of nestedBlocks(ctx.block.body, 'spec')) {
        const type = unquote(topLevelAttrs(spec)['type'] || attrAnywhere(spec, 'type'));
        if (type === 'LoadBalancer') {
          ctx.signals.push(
            makeSignal(
              'EXPOSURE_K8S_LB',
              'spec.type',
              type,
              'declared-public',
              'LoadBalancer service provisions a public IP'
            )
          );
        }
      }
    },
  },
  {
    // Cloud Run ingress defaults to INGRESS_TRAFFIC_ALL.
    id: 'gcp.cloudrun-ingress',
    match: /^google_cloud_run(_v2)?_service$/,
    apply: (ctx) => {
      const ing = attrAnywhere(ctx.block.body, 'ingress');
      if (ing !== undefined && /INGRESS_TRAFFIC_ALL/i.test(ing)) {
        ctx.signals.push(
          makeSignal(
            'EXPOSURE_CLOUDRUN_ALL',
            'ingress',
            ing,
            'declared-public',
            'Cloud Run allows all ingress traffic'
          )
        );
      } else if (ing === undefined) {
        ctx.signals.push(
          makeSignal(
            'EXPOSURE_CLOUDRUN_DEFAULT',
            'ingress',
            '(unset)',
            'structurally-public',
            'Cloud Run ingress defaults to all traffic'
          )
        );
      } else if (isDynamicValue(ing)) ctx.unresolved.push(`${ctx.block.id}::ingress`);
    },
  },
  {
    id: 'aws.s3-acl',
    match: 'aws_s3_bucket_acl',
    apply: (ctx) => {
      const acl = unquote(ctx.attrs['acl']);
      if (/public|authenticated-read/i.test(acl)) {
        ctx.signals.push(
          makeSignal(
            'EXPOSURE_S3_PUBLIC_ACL',
            'acl',
            acl,
            'declared-public',
            `bucket ACL is ${acl}`
          )
        );
      }
    },
  },
  {
    id: 'aws.s3-access-block',
    match: 'aws_s3_bucket_public_access_block',
    apply: (ctx) => {
      for (const flag of [
        'block_public_acls',
        'block_public_policy',
        'ignore_public_acls',
        'restrict_public_buckets',
      ]) {
        const v = ctx.attrs[flag];
        if (v !== undefined && FALSY.test(v)) {
          ctx.signals.push(
            makeSignal(
              'EXPOSURE_S3_ACCESS_BLOCK_OPEN',
              flag,
              v,
              'declared-public',
              `${flag}=false leaves public access possible`
            )
          );
        }
      }
    },
  },
  {
    id: 'aws.s3-website',
    match: 'aws_s3_bucket_website_configuration',
    apply: (ctx) => {
      ctx.signals.push(
        makeSignal(
          'EXPOSURE_S3_WEBSITE',
          '(resource-type)',
          ctx.t,
          'declared-public',
          'static website hosting is public'
        )
      );
    },
  },
  {
    // Policies are commonly heredocs — scan the raw body, not just the attr value.
    id: 'aws.s3-policy',
    match: 'aws_s3_bucket_policy',
    apply: (ctx) => {
      if (/"Principal"\s*:\s*"\*"|"AWS"\s*:\s*"\*"|"AWS"\s*:\s*\[\s*"\*"/.test(ctx.block.body)) {
        ctx.signals.push(
          makeSignal(
            'EXPOSURE_S3_POLICY_PUBLIC',
            'policy',
            '(wildcard-principal)',
            'declared-public',
            'bucket policy grants wildcard principal'
          )
        );
      }
      if (isDynamicValue(ctx.attrs['policy'] || '')) ctx.unresolved.push(`${ctx.block.id}::policy`);
    },
  },
  {
    id: 'azure.storage-network-rules',
    match: 'azurerm_storage_account',
    apply: (ctx) => {
      for (const nr of nestedBlocks(ctx.block.body, 'network_rules')) {
        const action = topLevelAttrs(nr)['default_action'];
        if (action !== undefined && /Allow/i.test(action)) {
          ctx.signals.push(
            makeSignal(
              'EXPOSURE_AZURE_STORAGE_OPEN',
              'network_rules.default_action',
              action,
              'declared-public',
              'storage firewall default allows traffic'
            )
          );
        }
      }
    },
  },
  {
    // Wildcard/cross-account principals and full admin grants in IAM documents.
    // Covers JSON policies ("Action": "*") and the HCL statement form used by
    // `data "aws_iam_policy_document"` (actions = ["*"], identifiers = ["*"]).
    id: 'aws.iam-wildcard',
    match: /^aws_iam_(policy|role|role_policy|user_policy|group_policy|policy_document)$/,
    kinds: ['resource', 'data'],
    apply: (ctx) => {
      const b = ctx.block.body;
      const wildcardPrincipal =
        /"Principal"\s*:\s*"\*"|"AWS"\s*:\s*"\*"|"AWS"\s*:\s*\[\s*"\*"/.test(b) ||
        /identifiers\s*=\s*\[[^\]]*"\*"/.test(b);
      const wildcardAdmin =
        (/"Action"\s*:\s*"\*"/.test(b) && /"Resource"\s*:\s*"\*"/.test(b)) ||
        (/actions\s*=\s*\[[^\]]*"\*"/.test(b) && /resources\s*=\s*\[[^\]]*"\*"/.test(b));
      if (wildcardPrincipal) {
        ctx.signals.push(
          makeSignal(
            'EXPOSURE_IAM_WILDCARD_PRINCIPAL',
            'policy',
            '(wildcard-principal)',
            'declared-public',
            'IAM document grants a wildcard principal (external trust)'
          )
        );
      }
      if (wildcardAdmin) {
        ctx.signals.push(
          makeSignal(
            'EXPOSURE_IAM_ADMIN',
            'policy',
            '(action+resource *)',
            'indirect',
            'IAM document grants Action=* on Resource=* (full admin)'
          )
        );
      }
    },
  },
  {
    id: 'gcp.gcs-public-iam',
    match: /^google_storage_bucket_iam_(member|binding)$/,
    apply: (ctx) => {
      const memberBlob = `${ctx.attrs['member'] || ''} ${ctx.attrs['members'] || ''}`;
      if (/allUsers|allAuthenticatedUsers/.test(memberBlob)) {
        ctx.signals.push(
          makeSignal(
            'EXPOSURE_GCS_PUBLIC_IAM',
            'member(s)',
            unquote(memberBlob),
            'declared-public',
            'bucket IAM grants allUsers/allAuthenticatedUsers'
          )
        );
      }
    },
  },
  {
    // Default route to an Internet Gateway — the mechanism that makes a
    // subnet's resources publicly reachable.
    id: 'aws.igw-route',
    match: /^aws_(route|route_table)$/,
    apply: (ctx) => {
      const bodies =
        ctx.t === 'aws_route' ? [ctx.block.body] : nestedBlocks(ctx.block.body, 'route');
      for (const b of bodies) {
        const a = topLevelAttrs(b);
        // `aws_route` uses destination_*; `aws_route_table` route{} uses cidr_block.
        const dest =
          a['destination_cidr_block'] ||
          a['destination_ipv6_cidr_block'] ||
          a['cidr_block'] ||
          a['ipv6_cidr_block'] ||
          '';
        const gw = a['gateway_id'] || '';
        if (PUBLIC_CIDR_RE.test(dest) && /aws_internet_gateway/.test(gw)) {
          ctx.signals.push(
            makeSignal(
              'EXPOSURE_IGW_ROUTE',
              'destination_cidr_block',
              unquote(dest),
              'indirect',
              'default route to an internet gateway'
            )
          );
        }
      }
    },
  },
  {
    // Inline `ingress {}` + the `dynamic "ingress" { for_each / content }` idiom:
    // for_each lives on the outer body, rule attributes inside `content`.
    // Scan both — the outer body carries no cidr attrs, so no double counting.
    id: 'aws.sg-inline-ingress',
    match: /^aws_(security_group|default_security_group)$/,
    apply: (ctx) => {
      for (const ing of nestedBlocks(ctx.block.body, 'ingress')) {
        const contentBodies = nestedBlocks(ing, 'content');
        for (const body of [ing, ...contentBodies]) {
          ctx.collectIngress(body, 'inline', ctx.block.id);
        }
      }
    },
  },
  {
    id: 'aws.sg-rule',
    match: /^aws_(security_group_rule|vpc_security_group_ingress_rule)$/,
    apply: (ctx) => {
      const type = unquote(ctx.attrs['type'] || 'ingress');
      if (type === 'ingress' || ctx.t === 'aws_vpc_security_group_ingress_rule') {
        ctx.collectIngress(ctx.block.body, 'resource', ctx.block.id);
      }
    },
  },
  {
    // Standalone rule resource or inline `security_rule {}` blocks; Inbound
    // Allow only — a Deny rule on 0.0.0.0/0 is a block, not an exposure.
    id: 'azure.nsg-rule',
    match: /^azurerm_network_security_(rule|group)$/,
    apply: (ctx) => {
      const bodies =
        ctx.t === 'azurerm_network_security_rule'
          ? [ctx.block.body]
          : nestedBlocks(ctx.block.body, 'security_rule');
      for (const b of bodies) {
        const ba = topLevelAttrs(b);
        const direction = unquote(ba['direction'] || 'Inbound');
        const access = unquote(ba['access'] || 'Allow');
        if (direction === 'Inbound' && access === 'Allow')
          ctx.collectIngress(b, 'resource', ctx.block.id);
      }
    },
  },
  {
    // GCP `allow` without a ports list opens every port of that protocol.
    // `direction = "EGRESS"` rules are outbound-only — source_ranges applies
    // to INGRESS, so an explicit EGRESS rule is never world-open ingress.
    id: 'gcp.firewall',
    match: 'google_compute_firewall',
    apply: (ctx) => {
      const a = topLevelAttrs(ctx.block.body);
      if (/EGRESS/i.test(unquote(a['direction'] || ''))) return;
      // A `disabled = true` firewall is not live — no exposure signal.
      if (a['disabled'] !== undefined && TRUTHY.test(a['disabled'])) return;
      const srcRanges = a['source_ranges'];
      const emptyNonLiteral =
        srcRanges !== undefined && parseList(srcRanges).length === 0 && srcRanges.trim() !== '[]';
      if (
        srcRanges !== undefined &&
        (isDynamicValue(srcRanges) || emptyNonLiteral || containsUnquotedRef(srcRanges))
      ) {
        ctx.unresolved.push(`${ctx.block.id}::source_ranges`);
      }
      const open = parseList(srcRanges).some((c) => PUBLIC_CIDR_RE.test(c));
      if (!open) return;
      for (const allow of nestedBlocks(ctx.block.body, 'allow')) {
        const aa = topLevelAttrs(allow);
        const ports = parsePortAttrs([aa['ports']]);
        const proto = unquote(aa['protocol'] || '');
        const sensitive = ports === 'unspecified' ? ['all-ports'] : sensitivePortsFor(ports, proto);
        ctx.ingress.push({
          resource: ctx.block.id,
          rule_source: 'resource',
          open_to_world: true,
          cidrs: parseList(a['source_ranges']),
          protocol: proto || 'unspecified',
          ports,
          sensitive_ports: sensitive,
        });
        ctx.signals.push(
          makeSignal(
            'EXPOSURE_OPEN_INGRESS',
            'source_ranges',
            parseList(a['source_ranges']).join(','),
            'declared-public',
            sensitive.length
              ? `open to world incl. sensitive ports: ${sensitive.join(', ')}`
              : 'ingress open to the world'
          )
        );
      }
    },
  },
];

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
