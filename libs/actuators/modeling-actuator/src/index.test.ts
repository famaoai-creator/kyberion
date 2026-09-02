import * as path from 'node:path';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { compileSchemaFromPath } from '@agent/core/schema-loader';
import { pathResolver } from '@agent/core/path-resolver';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
} from '@agent/core/secure-io';
import { handleAction } from './index.js';
import { extractDesignSpec, extractRequirements } from './sdlc-ops.js';

const AjvCtor = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;
const ROOT = pathResolver.rootDir();

describe('modeling-actuator terraform_to_architecture_adf', () => {
  it('rejects an external requirements source path before backend execution', async () => {
    await expect(
      extractRequirements({
        mission_id: 'MSN-MODELING-PATH',
        project_name: 'path-boundary',
        source_path: '/tmp/external-requirements.md',
      })
    ).rejects.toThrow('[RESOURCE_PATH_SCOPE]');
  });

  it('rejects an external requirements draft path before backend execution', async () => {
    await expect(
      extractDesignSpec({
        mission_id: 'MSN-MODELING-PATH',
        project_name: 'path-boundary',
        requirements_draft_path: '/tmp/external-requirements.json',
      })
    ).rejects.toThrow('[RESOURCE_PATH_SCOPE]');
  });

  it('rejects an unsupported action instead of running an empty pipeline', async () => {
    await expect(
      handleAction({ action: 'invalid', steps: [] } as unknown as Parameters<
        typeof handleAction
      >[0])
    ).rejects.toThrow('Unsupported action: invalid');
  });

  it('rejects a malformed persisted reconcile strategy before executing a step', async () => {
    const strategyPath = path.join(
      ROOT,
      `active/shared/tmp/modeling-actuator-tests/malformed-strategy-${process.pid}.json`
    );
    safeMkdir(path.dirname(strategyPath), { recursive: true });
    safeWriteFile(
      strategyPath,
      JSON.stringify({ strategies: [{ pipeline: [{ type: 'apply', op: 'log', params: [] }] }] })
    );

    try {
      const { performReconcile } = await import('./modeling-pipeline-helpers.js');
      await expect(
        performReconcile({
          action: 'reconcile',
          strategy_path: path.relative(ROOT, strategyPath),
        })
      ).rejects.toThrow('modeling strategy.strategies[0].pipeline[0].params must be a JSON object');
    } finally {
      safeRmSync(strategyPath, { force: true });
    }
  });

  it('rejects a context path outside the repository root', async () => {
    await expect(
      handleAction({
        action: 'pipeline',
        context: { context_path: '../../outside-context.json' },
        steps: [],
      } as unknown as Parameters<typeof handleAction>[0])
    ).rejects.toThrow('[RESOURCE_PATH_SCOPE]');
  });

  it('loads and persists pipeline context via context_path', async () => {
    const fixtureRoot = path.join(
      ROOT,
      'active/shared/tmp/modeling-actuator-tests/context-roundtrip'
    );
    safeMkdir(fixtureRoot, { recursive: true });
    const contextPath = path.join(fixtureRoot, 'context.json');
    const inputPath = path.join(fixtureRoot, 'input.json');

    safeWriteFile(contextPath, JSON.stringify({ existing: 'kept' }, null, 2));
    safeWriteFile(inputPath, JSON.stringify({ count: 2 }, null, 2));

    const result = await handleAction({
      action: 'pipeline',
      context: {
        context_path: path.relative(ROOT, contextPath),
      },
      steps: [
        {
          type: 'capture',
          op: 'read_json',
          params: {
            path: path.relative(ROOT, inputPath),
            export_as: 'payload',
          },
        },
      ],
    } as any);

    expect(result.status).toBe('succeeded');
    expect(result.context.existing).toBe('kept');
    expect(result.context.payload).toEqual({ count: 2 });

    const persisted = JSON.parse(safeReadFile(contextPath, { encoding: 'utf8' }) as string);
    expect(persisted.existing).toBe('kept');
    expect(persisted.payload).toEqual({ count: 2 });
  });

  it('normalizes terraform into architecture-adf with boundaries and module expansion', async () => {
    const fixtureRoot = path.join(ROOT, 'active/shared/tmp/modeling-actuator-tests/terraform-arch');
    const moduleDir = path.join(fixtureRoot, 'modules/services/webserver-cluster');
    const envDir = path.join(fixtureRoot, 'live/prod/services/webserver-cluster');
    safeMkdir(moduleDir, { recursive: true });
    safeMkdir(envDir, { recursive: true });

    safeWriteFile(
      path.join(moduleDir, 'main.tf'),
      `
resource "aws_elb" "example" {}
resource "aws_autoscaling_group" "example" {}
resource "aws_security_group" "instance" {}
data "aws_availability_zones" "all" {}
`
    );

    safeWriteFile(
      path.join(moduleDir, 'variables.tf'),
      `
variable "cluster_name" {}
variable "server_port" {}
output "elb_dns_name" {}
`
    );

    safeWriteFile(
      path.join(envDir, 'main.tf'),
      `
provider "aws" {
  region = "eu-west-1"
}

module "webserver_cluster" {
  source = "../../../../modules/services/webserver-cluster"
  cluster_name = "prod-cluster"
  server_port = 8080
}
`
    );

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
    expect(
      adf.nodes.some((node: any) => node.boundary === 'region' && node.name === 'eu-west-1')
    ).toBe(true);
    expect(adf.nodes.some((node: any) => node.type === 'terraform_module_catalog')).toBe(true);
    expect(adf.nodes.some((node: any) => node.type === 'terraform_module_expansion')).toBe(true);
    expect(adf.nodes.some((node: any) => node.name === 'ELB example')).toBe(true);
    expect(adf.nodes.some((node: any) => String(node.name).includes('Web Instances AZ A'))).toBe(
      true
    );
    expect(adf.edges.some((edge: any) => edge.label === 'source')).toBe(true);
    expect(adf.edges.some((edge: any) => edge.label === 'expands')).toBe(true);
  });

  it('can emit topology ir before composing architecture adf', async () => {
    const fixtureRoot = path.join(ROOT, 'active/shared/tmp/modeling-actuator-tests/terraform-ir');
    const envDir = path.join(fixtureRoot, 'env');
    safeMkdir(envDir, { recursive: true });

    safeWriteFile(
      path.join(envDir, 'main.tf'),
      `
provider "aws" {
  region = "us-west-2"
}

module "webserver_cluster" {
  source = "../modules/webserver-cluster"
}
`
    );
    safeMkdir(path.join(fixtureRoot, 'modules/webserver-cluster'), { recursive: true });
    safeWriteFile(
      path.join(fixtureRoot, 'modules/webserver-cluster/main.tf'),
      `
resource "aws_elb" "example" {}
`
    );

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
    const fixtureRoot = path.join(
      ROOT,
      'active/shared/tmp/modeling-actuator-tests/terraform-ignore-cache'
    );
    const envDir = path.join(fixtureRoot, 'live/prod/app');
    const cacheDir = path.join(envDir, '.terraform/modules/cached');
    safeMkdir(envDir, { recursive: true });
    safeMkdir(cacheDir, { recursive: true });

    safeWriteFile(
      path.join(envDir, 'main.tf'),
      `
provider "aws" {
  region = "ap-northeast-1"
}

resource "aws_s3_bucket" "app" {}
`
    );

    safeWriteFile(
      path.join(cacheDir, 'ignored.tf'),
      `
resource "aws_db_instance" "should_not_appear" {}
`
    );

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
    const fixtureRoot = path.join(
      ROOT,
      'active/shared/tmp/modeling-actuator-tests/terraform-symlink'
    );
    const envDir = path.join(fixtureRoot, 'env');
    const linkedDir = path.join(fixtureRoot, 'linked');
    const symlinkPath = path.join(envDir, 'linked-loop');
    safeMkdir(envDir, { recursive: true });
    safeMkdir(linkedDir, { recursive: true });

    safeWriteFile(
      path.join(envDir, 'main.tf'),
      `
provider "aws" {
  region = "us-east-1"
}

resource "aws_security_group" "app" {}
`
    );

    safeWriteFile(
      path.join(linkedDir, 'ignored.tf'),
      `
resource "aws_db_instance" "from_symlink" {}
`
    );

    try {
      safeSymlinkSync(linkedDir, symlinkPath, 'dir');
    } catch (error: any) {
      if (error?.code === 'EEXIST') {
        safeRmSync(symlinkPath, { force: true, recursive: true });
        safeSymlinkSync(linkedDir, symlinkPath, 'dir');
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

describe('modeling-actuator web_profile_to_ui_flow_adf', () => {
  it('emits a ui-flow-adf that matches the contract schema', async () => {
    const ajv = new AjvCtor({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(
      ajv,
      path.resolve(ROOT, 'knowledge/product/schemas/ui-flow-adf.schema.json')
    );

    const result = await handleAction({
      action: 'pipeline',
      context: {
        web_profile: {
          app_id: 'sample-web-app',
          base_url: 'https://example.com',
          login_route: '/login',
          logout_route: '/logout',
          guarded_routes: ['/dashboard'],
          debug_routes: {
            session_export: '/__kyberion/session-export',
          },
          selectors: {
            login: {
              email: '[name=email]',
              password: '[name=password]',
              submit: 'button[type=submit]',
            },
            navigation: {},
          },
        },
      },
      steps: [
        {
          type: 'transform',
          op: 'web_profile_to_ui_flow_adf',
          params: {
            from: 'web_profile',
            export_as: 'ui_flow_adf',
          },
        },
      ],
    } as any);

    const uiFlow = result.context.ui_flow_adf;
    expect(uiFlow.kind).toBe('ui-flow-adf');
    expect(uiFlow.platform).toBe('browser');
    expect(uiFlow.states.some((state: any) => state.id === 'login')).toBe(true);
    expect(uiFlow.transitions.some((transition: any) => transition.id === 'login_success')).toBe(
      true
    );
    expect(validate(uiFlow)).toBe(true);
  });
});
