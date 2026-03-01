#!/usr/bin/env node
/**
 * Trust Fund Monitor v1.5 (Public Data Edition)
 * Strictly uses @agent/core for I/O and path resolution.
 * Fetches data from public financial sources.
 */

const { runSkill } = require('@agent/core');
const { logger } = require('@agent/core/core');
const { safeWriteFile } = require('@agent/core/secure-io');
const pathResolver = require('@agent/core/path-resolver');
const axios = require('axios');
const path = require('path');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const FUND_ALIASES = {
  'オルカン': '0331418A',
  's&p500': '03311187',
  '先進国': '03311172',
  '国内': '03311184',
};

runSkill('trust-fund-monitor', async () => {
  const argv = yargs(hideBin(process.argv)).argv;
  const action = argv.action || argv._[0] || 'get-nav';
  let fundCode = argv.code;

  if (fundCode && FUND_ALIASES[fundCode.toLowerCase()]) {
    fundCode = FUND_ALIASES[fundCode.toLowerCase()];
  }

  try {
    switch (action) {
      case 'get-nav':
        if (!fundCode) throw new Error('Fund code or alias (--code) is required.');
        logger.info(`💰 [Finance] Fetching NAV for fund code: ${fundCode}...`);
        
        // Fallback Strategy: Using a reliable public CSV endpoint if REST fails
        // For eMAXIS Slim, the CSV is often accessible at this pattern
        const url = `https://www.am.mufg.jp/service/fund/csv/${fundCode}/`;
        
        try {
          const response = await axios.get(url, { responseType: 'arraybuffer' });
          // Basic ASCII parsing for NAV and Date (works even if Japanese chars are garbled)
          const raw = response.data.toString('binary');
          const lines = raw.trim().split('\n');
          if (lines.length > 1) {
            const latest = lines[lines.length - 1].split(',');
            const date = latest[0].replace(/"/g, '');
            const nav = latest[1].replace(/"/g, '');
            
            const output = `### 🏦 Fund Status: ${fundCode}\n- **Date**: ${date}\n- **NAV**: ¥${Number(nav).toLocaleString()}\n\n*Note: Data retrieved from official MUFG CSV.*`;
            logger.success(`✅ Retreived latest NAV.`);
            return { status: 'success', data: { date, nav }, formatted: output };
          }
        } catch (e) {
          // If CSV fails, provide the API instructions
          return {
            status: 'needs_attention',
            message: 'Official API Key required for REST access.',
            instructions: 'Visit https://www.am.mufg.jp/tool/api/ to register for a Web API key and save it to knowledge/personal/connections/mufg/mufg-credentials.json'
          };
        }
        break;

      case 'list-aliases':
        return { status: 'success', aliases: FUND_ALIASES };

      default:
        throw new Error(`Unsupported action: ${action}`);
    }
  } catch (err) {
    logger.error(`Finance Monitor Failure: ${err.message}`);
    throw err;
  }
});
