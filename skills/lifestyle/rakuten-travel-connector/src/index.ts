import { runSkillAsync, logger, safeReadFile, pathResolver } from '@agent/core';
import axios from 'axios';
import * as fs from 'node:fs';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

runSkillAsync('rakuten-travel-connector', async () => {
  const argv = yargs(hideBin(process.argv))
    .option('keyword', { alias: 'k', type: 'string' })
    .option('limit', { alias: 'l', type: 'number', default: 5 })
    .parseSync();

  const keyword = argv.keyword || (argv._ && argv._[0]);
  const limit = argv.limit as number;

  const credPath = pathResolver.rootResolve('knowledge/personal/connections/rakuten/rakuten-credentials.json');
  const endpointPath = pathResolver.rootResolve('knowledge/common/api-endpoints.json');

  if (!fs.existsSync(credPath)) throw new Error('Rakuten credentials missing.');
  
  const { applicationId } = JSON.parse(safeReadFile(credPath, { encoding: 'utf8' }) as string);
  const endpoints = JSON.parse(safeReadFile(endpointPath, { encoding: 'utf8' }) as string);
  const url = endpoints.rakuten.travel_hotel_search;

  if (!keyword) throw new Error('Keyword is required.');

  logger.info(`🏨 [Lifestyle] Searching Rakuten Travel for: "${keyword}"...`);

  try {
    const response = await axios.get(url, {
      params: { applicationId, keyword, hits: limit, format: 'json' }
    });

    const hotels = response.data.hotels || [];
    const formatted = hotels.map((h: any, idx: number) => {
      const basic = h.hotel[0].hotelBasicInfo;
      return `${idx + 1}. ${basic.hotelName} (Rating: ${basic.reviewAverage})\n   Min: ${basic.hotelMinCharge}円~\n   URL: ${basic.hotelInformationUrl}`;
    }).join('\n\n');

    logger.success(`✅ Found ${hotels.length} hotels.`);
    return { status: 'success', data: { keyword, results: formatted } };
  } catch (err: any) {
    throw new Error(`Rakuten Travel Failure: ${err.message}`);
  }
});
