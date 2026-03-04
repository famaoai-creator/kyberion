import { runSkillAsync, logger, safeReadFile, pathResolver } from '@agent/core';
import axios from 'axios';
import * as fs from 'node:fs';
import * as path from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

runSkillAsync('trust-fund-monitor', async () => {
  const argv = yargs(hideBin(process.argv))
    .option('action', { alias: 'a', type: 'string' })
    .option('code', { alias: 'c', type: 'string' })
    .parseSync();

  const action = argv.action || (argv._ && argv._[0]) || 'get-nav';
  let fundCode = argv.code as string;

  const endpointPath = pathResolver.rootResolve('knowledge/common/api-endpoints.json');
  const aliasPath = pathResolver.rootResolve('knowledge/finance/fund-aliases.json');

  const endpoints = JSON.parse(safeReadFile(endpointPath, { encoding: 'utf8' }) as string);
  const fundData = JSON.parse(safeReadFile(aliasPath, { encoding: 'utf8' }) as string);

  if (fundCode && fundData.aliases[fundCode.toLowerCase()]) {
    fundCode = fundData.aliases[fundCode.toLowerCase()];
  }

  try {
    if (action === 'get-nav') {
      if (!fundCode) throw new Error('Fund code or alias required.');
      logger.info('💰 [Finance] Fetching NAV for: ' + fundCode);
      const url = endpoints.mufg.csv_base + fundCode + '/';
      
      try {
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        const raw = response.data.toString('binary');
        const lines = raw.trim().split('\n');
        if (lines.length > 1) {
          const latest = lines[lines.length - 1].split(',');
          const date = latest[0].replace(/"/g, '');
          const nav = latest[1].replace(/"/g, '');
          return { status: 'success', data: { date, nav } };
        }
      } catch (e) {
        return { 
          status: 'needs_attention', 
          message: 'API Key may be required for REST v1.',
          url: endpoints.mufg.rest_v1 
        };
      }
    } else if (action === 'list-aliases') {
      return { status: 'success', data: fundData.aliases };
    }
  } catch (err: any) {
    throw new Error('Finance Monitor Failure: ' + err.message);
  }
});
