/* eslint-disable no-restricted-imports -- IP-08 で safeExec へ移行予定 (docs/developer/improvement-plans-2026-07/IP-08_ERROR_HANDLING_DISCIPLINE.ja.md) */
/**
 * E2E-05 Task 6: mobile beta distribution adapter.
 *
 * Deliberately thin: the entire distribution mechanics (signing, upload,
 * TestFlight / Play internal track) is delegated to fastlane — the Fastfile is
 * the app repo's responsibility. Signing secrets are referenced by NAME only
 * (fastlane reads them from its own env/vault integration); this adapter never
 * logs or embeds secret values (SA-series rule).
 *
 * Safety: like every deployment adapter, this runs only after the
 * approval-gate `config:update` rule has passed (deployment-adapter.ts
 * contract note) — the adapter itself never bypasses the gate.
 */
import { execFileSync } from 'node:child_process';
import { logger } from '../core.js';
import type { DeployInput, DeployResult, DeploymentAdapter } from '../deployment-adapter.js';

export interface MobileBetaAdapterOptions {
  platform: 'ios' | 'android';
  /** App repository root containing fastlane/Fastfile. */
  projectDir: string;
  /** fastlane lane name (default: beta). */
  lane?: string;
  timeoutMs?: number;
  /** Extra env (secret NAMES resolved by fastlane itself, never values). */
  env?: Record<string, string>;
}

export class MobileBetaDeploymentAdapter implements DeploymentAdapter {
  readonly name = 'mobile-beta';
  constructor(private readonly options: MobileBetaAdapterOptions) {}

  async deploy(input: DeployInput): Promise<DeployResult> {
    const startedAt = new Date().toISOString();
    const lane = this.options.lane || 'beta';
    try {
      execFileSync('fastlane', ['--version'], {
        encoding: 'utf8',
        timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      return {
        adapter: this.name,
        status: 'failed',
        message:
          'fastlane is not installed — `brew install fastlane` (or gem install fastlane) and add a Fastfile with a beta lane to the app repo.',
        started_at: startedAt,
      };
    }
    try {
      const stdout = execFileSync('fastlane', [this.options.platform, lane], {
        encoding: 'utf8',
        cwd: this.options.projectDir,
        timeout: this.options.timeoutMs ?? 30 * 60 * 1000,
        env: this.options.env ? { ...process.env, ...this.options.env } : process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 32 * 1024 * 1024,
      });
      logger.success(
        `[deployment-adapter:mobile-beta] fastlane ${this.options.platform} ${lane} triggered for ${input.projectName}@${input.version}`
      );
      return {
        adapter: this.name,
        status: 'triggered',
        message: `fastlane ${this.options.platform} ${lane} completed for ${input.projectName}@${input.version} → ${input.environment}`,
        started_at: startedAt,
        raw: stdout.slice(-4000),
      };
    } catch (err: any) {
      const detail = String(err?.message || err);
      const actionable = /Could not find.*Fastfile|No Fastfile/i.test(detail)
        ? `Fastfile not found in ${this.options.projectDir} — the app repo must define a "${lane}" lane (fastlane init).`
        : detail.slice(0, 500);
      return {
        adapter: this.name,
        status: 'failed',
        message: actionable,
        started_at: startedAt,
      };
    }
  }
}
