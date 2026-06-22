/**
 * Cowork Integration Health Check (Phase 5 — L6 baseline layer)
 *
 * Checks the health of the Kyberion×Cowork integration:
 *   - MCP server binary built and ready
 *   - Plugin manifest and connector config present
 *   - Cowork outbox directory accessible
 *   - Knowledge sync policy present
 *   - Sync state freshness (warns if stale > 24h)
 *
 * Used by run_baseline_check.ts as L6 "Cowork Integration Layer".
 * Also callable standalone via the cowork-integration-review pipeline.
 */

import * as nodePath from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CoworkHealthReport {
  healthy: boolean;
  checks: CoworkHealthCheck[];
  degraded_components: string[];
  warnings: string[];
}

export interface CoworkHealthCheck {
  name: string;
  passed: boolean;
  detail?: string;
}

// ── Check definitions ─────────────────────────────────────────────────────────

function checkMcpServerBuilt(): CoworkHealthCheck {
  const scriptPath = pathResolver.rootResolve('dist/scripts/mcp_server.js');
  const exists = safeExistsSync(scriptPath);
  return {
    name: 'mcp_server_built',
    passed: exists,
    detail: exists ? scriptPath : 'dist/scripts/mcp_server.js not found — run pnpm build',
  };
}

function checkPluginManifest(): CoworkHealthCheck {
  const manifestPath = pathResolver.rootResolve('plugins/kyberion/plugin-manifest.json');
  const exists = safeExistsSync(manifestPath);
  return {
    name: 'plugin_manifest_present',
    passed: exists,
    detail: exists ? manifestPath : 'plugins/kyberion/plugin-manifest.json missing',
  };
}

function checkConnectorConfig(): CoworkHealthCheck {
  const connectorPath = pathResolver.rootResolve('plugins/kyberion/connector.json');
  const exists = safeExistsSync(connectorPath);
  return {
    name: 'connector_config_present',
    passed: exists,
    detail: exists ? connectorPath : 'plugins/kyberion/connector.json missing',
  };
}

function checkSyncPolicy(): CoworkHealthCheck {
  const policyPath = pathResolver.rootResolve('knowledge/product/governance/cowork-sync-policy.json');
  const exists = safeExistsSync(policyPath);
  return {
    name: 'sync_policy_present',
    passed: exists,
    detail: exists ? policyPath : 'cowork-sync-policy.json missing',
  };
}

function checkCoworkOutbox(): CoworkHealthCheck {
  const outboxPath = pathResolver.resolve('active/shared/coordination/channels/cowork/outbox');
  const exists = safeExistsSync(outboxPath);
  return {
    name: 'cowork_outbox_accessible',
    passed: exists,
    detail: exists ? outboxPath : 'Cowork outbox dir not yet created (no deliveries yet — acceptable)',
  };
}

function checkSyncStateFreshness(maxAgeHours = 24): { check: CoworkHealthCheck; warning?: string } {
  const statePath = pathResolver.resolve('active/shared/runtime/cowork-sync-state.json');
  if (!safeExistsSync(statePath)) {
    return {
      check: {
        name: 'sync_state_freshness',
        passed: true,
        detail: 'Sync state not yet created (no syncs run — acceptable)',
      },
    };
  }

  try {
    const raw = safeReadFile(statePath, { encoding: 'utf8' }) as string;
    const state = JSON.parse(raw) as { last_sync_at?: string };
    const lastSync = state.last_sync_at ? new Date(state.last_sync_at).getTime() : 0;
    const ageHours = (Date.now() - lastSync) / (1000 * 60 * 60);
    const stale = lastSync > 0 && ageHours > maxAgeHours;
    return {
      check: {
        name: 'sync_state_freshness',
        passed: true,
        detail: `Last sync: ${state.last_sync_at ?? 'never'} (${stale ? `stale: ${ageHours.toFixed(1)}h ago` : 'fresh'})`,
      },
      warning: stale
        ? `Knowledge sync is stale (${ageHours.toFixed(1)}h since last sync). Run: pnpm knowledge:cowork-sync`
        : undefined,
    };
  } catch {
    return {
      check: {
        name: 'sync_state_freshness',
        passed: true,
        detail: 'Sync state unreadable — treating as not-yet-synced',
      },
    };
  }
}

function checkSurfaceManifest(): CoworkHealthCheck {
  const manifestPath = pathResolver.rootResolve(
    'knowledge/product/governance/surfaces/mcp-server-cowork.json',
  );
  const exists = safeExistsSync(manifestPath);
  return {
    name: 'mcp_surface_manifest_present',
    passed: exists,
    detail: exists ? manifestPath : 'mcp-server-cowork surface manifest missing',
  };
}

// ── Main health check ─────────────────────────────────────────────────────────

/**
 * Run all Cowork integration health checks.
 *
 * @param options.syncStateMaxAgeHours  Warn if sync state is older than this (default: 24h).
 */
export function runCoworkHealthCheck(options: { syncStateMaxAgeHours?: number } = {}): CoworkHealthReport {
  const freshnessResult = checkSyncStateFreshness(options.syncStateMaxAgeHours ?? 24);

  const checks: CoworkHealthCheck[] = [
    checkMcpServerBuilt(),
    checkPluginManifest(),
    checkConnectorConfig(),
    checkSyncPolicy(),
    checkCoworkOutbox(),
    freshnessResult.check,
    checkSurfaceManifest(),
  ];

  const degraded = checks.filter((c) => !c.passed).map((c) => c.name);
  const warnings: string[] = [];
  if (freshnessResult.warning) warnings.push(freshnessResult.warning);

  // Outbox not existing is non-fatal (no deliveries yet is OK at boot)
  const fatallyDegraded = degraded.filter((n) => n !== 'cowork_outbox_accessible');

  return {
    healthy: fatallyDegraded.length === 0,
    checks,
    degraded_components: degraded,
    warnings,
  };
}
