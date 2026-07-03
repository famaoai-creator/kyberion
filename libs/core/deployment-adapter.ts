/* eslint-disable no-restricted-imports -- IP-08 で safeExec へ移行予定 (docs/improvement-plans-2026-07/IP-08_ERROR_HANDLING_DISCIPLINE.ja.md) */
/**
 * Deployment Adapter — contract for triggering the actual deploy (CI/CD
 * pipeline, kubectl apply, serverless deploy, etc.) from a Kyberion
 * operations_and_release mission.
 *
 * The adapter is deliberately project-specific: every org has a different
 * CI/CD boundary. We ship a stub that prints the intended action and a
 * ShellDeploymentAdapter that invokes a user-configured shell command.
 * Downstream teams layer their own (GitHub Actions dispatch, ArgoCD sync,
 * Cloud Deploy, Terraform apply…) by implementing the interface.
 *
 * Safety: every deploy runs through approval-gate via the
 * `config:update` rule on approval-policy.json — the adapter itself
 * doesn't gate, but requireApprovalForOp(CONFIG_UPDATE) must succeed
 * before the pipeline reaches this step.
 */

import AjvModule, { type ValidateFunction } from 'ajv';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { withExecutionContext } from './authority.js';
import { logger } from './core.js';
import { compileSchemaFromPath } from './schema-loader.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';

export interface DeployInput {
  /** Semantic environment — prod / staging / canary / dr etc. */
  environment: string;
  /** Project identifier visible to the adapter. */
  projectName: string;
  /** Version / tag to deploy (e.g. "v0.1.0", "release/2026-04-21"). */
  version: string;
  /** Optional release notes reference (markdown path). */
  releaseNotesPath?: string;
  /** Adapter-specific free-form payload (pipeline id, stack name, etc.). */
  metadata?: Record<string, unknown>;
}

export interface DeployResult {
  adapter: string;
  status: 'triggered' | 'failed' | 'dry_run';
  message: string;
  trigger_id?: string;
  started_at: string;
  raw?: unknown;
}

export interface DeploymentAdapter {
  name: string;
  deploy(input: DeployInput): Promise<DeployResult>;
}

let registered: DeploymentAdapter | null = null;

export function registerDeploymentAdapter(adapter: DeploymentAdapter): void {
  registered = adapter;
}

export function getDeploymentAdapter(): DeploymentAdapter {
  return registered ?? stubDeploymentAdapter;
}

export function resetDeploymentAdapter(): void {
  registered = null;
}

export const stubDeploymentAdapter: DeploymentAdapter = {
  name: 'stub',
  async deploy(input) {
    logger.warn(
      `[deployment-adapter:stub] no adapter registered — dry run. Would deploy ${input.projectName}@${input.version} to ${input.environment}.`
    );
    return {
      adapter: 'stub',
      status: 'dry_run',
      message: `[DRY RUN] ${input.projectName}@${input.version} → ${input.environment}`,
      started_at: new Date().toISOString(),
    };
  },
};

export interface ShellDeploymentAdapterOptions {
  /**
   * Shell command. Tokens replaced before execution:
   *   {{environment}}  {{projectName}}  {{version}}  {{releaseNotesPath}}
   * Each token is empty-string when the input omits it.
   */
  command: string;
  shell?: string;
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string>;
}

export interface ShellDeploymentAdapterConfig {
  command: string;
  shell?: string;
  timeout_ms?: number;
  cwd?: string;
  env?: Record<string, string>;
}

function normalizeDeploymentProjectName(value: string): string {
  return String(value || '')
    .trim()
    .replace(/[\\/]+/g, '-')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function resolveDeploymentConfigPath(env: NodeJS.ProcessEnv): string | null {
  const explicitPath = env.KYBERION_DEPLOY_CONFIG_PATH?.trim();
  if (explicitPath) {
    return pathResolver.resolve(explicitPath);
  }
  const projectName = normalizeDeploymentProjectName(
    env.KYBERION_DEPLOY_PROJECT ||
      env.KYBERION_PROJECT_NAME ||
      env.KYBERION_DEPLOYMENT_PROJECT ||
      'default'
  );
  if (!projectName) return null;
  return pathResolver.knowledge(path.join('personal/deployments', `${projectName}.json`));
}

function loadShellDeploymentAdapterConfig(
  env: NodeJS.ProcessEnv
): { config: ShellDeploymentAdapterConfig; path: string } | null {
  return withExecutionContext('ecosystem_architect', () => {
    const configPath = resolveDeploymentConfigPath(env);
    if (!configPath || !safeExistsSync(configPath)) return null;
    const parsed = JSON.parse(safeReadFile(configPath, { encoding: 'utf8' }) as string);
    const validate = ensureDeploymentConfigValidator();
    if (!validate(parsed)) {
      const errors = (validate.errors || [])
        .map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`)
        .join('; ');
      throw new Error(`Invalid deployment adapter config at ${configPath}: ${errors}`);
    }
    return { config: parsed as ShellDeploymentAdapterConfig, path: configPath };
  });
}

export class ShellDeploymentAdapter implements DeploymentAdapter {
  readonly name = 'shell';
  constructor(private readonly options: ShellDeploymentAdapterOptions) {}

  async deploy(input: DeployInput): Promise<DeployResult> {
    const cmd = this.options.command
      .replace(/\{\{environment\}\}/gu, input.environment)
      .replace(/\{\{projectName\}\}/gu, input.projectName)
      .replace(/\{\{version\}\}/gu, input.version)
      .replace(/\{\{releaseNotesPath\}\}/gu, input.releaseNotesPath ?? '');
    const shell = this.options.shell ?? process.env.SHELL ?? '/bin/sh';
    const startedAt = new Date().toISOString();
    try {
      const stdout = execFileSync(shell, ['-c', cmd], {
        encoding: 'utf8',
        timeout: this.options.timeoutMs ?? 10 * 60 * 1000,
        cwd: this.options.cwd,
        env: this.options.env ? { ...process.env, ...this.options.env } : process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 16 * 1024 * 1024,
      });
      return {
        adapter: 'shell',
        status: 'triggered',
        message:
          stdout.trim() ||
          `deploy triggered for ${input.projectName}@${input.version} → ${input.environment}`,
        started_at: startedAt,
        raw: stdout,
      };
    } catch (err: any) {
      return {
        adapter: 'shell',
        status: 'failed',
        message: err?.message ?? String(err),
        started_at: startedAt,
        raw: err,
      };
    }
  }
}

export function installShellDeploymentAdapterIfAvailable(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const command = env.KYBERION_DEPLOY_COMMAND?.trim();
  if (!command) return false;
  registerDeploymentAdapter(
    new ShellDeploymentAdapter({
      command,
      ...(env.KYBERION_DEPLOY_TIMEOUT_MS
        ? { timeoutMs: parseInt(env.KYBERION_DEPLOY_TIMEOUT_MS, 10) }
        : {}),
    })
  );
  logger.success(
    '[deployment-adapter] installed ShellDeploymentAdapter from KYBERION_DEPLOY_COMMAND'
  );
  return true;
}

export function installShellDeploymentAdapterFromConfigIfAvailable(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const loaded = loadShellDeploymentAdapterConfig(env);
  if (!loaded) return false;
  registerDeploymentAdapter(
    new ShellDeploymentAdapter({
      command: loaded.config.command,
      ...(typeof loaded.config.shell === 'string' ? { shell: loaded.config.shell } : {}),
      ...(typeof loaded.config.timeout_ms === 'number'
        ? { timeoutMs: loaded.config.timeout_ms }
        : {}),
      ...(typeof loaded.config.cwd === 'string' ? { cwd: loaded.config.cwd } : {}),
      ...(loaded.config.env ? { env: loaded.config.env } : {}),
    })
  );
  logger.success(`[deployment-adapter] installed ShellDeploymentAdapter from ${loaded.path}`);
  return true;
}
const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });
const DEPLOYMENT_CONFIG_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/deployment-adapter-config.schema.json'
);

let deploymentConfigValidateFn: ValidateFunction | null = null;

function ensureDeploymentConfigValidator(): ValidateFunction {
  if (deploymentConfigValidateFn) return deploymentConfigValidateFn;
  deploymentConfigValidateFn = compileSchemaFromPath(ajv, DEPLOYMENT_CONFIG_SCHEMA_PATH);
  return deploymentConfigValidateFn;
}
