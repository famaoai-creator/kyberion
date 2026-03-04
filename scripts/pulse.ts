/**
 * scripts/pulse.ts
 * Ecosystem Pulse Monitor.
 */

import * as fs from 'node:fs';
import chalk from 'chalk';
import { logger, safeReadFile } from '@agent/core';
import * as ledger from '@agent/core/ledger';
import * as pathResolver from '@agent/core/path-resolver';

const LEDGER_PATH = pathResolver.rootResolve('active/audit/governance-ledger.jsonl');

export function analyzePulse() {
  if (!fs.existsSync(LEDGER_PATH)) {
    return { status: 'NEW', errorRate: '0.0', isChainValid: true, totalEvents: 0 };
  }

  try {
    const content = safeReadFile(LEDGER_PATH, { encoding: 'utf8' }) as string;
    const lines = content.trim().split('\n').filter(l => l.length > 0);
    const entries = lines.map(l => JSON.parse(l));
    const recent = entries.slice(-50);

    const total = recent.length;
    const errors = recent.filter(e => e.payload?.status === 'error').length;
    const errorRate = total > 0 ? (errors / total) * 100 : 0;

    const isChainValid = ledger.verifyIntegrity();

    let status = 'HEALTHY';
    if (errorRate > 20) status = 'DEGRADED';
    if (errorRate > 50 || !isChainValid) status = 'CRITICAL';

    return {
      status,
      errorRate: errorRate.toFixed(1),
      totalEvents: entries.length,
      isChainValid
    };
  } catch (err: any) {
    logger.error(`Pulse Failure: ${err.message}`);
    return { status: 'ERROR', errorRate: '0.0', isChainValid: false, totalEvents: 0 };
  }
}

async function main() {
  const p = analyzePulse();
  console.log(chalk.bold(`
ECOSYSTEM PULSE: ${p.status}`));
  console.log(`  Integrity: ${p.isChainValid ? 'OK' : 'FAIL'}`);
  console.log(`  Error Rate: ${p.errorRate}%`);
}

if (require.main === module) {
  main().catch(err => {
    logger.error(err.message);
    process.exit(1);
  });
}
