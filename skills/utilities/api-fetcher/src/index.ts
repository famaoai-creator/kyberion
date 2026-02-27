import { runAsyncSkill } from '@agent/core';
import { requireArgs, safeJsonParse } from '@agent/core/validators';
import { safeWriteFile } from '@agent/core/secure-io';
import { fetchApi } from './lib.js';

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runAsyncSkill('api-fetcher', async () => {
    const args = requireArgs(['url']);

    const options = {
      method: args.method,
      headers: args.headers ? safeJsonParse(args.headers as string, 'headers') : undefined,
      body: args.body ? safeJsonParse(args.body as string, 'request body') : undefined,
    };

    const data = await fetchApi(args.url as string, options);

    if (args.out) {
      safeWriteFile(args.out as string, JSON.stringify(data, null, 2));
    }

    return { data };
  });
}
