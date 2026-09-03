import {
  loadReasoningRoutePolicy,
  loadReasoningRouteUserConfigAtPath,
  loadReasoningRouteUserConfig,
  normalizeReasoningRole,
  reasoningRouteUserConfigPath,
  resolveReasoningRoute,
  saveReasoningRouteUserConfig,
  validateReasoningRouteUserConfig,
  type ReasoningRouteUserConfig,
} from '@agent/core/reasoning-route-resolver';
import { inspectReasoningRoutes } from '@agent/core/reasoning-route-doctor';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';
import { nowIso } from '@agent/core/foundation';
import { getRegisteredEnv } from '@agent/core/foundation/env';
import { recordGovernanceAction } from '@agent/core/governance-action-recorder';
import { safeExistsSync, safeReadFile, safeWriteFile } from '@agent/core/secure-io';

const HELP = `Usage:
  pnpm reasoning:config list [--json]
  pnpm reasoning:config explain --role <role> [--json]
  pnpm reasoning:config validate [--json]
  pnpm reasoning:config doctor [--json]
  pnpm reasoning:config bind-role <role> <profile|mode:model> [--dry-run]
  pnpm reasoning:config set-fallback --role <role> <profile1,profile2,...> [--dry-run]
  pnpm reasoning:config rollback [--dry-run]
`;

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}
function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function validateConfigResolves(config: ReasoningRouteUserConfig): void {
  const policy = loadReasoningRoutePolicy();
  for (const role of Object.keys(policy.roles)) resolveReasoningRoute({ role, userConfig: config });
}

function saveWithBackup(
  config: ReasoningRouteUserConfig,
  dryRun: boolean,
  change: string,
  print: (value: unknown) => void
): void {
  const path = reasoningRouteUserConfigPath();
  const backup = `${path}.previous`;
  const historyPath = `${path}.history/reasoning-route-user-config-${Date.now()}.json`;
  const nextConfig: ReasoningRouteUserConfig = {
    ...config,
    version: config.version || '1.0.0',
    revision: (config.revision || 0) + 1,
    updated_at: nowIso(),
    last_change: change,
  };
  validateReasoningRouteUserConfig(nextConfig);
  validateConfigResolves(nextConfig);
  if (dryRun) {
    print({ dry_run: true, path, config: nextConfig });
    return;
  }
  if (safeExistsSync(path)) {
    const previous = safeReadFile(path, { encoding: 'utf8' }) as string;
    safeWriteFile(backup, previous, { mkdir: true, encoding: 'utf8' });
    safeWriteFile(historyPath, previous, { mkdir: true, encoding: 'utf8' });
  }
  saveReasoningRouteUserConfig(nextConfig);
  recordGovernanceAction(
    (getRegisteredEnv<string>('KYBERION_PERSONA') as string | undefined) || 'operator',
    'reasoning_route_config_update',
    change
  );
  print(`Updated ${path}`);
}

function listRoutes(asJson: boolean, print: (value: unknown) => void): void {
  const routes = Object.keys(loadReasoningRoutePolicy().roles).map((role) => {
    try {
      return resolveReasoningRoute({ role });
    } catch (error) {
      return { role, error: error instanceof Error ? error.message : String(error) };
    }
  });
  if (asJson) return print({ routes, config_path: reasoningRouteUserConfigPath() });
  print(
    routes
      .map((route) =>
        'error' in route
          ? `${route.role}: ERROR ${route.error}`
          : `${route.role}: ${route.profileRef} (${route.mode}${route.model ? `:${route.model}` : ''}) candidates=${route.candidates.join(' -> ')}`
      )
      .join('\n')
  );
}

function explainRoute(argv: string[], asJson: boolean, print: (value: unknown) => void): void {
  const role = normalizeReasoningRole(option(argv, '--role'));
  const route = resolveReasoningRoute({ role });
  if (asJson) return print(route);
  const lines = [
    `role=${route.role}`,
    `selected=${route.profileRef} adapter=${route.adapter} mode=${route.mode} model=${route.model || '(provider default)'}`,
    `capabilities=${route.capabilities.join(',')}`,
    `candidates=${route.candidates.join(' -> ')}`,
    `provenance=${route.provenance.map((entry) => `${entry.source}:${entry.field}`).join(', ')}`,
  ];
  if (route.rejectedCandidates.length) {
    lines.push(
      `rejected=${route.rejectedCandidates.map((entry) => `${entry.profile}:${entry.reason}`).join('; ')}`
    );
  }
  print(lines.join('\n'));
}

function validateRoutes(asJson: boolean, print: (value: unknown) => void): void {
  const policy = loadReasoningRoutePolicy();
  const results = Object.keys(policy.roles).map((role) => {
    try {
      const route = resolveReasoningRoute({ role });
      return { role, valid: true, selected: route.profileRef, mode: route.mode };
    } catch (error) {
      return { role, valid: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  const result = { valid: results.every((entry) => entry.valid), results };
  if (asJson) print(result);
  else
    print(
      results
        .map(
          (entry) =>
            `${entry.role}: ${entry.valid ? `ok (${entry.selected})` : `ERROR ${entry.error}`}`
        )
        .join('\n')
    );
  if (!result.valid) throw new ScriptExitError(1, '', true);
}

function bindRole(argv: string[], dryRun: boolean, print: (value: unknown) => void): void {
  const role = normalizeReasoningRole(argv[1]);
  const binding = argv[2]?.trim();
  if (!binding) throw new Error('bind-role requires <profile|mode:model>');
  const config = loadReasoningRouteUserConfig();
  const profile =
    binding.includes(':') && !binding.startsWith('profile:')
      ? `user-${role}`
      : binding.replace(/^profile:/, '');
  if (profile === `user-${role}`) {
    const separator = binding.indexOf(':');
    config.profiles = {
      ...(config.profiles || {}),
      [profile]: { mode: binding.slice(0, separator), model: binding.slice(separator + 1) },
    };
  }
  config.roles = { ...(config.roles || {}), [role]: { ...(config.roles?.[role] || {}), profile } };
  saveWithBackup(config, dryRun, `bind-role:${role}`, print);
}

function setFallback(argv: string[], dryRun: boolean, print: (value: unknown) => void): void {
  const role = normalizeReasoningRole(option(argv, '--role'));
  const raw = argv.find(
    (value, index) => index > 0 && value.includes(',') && !value.startsWith('--')
  );
  const candidates =
    raw
      ?.split(',')
      .map((value) => value.trim())
      .filter(Boolean) || [];
  if (!candidates.length) throw new Error('set-fallback requires a comma-separated profile list');
  const config = loadReasoningRouteUserConfig();
  config.roles = {
    ...(config.roles || {}),
    [role]: { ...(config.roles?.[role] || {}), candidates },
  };
  saveWithBackup(config, dryRun, `set-fallback:${role}`, print);
}

function rollback(argv: string[], dryRun: boolean, print: (value: unknown) => void): void {
  const path = reasoningRouteUserConfigPath();
  const backup = `${path}.previous`;
  if (!safeExistsSync(backup)) throw new Error(`No rollback snapshot at ${backup}`);
  const restored = loadReasoningRouteUserConfigAtPath(backup);
  validateReasoningRouteUserConfig(restored, backup);
  validateConfigResolves(restored);
  if (dryRun) return print({ dry_run: true, restore: backup, target: path, config: restored });
  saveWithBackup(restored, false, 'rollback', print);
  print(`Restored ${path}`);
}

async function doctor(asJson: boolean, print: (value: unknown) => void): Promise<void> {
  const report = await inspectReasoningRoutes();
  if (asJson) return print(report);
  const lines = report.entries.map(
    (entry) => `${entry.role}: ${entry.status} ${entry.mode} ${entry.profileRef} — ${entry.reason}`
  );
  if (report.nextActions.length) {
    lines.push('Next actions:', ...report.nextActions.map((action) => `- ${action}`));
  }
  print(lines.join('\n'));
  if (!report.valid) throw new ScriptExitError(1, '', true);
}

export async function main(
  argv: string[] = [],
  print: (value: unknown) => void = () => undefined,
  options: { json?: boolean; dryRun?: boolean; check?: boolean } = {}
): Promise<void> {
  const command = argv[0];
  const asJson = options.json ?? hasFlag(argv, '--json');
  const dryRun = options.dryRun === true || options.check === true || hasFlag(argv, '--dry-run');
  if (!command || command === '--help' || command === 'help') return print(HELP);
  if (command === 'list') return listRoutes(asJson, print);
  if (command === 'explain') return explainRoute(argv, asJson, print);
  if (command === 'validate') return validateRoutes(asJson, print);
  if (command === 'doctor') return doctor(asJson, print);
  if (command === 'bind-role') return bindRole(argv, dryRun, print);
  if (command === 'set-fallback') return setFallback(argv, dryRun, print);
  if (command === 'rollback') return rollback(argv, dryRun, print);
  throw new Error(`Unknown command ${command}\n${HELP}`);
}

export const runReasoningConfig = defineScript({
  name: 'reasoning:config',
  flags: ['json', 'dry-run', 'check', 'quiet'],
  run: async ({ argv, print, json, dryRun, check }) => main(argv, print, { json, dryRun, check }),
});

if (
  isDirectScript(import.meta.url, 'reasoning_config.ts') ||
  isDirectScript(import.meta.url, 'reasoning_config.js')
)
  void runReasoningConfig();
