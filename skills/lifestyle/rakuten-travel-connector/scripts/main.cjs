#!/usr/bin/env node
/**
 * Rakuten Travel Connector v1.0
 * Strictly uses @agent/core for I/O and path resolution.
 */

const { runSkill } = require('@agent/core');
const { logger } = require('@agent/core/core');
const { safeReadFile } = require('@agent/core/secure-io');
const pathResolver = require('@agent/core/path-resolver');
const axios = require('axios');
const fs = require('fs');

const CREDENTIALS_PATH = pathResolver.rootResolve('knowledge/personal/rakuten-credentials.json');

runSkill('rakuten-travel-connector', async (args) => {
  const keyword = args.keyword || args._[0];
  const limit = args.limit || 5;

  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(`Rakuten credentials not found. Please save {"applicationId": "YOUR_ID"} to ${CREDENTIALS_PATH}`);
  }

  const { applicationId } = JSON.parse(safeReadFile(CREDENTIALS_PATH, { encoding: 'utf8' }));
  
  if (!applicationId) throw new Error('Missing applicationId');
  if (!keyword) throw new Error('Keyword is required.');

  logger.info(`🏨 Searching Rakuten Travel for: "${keyword}"...`);

  try {
    const url = 'https://app.rakuten.co.jp/services/api/Travel/KeywordHotelSearch/20170426';
    const response = await axios.get(url, {
      params: {
        applicationId,
        keyword,
        hits: limit,
        format: 'json'
      }
    });

    const hotels = response.data.hotels || [];
    const formatted = hotels.map((h, idx) => {
      const basic = h.hotel[0].hotelBasicInfo;
      return `${idx + 1}. ${basic.hotelName} (評価: ${basic.reviewAverage})
   最安料金: ${basic.hotelMinCharge}円〜
   URL: ${basic.hotelInformationUrl}`;
    }).join('

');

    logger.success(`✅ Found ${hotels.length} hotels.`);

    return {
      status: 'success',
      data: {
        keyword,
        count: hotels.length,
        results: formatted
      }
    };
  } catch (err) {
    logger.error(`Rakuten Travel API Failure: ${err.message}`);
    throw err;
  }
});
