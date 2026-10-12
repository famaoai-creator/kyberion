import { describe, expect, it } from 'vitest';
import { terraformIrToAssetInventory } from './terraform-asset-inventory.js';
import type { TerraformBlock, TerraformTopologyIr } from './topology-ir.js';

function block(kind: string, type: string, name: string, body: string): TerraformBlock {
  const base =
    kind === 'resource' ? `resource.${type}.${name}` : `${kind}.${type}${name ? `.${name}` : ''}`;
  return { kind, type, name, id: `.::${base}`, dir: '.', body, filePath: `/root/${base}.tf` };
}

function ir(blocks: TerraformBlock[]): TerraformTopologyIr {
  return {
    kind: 'terraform_topology_ir',
    version: '1.0.0',
    source_kind: 'terraform',
    source_root: '/root',
    title: 'test',
    provider: 'aws',
    tfFiles: ['/root/main.tf'],
    allBlocks: blocks,
    runtimeBlocks: blocks.filter((b) =>
      ['provider', 'resource', 'data', 'module', 'backend'].includes(b.kind)
    ),
    moduleSourceDirs: [],
    callerBlocksBySource: {},
  };
}

describe('terraformIrToAssetInventory', () => {
  it('derives external services from provider blocks and resource prefixes, excluding utility providers', () => {
    const inv = terraformIrToAssetInventory(
      ir([
        block('provider', 'aws', '', ''),
        block('provider', 'datadog', '', ''),
        block('provider', 'random', '', ''),
        block('resource', 'aws_s3_bucket', 'logs', 'bucket = "x"'),
      ])
    );
    const services = inv.external_services.map((s) => s.service);
    expect(services).toContain('aws');
    expect(services).toContain('datadog');
    expect(services).not.toContain('random');
    expect(inv.external_services.find((s) => s.service === 'aws')?.kind).toBe('cloud');
    expect(inv.external_services.find((s) => s.service === 'datadog')?.kind).toBe('saas');
    expect(inv.stats.provider_kinds).toEqual(['aws', 'datadog', 'random']);
  });

  it('classifies internet-facing, internal, and default LB schemes', () => {
    const inv = terraformIrToAssetInventory(
      ir([
        block('resource', 'aws_lb', 'pub', 'internal = false'),
        block('resource', 'aws_lb', 'priv', 'internal = true'),
        block('resource', 'aws_lb', 'unset', 'load_balancer_type = "application"'),
      ])
    );
    const byRes = Object.fromEntries(
      inv.public_candidates.map((c) => [c.resource.split('::').pop(), c.exposure])
    );
    expect(byRes['resource.aws_lb.pub']).toBe('public');
    expect(byRes['resource.aws_lb.priv']).toBe('internal');
    expect(byRes['resource.aws_lb.unset']).toBe('public-candidate');
  });

  it('detects world-open ingress with sensitive ports from inline SG rules', () => {
    const inv = terraformIrToAssetInventory(
      ir([
        block(
          'resource',
          'aws_security_group',
          'ssh',
          `ingress {
        from_port   = 22
        to_port     = 22
        protocol    = "tcp"
        cidr_blocks = ["0.0.0.0/0"]
      }`
        ),
        block(
          'resource',
          'aws_security_group',
          'web',
          `ingress {
        from_port   = 443
        to_port     = 443
        protocol    = "tcp"
        cidr_blocks = ["0.0.0.0/0"]
      }`
        ),
      ])
    );
    expect(inv.ingress_findings).toHaveLength(2);
    const ssh = inv.ingress_findings.find((f) => f.resource.includes('ssh'))!;
    expect(ssh.open_to_world).toBe(true);
    expect(ssh.sensitive_ports).toEqual(['22/ssh']);
    const web = inv.ingress_findings.find((f) => f.resource.includes('web'))!;
    expect(web.sensitive_ports).toEqual([]);
  });

  it('detects ingress from standalone rule resources and all-protocol openings', () => {
    const inv = terraformIrToAssetInventory(
      ir([
        block(
          'resource',
          'aws_vpc_security_group_ingress_rule',
          'all',
          `cidr_ipv4 = "0.0.0.0/0"
        ip_protocol = "-1"`
        ),
      ])
    );
    expect(inv.ingress_findings).toHaveLength(1);
    expect(inv.ingress_findings[0].ports).toBe('all');
    expect(inv.ingress_findings[0].sensitive_ports).toContain('all-ports');
  });

  it('flags declared-public data stores and records them under data_stores', () => {
    const inv = terraformIrToAssetInventory(
      ir([
        block('resource', 'aws_db_instance', 'main', 'publicly_accessible = true'),
        block('resource', 'aws_s3_bucket_acl', 'logs', 'acl = "public-read"'),
      ])
    );
    const db = inv.public_candidates.find((c) => c.resource.includes('aws_db_instance'))!;
    expect(db.exposure).toBe('public');
    expect(inv.data_stores.map((d) => d.resource_type)).toEqual(
      expect.arrayContaining(['aws_db_instance', 'aws_s3_bucket_acl'])
    );
  });

  it('derives SaaS hints from DNS records (CNAME, SPF include, MX)', () => {
    const inv = terraformIrToAssetInventory(
      ir([
        block(
          'resource',
          'aws_route53_record',
          'www',
          `type = "CNAME"
        records = ["app.herokuapp.com"]
        name = "www.example.com"`
        ),
        block(
          'resource',
          'aws_route53_record',
          'spf',
          `type = "TXT"
        records = ["v=spf1 include:sendgrid.net ~all"]
        name = "example.com"`
        ),
        block(
          'resource',
          'aws_route53_record',
          'mx',
          `type = "MX"
        records = ["10 mail.protection.outlook.com"]
        name = "example.com"`
        ),
      ])
    );
    expect(inv.dns_records).toHaveLength(3);
    const services = inv.external_services.map((s) => s.service);
    expect(services).toEqual(expect.arrayContaining(['heroku', 'sendgrid', 'microsoft-365']));
    const heroku = inv.external_services.find((s) => s.service === 'heroku')!;
    expect(heroku.via).toContain('dns');
  });

  it('marks dynamic values as unresolved instead of guessing exposure', () => {
    const inv = terraformIrToAssetInventory(
      ir([block('resource', 'aws_db_instance', 'd', 'publicly_accessible = var.expose_db')])
    );
    expect(inv.unresolved_refs).toEqual(['.::resource.aws_db_instance.d::publicly_accessible']);
  });

  it('handles API gateway private vs edge endpoints and lambda auth', () => {
    const inv = terraformIrToAssetInventory(
      ir([
        block(
          'resource',
          'aws_api_gateway_rest_api',
          'priv',
          `endpoint_configuration {
        types = ["PRIVATE"]
      }`
        ),
        block('resource', 'aws_lambda_function_url', 'open', 'authorization_type = "NONE"'),
        block('resource', 'aws_lambda_function_url', 'iam', 'authorization_type = "AWS_IAM"'),
      ])
    );
    const byRes = Object.fromEntries(
      inv.public_candidates.map((c) => [c.resource.split('::').pop(), c.exposure])
    );
    expect(byRes['resource.aws_api_gateway_rest_api.priv']).toBe('internal');
    expect(byRes['resource.aws_lambda_function_url.open']).toBe('public');
    expect(byRes['resource.aws_lambda_function_url.iam']).toBe('internal');
  });

  it('extracts backends, module sources, outputs, and required_providers', () => {
    const inv = terraformIrToAssetInventory(
      ir([
        block(
          'terraform',
          'terraform',
          '',
          `backend "s3" {
        bucket = "state"
      }
      required_providers {
        okta = {
          source  = "okta/okta"
          version = ">= 4.0"
        }
      }`
        ),
        block('backend', 's3', '', 'backend "s3" { bucket = "state" }'),
        block('module', 'vpc', '', 'source = "terraform-aws-modules/vpc/aws"'),
        block('module', 'gitmod', '', 'source = "git::https://github.com/org/mod.git"'),
        block('output', 'url', '', 'value = "https://app.example.com"'),
      ])
    );
    expect(inv.backends).toHaveLength(1);
    expect(inv.backends[0].backend).toBe('s3');
    expect(inv.backends[0].attributes.bucket).toBe('"state"');
    expect(inv.module_sources.map((m) => m.source_kind)).toEqual(['registry', 'git']);
    expect(inv.outputs[0].url_like).toBe(true);
    expect(inv.required_providers.some((p) => p.name === 'okta' && p.source === 'okta/okta')).toBe(
      true
    );
    expect(inv.external_services.map((s) => s.service)).toContain('okta');
    // The `version = "..."` inside the okta object must not leak as a service.
    expect(inv.external_services.map((s) => s.service)).not.toContain('version');
  });

  it('detects wildcard-principal bucket policies written as heredocs', () => {
    const inv = terraformIrToAssetInventory(
      ir([
        block(
          'resource',
          'aws_s3_bucket_policy',
          'pub',
          `policy = <<POLICY
        {"Statement": [{"Principal": "*", "Action": "s3:GetObject"}]}
        POLICY`
        ),
      ])
    );
    const c = inv.public_candidates.find((x) => x.resource.includes('aws_s3_bucket_policy'))!;
    expect(c.exposure).toBe('public');
  });

  it('ignores commented-out attribute lines', () => {
    const inv = terraformIrToAssetInventory(
      ir([
        block(
          'resource',
          'aws_db_instance',
          'c',
          `# publicly_accessible = true
      // publicly_accessible = true
      publicly_accessible = false`
        ),
      ])
    );
    expect(inv.public_candidates).toHaveLength(0);
  });

  it('parses port ranges and wildcard ports on Azure NSG rules', () => {
    const inv = terraformIrToAssetInventory(
      ir([
        block(
          'resource',
          'azurerm_network_security_rule',
          'range',
          `direction = "Inbound"
        source_address_prefix = "0.0.0.0/0"
        destination_port_range = "80-443"
        protocol = "Tcp"`
        ),
        block(
          'resource',
          'azurerm_network_security_rule',
          'wild',
          `direction = "Inbound"
        source_address_prefix = "*"
        destination_port_range = "*"
        protocol = "*"`
        ),
      ])
    );
    const range = inv.ingress_findings.find((f) => f.resource.includes('range'))!;
    expect(range.ports).toEqual({ from: 80, to: 443 });
    const wild = inv.ingress_findings.find((f) => f.resource.includes('wild'))!;
    expect(wild.ports).toBe('all');
    expect(wild.sensitive_ports).toContain('all-ports');
  });

  it('records dynamic CIDR/port values as unresolved instead of dropping them', () => {
    const inv = terraformIrToAssetInventory(
      ir([
        block(
          'resource',
          'aws_vpc_security_group_ingress_rule',
          'dyn',
          `cidr_ipv4 = var.allowed_cidr
        from_port = 22
        to_port = 22
        ip_protocol = "tcp"`
        ),
      ])
    );
    expect(inv.ingress_findings).toHaveLength(0);
    expect(inv.unresolved_refs.some((r) => r.includes('cidr_ipv4'))).toBe(true);
  });

  it('reads dynamic ingress content blocks and flags authenticated-read ACLs', () => {
    const inv = terraformIrToAssetInventory(
      ir([
        block(
          'resource',
          'aws_security_group',
          'dyn',
          `dynamic "ingress" {
        for_each = var.rules
        content {
          from_port   = ingress.value.port
          to_port     = ingress.value.port
          cidr_blocks = ["0.0.0.0/0"]
        }
      }`
        ),
        block('resource', 'aws_s3_bucket_acl', 'auth', 'acl = "authenticated-read"'),
      ])
    );
    const sg = inv.ingress_findings.find((f) => f.resource.includes('aws_security_group'))!;
    expect(sg.open_to_world).toBe(true);
    expect(inv.unresolved_refs.some((r) => r.includes('for_each'))).toBe(true);
    const acl = inv.public_candidates.find((c) => c.resource.includes('aws_s3_bucket_acl'))!;
    expect(acl.exposure).toBe('public');
  });

  it('flags mixed literal+reference CIDR lists as unresolved', () => {
    const inv = terraformIrToAssetInventory(
      ir([
        block(
          'resource',
          'aws_security_group_rule',
          'mixed',
          `type = "ingress"
        from_port = 443 to_port = 443 protocol = "tcp"
        cidr_blocks = ["10.0.0.0/8", aws_vpc.main.cidr_block]`
        ),
      ])
    );
    expect(inv.unresolved_refs.some((r) => r.includes('cidr_blocks'))).toBe(true);
  });

  it('detects wildcards in data aws_iam_policy_document (HCL form)', () => {
    const inv = terraformIrToAssetInventory(
      ir([
        block(
          'data',
          'aws_iam_policy_document',
          'admin',
          `statement {
        actions = ["*"]
        resources = ["*"]
      }`
        ),
        block(
          'data',
          'aws_iam_policy_document',
          'ext',
          `statement {
        principals { type = "AWS" identifiers = ["*"] }
        actions = ["sts:AssumeRole"]
      }`
        ),
      ])
    );
    const admin = inv.public_candidates.find((c) => c.resource.includes('admin'))!;
    expect(admin.signals.some((s) => s.rule === 'EXPOSURE_IAM_ADMIN')).toBe(true);
    const ext = inv.public_candidates.find((c) => c.resource.includes('ext'))!;
    expect(ext.signals.some((s) => s.rule === 'EXPOSURE_IAM_WILDCARD_PRINCIPAL')).toBe(true);
  });

  it('flags unquoted resource-reference CIDRs as unresolved, not skipped', () => {
    const inv = terraformIrToAssetInventory(
      ir([
        block(
          'resource',
          'aws_security_group_rule',
          'vpc',
          `type = "ingress"
        from_port = 443
        to_port = 443
        protocol = "tcp"
        cidr_blocks = [aws_vpc.main.cidr_block]
        security_group_id = aws_security_group.allow_tls.id`
        ),
      ])
    );
    expect(inv.unresolved_refs.some((r) => r.includes('cidr_blocks'))).toBe(true);
    expect(inv.ingress_findings).toHaveLength(0);
  });

  it('captures terraform-cloud backends and skips placeholder domains', () => {
    const inv = terraformIrToAssetInventory(
      ir([
        block('terraform', 'terraform', '', 'cloud {\n    organization = "acme"\n  }'),
        block('module', 'm', '', 'source = "git::https://example.com/mod.git?ref=v1"'),
      ])
    );
    expect(inv.backends.some((b) => b.backend === 'terraform-cloud')).toBe(true);
    expect(inv.external_services.map((s) => s.service)).toContain('terraform-cloud');
    expect(inv.external_services.map((s) => s.service)).not.toContain('example');
  });

  it('skips GCP EGRESS firewall rules and flags non-literal source_ranges', () => {
    const inv = terraformIrToAssetInventory(
      ir([
        block(
          'resource',
          'google_compute_firewall',
          'out',
          `direction = "EGRESS"
        source_ranges = ["0.0.0.0/0"]
        allow { protocol = "tcp" ports = ["443"] }`
        ),
        block(
          'resource',
          'google_compute_firewall',
          'dyn',
          `source_ranges = [google_compute_network.x.id]
        allow { protocol = "tcp" ports = ["22"] }`
        ),
      ])
    );
    expect(inv.ingress_findings).toHaveLength(0);
    expect(inv.unresolved_refs.some((r) => r.includes('source_ranges'))).toBe(true);
  });

  it('detects MSK public_access via SERVICE_PROVIDED_EIPS', () => {
    const inv = terraformIrToAssetInventory(
      ir([
        block(
          'resource',
          'aws_msk_cluster',
          'm',
          `broker_node_group_info {
        connectivity_info { public_access { type = "SERVICE_PROVIDED_EIPS" } }
      }`
        ),
      ])
    );
    const c = inv.public_candidates.find((x) => x.resource.includes('aws_msk_cluster'))!;
    expect(c.exposure).toBe('public');
    expect(c.signals.some((s) => s.rule === 'EXPOSURE_MSK_PUBLIC')).toBe(true);
  });

  it('flags wildcard-principal and admin-wildcard IAM documents', () => {
    const inv = terraformIrToAssetInventory(
      ir([
        block(
          'resource',
          'aws_iam_role',
          'ext',
          `assume_role_policy = <<JSON
        {"Statement": [{"Principal": {"AWS": "*"}, "Action": "sts:AssumeRole"}]}
        JSON`
        ),
        block(
          'resource',
          'aws_iam_policy',
          'admin',
          `policy = <<JSON
        {"Statement": [{"Action": "*", "Resource": "*"}]}
        JSON`
        ),
      ])
    );
    const role = inv.public_candidates.find((c) => c.resource.includes('aws_iam_role'))!;
    expect(role.signals.some((s) => s.rule === 'EXPOSURE_IAM_WILDCARD_PRINCIPAL')).toBe(true);
    const pol = inv.public_candidates.find((c) => c.resource.includes('aws_iam_policy'))!;
    expect(pol.signals.some((s) => s.rule === 'EXPOSURE_IAM_ADMIN')).toBe(true);
  });

  it('reads inline ingress on aws_default_security_group', () => {
    const inv = terraformIrToAssetInventory(
      ir([
        block(
          'resource',
          'aws_default_security_group',
          'd',
          `ingress {
        from_port = 22 to_port = 22 protocol = "tcp"
        cidr_blocks = ["0.0.0.0/0"]
      }`
        ),
      ])
    );
    expect(inv.ingress_findings).toHaveLength(1);
    expect(inv.ingress_findings[0].sensitive_ports).toContain('22/ssh');
  });

  it('joins Azure NSG associations and literal-name rules to open NSGs', () => {
    const inv = terraformIrToAssetInventory(
      ir([
        block('resource', 'azurerm_network_security_group', 'web', 'name = "web-nsg"'),
        block(
          'resource',
          'azurerm_network_security_rule',
          'open',
          `network_security_group_name = azurerm_network_security_group.web.name
        direction = "Inbound"
        source_address_prefix = "*"
        destination_port_range = "3389"`
        ),
        block(
          'resource',
          'azurerm_network_interface_security_group_association',
          'a',
          `network_interface_id = azurerm_network_interface.app.id
        network_security_group_id = azurerm_network_security_group.web.id`
        ),
        block('resource', 'azurerm_network_interface', 'app', ''),
      ])
    );
    const assoc = inv.public_candidates.find((c) =>
      c.resource.includes('security_group_association')
    )!;
    expect(assoc.signals.some((s) => s.rule === 'EXPOSURE_VIA_OPEN_NSG')).toBe(true);
    const nic = inv.public_candidates.find((c) =>
      c.resource.includes('azurerm_network_interface.app')
    )!;
    expect(nic.signals.some((s) => s.rule === 'EXPOSURE_VIA_OPEN_NSG')).toBe(true);
  });

  it('joins GCP firewall target_tags and network-wide rules to instances', () => {
    const inv = terraformIrToAssetInventory(
      ir([
        block(
          'resource',
          'google_compute_firewall',
          'web',
          `source_ranges = ["0.0.0.0/0"]
        target_tags = ["web"]
        allow { protocol = "tcp" ports = ["80"] }`
        ),
        block('resource', 'google_compute_instance', 'web1', 'tags = ["web", "prod"]'),
        block('resource', 'google_compute_instance', 'db1', 'tags = ["db"]'),
        block(
          'resource',
          'google_compute_firewall',
          'all',
          `source_ranges = ["0.0.0.0/0"]
        allow { protocol = "tcp" ports = ["443"] }`
        ),
        block(
          'resource',
          'google_compute_instance',
          'other-net',
          `network_interface { network = "custom" }`
        ),
      ])
    );
    const web1 = inv.public_candidates.find((c) => c.resource.includes('web1'))!;
    expect(web1.signals.some((s) => s.rule === 'EXPOSURE_VIA_OPEN_FIREWALL')).toBe(true);
    // 'all' firewall has no target_tags → applies to default-network instances.
    const db1 = inv.public_candidates.find((c) => c.resource.includes('db1'))!;
    expect(db1.signals.some((s) => s.rule === 'EXPOSURE_VIA_OPEN_FIREWALL')).toBe(true);
    // custom-network instance only matches tag-targeted rules — 'web' tag absent → no hit.
    const other = inv.public_candidates.find((c) => c.resource.includes('other-net'));
    expect(
      other === undefined || !other.signals.some((s) => s.rule === 'EXPOSURE_VIA_OPEN_FIREWALL')
    ).toBe(true);
  });

  it('flags default routes to internet gateways and ignores referenced source SGs', () => {
    const inv = terraformIrToAssetInventory(
      ir([
        block(
          'resource',
          'aws_route_table',
          'pub',
          `route {
        cidr_block = "0.0.0.0/0"
        gateway_id = aws_internet_gateway.main.id
      }`
        ),
        block(
          'resource',
          'aws_route',
          'priv',
          `route_table_id = aws_route_table.private.id
        destination_cidr_block = "0.0.0.0/0"
        gateway_id = aws_nat_gateway.nat.id`
        ),
        block(
          'resource',
          'aws_vpc_security_group_ingress_rule',
          'sgt',
          `security_group_id = aws_security_group.inner.id
        referenced_security_group_id = aws_security_group.web.id
        cidr_ipv6 = "::/0" from_port = 443 to_port = 443 ip_protocol = "tcp"`
        ),
        block(
          'resource',
          'aws_instance',
          'app',
          'security_groups = ["${aws_security_group.inner.id}"]'
        ),
      ])
    );
    const rt = inv.public_candidates.find((c) => c.resource.includes('aws_route_table'))!;
    expect(rt.signals.some((s) => s.rule === 'EXPOSURE_IGW_ROUTE')).toBe(true);
    expect(inv.public_candidates.find((c) => c.resource.includes('aws_route.'))).toBeUndefined();
    // The open rule targets `inner`; `web` (the source SG) must not become a guard.
    const inst = inv.public_candidates.find((c) => c.resource.includes('aws_instance'))!;
    expect(inst.signals.some((s) => s.rule === 'EXPOSURE_VIA_OPEN_SG')).toBe(true);
    const webSg = inv.public_candidates.find((c) => c.resource.includes('aws_security_group.web'));
    expect(
      webSg === undefined || !webSg.signals.some((s) => s.rule === 'EXPOSURE_VIA_OPEN_SG')
    ).toBe(true);
  });

  it('ignores Azure Deny rules and never leaks "access" into the protocol field', () => {
    const inv = terraformIrToAssetInventory(
      ir([
        block(
          'resource',
          'azurerm_network_security_rule',
          'deny',
          `direction = "Inbound"
        access = "Deny"
        source_address_prefix = "0.0.0.0/0"
        destination_port_range = "*"`
        ),
        block(
          'resource',
          'azurerm_network_security_rule',
          'allow',
          `direction = "Inbound"
        access = "Allow"
        protocol = "Tcp"
        source_address_prefix = "0.0.0.0/0"
        destination_port_range = "443"`
        ),
      ])
    );
    expect(inv.ingress_findings).toHaveLength(1);
    expect(inv.ingress_findings[0].resource).toContain('allow');
    expect(inv.ingress_findings[0].protocol).toBe('Tcp');
  });

  it('records prefix_list_ids as cidr evidence instead of skipping the rule', () => {
    const inv = terraformIrToAssetInventory(
      ir([
        block(
          'resource',
          'aws_vpc_security_group_ingress_rule',
          'pl',
          `cidr_ipv6 = "::/0"
        prefix_list_ids = ["pl-abcdef"]
        from_port = 443 to_port = 443 ip_protocol = "tcp"`
        ),
      ])
    );
    expect(inv.ingress_findings).toHaveLength(1);
    expect(inv.ingress_findings[0].cidrs).toContain('pl-abcdef');
  });

  it('skips disabled GCP firewall rules', () => {
    const inv = terraformIrToAssetInventory(
      ir([
        block(
          'resource',
          'google_compute_firewall',
          'off',
          `disabled = true
        source_ranges = ["0.0.0.0/0"]
        allow { protocol = "tcp" ports = ["22"] }`
        ),
      ])
    );
    expect(inv.ingress_findings).toHaveLength(0);
  });

  it('flags AKS/GKE default-public control-plane endpoints', () => {
    const inv = terraformIrToAssetInventory(
      ir([
        block('resource', 'azurerm_kubernetes_cluster', 'aks', ''),
        block('resource', 'google_container_cluster', 'gke', ''),
        block('resource', 'google_container_cluster', 'priv', 'enable_private_endpoint = true'),
      ])
    );
    const aks = inv.public_candidates.find((c) => c.resource.includes('aks'))!;
    expect(aks.exposure).toBe('public');
    const gke = inv.public_candidates.find(
      (c) => c.resource.includes('gke') && !c.resource.includes('priv')
    )!;
    expect(gke.signals.some((s) => s.rule === 'EXPOSURE_GKE_DEFAULT_PUBLIC')).toBe(true);
    const priv = inv.public_candidates.find((c) => c.resource.includes('priv'))!;
    expect(priv.exposure).toBe('internal');
  });

  it('dedupes double-parsed blocks but keeps same-id blocks from different files', () => {
    const dup: TerraformBlock = {
      kind: 'resource',
      type: 'aws_security_group_rule',
      name: 'open',
      id: 'mod::resource.aws_security_group_rule.open',
      dir: 'mod',
      body: 'type = "ingress"\nfrom_port = 80\nto_port = 80\nprotocol = "tcp"\ncidr_blocks = ["0.0.0.0/0"]',
      filePath: '/root/mod/a.tf',
    };
    const sameBlockAbsPath = { ...dup, filePath: '/abs/root/mod/a.tf' };
    const sameIdOtherFile = { ...dup, filePath: '/root/mod/b.tf' };
    const inv = terraformIrToAssetInventory(ir([dup, sameBlockAbsPath, sameIdOtherFile]));
    expect(inv.ingress_findings).toHaveLength(2);
  });

  it('keeps registry module sources out of service candidates and dedupes services', () => {
    const inv = terraformIrToAssetInventory(
      ir([
        block('provider', 'aws', '', ''),
        block('module', 'vpc', '', 'source = "terraform-aws-modules/vpc/aws"'),
        block('module', 'gitmod', '', 'source = "git::https://github.com/org/mod.git"'),
        block('module', 'sshmod', '', 'source = "git@github.com:org/mod.git"'),
      ])
    );
    const services = inv.external_services.map((s) => s.service);
    expect(services).not.toContain('terraform-aws-modules');
    expect(services).toContain('github');
    const aws = inv.external_services.filter((s) => s.service === 'aws');
    expect(aws).toHaveLength(1);
  });
});
