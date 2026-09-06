/* eslint-disable no-restricted-imports -- IP-08 で safeExec へ移行予定 (docs/developer/improvement-plans-2026-07/IP-08_ERROR_HANDLING_DISCIPLINE.ja.md) */
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

import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { withExecutionContext } from './authority.js';
import { logger } from './core.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { nowIso } from './foundation/time.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from './secure-io.js';
import { MobileBetaDeploymentAdapter } from './deployment-adapters/mobile-beta.js';
import { coreSeamCatalog, createSeam } from './seam.js';

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

function envText(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return getRegisteredEnvText(name, { env });
}

const deploymentAdapterSeam = createSeam<DeploymentAdapter>({
  key: 'deployment-adapter',
  multiplicity: 'sole',
  catalog: coreSeamCatalog,
});
let registeredDisposer: (() => void) | null = null;

export function registerDeploymentAdapter(adapter: DeploymentAdapter): () => void {
  if (!adapter || typeof adapter.name !== 'string' || !adapter.name.trim()) {
    throw new TypeError('Deployment adapter must have a non-empty name');
  }
  registeredDisposer = deploymentAdapterSeam.register(adapter.name, adapter, {
    provenance: 'builtin',
    source: 'deployment-adapter',
  });
  return registeredDisposer;
}

export function getDeploymentAdapter(): DeploymentAdapter {
  return deploymentAdapterSeam.getOptional() ?? stubDeploymentAdapter;
}

export function resetDeploymentAdapter(): void {
  registeredDisposer?.();
  registeredDisposer = null;
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
      message: `[DRY RUN] ${input.projectName}@${input.version} → ${input.environment}. To enable real deployment, create knowledge/personal/deployments/${input.projectName}.json matching deployment-adapter-config.schema.json.`,
      started_at: nowIso(),
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
  adapter?: 'shell' | 'mobile-beta';
  command?: string;
  shell?: string;
  platform?: 'ios' | 'android';
  project_dir?: string;
  lane?: string;
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
  const explicitPath = envText(env, 'KYBERION_DEPLOY_CONFIG_PATH')?.trim();
  if (explicitPath) {
    return assertSafeRepositoryPath(pathResolver.resolve(explicitPath), {
      allowMissingLeaf: true,
    });
  }
  const projectName = normalizeDeploymentProjectName(
    envText(env, 'KYBERION_DEPLOY_PROJECT') ||
      envText(env, 'KYBERION_PROJECT_NAME') ||
      envText(env, 'KYBERION_DEPLOYMENT_PROJECT') ||
      'default'
  );
  if (!projectName) return null;
  return assertSafeRepositoryPath(
    pathResolver.knowledge(path.join('personal/deployments', `${projectName}.json`)),
    { allowMissingLeaf: true }
  );
}

function loadShellDeploymentAdapterConfig(
  env: NodeJS.ProcessEnv
): { config: ShellDeploymentAdapterConfig; path: string } | null {
  return withExecutionContext('ecosystem_architect', () => {
    const configPath = resolveDeploymentConfigPath(env);
    if (!configPath || !safeExistsSync(configPath)) return null;
    if (!safeLstat(configPath).isFile()) {
      throw new Error(
        `Invalid deployment adapter config at ${configPath}: config must be a regular file`
      );
    }
    try {
      const parsed = defineCatalog<ShellDeploymentAdapterConfig>({
        id: 'deployment-adapter-config',
        path: configPath,
        schema: DEPLOYMENT_CONFIG_SCHEMA_PATH,
      }).load();
      return { config: parsed, path: configPath };
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid deployment adapter config at ${configPath}: ${reason}`);
    }
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
    const shell = this.options.shell ?? getRegisteredEnvText('SHELL') ?? '/bin/sh';
    const startedAt = nowIso();
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
  const command = envText(env, 'KYBERION_DEPLOY_COMMAND')?.trim();
  if (!command) return false;
  const timeoutText = envText(env, 'KYBERION_DEPLOY_TIMEOUT_MS');
  resetDeploymentAdapter();
  registerDeploymentAdapter(
    new ShellDeploymentAdapter({
      command,
      ...(timeoutText ? { timeoutMs: parseInt(timeoutText, 10) } : {}),
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
  resetDeploymentAdapter();
  // E2E-05 Task 6: config can select the fastlane-delegating mobile adapter.
  if (loaded.config.adapter === 'mobile-beta') {
    if (!loaded.config.platform || !loaded.config.project_dir) {
      throw new Error(
        `Invalid deployment adapter config at ${loaded.path}: mobile-beta requires platform and project_dir`
      );
    }
    registerDeploymentAdapter(
      new MobileBetaDeploymentAdapter({
        platform: loaded.config.platform,
        projectDir: pathResolver.rootResolve(loaded.config.project_dir),
        ...(typeof loaded.config.lane === 'string' ? { lane: loaded.config.lane } : {}),
        ...(typeof loaded.config.timeout_ms === 'number'
          ? { timeoutMs: loaded.config.timeout_ms }
          : {}),
        ...(loaded.config.env ? { env: loaded.config.env } : {}),
      })
    );
    logger.success(
      `[deployment-adapter] installed MobileBetaDeploymentAdapter from ${loaded.path}`
    );
    return true;
  }
  if (!loaded.config.command) {
    throw new Error(
      `Invalid deployment adapter config at ${loaded.path}: shell adapter requires command`
    );
  }
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
const DEPLOYMENT_CONFIG_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/deployment-adapter-config.schema.json'
);
