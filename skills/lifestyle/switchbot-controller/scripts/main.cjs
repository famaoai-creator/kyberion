#!/usr/bin/env node
/**
 * SwitchBot Controller v1.0
 * Strictly uses @agent/core for I/O and path resolution.
 */

const { runSkill } = require('@agent/core');
const { logger } = require('@agent/core/core');
const { safeReadFile } = require('@agent/core/secure-io');
const pathResolver = require('@agent/core/path-resolver');
const axios = require('axios');
const fs = require('fs');
const crypto = require('crypto');

const CREDENTIALS_PATH = pathResolver.rootResolve('knowledge/personal/switchbot-credentials.json');

/**
 * Generates headers for SwitchBot API v1.1
 */
function getHeaders(token, secret) {
  const nonce = crypto.randomUUID();
  const t = Date.now();
  const data = token + t + nonce;
  const sign = crypto.createHmac('sha256', secret).update(data).digest('base64');

  return {
    'Authorization': token,
    'sign': sign,
    'nonce': nonce,
    't': t,
    'Content-Type': 'application/json; charset=utf8'
  };
}

runSkill('switchbot-controller', async (args) => {
  const action = args.action || args._[0] || 'list-devices';

  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(`SwitchBot credentials not found at ${CREDENTIALS_PATH}. Please save {"openToken": "...", "secret": "..."} to this file.`);
  }

  const { openToken, secret } = JSON.parse(safeReadFile(CREDENTIALS_PATH, { encoding: 'utf8' }));
  if (!openToken || !secret) throw new Error('Missing openToken or secret in switchbot-credentials.json');

  const headers = getHeaders(openToken, secret);
  const baseUrl = 'https://api.switch-bot.com/v1.1/devices';

  try {
    switch (action) {
      case 'list-devices':
        logger.info('📱 Fetching SwitchBot devices...');
        const listRes = await axios.get(baseUrl, { headers });
        const devices = listRes.data.body.deviceList || [];
        const infra = listRes.data.body.infraredRemoteList || [];
        
        const output = [...devices, ...infra].map(d => `- [${d.deviceId}] ${d.deviceName} (${d.deviceType})`).join('
');
        logger.success(`✅ Found ${devices.length + infra.length} devices.`);
        return { status: 'success', devices: output };

      case 'control':
        const { deviceId, cmd, param = 'default' } = args;
        if (!deviceId || !cmd) throw new Error('Missing --deviceId or --cmd for control action.');

        logger.info(`🎮 Sending command [${cmd}] to device [${deviceId}]...`);
        const controlUrl = `${baseUrl}/${deviceId}/commands`;
        const payload = {
          command: cmd,
          parameter: param,
          commandType: 'command'
        };

        const controlRes = await axios.post(controlUrl, payload, { headers });
        if (controlRes.data.statusCode === 100) {
          logger.success('✅ Command executed successfully.');
          return { status: 'success', message: 'Command sent.' };
        } else {
          throw new Error(`SwitchBot API Error: ${controlRes.data.message}`);
        }

      default:
        throw new Error(`Unsupported action: ${action}`);
    }
  } catch (err) {
    logger.error(`SwitchBot Failure: ${err.message}`);
    if (err.response?.data) logger.error(JSON.stringify(err.response.data));
    throw err;
  }
});
