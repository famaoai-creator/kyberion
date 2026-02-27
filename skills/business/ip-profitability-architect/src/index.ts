import fs from 'fs';
import path from 'path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { runSkill } from '@agent/core';
import { safeWriteFile } from '@agent/core/secure-io';
import { processIPStrategy, IPAsset } from './lib.js';

const argv = yargs(hideBin(process.argv))
  .option('input', {
    alias: 'i',
    type: 'string',
    demandOption: true,
    description: 'Path to JSON with IP portfolio data',
  })
  .option('out', {
    alias: 'o',
    type: 'string',
    description: 'Output file path',
  })
  .parseSync();

runSkill('ip-profitability-architect', () => {
  const resolved = path.resolve(argv.input as string);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }

  const inputContent = fs.readFileSync(resolved, 'utf8');
  const rawData = JSON.parse(inputContent);

  let assets: IPAsset[] = [];

  // Synergy Logic: If input is from ip-strategist, map findings to assets
  if (rawData.data && rawData.data.findings) {
    assets = rawData.data.findings
      .filter((f: any) => f.patentable)
      .map((f: any) => ({
        name: f.file,
        type: f.category,
        development_cost: 50000,
        potential_annual_revenue: f.matchCount * 10000,
      }));
  } else if (rawData.assets) {
    assets = rawData.assets;
  } else if (Array.isArray(rawData)) {
    assets = rawData;
  }

  const result = processIPStrategy(assets);
  const resultWithSource = {
    ...result,
    source: path.basename(resolved),
  };

  if (argv.out) {
    safeWriteFile(argv.out as string, JSON.stringify(resultWithSource, null, 2));
  }

  return resultWithSource;
});
