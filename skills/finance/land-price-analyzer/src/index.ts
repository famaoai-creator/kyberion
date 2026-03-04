import { runSkillAsync, logger, safeReadFile, pathResolver } from '@agent/core';
import axios from 'axios';
import * as fs from 'node:fs';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

runSkillAsync('land-price-analyzer', async () => {
  const argv = yargs(hideBin(process.argv))
    .option('action', { alias: 'a', type: 'string' })
    .option('area', { type: 'string' })
    .option('year', { type: 'string' })
    .parseSync();

  const credPath = pathResolver.rootResolve('knowledge/personal/connections/mlit/mlit-credentials.json');
  const endpointPath = pathResolver.rootResolve('knowledge/common/api-endpoints.json');
  const aliasPath = pathResolver.rootResolve('knowledge/finance/fund-aliases.json');

  if (!fs.existsSync(credPath)) throw new Error('MLIT credentials missing.');
  
  const { apiKey } = JSON.parse(safeReadFile(credPath, { encoding: 'utf8' }) as string);
  const endpoints = JSON.parse(safeReadFile(endpointPath, { encoding: 'utf8' }) as string);
  const aliases = JSON.parse(safeReadFile(aliasPath, { encoding: 'utf8' }) as string);

  const action = argv.action || (argv._ && argv._[0]) || 'get-land-price';
  const areaCode = (argv.area as string) || aliases.default_municipality || '13101';

  logger.info('🏘️ [Finance] Analyzing land data for area: ' + areaCode);

  try {
    let url = '';
    let params: any = { area: areaCode };

    if (action === 'get-land-price') {
      url = endpoints.mlit.land_price_search;
    } else if (action === 'get-transaction-price') {
      url = endpoints.mlit.real_estate_transaction_search;
      params.year = argv.year || '2023';
    } else {
      throw new Error('Unsupported action: ' + action);
    }

    const response = await axios.get(url, {
      headers: { 'Ocp-Apim-Subscription-Key': apiKey },
      params
    });

    const data = response.data.data || [];
    return { status: 'success', data: { action, area: areaCode, results: data.slice(0, 10) } };
  } catch (err: any) {
    throw new Error('RE-Infolib Failure: ' + err.message);
  }
});
