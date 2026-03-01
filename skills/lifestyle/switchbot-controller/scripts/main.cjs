#!/usr/bin/env node
/**
 * SwitchBot Controller v1.0.1
 * Fixed multiline syntax.
 */

const { runSkill } = require('@agent/core');
const { logger } = require('@agent/core/core');
const { safeReadFile } = require('@agent/core/secure-io');
const pathResolver = require('@agent/core/path-resolver');
const axios = require('axios');
const fs = require('fs');
const crypto = require('crypto');

const CREDENTIALS_PATH = pathResolver.rootResolve('knowledge/personal/connections/switchbot/switchbot-credentials.json');

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
    throw new Error('SwitchBot credentials not found.');
  }

  const { openToken, secret } = JSON.parse(safeReadFile(CREDENTIALS_PATH, { encoding: 'utf8' }));
  if (!openToken || !secret) throw new Error('Missing credentials.');

  const headers = getHeaders(openToken, secret);
  const baseUrl = 'https://api.switch-bot.com/v1.1/devices';

  try {
    if (action === 'list-devices') {
      const res = await axios.get(baseUrl, { headers });
      const list = [...(res.data.body.deviceList || []), ...(res.data.body.infraredRemoteList || [])];
      const output = list.map(d => `- [${d.deviceId}] ${d.deviceName} (${d.deviceType})`).join('\n');
      return { status: 'success', data: output };
    } else if (action === 'control') {
      const { deviceId, cmd, param = 'default' } = args;
      await axios.post(`${baseUrl}/${deviceId}/commands`, { command: cmd, parameter: param, commandType: 'command' }, { headers });
      return { status: 'success', message: 'Command sent.' };
    }
  } catch (err) {
    throw new Error(`SwitchBot Failure: ${err.message}`);
  }
});
