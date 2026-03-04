/**
 * scripts/ingest.ts
 * Sovereign Asset Ingestion Gateway.
 * Manages the transition of data from external sources into the governed vault.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { logger, safeWriteFile, fileUtils, pathResolver } from '@agent/core';
import { Asset, LedgerEntry } from '@agent/core/shared-business-types';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const LEDGER_PATH = pathResolver.resolve('active/shared/ledger/governance-ledger.jsonl');
const ASSET_REGISTRY_PATH = pathResolver.resolve('active/shared/ledger/asset-registry.json');

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('file', { alias: 'f', type: 'string', demandOption: true, describe: 'External file to ingest' })
    .option('tenant', { alias: 't', type: 'string', demandOption: true, describe: 'Target company/tenant' })
    .option('tier', { alias: 'T', type: 'string', choices: ['public', 'internal', 'confidential', 'restricted'], default: 'internal' })
    .option('type', { alias: 'y', type: 'string', choices: ['code', 'doc', 'credential', 'other'], default: 'doc' })
    .parseSync();

  const externalPath = path.resolve(argv.file as string);
  if (!fs.existsSync(externalPath)) {
    throw new Error(`External file not found: ${externalPath}`);
  }

  const fileName = path.basename(externalPath);
  const fileContent = fs.readFileSync(externalPath);
  const hash = crypto.createHash('sha256').update(fileContent).digest('hex');
  const assetId = `AST-${hash.substring(0, 12).toUpperCase()}`;

  // 1. Determine Internal Destination (Vault)
  const destDir = path.join(process.cwd(), 'vault', argv.tenant as string, argv.tier as string);
  const destPath = path.join(destDir, fileName);

  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

  // 2. Register Asset
  const asset: Asset = {
    id: assetId,
    name: fileName,
    type: argv.type as any,
    tenant: argv.tenant as string,
    confidentiality: argv.tier as any,
    hash: hash,
    path: path.relative(process.cwd(), destPath),
    created_at: new Date().toISOString()
  };

  // 3. Record in Ledger (Audit Trail)
  const entry: LedgerEntry = {
    action: 'ingest',
    asset_id: assetId,
    timestamp: new Date().toISOString(),
    actor: 'Ecosystem Architect',
    details: `Ingested ${fileName} from ${externalPath} into ${argv.tenant}/${argv.tier}`
  };

  // Physical Persistence
  fs.copyFileSync(externalPath, destPath);
  
  // Update Registry
  let registry: Record<string, Asset> = {};
  if (fs.existsSync(ASSET_REGISTRY_PATH)) {
    registry = JSON.parse(fs.readFileSync(ASSET_REGISTRY_PATH, 'utf8'));
  }
  registry[assetId] = asset;
  safeWriteFile(ASSET_REGISTRY_PATH, JSON.stringify(registry, null, 2));

  // Append to Ledger
  fs.appendFileSync(LEDGER_PATH, JSON.stringify(entry) + '\n');

  logger.success(`🚀 ASSET INGESTED: ${assetId}`);
  logger.info(`- Name: ${fileName}`);
  logger.info(`- Tenant: ${argv.tenant}`);
  logger.info(`- Ledger Entry: ${entry.timestamp}`);
}

main().catch(err => {
  logger.error(`Ingestion Failed: ${err.message}`);
  process.exit(1);
});
