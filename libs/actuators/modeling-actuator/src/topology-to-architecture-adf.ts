import * as path from 'node:path';
import { safeExistsSync, safeLstat, safeReadFile, safeReaddir } from '@agent/core';
import type { TerraformBlock, TerraformTopologyIr } from './topology-ir.js';
import { resolveTerraformModuleSourceDir } from './terraform-topology.js';

function titleCase(value: string): string {
  return value
    .split(/[-_/]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function shouldSkipTerraformDir(name: string): boolean {
  return ['.git', '.terraform', '.terragrunt-cache', 'node_modules'].includes(name);
}

function listModuleTfFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of safeReaddir(dir)) {
    if (shouldSkipTerraformDir(name)) continue;
    const abs = path.join(dir, name);
    const stat = safeLstat(abs);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) out.push(...listModuleTfFiles(abs));
    else if (stat.isFile() && abs.endsWith('.tf')) out.push(abs);
  }
  return out.sort();
}

function blockLookupId(ref: string, currentDir: string, blocksById: Map<string, TerraformBlock>): string | null {
  const candidates: string[] = [];
  if (ref.startsWith('module.')) candidates.push(`${currentDir}::${ref}`);
  else if (ref.startsWith('data.')) candidates.push(`${currentDir}::${ref}`);
  else candidates.push(`${currentDir}::resource.${ref}`);
  for (const key of candidates) {
    if (blocksById.has(key)) return key;
  }
  for (const key of blocksById.keys()) {
    if (ref.startsWith('module.') || ref.startsWith('data.')) {
      if (key.endsWith(`::${ref}`)) return key;
    } else if (key.endsWith(`::resource.${ref}`)) {
      return key;
    }
  }
  return null;
}

function extractSecurityGroupReference(body: string): string | null {
  const text = String(body || '');
  const direct = text.match(/security_group_id\s*=\s*"\$\{(aws_security_group\.[A-Za-z0-9_]+)\.id\}"/);
  if (direct) return direct[1];
  const loose = text.match(/security_group_id\s*=\s*"\$\{([^}]+)\}"/);
  if (loose) return loose[1];
  return null;
}

function extractProviderRegion(body: string): string | null {
  const match = String(body || '').match(/\bregion\s*=\s*"([^"]+)"/);
  return match ? match[1] : null;
}

function providerTechnology(type: string): string {
  const map: Record<string, string> = {
    aws_instance: 'Amazon EC2',
    aws_vpc: 'Amazon VPC',
    aws_subnet: 'Subnet',
    aws_security_group: 'Security Group',
    aws_security_group_rule: 'Security Group Rule',
    aws_launch_configuration: 'Launch Configuration',
    aws_autoscaling_group: 'Auto Scaling Group',
    aws_autoscaling_schedule: 'Auto Scaling Schedule',
    aws_elb: 'Elastic Load Balancer',
    aws_lb: 'Elastic Load Balancing',
    aws_db_instance: 'Amazon RDS',
    aws_s3_bucket: 'Amazon S3',
    aws_cloudwatch_metric_alarm: 'Amazon CloudWatch',
    terraform_remote_state: 'Terraform Remote State',
  };
  return map[type] || titleCase(type.replace(/^aws_/, ''));
}

function iconKeyForType(type: string): string {
  if (type === 'aws_db_instance') return 'aws_rds_instance';
  return type;
}

function containerIdForDir(dir: string): string {
  return dir === '.' ? 'container::.' : `container::${dir}`;
}

function laneContainerId(parentId: string, tier: string): string {
  const scopeId = parentId === 'container::.' ? 'root' : parentId.replace(/^container::/, '');
  return `lane::${scopeId}::${tier}`;
}

function vpcContainerIdForDir(dir: string): string {
  return `container::vpc::${dir === '.' ? 'root' : dir}`;
}

function azContainerId(dir: string, azKey: string): string {
  return `container::az::${dir === '.' ? 'root' : dir}::${azKey}`;
}

function subnetContainerId(dir: string, azKey: string, subnetKind: string): string {
  return `container::subnet::${dir === '.' ? 'root' : dir}::${azKey}::${subnetKind}`;
}

function shouldCreateSemanticLane(parentId: string, tier: string): boolean {
  if (!parentId || !tier) return false;
  if (!parentId.startsWith('container::')) return false;
  if (tier === 'module') return false;
  return ['state', 'control', 'network', 'security', 'edge', 'web', 'application', 'data'].includes(tier);
}

function preferredSizeForLane(tier: string): { preferred_width: number; preferred_height: number } {
  switch (tier) {
    case 'control':
    case 'state':
      return { preferred_width: 220, preferred_height: 150 };
    case 'edge':
      return { preferred_width: 240, preferred_height: 160 };
    case 'security':
      return { preferred_width: 260, preferred_height: 190 };
    case 'web':
      return { preferred_width: 300, preferred_height: 180 };
    case 'application':
      return { preferred_width: 280, preferred_height: 170 };
    case 'data':
      return { preferred_width: 260, preferred_height: 170 };
    case 'network':
      return { preferred_width: 280, preferred_height: 180 };
    default:
      return { preferred_width: 220, preferred_height: 150 };
  }
}

function preferredSizeForBlock(block: TerraformBlock, semanticTier: string): Record<string, number> {
  if (block.kind === 'module') {
    return { preferred_width: 196, preferred_height: 112 };
  }
  if (block.kind === 'backend' || block.kind === 'provider') {
    return { preferred_width: 84, preferred_height: 84 };
  }
  if (block.kind === 'data') {
    if (block.type === 'terraform_remote_state') return { preferred_width: 92, preferred_height: 92 };
    if (block.type === 'template_file') return { preferred_width: 140, preferred_height: 72 };
    return { preferred_width: 80, preferred_height: 80 };
  }
  if (block.kind === 'resource') {
    if (block.type === 'aws_security_group_rule') return { preferred_width: 72, preferred_height: 72 };
    if (semanticTier === 'edge' || semanticTier === 'data') return { preferred_width: 92, preferred_height: 92 };
    if (semanticTier === 'security' || semanticTier === 'control') return { preferred_width: 80, preferred_height: 80 };
    return { preferred_width: 88, preferred_height: 88 };
  }
  return {};
}

function inferSemanticTier(block: TerraformBlock): string {
  const dir = `${block.dir}/${block.name || ''}`.toLowerCase();
  const type = String(block.type || '').toLowerCase();
  const body = String(block.body || '').toLowerCase();
  if (type === 'terraform_remote_state' || type.startsWith('backend_')) return 'state';
  if (type.includes('db') || type.includes('rds') || type.includes('s3') || dir.includes('data-store') || dir.includes('/mysql')) return 'data';
  if (type.includes('security_group') || type.startsWith('aws_iam_') || body.includes('cidr_blocks')) return 'security';
  if (type.includes('cloudwatch') || type.includes('autoscaling_schedule') || type.includes('availability_zones') || type === 'template_file') return 'control';
  if (type.includes('vpc') || type.includes('subnet') || type.includes('internet_gateway') || type.includes('nat_gateway') || dir.includes('/network') || dir.includes('/vpc')) return 'network';
  if (type === 'aws_elb' || type === 'aws_lb' || dir.includes('load-balancer')) return 'edge';
  if (type.includes('instance') || type.includes('launch_configuration') || type.includes('launch_template') || type.includes('autoscaling_group') || dir.includes('webserver')) return 'web';
  if (block.kind === 'module') return 'module';
  if (block.kind === 'backend') return 'state';
  return 'application';
}

function inferContainerTier(dir: string): string {
  const value = String(dir || '').toLowerCase();
  if (value === '.') return 'application';
  if (value.includes('global') || value.includes('state')) return 'state';
  if (value.includes('network') || value.includes('vpc')) return 'network';
  if (value.includes('services') || value.includes('webserver')) return 'web';
  if (value.includes('data-stores') || value.includes('mysql') || value.includes('s3')) return 'data';
  if (value.includes('security')) return 'security';
  if (value.includes('modules')) return 'module';
  return 'application';
}

function isVpcScopedBlock(block: TerraformBlock): boolean {
  const type = String(block?.type || '').toLowerCase();
  if (block?.kind === 'provider' || block?.kind === 'backend' || block?.kind === 'module') return false;
  if (type === 'terraform_remote_state' || type === 'template_file') return false;
  if (type.includes('s3')) return false;
  return [
    'aws_vpc',
    'aws_subnet',
    'aws_internet_gateway',
    'aws_nat_gateway',
    'aws_route_table',
    'aws_route',
    'aws_security_group',
    'aws_security_group_rule',
    'aws_elb',
    'aws_lb',
    'aws_instance',
    'aws_launch_configuration',
    'aws_launch_template',
    'aws_autoscaling_group',
    'aws_autoscaling_schedule',
    'aws_db_instance',
    'aws_rds_instance',
  ].some((prefix) => type.includes(prefix.replace(/^aws_/, '')) || type === prefix);
}

function inferExampleRegion(blocks: TerraformBlock[]): string {
  for (const block of blocks) {
    if (block.kind !== 'provider') continue;
    const region = extractProviderRegion(block.body);
    if (region) return region;
  }
  return 'default-region';
}

function isWithinModuleSourceDir(dir: string, moduleSourceDirs: string[]): boolean {
  return moduleSourceDirs.some((sourceDir) => dir === sourceDir || dir.startsWith(`${sourceDir}/`));
}

function collectVpcScopeDirs(blocks: TerraformBlock[]): Set<string> {
  const dirs = new Set<string>();
  for (const block of blocks) {
    if (!isVpcScopedBlock(block)) continue;
    dirs.add(block.dir || '.');
  }
  return dirs;
}

function buildScopeNetworkModel(blocks: TerraformBlock[]): Map<string, any> {
  const model = new Map<string, any>();
  const ensure = (dir: string) => {
    if (!model.has(dir)) {
      model.set(dir, {
        vpcScoped: false,
        multiAz: false,
        hasPublic: false,
        hasPrivate: false,
        hasAppTier: false,
        hasWebTier: false,
        hasSecurityTier: false,
        hasDataTier: false,
        hasOpenIngress: false,
        hasOpenEgress: false,
        hasInternetGateway: false,
        hasNatGateway: false,
        hasRouteTable: false,
      });
    }
    return model.get(dir);
  };

  for (const block of blocks) {
    const dir = block.dir || '.';
    const entry = ensure(dir);
    if (isVpcScopedBlock(block)) entry.vpcScoped = true;
    const tier = inferSemanticTier(block);
    const type = String(block.type || '').toLowerCase();
    const body = String(block.body || '').toLowerCase();
    if (entry.vpcScoped && (type.includes('availability_zones') || type.includes('autoscaling_group') || type === 'aws_elb' || type === 'aws_lb')) entry.multiAz = true;
    if (entry.vpcScoped && tier === 'edge') entry.hasPublic = true;
    if (entry.vpcScoped && ['web', 'application', 'data', 'security'].includes(tier)) entry.hasPrivate = true;
    if (entry.vpcScoped && tier === 'application') entry.hasAppTier = true;
    if (entry.vpcScoped && tier === 'web') entry.hasWebTier = true;
    if (entry.vpcScoped && tier === 'security') entry.hasSecurityTier = true;
    if (entry.vpcScoped && tier === 'data') entry.hasDataTier = true;
    if (entry.vpcScoped && body.includes('0.0.0.0/0') && body.includes('ingress')) {
      entry.hasOpenIngress = true;
      entry.hasPublic = true;
    }
    if (entry.vpcScoped && body.includes('0.0.0.0/0') && body.includes('egress')) {
      entry.hasOpenEgress = true;
      entry.hasPublic = true;
    }
    if (entry.vpcScoped && block.kind === 'resource' && type.includes('internet_gateway')) {
      entry.hasInternetGateway = true;
      entry.hasPublic = true;
    }
    if (entry.vpcScoped && block.kind === 'resource' && type.includes('nat_gateway')) {
      entry.hasNatGateway = true;
      entry.hasPrivate = true;
    }
    if (entry.vpcScoped && block.kind === 'resource' && (type.includes('route_table') || type === 'aws_route')) {
      entry.hasRouteTable = true;
    }
  }
  return model;
}

function inferSubnetKindForBlock(block: TerraformBlock, resolvedTier: string): string | null {
  const type = String(block?.type || '').toLowerCase();
  const name = String(block?.name || '').toLowerCase();
  const body = String(block?.body || '').toLowerCase();
  const relatedSecurityGroup = extractSecurityGroupReference(block?.body || '')?.toLowerCase() || '';
  if (type === 'aws_elb' || type === 'aws_lb' || type.includes('internet_gateway') || type.includes('nat_gateway')) return 'public';
  if (type.includes('db') || type.includes('rds') || resolvedTier === 'data') return 'private-data';
  if (type === 'aws_security_group' || type === 'aws_security_group_rule') {
    const publicFacing = type === 'aws_security_group'
      ? (name.includes('elb') || body.includes('elb'))
      : (name.includes('elb') || body.includes('elb') || relatedSecurityGroup.includes('elb') || body.includes('cidr_blocks'));
    return publicFacing ? 'public' : 'private-app';
  }
  if (type.includes('route_table') || type === 'aws_route') {
    const publicFacing = name.includes('public') || body.includes('internet_gateway') || body.includes('0.0.0.0/0') || body.includes('igw');
    if (publicFacing) return 'public';
    if (body.includes('nat_gateway') || body.includes('private')) return 'private-app';
  }
  if (resolvedTier === 'network' || resolvedTier === 'web' || resolvedTier === 'application' || resolvedTier === 'security') return 'private-app';
  return null;
}

function regionalLaneHostForBlock(block: TerraformBlock, resolvedTier: string, networkModel: Map<string, any>): string | null {
  const dir = block.dir || '.';
  const entry = networkModel.get(dir);
  if (!entry?.vpcScoped || !entry.multiAz) return null;
  if (block.kind === 'data' && block.type === 'aws_availability_zones') return containerIdForDir(dir);
  if (block.kind === 'resource' && (block.type === 'aws_elb' || block.type === 'aws_lb') && resolvedTier === 'edge') return vpcContainerIdForDir(dir);
  if (block.kind === 'resource' && block.type === 'aws_autoscaling_group' && resolvedTier === 'web') return vpcContainerIdForDir(dir);
  return null;
}

function laneHostParentForBlock(block: TerraformBlock, resolvedTier: string, networkModel: Map<string, any>): string {
  const scopeParent = containerIdForDir(block.dir);
  const regionalParent = regionalLaneHostForBlock(block, resolvedTier, networkModel);
  if (regionalParent) return regionalParent;
  const entry = networkModel.get(block.dir || '.');
  if (!entry?.vpcScoped) return scopeParent;
  const subnetKind = inferSubnetKindForBlock(block, resolvedTier);
  if (subnetKind) return subnetContainerId(block.dir || '.', 'a', subnetKind);
  return scopeParent;
}

function nodeForBlock(block: TerraformBlock, networkModel: Map<string, any>): any {
  const semanticTier = inferSemanticTier(block);
  const scopeParent = containerIdForDir(block.dir);
  const resolvedTier =
    block.kind === 'provider' ? 'control' :
    block.kind === 'backend' ? 'state' :
    semanticTier;
  const baseParent = laneHostParentForBlock(block, resolvedTier, networkModel);
  const parent = shouldCreateSemanticLane(scopeParent, resolvedTier) ? laneContainerId(baseParent, resolvedTier) : baseParent;
  const sizeHints = preferredSizeForBlock(block, resolvedTier);

  if (block.kind === 'provider') {
    return {
      id: block.id,
      type: 'aws_provider',
      name: `${block.type} provider`,
      technology: titleCase(block.type),
      provider: 'aws',
      group: 'control',
      parent: scopeParent,
      render_hints: { semantic_tier: 'control', ...sizeHints },
    };
  }
  if (block.kind === 'backend') {
    return {
      id: block.id,
      type: `backend_${block.type}`,
      name: `${block.type} backend`,
      technology: `${titleCase(block.type)} backend`,
      provider: 'aws',
      group: 'state',
      parent: scopeParent,
      render_hints: { semantic_tier: 'state', ...sizeHints },
    };
  }
  if (block.kind === 'data') {
    return {
      id: block.id,
      type: block.type,
      icon_key: iconKeyForType(block.type),
      name: block.name || block.type,
      technology: providerTechnology(block.type),
      provider: 'aws',
      group: semanticTier,
      parent,
      render_hints: { semantic_tier: semanticTier, ...sizeHints },
    };
  }
  if (block.kind === 'module') {
    return {
      id: block.id,
      type: 'terraform_module',
      name: block.type,
      technology: 'Terraform Module',
      provider: 'terraform',
      group: 'module',
      parent,
      render_hints: { semantic_tier: 'module', ...sizeHints },
    };
  }
  if (block.kind === 'resource') {
    const relatedSecurityGroup = block.type === 'aws_security_group_rule' ? extractSecurityGroupReference(block.body) : null;
    const securityClusterKey =
      block.type === 'aws_security_group'
        ? `security:${block.dir}:aws_security_group.${block.name}`
        : relatedSecurityGroup
          ? `security:${block.dir}:${relatedSecurityGroup}`
          : undefined;
    return {
      id: block.id,
      type: block.type,
      icon_key: iconKeyForType(block.type),
      name: block.name,
      technology: providerTechnology(block.type),
      provider: 'aws',
      group: semanticTier === 'web' ? 'application' : semanticTier,
      parent,
      render_hints: {
        semantic_tier: semanticTier,
        related_security_group: relatedSecurityGroup || extractSecurityGroupReference(block.body) || undefined,
        cluster_key: securityClusterKey,
        ...sizeHints,
      },
    };
  }
  return null;
}

function collectDirContainers(exampleName: string, blocks: TerraformBlock[], networkModel: Map<string, any>): any[] {
  const region = inferExampleRegion(blocks);
  const accountId = `container::account::${slugify(exampleName)}`;
  const regionId = `container::region::${slugify(exampleName)}::${slugify(region)}`;
  const vpcScopeDirs = collectVpcScopeDirs(blocks);
  const dirSet = new Set<string>(['.']);
  for (const block of blocks) {
    const parts = block.dir.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      dirSet.add(current);
    }
  }
  const dirs = [...dirSet].sort();
  const containers: any[] = [
    {
      id: `container::${slugify(exampleName)}`,
      type: 'terraform_example',
      name: exampleName,
      technology: `Terraform Example ${exampleName}`,
      provider: 'aws',
      boundary: 'example',
      render_hints: { container: true, preferred_width: 300, preferred_height: 220, semantic_tier: 'application' },
    },
    {
      id: accountId,
      type: 'aws_account',
      name: 'AWS Account',
      technology: 'AWS Account',
      provider: 'aws',
      boundary: 'account',
      parent: `container::${slugify(exampleName)}`,
      render_hints: { container: true, preferred_width: 320, preferred_height: 240, semantic_tier: 'application' },
    },
    {
      id: regionId,
      type: 'aws_region',
      name: region,
      technology: `AWS Region ${region}`,
      provider: 'aws',
      boundary: 'region',
      parent: accountId,
      render_hints: { container: true, preferred_width: 300, preferred_height: 220, semantic_tier: 'network' },
    },
    {
      id: 'container::.',
      type: 'terraform_scope',
      name: 'root',
      technology: 'Root Scope',
      provider: 'terraform',
      boundary: 'scope',
      parent: regionId,
      render_hints: { container: true, preferred_width: 260, preferred_height: 180, semantic_tier: 'application' },
    },
  ];

  for (const dir of dirs) {
    if (dir === '.') continue;
    const parentDir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '.';
    containers.push({
      id: `container::${dir}`,
      type: 'terraform_scope',
      name: dir,
      technology: titleCase(dir),
      provider: 'terraform',
      boundary: 'scope',
      parent: parentDir === '.' ? regionId : `container::${parentDir}`,
      render_hints: { container: true, preferred_width: 260, preferred_height: 180, semantic_tier: inferContainerTier(dir) },
    });
  }

  const vpcContainers: any[] = [];
  const subnetContainers: any[] = [];
  for (const dir of [...vpcScopeDirs].sort()) {
    const vpcId = vpcContainerIdForDir(dir);
    const parentDir = dir === '.' ? '.' : (dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '.');
    vpcContainers.push({
      id: vpcId,
      type: 'aws_vpc',
      name: dir === '.' ? 'Default VPC' : `${dir} VPC`,
      technology: 'Amazon VPC',
      provider: 'aws',
      boundary: 'vpc',
      parent: parentDir === '.' ? regionId : `container::${parentDir}`,
      render_hints: { container: true, preferred_width: 280, preferred_height: 200, semantic_tier: 'network' },
    });
    const net = networkModel.get(dir) || {};
    const azKeys = net.multiAz ? ['a', 'b'] : ['a'];
    for (const azKey of azKeys) {
      const azId = azContainerId(dir, azKey);
      subnetContainers.push({
        id: azId,
        type: 'aws_availability_zone',
        name: `AZ ${azKey.toUpperCase()}`,
        technology: 'Availability Zone',
        provider: 'aws',
        boundary: 'az',
        parent: vpcId,
        render_hints: { container: true, preferred_width: 300, preferred_height: 220, semantic_tier: 'network' },
      });
      if (net.hasPublic) {
        subnetContainers.push({
          id: subnetContainerId(dir, azKey, 'public'),
          type: 'aws_subnet',
          name: 'Public Subnet',
          technology: 'Public Subnet',
          provider: 'aws',
          boundary: 'subnet',
          parent: azId,
          render_hints: { container: true, preferred_width: 260, preferred_height: 180, semantic_tier: 'network' },
        });
      }
      if (net.hasPrivate) {
        subnetContainers.push({
          id: subnetContainerId(dir, azKey, 'private-app'),
          type: 'aws_subnet',
          name: 'Private App Subnet',
          technology: 'Private App Subnet',
          provider: 'aws',
          boundary: 'subnet',
          parent: azId,
          render_hints: { container: true, preferred_width: 280, preferred_height: 220, semantic_tier: 'network' },
        });
        subnetContainers.push({
          id: subnetContainerId(dir, azKey, 'private-data'),
          type: 'aws_subnet',
          name: 'Private Data Subnet',
          technology: 'Private Data Subnet',
          provider: 'aws',
          boundary: 'subnet',
          parent: azId,
          render_hints: { container: true, preferred_width: 260, preferred_height: 180, semantic_tier: 'network' },
        });
      }
    }
  }

  const laneMap = new Map<string, any>();
  const ensureLane = (parent: string, tier: string, name?: string) => {
    const id = laneContainerId(parent, tier);
    if (!laneMap.has(id)) {
      laneMap.set(id, {
        id,
        type: 'terraform_lane',
        name: name || titleCase(tier),
        technology: `${titleCase(tier)} Lane`,
        provider: 'aws',
        boundary: 'lane',
        parent,
        render_hints: { container: true, ...preferredSizeForLane(tier), semantic_tier: tier },
      });
    }
  };

  for (const block of blocks) {
    const semanticTier = inferSemanticTier(block);
    const resolvedTier = block.kind === 'provider' ? 'control' : block.kind === 'backend' ? 'state' : semanticTier;
    const scopeParent = containerIdForDir(block.dir);
    const laneHostParent = laneHostParentForBlock(block, resolvedTier, networkModel);
    if (shouldCreateSemanticLane(scopeParent, resolvedTier)) ensureLane(laneHostParent, resolvedTier);
  }

  for (const [dir, net] of [...networkModel.entries()]) {
    if (!net?.vpcScoped) continue;
    const scopeParent = containerIdForDir(dir);
    const vpcParent = vpcContainerIdForDir(dir);
    ensureLane(scopeParent, 'control');
    if (net.multiAz && net.hasPublic) ensureLane(vpcParent, 'edge', 'Regional Edge');
    if (net.multiAz && net.hasWebTier) ensureLane(vpcParent, 'web', 'Regional Web');
    if (net.multiAz && (net.hasPublic || net.hasPrivate || net.hasDataTier)) ensureLane(vpcParent, 'network', 'Regional Network');
    const azKeys = net.multiAz ? ['a', 'b'] : ['a'];
    for (const azKey of azKeys) {
      if (net.hasPublic) {
        const publicSubnet = subnetContainerId(dir, azKey, 'public');
        ensureLane(publicSubnet, 'network', 'Network');
        ensureLane(publicSubnet, 'edge', 'Edge');
        ensureLane(publicSubnet, 'security', 'Security');
      }
      if (net.hasPrivate && (net.hasAppTier || net.hasWebTier || net.hasSecurityTier)) {
        const privateAppSubnet = subnetContainerId(dir, azKey, 'private-app');
        ensureLane(privateAppSubnet, 'network', 'Network');
        ensureLane(privateAppSubnet, 'web', 'Web');
        ensureLane(privateAppSubnet, 'security', 'Security');
      }
      if (net.hasDataTier) {
        const privateDataSubnet = subnetContainerId(dir, azKey, 'private-data');
        ensureLane(privateDataSubnet, 'network', 'Network');
        ensureLane(privateDataSubnet, 'data', 'Data');
      }
    }
  }

  const allContainers = [...containers, ...vpcContainers, ...subnetContainers, ...[...laneMap.values()].sort((a, b) => a.id.localeCompare(b.id))];
  const ids = new Set(allContainers.map((item) => item.id));
  return allContainers.map((item) => {
    if (!item.id.startsWith('container::') || item.id.startsWith('container::vpc::')) return item;
    const scopeKey = item.id.replace(/^container::/, '');
    const vpcId = vpcContainerIdForDir(scopeKey === '.' ? '.' : scopeKey);
    if (ids.has(vpcId) && item.boundary === 'scope') {
      return { ...item, parent: vpcId };
    }
    return item;
  });
}

function collectModuleSourceInterface(exampleRoot: string, dir: string): { variables: string[]; outputs: string[] } {
  const moduleRoot = path.join(exampleRoot, dir);
  if (!safeExistsSync(moduleRoot)) return { variables: [], outputs: [] };
  const variables = new Set<string>();
  const outputs = new Set<string>();
  for (const filePath of listModuleTfFiles(moduleRoot)) {
    const content = String(safeReadFile(filePath, { encoding: 'utf8' }));
    for (const match of content.matchAll(/\bvariable\s+"([^"]+)"/g)) variables.add(match[1]);
    for (const match of content.matchAll(/\boutput\s+"([^"]+)"/g)) outputs.add(match[1]);
  }
  return { variables: [...variables].sort(), outputs: [...outputs].sort() };
}

function buildInfoText(title: string, values: string[]): string {
  if (!values || values.length === 0) return `${title}\n- none`;
  return `${title}\n- ${values.join('\n- ')}`;
}

function collectModuleSourceArtifacts(ir: TerraformTopologyIr): any[] {
  if (ir.moduleSourceDirs.length === 0) return [];
  const nodes: any[] = [
    {
      id: `container::module-sources::${slugify(ir.title)}`,
      type: 'terraform_module_catalog',
      name: 'Terraform Module Sources',
      technology: 'Terraform Module Sources',
      provider: 'terraform',
      boundary: 'scope',
      parent: `container::${slugify(ir.title)}`,
      render_hints: { container: true, preferred_width: 320, preferred_height: 220, semantic_tier: 'module' },
    },
  ];
  for (const dir of ir.moduleSourceDirs) {
    const callers = ir.callerBlocksBySource[dir] || [];
    const summary = collectModuleSourceInterface(ir.source_root, dir);
    const callerLabels = callers.map((block) => block.dir || block.id.replace(/^.*::module\./, '')).filter(Boolean).filter((value, index, list) => list.indexOf(value) === index).sort();
    nodes.push({
      id: `container::module-source::${dir}`,
      type: 'terraform_module_source',
      name: dir,
      technology: 'Terraform Module Source',
      provider: 'terraform',
      boundary: 'scope',
      parent: `container::module-sources::${slugify(ir.title)}`,
      render_hints: { container: true, semantic_tier: 'module', preferred_width: 300, preferred_height: 280 },
    });
    nodes.push({
      id: `module-source::${dir}::inputs`,
      type: 'terraform_module_inputs',
      name: buildInfoText('Inputs', summary.variables),
      technology: 'Module Inputs',
      provider: 'terraform',
      group: 'control',
      parent: `container::module-source::${dir}`,
      render_hints: { semantic_tier: 'control', preferred_width: 240, preferred_height: Math.max(110, 52 + summary.variables.length * 18) },
    });
    nodes.push({
      id: `module-source::${dir}::outputs`,
      type: 'terraform_module_outputs',
      name: buildInfoText('Outputs', summary.outputs),
      technology: 'Module Outputs',
      provider: 'terraform',
      group: 'data',
      parent: `container::module-source::${dir}`,
      render_hints: { semantic_tier: 'data', preferred_width: 240, preferred_height: Math.max(110, 52 + summary.outputs.length * 18) },
    });
    nodes.push({
      id: `module-source::${dir}::callers`,
      type: 'terraform_module_callers',
      name: buildInfoText('Called By', callerLabels),
      technology: 'Module Callers',
      provider: 'terraform',
      group: 'module',
      parent: `container::module-source::${dir}`,
      render_hints: { semantic_tier: 'module', preferred_width: 240, preferred_height: Math.max(96, 52 + callerLabels.length * 18) },
    });
  }
  return nodes;
}

function cloneExpandedModuleBlock(callerBlock: TerraformBlock, sourceBlock: TerraformBlock): TerraformBlock {
  const localId =
    sourceBlock.kind === 'resource' ? `resource.${sourceBlock.type}.${sourceBlock.name}` :
    sourceBlock.kind === 'data' ? `data.${sourceBlock.type}.${sourceBlock.name}` :
    `${sourceBlock.kind}.${sourceBlock.type}.${sourceBlock.name || 'root'}`;
  return {
    ...sourceBlock,
    id: `expanded::${callerBlock.id}::${localId}`,
    dir: callerBlock.dir,
    module_origin: sourceBlock.dir,
  };
}

function expandedModuleNodeName(sourceBlock: TerraformBlock): string {
  const baseName = sourceBlock.name || sourceBlock.type;
  const type = String(sourceBlock.type || '');
  if (type === 'aws_elb' || type === 'aws_lb') return `ELB ${baseName}`;
  if (type === 'aws_autoscaling_group') return `ASG ${baseName}`;
  if (type === 'aws_launch_configuration') return `Launch Config ${baseName}`;
  if (type === 'aws_launch_template') return `Launch Template ${baseName}`;
  if (type === 'aws_security_group') return `SG ${baseName}`;
  if (type === 'aws_security_group_rule') return `SG Rule ${baseName}`;
  if (type === 'terraform_remote_state') return `Remote State ${baseName}`;
  if (type === 'aws_availability_zones') return `Availability Zones ${baseName}`;
  if (type === 'template_file') return `Template ${baseName}`;
  return `${providerTechnology(type)} ${baseName}`;
}

type EnrichedTopology = {
  infraBlocks: TerraformBlock[];
  networkModel: Map<string, any>;
  expandedModuleArtifacts: { nodes: any[]; edges: any[] };
};

export function enrichTopologyIr(ir: TerraformTopologyIr): EnrichedTopology {
  const expandedBlocks = ir.runtimeBlocks
    .filter((item) => item.kind === 'module')
    .flatMap((callerBlock) => {
      const relSourceDir = resolveTerraformModuleSourceDir(callerBlock, ir.source_root);
      if (!relSourceDir || !ir.moduleSourceDirs.includes(relSourceDir)) return [];
      const sourceBlocks = ir.allBlocks.filter((block) => block.dir === relSourceDir && ['resource', 'data'].includes(block.kind)).sort((a, b) => a.id.localeCompare(b.id));
      return sourceBlocks.map((sourceBlock) => cloneExpandedModuleBlock(callerBlock, sourceBlock));
    });
  const infraBlocks = [...ir.runtimeBlocks, ...expandedBlocks];
  const networkModel = buildScopeNetworkModel(infraBlocks);
  const expandedModuleArtifacts = collectExpandedModuleArtifacts(ir, networkModel);
  return { infraBlocks, networkModel, expandedModuleArtifacts };
}

function collectExpandedModuleArtifacts(ir: TerraformTopologyIr, networkModel: Map<string, any>): { nodes: any[]; edges: any[] } {
  const nodes: any[] = [];
  const edges: any[] = [];
  for (const callerBlock of ir.runtimeBlocks.filter((item) => item.kind === 'module')) {
    const relSourceDir = resolveTerraformModuleSourceDir(callerBlock, ir.source_root);
    if (!relSourceDir || !ir.moduleSourceDirs.includes(relSourceDir)) continue;
    const sourceBlocks = ir.allBlocks.filter((block) => block.dir === relSourceDir && ['resource', 'data'].includes(block.kind)).sort((a, b) => a.id.localeCompare(b.id));
    if (sourceBlocks.length === 0) continue;
    const expansionContainerId = `container::module-expansion::${callerBlock.id}`;
    const callerScopeLabel = callerBlock.dir === '.' ? 'root' : callerBlock.dir;
    nodes.push({
      id: expansionContainerId,
      type: 'terraform_module_expansion',
      name: `Expanded: ${callerScopeLabel} -> ${callerBlock.type}`,
      technology: `Expanded Terraform Module ${callerScopeLabel} ${callerBlock.type}`,
      provider: 'aws',
      boundary: 'scope',
      parent: containerIdForDir(callerBlock.dir),
      render_hints: { container: true, semantic_tier: 'module', preferred_width: 260, preferred_height: 120 },
    });
    const sourceBlocksById = new Map(sourceBlocks.map((block) => [block.id, block]));
    const expandedIdBySourceId = new Map<string, string>();
    for (const sourceBlock of sourceBlocks) {
      const expandedBlock = cloneExpandedModuleBlock(callerBlock, sourceBlock);
      const node = nodeForBlock(expandedBlock, networkModel);
      if (!node) continue;
      node.name = expandedModuleNodeName(sourceBlock);
      node.render_hints = {
        ...(node.render_hints || {}),
        semantic_tier: node.render_hints?.semantic_tier || inferSemanticTier(sourceBlock),
        module_call: callerBlock.id,
        module_origin: relSourceDir,
      };
      nodes.push(node);
      expandedIdBySourceId.set(sourceBlock.id, expandedBlock.id);
    }
    for (const sourceBlock of sourceBlocks) {
      const expandedTarget = expandedIdBySourceId.get(sourceBlock.id);
      if (!expandedTarget) continue;
      const refs = new Set<string>();
      for (const match of sourceBlock.body.matchAll(/\bdata\.([A-Za-z0-9_]+\.[A-Za-z0-9_]+)\b/g)) refs.add(`data.${match[1]}`);
      for (const match of sourceBlock.body.matchAll(/\bmodule\.([A-Za-z0-9_]+)\b/g)) refs.add(`module.${match[1]}`);
      for (const match of sourceBlock.body.matchAll(/\b(aws_[A-Za-z0-9_]+\.[A-Za-z0-9_]+)\b/g)) refs.add(match[1]);
      for (const ref of refs) {
        const resolvedSourceId = blockLookupId(ref, sourceBlock.dir, sourceBlocksById);
        const expandedSource = resolvedSourceId ? expandedIdBySourceId.get(resolvedSourceId) : null;
        if (expandedSource && expandedSource !== expandedTarget) edges.push({ from: expandedSource, to: expandedTarget, direction: 'uni' });
      }
    }
    edges.push({ from: callerBlock.id, to: expansionContainerId, label: 'expands', direction: 'uni' });
  }
  return { nodes, edges };
}

function collectSyntheticNetworkNodes(networkModel: Map<string, any>): any[] {
  const nodes: any[] = [];
  for (const [dir, net] of [...networkModel.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!net?.vpcScoped) continue;
    const scopeParent = containerIdForDir(dir);
    const controlParent = laneContainerId(scopeParent, 'control');
    const vpcParent = vpcContainerIdForDir(dir);
    const azKeys = net.multiAz ? ['a', 'b'] : ['a'];
    nodes.push({
      id: `${dir}::synthetic.region`,
      type: 'aws_region',
      icon_key: 'aws_region',
      name: 'Region',
      technology: 'AWS Region',
      provider: 'aws',
      group: 'control',
      parent: controlParent,
      render_hints: { semantic_tier: 'control', preferred_width: 80, preferred_height: 80 },
    });
    if (net.hasPublic && !net.hasInternetGateway) {
      nodes.push({
        id: `${dir}::synthetic.internet_gateway`,
        type: 'aws_internet_gateway',
        icon_key: 'aws_internet_gateway',
        name: 'Internet Gateway',
        technology: 'Internet Gateway',
        provider: 'aws',
        group: 'network',
        parent: net.multiAz ? laneContainerId(vpcParent, 'network') : laneContainerId(subnetContainerId(dir, 'a', 'public'), 'network'),
        render_hints: { semantic_tier: 'network', preferred_width: 88, preferred_height: 88 },
      });
    }
    for (const azKey of azKeys) {
      if (net.hasPublic) {
        const publicLane = laneContainerId(subnetContainerId(dir, azKey, 'public'), 'network');
        if (!net.hasRouteTable) {
          nodes.push({
            id: `${dir}::synthetic.public_route_table::${azKey}`,
            type: 'aws_route_table',
            icon_key: 'aws_route_table',
            name: net.multiAz ? `Public Route Table AZ ${azKey.toUpperCase()}` : 'Public Route Table',
            technology: 'Route Table',
            provider: 'aws',
            group: 'network',
            parent: publicLane,
            render_hints: { semantic_tier: 'network', preferred_width: 88, preferred_height: 88 },
          });
        }
        if (net.hasPrivate && !net.hasNatGateway) {
          nodes.push({
            id: `${dir}::synthetic.nat_gateway::${azKey}`,
            type: 'aws_nat_gateway',
            icon_key: 'aws_nat_gateway',
            name: net.multiAz ? `NAT Gateway AZ ${azKey.toUpperCase()}` : 'NAT Gateway',
            technology: 'NAT Gateway',
            provider: 'aws',
            group: 'network',
            parent: publicLane,
            render_hints: { semantic_tier: 'network', preferred_width: 88, preferred_height: 88 },
          });
        }
      }
      if (net.hasPrivate && (net.hasAppTier || net.hasWebTier || net.hasSecurityTier) && !net.hasRouteTable) {
        nodes.push({
          id: `${dir}::synthetic.private_app_route_table::${azKey}`,
          type: 'aws_route_table',
          icon_key: 'aws_route_table',
          name: net.multiAz ? `Private App Route Table AZ ${azKey.toUpperCase()}` : 'Private App Route Table',
          technology: 'Route Table',
          provider: 'aws',
          group: 'network',
          parent: laneContainerId(subnetContainerId(dir, azKey, 'private-app'), 'network'),
          render_hints: { semantic_tier: 'network', preferred_width: 88, preferred_height: 88 },
        });
      }
      if (net.hasDataTier && !net.hasRouteTable) {
        nodes.push({
          id: `${dir}::synthetic.private_data_route_table::${azKey}`,
          type: 'aws_route_table',
          icon_key: 'aws_route_table',
          name: net.multiAz ? `Private Data Route Table AZ ${azKey.toUpperCase()}` : 'Private Data Route Table',
          technology: 'Route Table',
          provider: 'aws',
          group: 'network',
          parent: laneContainerId(subnetContainerId(dir, azKey, 'private-data'), 'network'),
          render_hints: { semantic_tier: 'network', preferred_width: 88, preferred_height: 88 },
        });
      }
    }
  }
  return nodes;
}

function collectSyntheticComputeNodes(networkModel: Map<string, any>): any[] {
  const nodes: any[] = [];
  for (const [dir, net] of [...networkModel.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!net?.vpcScoped || !net.multiAz || !net.hasWebTier) continue;
    for (const azKey of ['a', 'b']) {
      nodes.push({
        id: `${dir}::synthetic.web_instances::${azKey}`,
        type: 'aws_instance',
        icon_key: 'aws_instance',
        name: `Web Instances AZ ${azKey.toUpperCase()}`,
        technology: 'Auto-Scaled EC2 Instances',
        provider: 'aws',
        group: 'web',
        parent: laneContainerId(subnetContainerId(dir, azKey, 'private-app'), 'web'),
        render_hints: { semantic_tier: 'web', preferred_width: 88, preferred_height: 88 },
      });
    }
  }
  return nodes;
}

function buildEdges(runtimeBlocks: TerraformBlock[], exampleRoot: string, moduleSourceDirs: string[]): any[] {
  const blocksById = new Map(runtimeBlocks.map((block) => [block.id, block]));
  const edges = new Map<string, any>();
  const addEdge = (from: string | null, to: string | null, label?: string) => {
    if (!from || !to || from === to) return;
    const key = `${from}::${to}::${label || ''}`;
    edges.set(key, { from, to, label, direction: 'uni' });
  };
  for (const block of runtimeBlocks) {
    const refs = new Set<string>();
    for (const match of block.body.matchAll(/\bdata\.([A-Za-z0-9_]+\.[A-Za-z0-9_]+)\b/g)) refs.add(`data.${match[1]}`);
    for (const match of block.body.matchAll(/\bmodule\.([A-Za-z0-9_]+)\b/g)) refs.add(`module.${match[1]}`);
    for (const match of block.body.matchAll(/\b(aws_[A-Za-z0-9_]+\.[A-Za-z0-9_]+)\b/g)) refs.add(match[1]);
    for (const ref of refs) addEdge(blockLookupId(ref, block.dir, blocksById), block.id);
  }
  for (const block of runtimeBlocks.filter((item) => item.kind === 'module')) {
    const relSourceDir = resolveTerraformModuleSourceDir(block, exampleRoot);
    if (!relSourceDir || !moduleSourceDirs.includes(relSourceDir)) continue;
    addEdge(block.id, `container::module-source::${relSourceDir}`, 'source');
  }
  return [...edges.values()];
}

export function topologyIrToArchitectureAdf(ir: TerraformTopologyIr): any {
  const enriched = enrichTopologyIr(ir);
  const containers = collectDirContainers(ir.title, enriched.infraBlocks, enriched.networkModel);
  const moduleSourceNodes = collectModuleSourceArtifacts(ir);
  const syntheticNetworkNodes = collectSyntheticNetworkNodes(enriched.networkModel);
  const syntheticComputeNodes = collectSyntheticComputeNodes(enriched.networkModel);
  const nodes = [
    ...containers,
    ...moduleSourceNodes,
    ...enriched.expandedModuleArtifacts.nodes,
    ...syntheticNetworkNodes,
    ...syntheticComputeNodes,
    ...ir.runtimeBlocks.map((block) => nodeForBlock(block, enriched.networkModel)).filter(Boolean),
  ];
  const edges = [
    ...buildEdges(ir.runtimeBlocks, ir.source_root, ir.moduleSourceDirs),
    ...enriched.expandedModuleArtifacts.edges,
  ];

  return {
    version: '1.1.0',
    title: `${ir.title} Terraform Architecture`,
    provider: ir.provider,
    render_hints: {
      engine: 'drawio',
      direction: 'LR',
      theme: 'aws-architecture',
      icon_pack: 'aws-architecture',
      group_by: 'boundary',
    },
    metadata: {
      source_kind: ir.source_kind,
      source_root: ir.source_root,
      tf_file_count: ir.tfFiles.length,
    },
    nodes,
    edges,
  };
}
