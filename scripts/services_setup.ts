import { createStandardYargs } from '@agent/core/cli-utils';
import {
  customerResolver,
  inspectServiceAuth,
  loadServiceEndpointsCatalog,
  logger,
  safeExistsSync,
} from '@agent/core';
import * as path from 'node:path';
import { pathResolver } from '@agent/core';
import { formatSetupHintLine, formatSetupSummaryLine } from './setup-report.js';

type ServiceSetupRow = {
  service: string;
  auth: 'ready' | 'missing' | 'n/a';
  strategy: string;
  preset: string;
  connection: 'customer' | 'personal' | 'missing';
  connectionPath: string;
  secrets: string;
  cli: string;
  hint: string;
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
    .map((row) => ({ ...row, priority: setupRowPriority(row) } as RankedServiceSetupRow))
    .sort((a, b) => a.priority - b.priority || a.service.localeCompare(b.service))
    .map(({ priority: _priority, ...row }) => row);
}

function inspectConnection(serviceId: string): { connection: 'customer' | 'personal' | 'missing'; connectionPath: string } {
  const overlayPath = customerResolver.resolveOverlay(path.join('connections', `${serviceId}.json`));
  const candidates = customerResolver.overlayCandidates(path.join('connections', `${serviceId}.json`));
  if (overlayPath && safeExistsSync(overlayPath) && candidates.overlay && overlayPath === candidates.overlay) {
    return { connection: 'customer', connectionPath: overlayPath };
  }
  if (safeExistsSync(candidates.base)) {
    return { connection: 'personal', connectionPath: candidates.base };
  }
  return { connection: 'missing', connectionPath: candidates.overlay ?? candidates.base };
}

export async function setupServices() {
  const catalog = loadServiceEndpointsCatalog();
  const rows = sortServiceSetupRows(Object.entries(catalog.services).map(([serviceId, record]) => {
    const auth = record.preset_path ? inspectServiceAuth(serviceId, record.preset_path) : null;
    const connection = inspectConnection(serviceId);
    return {
      service: serviceId,
      auth: auth ? (auth.valid ? 'ready' : 'missing') : 'n/a',
      strategy: auth?.authStrategy || record.auth_strategy || 'host-managed',
      preset: record.preset_path || '',
      connection: connection.connection,
      connectionPath: connection.connectionPath,
      secrets: auth?.requiredSecrets.join(', ') || '',
      cli: auth?.cliFallbacks.join(', ') || '',
      hint: auth?.setupHint || 'Host-managed service or no preset path.',
    };
  }));

  const summary = rows.reduce((acc, row) => {
    acc.total += 1;
    if (row.auth === 'ready') acc.ready += 1;
    if (row.auth === 'missing') acc.authMissing += 1;
    if (row.connection === 'missing') acc.connectionMissing += 1;
    if (row.connection === 'customer') acc.customerConnections += 1;
    if (row.connection === 'personal') acc.personalConnections += 1;
    return acc;
  }, { total: 0, ready: 0, authMissing: 0, connectionMissing: 0, customerConnections: 0, personalConnections: 0 });

  console.log('');
  console.log(formatSetupSummaryLine([
    ['auth missing', summary.authMissing],
    ['connections missing', summary.connectionMissing],
    ['auth ready', summary.ready],
    ['total', summary.total],
  ]));
  const header = `${'SERVICE'.padEnd(20)} ${'AUTH'.padEnd(10)} ${'CONNECTION'.padEnd(12)} ${'STRATEGY'.padEnd(12)} ${'SECRETS'.padEnd(36)} CLI`;
  console.log(header);
  console.log('-'.repeat(header.length + 8));
  for (const row of rows) {
    const authSymbol = row.auth === 'ready' ? '✅' : row.auth === 'missing' ? '⚠️' : '—';
    const connectionSymbol = row.connection === 'customer' ? '🟢' : row.connection === 'personal' ? '🟡' : '⚠️';
    console.log(
      `${row.service.padEnd(20)} ${authSymbol} ${row.auth.padEnd(8)} ${connectionSymbol} ${row.connection.padEnd(10)} ${row.strategy.padEnd(12)} ${row.secrets.slice(0, 36).padEnd(36)} ${row.cli}`,
    );
    if (row.auth === 'missing' || row.connection === 'missing') {
      console.log(formatSetupHintLine(row.hint));
      if (row.connection === 'missing') {
        console.log(formatSetupHintLine(`Connection file: ${path.relative(pathResolver.rootDir(), row.connectionPath)}`));
      }
    }
  }
  console.log('');

  return {
    status: 'ok',
    catalogPath: 'knowledge/public/orchestration/service-endpoints.json',
    rows,
    summary,
  };
}

async function main(): Promise<void> {
  const argv = await createStandardYargs()
    .option('json', { type: 'boolean', default: false })
    .parseSync();

  const result = await setupServices();
  if (argv.json) {
    logger.info(JSON.stringify(result, null, 2));
    return;
  }
  logger.success('Service setup check completed.');
}

const isDirect = process.argv[1] && /services_setup\.(ts|js)$/.test(process.argv[1]);
if (isDirect) {
  main().catch((err) => {
    logger.error(err?.message ?? String(err));
    process.exit(1);
  });
}

export { main as runServiceSetup };
