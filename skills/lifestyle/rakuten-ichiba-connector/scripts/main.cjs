#!/usr/bin/env node
/**
 * Rakuten Ichiba Connector v1.0
 * Strictly uses @agent/core for I/O and path resolution.
 */

const { runSkill } = require('@agent/core');
const { logger } = require('@agent/core/core');
const { safeReadFile } = require('@agent/core/secure-io');
const pathResolver = require('@agent/core/path-resolver');
const axios = require('axios');
const fs = require('fs');

const CREDENTIALS_PATH = pathResolver.rootResolve('knowledge/personal/rakuten-credentials.json');

runSkill('rakuten-ichiba-connector', async (args) => {
  const keyword = args.keyword || args._[0];
  const limit = args.limit || 5;

  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(`Rakuten credentials not found at ${CREDENTIALS_PATH}. Please save {"applicationId": "YOUR_ID"} to this file.`);
  }

  const { applicationId } = JSON.parse(safeReadFile(CREDENTIALS_PATH, { encoding: 'utf8' }));
  
  if (!applicationId) throw new Error('Missing applicationId in rakuten-credentials.json');
  if (!keyword) throw new Error('Keyword is required for search.');

  logger.info(`🔍 Searching Rakuten Ichiba for: "${keyword}"...`);

  try {
    const url = 'https://app.rakuten.co.jp/services/api/IchibaItem/Search/20170426';
    const response = await axios.get(url, {
      params: {
        applicationId,
        keyword,
        hits: limit,
        format: 'json'
      }
    });

    const items = response.data.Items || [];
    const formatted = items.map((i, idx) => {
      const item = i.Item;
      return `${idx + 1}. [${item.itemPrice}円] ${item.itemName}
   URL: ${item.itemUrl}`;
    }).join('

');

    logger.success(`✅ Found ${items.length} items.`);

    return {
      status: 'success',
      data: {
        keyword,
        count: items.length,
        results: formatted
      }
    };
  } catch (err) {
    logger.error(`Rakuten API Failure: ${err.message}`);
    throw err;
  }
});
