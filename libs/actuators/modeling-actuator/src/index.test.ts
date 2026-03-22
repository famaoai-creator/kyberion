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
});
