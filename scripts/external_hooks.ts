#!/usr/bin/env node
/**
 * DH-16: governed entry point for project-local Claude/Codex hook configs.
 *
 *   pnpm kyberion hooks discover [--json]   list configs and their trust state
 *   pnpm kyberion hooks trust <path>        open (or reuse) the hash-bound
 *                                           project-trust approval for one config
 *
 * Discovery never executes anything. A config only reaches the worker
 * lifecycle engine when `KYBERION_EXTERNAL_HOOKS=project` is set AND an
 * authenticated human approved its exact content
 * (`ensureTrustedExternalHooksRegistered`); editing the file voids the approval.
 */
import { resolveCliApprovalRequester } from '@agent/core/governance/cli-operator-principal';
import * as path from 'node:path';
import {
  discoverExternalHookConfigs,
  isExternalHookBootstrapEnabled,
  resolveProjectHookTrustApprovals,
  type ExternalHookConfigCandidate,
} from '@agent/core/external-hook-discovery';
import { createProjectTrustApprovalRequest } from '@agent/core/project/project-trust';
import { pathResolver } from '@agent/core/path-resolver';
import { withExecutionContext } from '@agent/core/authority';
import { t } from '@agent/core/t';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

export interface ExternalHookDiscoveryRow {
  path: string;
  source: ExternalHookConfigCandidate['source'];
  trusted: boolean;
  approval_id?: string;
}

export interface ExternalHookDiscoveryReport {
  bootstrap_enabled: boolean;
  configs: ExternalHookDiscoveryRow[];
}

function relativeToRoot(filePath: string): string {
  return path.relative(pathResolver.rootDir(), filePath).split(path.sep).join('/');
}

export function buildExternalHookDiscoveryReport(
  options: { rootDir?: string } = {}
): ExternalHookDiscoveryReport {
  const candidates = discoverExternalHookConfigs(
    options.rootDir ? { rootDir: options.rootDir } : {}
  );
  const approvals = withExecutionContext('mission_controller', () =>
    resolveProjectHookTrustApprovals(candidates)
  );
  return {
    bootstrap_enabled: isExternalHookBootstrapEnabled(),
    configs: candidates.map((candidate) => {
      const approvalId = approvals[candidate.path];
      return {
        path: relativeToRoot(candidate.path),
        source: candidate.source,
        trusted: Boolean(approvalId),
        ...(approvalId ? { approval_id: approvalId } : {}),
      };
    }),
  };
}

export function formatExternalHookDiscoveryReport(report: ExternalHookDiscoveryReport): string {
  if (report.configs.length === 0) return t('cli:cli_hooks_none');
  const lines = [t('cli:cli_hooks_header', { count: report.configs.length })];
  for (const config of report.configs) {
    lines.push(
      config.trusted
        ? t('cli:cli_hooks_row_trusted', {
            path: config.path,
            source: config.source,
            id: config.approval_id ?? '',
          })
        : t('cli:cli_hooks_row_untrusted', { path: config.path, source: config.source })
    );
  }
  lines.push(
    report.bootstrap_enabled ? t('cli:cli_hooks_bootstrap_on') : t('cli:cli_hooks_bootstrap_off')
  );
  return lines.join('\n');
}

/** Open or reuse the project-trust request; deciding it stays a human's call. */
export function requestExternalHookTrust(inputPath: string, requestedBy?: string) {
  const report = buildExternalHookDiscoveryReport();
  const relative = relativeToRoot(pathResolver.rootResolve(inputPath));
  const discovered = report.configs.find((config) => config.path === relative);
  if (!discovered) {
    throw new ScriptExitError(1, t('cli:cli_hooks_trust_not_discovered', { path: relative }));
  }
  const request = withExecutionContext('mission_controller', () =>
    createProjectTrustApprovalRequest({
      inputPath: relative,
      requestedBy: resolveCliApprovalRequester({
        explicit: requestedBy,
        legacy: 'external-hooks-cli',
      }).requestedBy,
      // The approver authorizes shell commands from a hook config, not a pipeline.
      resource: { kind: 'external-hook-config', source: discovered.source },
    })
  );
  return { path: relative, request_id: request.id, status: request.status };
}

export const runExternalHooks = defineScript({
  name: 'external-hooks',
  flags: ['json'],
  run(context) {
    const [action, target] = context.argv.filter((arg) => !arg.startsWith('--'));
    if (action === 'discover') {
      const report = buildExternalHookDiscoveryReport();
      context.print(
        context.json ? JSON.stringify(report, null, 2) : formatExternalHookDiscoveryReport(report)
      );
      return report;
    }
    if (action === 'trust' && target) {
      const result = requestExternalHookTrust(target);
      context.print(
        context.json
          ? JSON.stringify(result, null, 2)
          : t('cli:cli_hooks_trust_requested', {
              path: result.path,
              id: result.request_id,
              status: result.status,
            })
      );
      return result;
    }
    throw new ScriptExitError(2, t('cli:cli_hooks_usage'));
  },
});

if (
  isDirectScript(import.meta.url, 'external_hooks.ts') ||
  isDirectScript(import.meta.url, 'external_hooks.js')
)
  void runExternalHooks();
