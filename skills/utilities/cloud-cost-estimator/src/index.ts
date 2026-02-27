import * as fs from 'node:fs';
import * as path from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { runSkill } from '@agent/core';
import { safeWriteFile } from '@agent/core/secure-io';
import { estimateCosts } from './lib.js';

const argv = yargs(hideBin(process.argv))
  .option('input', {
    alias: 'i',
    type: 'string',
    demandOption: true,
    description: 'Path to infrastructure map JSON',
  })
  .option('out', {
    alias: 'o',
    type: 'string',
    description: 'Output path for cost report',
  })
  .help()
  .parseSync();

runSkill('cloud-cost-estimator', () => {
  const inputPath = path.resolve(argv.input as string);
  const outputPath = (argv.out as string) || 'evidence/cost-report.json';

  // 1. Load Knowledge (Heuristic rules if file missing)
  const rulesPath = path.resolve('knowledge/skills/cloud-cost-estimator/cost-rules.json');
  let pricing = { aws_instance: 50, aws_rds_cluster: 200, default: 10 };
  let rules: any[] = [];

  if (fs.existsSync(rulesPath)) {
    const config = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
    pricing = config.instance_pricing || pricing;
    rules = config.optimization_rules || rules;
  }

  const adf = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const { totalCost, findings } = estimateCosts(adf, pricing, rules);

  const report = {
    title: 'Cloud FinOps Audit',
    summary: { total_monthly_estimated: totalCost, currency: 'USD' },
    optimizations: findings,
  };

  safeWriteFile(outputPath, JSON.stringify(report, null, 2));

  return { status: 'success', total_cost: totalCost, output: outputPath };
});
