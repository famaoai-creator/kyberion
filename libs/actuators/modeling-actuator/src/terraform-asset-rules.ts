import type { TerraformBlock } from './topology-ir.js';
import type { ExposureSignal, IngressFinding } from './terraform-asset-inventory.js';
import {
  attrAnywhere,
  containsUnquotedRef,
  isDynamicValue,
  makeSignal,
  nestedBlocks,
  parseList,
  parsePortAttrs,
  PUBLIC_CIDR_RE,
  sensitivePortsFor,
  topLevelAttrs,
  unquote,
  FALSY,
  TRUTHY,
} from './terraform-asset-primitives.js';

/* Resource-type exposure tables                      */
/* -------------------------------------------------- */

/** Types that are public-facing by resource semantics (LB/EIP/edge endpoints). */
export const PUBLIC_BY_DEFAULT = new Map<string, string>([
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
export const TRUTHY_PUBLIC_ATTRS: Array<{
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

/**
 * Declarative resource-classification engine.
 *
 * Each ResourceRule matches a resource type and emits evidence signals /
 * ingress findings via the RuleCtx. New providers or resource types are added
 * by appending a rule — no edits to the dispatcher. Rules run in declaration
 * order; signal order follows rule order.
 */
export interface RuleCtx {
  block: TerraformBlock;
  t: string;
  attrs: Record<string, string>;
  signals: ExposureSignal[];
  ingress: IngressFinding[];
  unresolved: string[];
  markDynamic: (attr: string) => void;
  collectIngress: (srcBody: string, ruleSource: 'inline' | 'resource', label: string) => void;
}

export type RuleMatcher = string | RegExp | ((t: string) => boolean);

export interface ResourceRule {
  id: string;
  match: RuleMatcher;
  /** Block kinds the rule applies to. Defaults to `['resource']`. */
  kinds?: Array<'resource' | 'data'>;
  apply: (ctx: RuleCtx) => void;
}

/** Source-CIDR attribute names across AWS/Azure/GCP security-rule forms. */
export const CIDR_ATTR_NAMES = [
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
export const PORT_ATTR_NAMES = [
  'from_port',
  'to_port',
  'destination_port_range',
  'destination_port_ranges',
  'port_range',
  'port_ranges',
  'ports',
] as const;

export function collectIngressImpl(
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

export const RESOURCE_RULES: ResourceRule[] = [
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
