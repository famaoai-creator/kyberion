import {
  loadReasoningRoutePolicy,
  loadReasoningRouteUserConfig,
  normalizeReasoningRole,
  reasoningRouteUserConfigPath,
  resolveReasoningRoute,
  saveReasoningRouteUserConfig,
  validateReasoningRouteUserConfig,
  type ReasoningRouteUserConfig,
  inspectReasoningRoutes,
} from '@agent/core';
import { recordGovernanceAction, safeExistsSync, safeReadFile, safeWriteFile } from '@agent/core';

const HELP = `Usage:
  pnpm reasoning:config list [--json]
  pnpm reasoning:config explain --role <role> [--json]
  pnpm reasoning:config validate [--json]
  pnpm reasoning:config doctor [--json]
  pnpm reasoning:config bind-role <role> <profile|mode:model> [--dry-run]
  pnpm reasoning:config set-fallback --role <role> <profile1,profile2,...> [--dry-run]
  pnpm reasoning:config rollback [--dry-run]
`;

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}
function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function jsonOutput(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function validateConfigResolves(config: ReasoningRouteUserConfig): void {
  const policy = loadReasoningRoutePolicy();
  for (const role of Object.keys(policy.roles)) resolveReasoningRoute({ role, userConfig: config });
}

function saveWithBackup(config: ReasoningRouteUserConfig, dryRun: boolean, change: string): void {
  const path = reasoningRouteUserConfigPath();
  const backup = `${path}.previous`;
  const historyPath = `${path}.history/reasoning-route-user-config-${Date.now()}.json`;
  const nextConfig: ReasoningRouteUserConfig = {
    ...config,
    version: config.version || '1.0.0',
    revision: (config.revision || 0) + 1,
    updated_at: new Date().toISOString(),
    last_change: change,
  };
  validateReasoningRouteUserConfig(nextConfig);
  validateConfigResolves(nextConfig);
  if (dryRun) {
    jsonOutput({ dry_run: true, path, config: nextConfig });
    return;
  }
  if (safeExistsSync(path)) {
    const previous = safeReadFile(path, { encoding: 'utf8' }) as string;
    safeWriteFile(backup, previous, { mkdir: true, encoding: 'utf8' });
    safeWriteFile(historyPath, previous, { mkdir: true, encoding: 'utf8' });
  }
  saveReasoningRouteUserConfig(nextConfig);
  recordGovernanceAction(
    process.env.KYBERION_PERSONA || 'operator',
    'reasoning_route_config_update',
    change
  );
  console.log(`Updated ${path}`);
}

function listRoutes(asJson: boolean): void {
  const routes = Object.keys(loadReasoningRoutePolicy().roles).map((role) => {
    try {
      return resolveReasoningRoute({ role });
    } catch (error) {
      return { role, error: error instanceof Error ? error.message : String(error) };
    }
  });
  if (asJson) return jsonOutput({ routes, config_path: reasoningRouteUserConfigPath() });
  for (const route of routes) {
    if ('error' in route) console.log(`${route.role}: ERROR ${route.error}`);
    else
      console.log(
        `${route.role}: ${route.profileRef} (${route.mode}${route.model ? `:${route.model}` : ''}) candidates=${route.candidates.join(' -> ')}`
      );
  }
}

function explainRoute(asJson: boolean): void {
  const role = normalizeReasoningRole(option('--role'));
  const route = resolveReasoningRoute({ role });
  if (asJson) return jsonOutput(route);
  console.log(`role=${route.role}`);
  console.log(
    `selected=${route.profileRef} adapter=${route.adapter} mode=${route.mode} model=${route.model || '(provider default)'}`
  );
  console.log(`capabilities=${route.capabilities.join(',')}`);
  console.log(`candidates=${route.candidates.join(' -> ')}`);
  console.log(
    `provenance=${route.provenance.map((entry) => `${entry.source}:${entry.field}`).join(', ')}`
  );
  if (route.rejectedCandidates.length)
    console.log(
      `rejected=${route.rejectedCandidates.map((entry) => `${entry.profile}:${entry.reason}`).join('; ')}`
    );
}

function validateRoutes(asJson: boolean): void {
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
  if (asJson) jsonOutput(result);
  else
    for (const entry of results)
      console.log(
        `${entry.role}: ${entry.valid ? `ok (${entry.selected})` : `ERROR ${entry.error}`}`
      );
  if (!result.valid) process.exitCode = 1;
}

function bindRole(): void {
  const role = normalizeReasoningRole(process.argv[3]);
  const binding = process.argv[4]?.trim();
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
  saveWithBackup(config, hasFlag('--dry-run'), `bind-role:${role}`);
}

function setFallback(): void {
  const role = normalizeReasoningRole(option('--role'));
  const raw = process.argv.find(
    (value, index) => index > 2 && value.includes(',') && !value.startsWith('--')
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
  saveWithBackup(config, hasFlag('--dry-run'), `set-fallback:${role}`);
}

function rollback(): void {
  const path = reasoningRouteUserConfigPath();
  const backup = `${path}.previous`;
  if (!safeExistsSync(backup)) throw new Error(`No rollback snapshot at ${backup}`);
  const restored = JSON.parse(
    safeReadFile(backup, { encoding: 'utf8' }) as string
  ) as ReasoningRouteUserConfig;
  validateReasoningRouteUserConfig(restored, backup);
  validateConfigResolves(restored);
  if (hasFlag('--dry-run'))
    return jsonOutput({ dry_run: true, restore: backup, target: path, config: restored });
  saveWithBackup(restored, false, 'rollback');
  console.log(`Restored ${path}`);
}

async function doctor(asJson: boolean): Promise<void> {
  const report = await inspectReasoningRoutes();
  if (asJson) return jsonOutput(report);
  for (const entry of report.entries) {
    console.log(
      `${entry.role}: ${entry.status} ${entry.mode} ${entry.profileRef} — ${entry.reason}`
    );
  }
  if (report.nextActions.length) {
    console.log('Next actions:');
    for (const action of report.nextActions) console.log(`- ${action}`);
  }
  if (!report.valid) process.exitCode = 1;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const asJson = hasFlag('--json');
  if (!command || command === '--help' || command === 'help') return console.log(HELP);
  if (command === 'list') return listRoutes(asJson);
  if (command === 'explain') return explainRoute(asJson);
  if (command === 'validate') return validateRoutes(asJson);
  if (command === 'doctor') return doctor(asJson);
  if (command === 'bind-role') return bindRole();
  if (command === 'set-fallback') return setFallback();
  if (command === 'rollback') return rollback();
  throw new Error(`Unknown command ${command}\n${HELP}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
