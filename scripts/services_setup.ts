import { createStandardYargs } from '@agent/core/cli-utils';
import { buildNextAction, formatNextAction } from '@agent/core/next-action';
import * as customerResolver from '@agent/core/customer-resolver';
import { inspectServiceAuth } from '@agent/core/service-validator';
import {
  loadNotificationPreferences,
  resolveOperatorNotificationRoute,
} from '@agent/core/operator-notifications';
import { resolveOpsAlertChannelStatus } from '@agent/core/ops-alert';
import { loadServiceEndpointsCatalog } from '@agent/core/service-endpoint-registry';
import { logger } from '@agent/core/core';
import { readJsonIfPresent } from '@agent/core/foundation';
import {
  isServiceConnectionReady,
  requiredServiceConnectionKeys,
} from '@agent/core/service-connection-readiness';
import { safeExistsSync } from '@agent/core/secure-io';
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { defineScript, isDirectScript } from './lib/harness.js';
import { withSensitivePathMediation } from '@agent/core/secure-io';
import { formatSetupHintLine, formatSetupSummaryLine } from './setup-report-format.js';

type ServiceSetupRow = {
  service: string;
  auth: 'ready' | 'missing' | 'n/a';
  strategy: string;
  preset: string;
  connection: 'customer' | 'personal' | 'missing';
  connectionPath: string;
  connectionReady: boolean;
  connectionRequiredKeys: string[];
  secrets: string;
  cli: string;
  hint: string;
  nextAction?: ReturnType<typeof buildNextAction>;
};

type RankedServiceSetupRow = ServiceSetupRow & { priority: number };

function setupRowPriority(row: Pick<ServiceSetupRow, 'auth' | 'connection' | 'service'>): number {
  if (row.auth === 'missing') return row.connection === 'missing' ? 0 : 1;
  if (row.auth === 'ready' && row.connection === 'missing') return 2;
  if (row.auth === 'ready') return 3;
  return 4;
}

function sortServiceSetupRows(rows: ServiceSetupRow[]): ServiceSetupRow[] {
  return rows
    .map((row) => ({ ...row, priority: setupRowPriority(row) }) as RankedServiceSetupRow)
    .sort((a, b) => a.priority - b.priority || a.service.localeCompare(b.service))
    .map(({ priority: _priority, ...row }) => row);
}

function inspectConnection(serviceId: string): {
  connection: 'customer' | 'personal' | 'missing';
  connectionPath: string;
  connectionReady: boolean;
  connectionRequiredKeys: string[];
} {
  const overlayPath = customerResolver.resolveOverlay(
    path.join('connections', `${serviceId}.json`)
  );
  const candidates = customerResolver.overlayCandidates(
    path.join('connections', `${serviceId}.json`)
  );
  const requiredKeys = requiredServiceConnectionKeys(serviceId);
  const inspectFile = (filePath: string): boolean => {
    if (!safeExistsSync(filePath)) return false;
    if (requiredKeys.length === 0) return true;
    try {
      const record = readJsonIfPresent<Record<string, unknown>>(filePath);
      if (!record) return false;
      return isServiceConnectionReady(serviceId, record);
    } catch {
      return false;
    }
  };
  if (
    overlayPath &&
    safeExistsSync(overlayPath) &&
    candidates.overlay &&
    overlayPath === candidates.overlay
  ) {
    return {
      connection: 'customer',
      connectionPath: overlayPath,
      connectionReady: inspectFile(overlayPath),
      connectionRequiredKeys: requiredKeys,
    };
  }
  if (safeExistsSync(candidates.base)) {
    return {
      connection: 'personal',
      connectionPath: candidates.base,
      connectionReady: inspectFile(candidates.base),
      connectionRequiredKeys: requiredKeys,
    };
  }
  return {
    connection: 'missing',
    connectionPath: candidates.overlay ?? candidates.base,
    connectionReady: false,
    connectionRequiredKeys: requiredKeys,
  };
}

// LC-02b: ops alerts are recorded to a JSONL nobody reads unless a delivery
// channel exists — surface that gap in the same inspection table operators
// already look at, with the exact env var to set.
function inspectOpsAlertChannel(): ReturnType<typeof resolveOpsAlertChannelStatus> {
  const prefs = loadNotificationPreferences();
  const opsAlertRoute = resolveOperatorNotificationRoute('ops_alert', prefs);
  return resolveOpsAlertChannelStatus({
    operatorRouteConfigured: Boolean(opsAlertRoute && opsAlertRoute !== 'mute'),
  });
}

export function buildServiceConnectionSetupCommand(serviceId: string): string {
  return `pnpm onboard -- --services-only --service ${serviceId}`;
}

export function buildServiceAuthNextAction(
  serviceId: string,
  auth: { setupHint: string; oauthAvailable?: boolean; requiredSecrets: string[] }
): ReturnType<typeof buildNextAction> {
  return buildNextAction({
    title: `Fix service auth for ${serviceId}`,
    reason: auth.setupHint,
    next_action_type: 'bootstrap_environment',
    ...(auth.oauthAvailable
      ? {
          suggested_command: `KYBERION_OAUTH_SERVICE_ID=${serviceId} node --import ./scripts/ts-loader.mjs scripts/setup_oauth.ts`,
        }
      : {
          suggested_followup_request: `Store one of ${auth.requiredSecrets.join(', ') || 'the required service credentials'} through Secret Guard, then rerun pnpm services:setup.`,
        }),
  });
}

export async function setupServices(options: { quiet?: boolean } = {}) {
  const catalog = loadServiceEndpointsCatalog();
  const rows = withSensitivePathMediation(() =>
    sortServiceSetupRows(
      Object.entries(catalog.services).map(([serviceId, record]) => {
        const auth = record.preset_path ? inspectServiceAuth(serviceId, record.preset_path) : null;
        const connection = inspectConnection(serviceId);
        return {
          service: serviceId,
          auth: auth ? (auth.valid ? 'ready' : 'missing') : 'n/a',
          strategy: auth?.authStrategy || record.auth_strategy || 'host-managed',
          preset: record.preset_path || '',
          connection: connection.connection,
          connectionPath: connection.connectionPath,
          connectionReady: connection.connectionReady,
          connectionRequiredKeys: connection.connectionRequiredKeys,
          secrets: auth?.requiredSecrets.join(', ') || '',
          cli: auth?.cliFallbacks.join(', ') || '',
          hint: auth?.setupHint || 'Host-managed service or no preset path.',
          nextAction:
            auth && !auth.valid
              ? buildServiceAuthNextAction(serviceId, auth)
              : connection.connection === 'missing' || !connection.connectionReady
                ? buildNextAction({
                    title: `Complete connection for ${serviceId}`,
                    reason:
                      connection.connection === 'missing'
                        ? `Missing connection file at ${connection.connectionPath}.`
                        : `Connection is missing one of: ${connection.connectionRequiredKeys.join(', ')}.`,
                    next_action_type: 'inspect_artifact',
                    suggested_command: buildServiceConnectionSetupCommand(serviceId),
                  })
                : undefined,
        };
      })
    )
  );

  const summary = rows.reduce(
    (acc, row) => {
      acc.total += 1;
      if (row.auth === 'ready') acc.ready += 1;
      if (row.auth === 'missing') acc.authMissing += 1;
      if (row.connection === 'missing') acc.connectionMissing += 1;
      if (row.connection === 'customer') acc.customerConnections += 1;
      if (row.connection === 'personal') acc.personalConnections += 1;
      return acc;
    },
    {
      total: 0,
      ready: 0,
      authMissing: 0,
      connectionMissing: 0,
      customerConnections: 0,
      personalConnections: 0,
    }
  );

  const opsAlertChannel = inspectOpsAlertChannel();

  if (!options.quiet) {
    console.log('');
    console.log(
      formatSetupSummaryLine([
        ['auth missing', summary.authMissing],
        ['connections missing', summary.connectionMissing],
        ['auth ready', summary.ready],
        ['total', summary.total],
      ])
    );
    const header = `${'SERVICE'.padEnd(20)} ${'AUTH'.padEnd(10)} ${'CONNECTION'.padEnd(12)} ${'STRATEGY'.padEnd(12)} ${'SECRETS'.padEnd(36)} CLI`;
    console.log(header);
    console.log('-'.repeat(header.length + 8));
    for (const row of rows) {
      const authSymbol = row.auth === 'ready' ? '✅' : row.auth === 'missing' ? '⚠️' : '—';
      const connectionSymbol =
        row.connection === 'customer' ? '🟢' : row.connection === 'personal' ? '🟡' : '⚠️';
      console.log(
        `${row.service.padEnd(20)} ${authSymbol} ${row.auth.padEnd(8)} ${connectionSymbol} ${row.connection.padEnd(10)} ${row.strategy.padEnd(12)} ${row.secrets.slice(0, 36).padEnd(36)} ${row.cli}`
      );
      if (row.auth === 'missing' || row.connection === 'missing' || !row.connectionReady) {
        console.log(formatSetupHintLine(row.hint));
        if (row.connection === 'missing' || !row.connectionReady) {
          console.log(
            formatSetupHintLine(
              `Connection file: ${path.relative(pathResolver.rootDir(), row.connectionPath)}`
            )
          );
        }
        if (row.nextAction) {
          for (const line of formatNextAction(row.nextAction)) {
            console.log(line);
          }
        }
      }
    }
    console.log('');
    if (!opsAlertChannel.configured) {
      console.log('⚠️  OPS ALERTS: no delivery channel configured — alerts and operator');
      console.log('   notifications are recorded to active/shared/observability/ops-alerts.jsonl');
      console.log('   but NEVER delivered to you.');
      console.log(`   Fix: export ${opsAlertChannel.env_var}=<webhook url>`);
      console.log('   (or configure knowledge/personal/notification-preferences.json), then');
      console.log('   run `pnpm ops:alerts -- --redeliver` to flush the backlog.');
      console.log('');
    }
  }

  return {
    status: 'ok',
    catalogPath: 'knowledge/product/orchestration/service-endpoints.json',
    rows,
    summary,
    opsAlertChannel,
  };
}

async function main(args: string[] = []): Promise<void> {
  const argv = await createStandardYargs(['node', 'services_setup', ...args])
    .option('json', { type: 'boolean', default: false })
    .parseSync();

  const result = await setupServices();
  if (argv.json) {
    logger.info(JSON.stringify(result, null, 2));
    return;
  }
  logger.success('Service setup check completed.');
}

const runServiceSetupScript = defineScript({
  name: 'service:setup',
  flags: [],
  run: ({ argv }) => main(argv),
});

if (
  isDirectScript(import.meta.url, 'services_setup.ts') ||
  isDirectScript(import.meta.url, 'services_setup.js')
) {
  void runServiceSetupScript();
}

export { main as runServiceSetup };
