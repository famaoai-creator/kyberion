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
import { logger } from './core.js';

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
      `[deployment-adapter:stub] no adapter registered — dry run. Would deploy ${input.projectName}@${input.version} to ${input.environment}.`,
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
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 16 * 1024 * 1024,
      });
      return {
        adapter: 'shell',
        status: 'triggered',
        message: stdout.trim() || `deploy triggered for ${input.projectName}@${input.version} → ${input.environment}`,
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
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const command = env.KYBERION_DEPLOY_COMMAND?.trim();
  if (!command) return false;
  registerDeploymentAdapter(
    new ShellDeploymentAdapter({
      command,
      ...(env.KYBERION_DEPLOY_TIMEOUT_MS
        ? { timeoutMs: parseInt(env.KYBERION_DEPLOY_TIMEOUT_MS, 10) }
        : {}),
    }),
  );
  logger.success('[deployment-adapter] installed ShellDeploymentAdapter from KYBERION_DEPLOY_COMMAND');
  return true;
}
