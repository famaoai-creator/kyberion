import { findMatchingBrace } from './terraform-topology.js';
import type {
  ExposureConfidence,
  ExposureSignal,
  ExternalServiceCandidate,
} from './terraform-asset-inventory.js';

/**
 * Terraform asset-inventory primitives: HCL-ish attribute helpers,
 * provider/service tables, port-range parsing and DNS hint tables shared
 * by the rule engine (terraform-asset-rules.ts) and the inventory engine
 * (terraform-asset-inventory.ts).
 */

/* ------------------------------------------------------------------ */
/* HCL-ish attribute helpers (same brace-scan style as topology parser) */
/* ------------------------------------------------------------------ */

export const ATTR_NAME_RE = /^([A-Za-z_][\w-]*)\s*=(?![=>])\s*/;

/**
 * Remove `#`/`//` line comments. `//` inside URLs (`https://`) is preserved by
 * requiring start-of-line or whitespace before the comment marker.
 */
export function stripComments(text: string): string {
  return text.replace(/(^|[ \t])#[^\n]*/gm, '$1').replace(/(^|[ \t])\/\/[^\n]*/gm, '$1');
}

/** Extract `name = value` pairs at brace-depth 0 of `body`. Values are raw text. */
export function topLevelAttrs(body: string): Record<string, string> {
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
export function nestedBlocks(body: string, name: string): string[] {
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
export function attrAnywhere(body: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=(?![=>])\\s*(\\[[^\\]]*\\]|"[^"]*"|[^\\s,}\\n]+)`);
  const m = stripComments(body).match(re);
  return m ? m[1].trim() : undefined;
}

export const REF_RE = /\b(?:var|local|data|module|each|count|self)\.[A-Za-z_]/;
export const PUBLIC_CIDR_RE = /0\.0\.0\.0\/0|::\/0/;
export const TRUTHY = /^\s*"?true"?\s*$/;
export const FALSY = /^\s*"?false"?\s*$/;

export function isDynamicValue(value: string | undefined): boolean {
  return value !== undefined && REF_RE.test(value);
}

/**
 * An attribute value that still contains an unquoted `type.name` reference
 * after quoted literals are removed — e.g. `[aws_vpc.main.cidr_block]` or a
 * mixed `["10.0.0.0/8", aws_x.y]` list that parseList only half-resolves.
 */
export function containsUnquotedRef(value: string | undefined): boolean {
  if (!value) return false;
  const unquoted = value.replace(/"[^"]*"/g, '');
  return /\b[a-zA-Z_][\w-]*\.[a-zA-Z_][\w.-]*/.test(unquoted);
}

export function unquote(value: string | undefined): string {
  if (!value) return '';
  return value.replace(/^"|"$/g, '');
}

export function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return [...value.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
}

/* -------------------------------------------------- */
/* Provider / service classification tables           */
/* -------------------------------------------------- */

export const UTILITY_PROVIDERS = new Set([
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

export const PLATFORM_PROVIDERS = new Set([
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

export const CLOUD_PROVIDERS = new Set([
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

export function providerKind(name: string): ExternalServiceCandidate['kind'] {
  const base = name.toLowerCase().replace(/-beta$/, '');
  if (UTILITY_PROVIDERS.has(base)) return 'utility';
  if (PLATFORM_PROVIDERS.has(base)) return 'platform';
  if (CLOUD_PROVIDERS.has(base)) return 'cloud';
  return 'saas';
}

export const PROVIDER_NAME_ALIASES: Record<string, string> = {
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

export function providerServiceName(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/-beta$/, '')
    .replace(/_/g, '-');
  return PROVIDER_NAME_ALIASES[base] || base;
}

/* -------------------------------------------------- */
/* Sensitive ports (conservative, scanner-informed)   */
/* -------------------------------------------------- */

export const SENSITIVE_PORTS = new Map<number, string>([
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

export function portInRange(port: number, from: number, to: number): boolean {
  return port >= from && port <= to;
}

export type PortSpec = { from: number; to: number } | 'all' | 'dynamic' | 'unspecified';

/** Parse one port token (`"22"`, `"80-443"`, `*`, `-1`) into a range or marker. */
export function parsePortToken(
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
export function parsePortAttrs(values: Array<string | undefined>): PortSpec {
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

export function sensitivePortsFor(ports: PortSpec, protocol: string): string[] {
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

export const DOMAIN_HINTS: Array<[RegExp, string]> = [
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

export const TXT_HINTS: Array<[RegExp, string]> = [
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

export const SPF_INCLUDE_HINTS: Array<[RegExp, string]> = [
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

export const MX_HINTS: Array<[RegExp, string]> = [
  [/google\.com|googlemail|aspmx/i, 'google-workspace'],
  [/mail\.protection\.outlook\.com|outlook\.com/i, 'microsoft-365'],
  [/mimecast/i, 'mimecast'],
  [/pphosted|proofpoint/i, 'proofpoint'],
  [/amazonses|inbound-smtp/i, 'amazon-ses'],
];

export function recordServiceHints(recordType: string, values: string[]): string[] {
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
export const DNS_RECORD_TYPES: Array<{
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

export const DATA_STORE_RE =
  /s3_bucket|db_instance|rds|dynamodb|redshift|elasticache|docdb|neptune|storage_account|storage_bucket|sql_database|cosmosdb|firestore|bigquery|snowflake|mongodb|elasticsearch|opensearch|cassandra|influxdb|qldb|timestream|keyspaces|memorydb|efs|ebs_volume|filestore|fsx/i;

/* -------------------------------------------------- */
/* Classification                                     */
/* -------------------------------------------------- */

export function makeSignal(
  rule: string,
  attribute: string,
  value: string,
  confidence: ExposureConfidence,
  note?: string
): ExposureSignal {
  return { rule, attribute, value, confidence, ...(note ? { note } : {}) };
}
