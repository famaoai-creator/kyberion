import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { safeMkdir, safeWriteFile } from '@agent/core';
import { handleAction } from './index.js';

describe('modeling-actuator terraform_to_architecture_adf', () => {
  it('normalizes terraform into architecture-adf with boundaries and module expansion', async () => {
    const root = process.cwd();
    const fixtureRoot = path.join(root, 'active/shared/tmp/modeling-actuator-tests/terraform-arch');
    const moduleDir = path.join(fixtureRoot, 'modules/services/webserver-cluster');
    const envDir = path.join(fixtureRoot, 'live/prod/services/webserver-cluster');
    safeMkdir(moduleDir, { recursive: true });
    safeMkdir(envDir, { recursive: true });

    safeWriteFile(path.join(moduleDir, 'main.tf'), `
resource "aws_elb" "example" {}
resource "aws_autoscaling_group" "example" {}
resource "aws_security_group" "instance" {}
data "aws_availability_zones" "all" {}
`);

    safeWriteFile(path.join(moduleDir, 'variables.tf'), `
variable "cluster_name" {}
variable "server_port" {}
output "elb_dns_name" {}
`);

    safeWriteFile(path.join(envDir, 'main.tf'), `
provider "aws" {
  region = "eu-west-1"
}

module "webserver_cluster" {
  source = "../../../../modules/services/webserver-cluster"
  cluster_name = "prod-cluster"
  server_port = 8080
}
`);

    const result = await handleAction({
      action: 'pipeline',
      steps: [
        {
          type: 'transform',
          op: 'terraform_to_architecture_adf',
          params: {
            dir: 'active/shared/tmp/modeling-actuator-tests/terraform-arch/live/prod/services/webserver-cluster',
            title: 'prod-web-cluster',
            export_as: 'architecture_adf',
          },
        },
      ],
    } as any);

    const adf = result.context.architecture_adf;
    expect(adf.title).toBe('prod-web-cluster Terraform Architecture');
    expect(adf.provider).toBe('aws');
    expect(adf.nodes.some((node: any) => node.boundary === 'account')).toBe(true);
    expect(adf.nodes.some((node: any) => node.boundary === 'region' && node.name === 'eu-west-1')).toBe(true);
    expect(adf.nodes.some((node: any) => node.type === 'terraform_module_catalog')).toBe(true);
    expect(adf.nodes.some((node: any) => node.type === 'terraform_module_expansion')).toBe(true);
    expect(adf.nodes.some((node: any) => node.name === 'ELB example')).toBe(true);
    expect(adf.nodes.some((node: any) => String(node.name).includes('Web Instances AZ A'))).toBe(true);
    expect(adf.edges.some((edge: any) => edge.label === 'source')).toBe(true);
    expect(adf.edges.some((edge: any) => edge.label === 'expands')).toBe(true);
  });

  it('can emit topology ir before composing architecture adf', async () => {
    const root = process.cwd();
    const fixtureRoot = path.join(root, 'active/shared/tmp/modeling-actuator-tests/terraform-ir');
    const envDir = path.join(fixtureRoot, 'env');
    safeMkdir(envDir, { recursive: true });

    safeWriteFile(path.join(envDir, 'main.tf'), `
provider "aws" {
  region = "us-west-2"
}

module "webserver_cluster" {
  source = "../modules/webserver-cluster"
}
`);
    safeMkdir(path.join(fixtureRoot, 'modules/webserver-cluster'), { recursive: true });
    safeWriteFile(path.join(fixtureRoot, 'modules/webserver-cluster/main.tf'), `
resource "aws_elb" "example" {}
`);

    const result = await handleAction({
      action: 'pipeline',
      steps: [
        {
          type: 'transform',
          op: 'terraform_to_topology_ir',
          params: {
            dir: 'active/shared/tmp/modeling-actuator-tests/terraform-ir/env',
            title: 'topology-ir',
            export_as: 'topology_ir',
          },
        },
      ],
    } as any);

    const topologyIr = result.context.topology_ir;
    expect(topologyIr.kind).toBe('terraform_topology_ir');
    expect(topologyIr.title).toBe('topology-ir');
    expect(topologyIr.runtimeBlocks.some((block: any) => block.kind === 'module')).toBe(true);
    expect(Array.isArray(topologyIr.moduleSourceDirs)).toBe(true);
    expect(topologyIr.moduleSourceDirs).toContain('../modules/webserver-cluster');
  });

  it('ignores .terraform cache directories while scanning the terraform root', async () => {
    const root = process.cwd();
    const fixtureRoot = path.join(root, 'active/shared/tmp/modeling-actuator-tests/terraform-ignore-cache');
    const envDir = path.join(fixtureRoot, 'live/prod/app');
    const cacheDir = path.join(envDir, '.terraform/modules/cached');
    safeMkdir(envDir, { recursive: true });
    safeMkdir(cacheDir, { recursive: true });

    safeWriteFile(path.join(envDir, 'main.tf'), `
provider "aws" {
  region = "ap-northeast-1"
}

resource "aws_s3_bucket" "app" {}
`);

    safeWriteFile(path.join(cacheDir, 'ignored.tf'), `
resource "aws_db_instance" "should_not_appear" {}
`);

    const result = await handleAction({
      action: 'pipeline',
      steps: [
        {
          type: 'transform',
          op: 'terraform_to_architecture_adf',
          params: {
            dir: 'active/shared/tmp/modeling-actuator-tests/terraform-ignore-cache/live/prod/app',
            title: 'ignore-cache',
            export_as: 'architecture_adf',
          },
        },
      ],
    } as any);

    const adf = result.context.architecture_adf;
    expect(adf.metadata.tf_file_count).toBe(1);
    expect(adf.nodes.some((node: any) => node.name === 'should_not_appear')).toBe(false);
  });

  it('skips symlinked directories during terraform discovery', async () => {
    const root = process.cwd();
    const fixtureRoot = path.join(root, 'active/shared/tmp/modeling-actuator-tests/terraform-symlink');
    const envDir = path.join(fixtureRoot, 'env');
    const linkedDir = path.join(fixtureRoot, 'linked');
    const symlinkPath = path.join(envDir, 'linked-loop');
    safeMkdir(envDir, { recursive: true });
    safeMkdir(linkedDir, { recursive: true });

    safeWriteFile(path.join(envDir, 'main.tf'), `
provider "aws" {
  region = "us-east-1"
}

resource "aws_security_group" "app" {}
`);

    safeWriteFile(path.join(linkedDir, 'ignored.tf'), `
resource "aws_db_instance" "from_symlink" {}
`);

    try {
      fs.symlinkSync(linkedDir, symlinkPath, 'dir');
    } catch (error: any) {
      if (error?.code === 'EEXIST') {
        fs.rmSync(symlinkPath, { force: true, recursive: true });
        fs.symlinkSync(linkedDir, symlinkPath, 'dir');
      } else {
        throw error;
      }
    }

    const result = await handleAction({
      action: 'pipeline',
      steps: [
        {
          type: 'transform',
          op: 'terraform_to_architecture_adf',
          params: {
            dir: 'active/shared/tmp/modeling-actuator-tests/terraform-symlink/env',
            title: 'skip-symlink',
            export_as: 'architecture_adf',
          },
        },
      ],
    } as any);

    const adf = result.context.architecture_adf;
    expect(adf.metadata.tf_file_count).toBe(1);
    expect(adf.nodes.some((node: any) => node.name === 'from_symlink')).toBe(false);
  });
});
