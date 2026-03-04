import { runSkillAsync, logger, safeReadFile, safeWriteFile, pathResolver } from '@agent/core';
import axios from 'axios';
import * as fs from 'node:fs';
import * as path from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

async function getAuthToken(creds: any, endpoints: any) {
  const cacheDir = pathResolver.active('shared/cache/jpx');
  const tokenCacheFile = path.join(cacheDir, 'tokens.json');
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

  let cache: any = { idToken: null, refreshToken: null, expires: 0 };
  if (fs.existsSync(tokenCacheFile)) {
    cache = JSON.parse(safeReadFile(tokenCacheFile, { encoding: 'utf8' }) as string);
  }

  if (cache.idToken && cache.expires > Date.now()) {
    return cache.idToken;
  }

  try {
    let refreshToken = cache.refreshToken;
    if (!refreshToken) {
      logger.info('🔑 [JPX] Authenticating...');
      const loginRes = await axios.post(endpoints.jpx.auth_user, {
        mailaddress: creds.mailaddress,
        password: creds.password
      });
      refreshToken = loginRes.data.refreshToken;
    }

    const idRes = await axios.post(endpoints.jpx.auth_refresh + '?refreshtoken=' + refreshToken);
    const idToken = idRes.data.idToken;

    safeWriteFile(tokenCacheFile, JSON.stringify({
      refreshToken,
      idToken,
      expires: Date.now() + (23 * 60 * 60 * 1000)
    }));

    return idToken;
  } catch (err: any) {
    throw new Error('JPX Auth Failed: ' + err.message);
  }
}

runSkillAsync('jpx-market-analyzer', async () => {
  const argv = yargs(hideBin(process.argv))
    .option('action', { alias: 'a', type: 'string' })
    .option('code', { alias: 'c', type: 'string' })
    .parseSync();

  const action = argv.action || (argv._ && argv._[0]) || 'get-prices';
  const code = argv.code as string;

  const credPath = pathResolver.rootResolve('knowledge/personal/connections/jpx/jpx-credentials.json');
  const endpointPath = pathResolver.rootResolve('knowledge/common/api-endpoints.json');

  if (!fs.existsSync(credPath)) throw new Error('JPX credentials missing.');
  
  const creds = JSON.parse(safeReadFile(credPath, { encoding: 'utf8' }) as string);
  const endpoints = JSON.parse(safeReadFile(endpointPath, { encoding: 'utf8' }) as string);

  const idToken = await getAuthToken(creds, endpoints);
  const headers = { Authorization: 'Bearer ' + idToken };

  try {
    if (action === 'get-prices') {
      if (!code) throw new Error('Stock code required.');
      const res = await axios.get(endpoints.jpx.daily_quotes, { headers, params: { code } });
      return { status: 'success', data: (res.data.daily_quotes || []).slice(-5) };
    } else if (action === 'get-financials') {
      if (!code) throw new Error('Stock code required.');
      const res = await axios.get(endpoints.jpx.statements, { headers, params: { code } });
      return { status: 'success', data: (res.data.statements || []).slice(0, 3) };
    } else {
      throw new Error('Unsupported action: ' + action);
    }
  } catch (err: any) {
    throw new Error('JPX API Failure: ' + err.message);
  }
});
