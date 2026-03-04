import { runAsyncSkill } from '@agent/core';
import { requireArgs, safeJsonParse, readJsonFile } from '@agent/core/validators';
import { safeWriteFile } from '@agent/core/secure-io';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { fetchApi } from './lib.js';

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runAsyncSkill('api-fetcher', async () => {
    const argv = yargs(hideBin(process.argv)).parseSync() as any;
    requireArgs(argv, ['url']);
    const args = argv;

    const options = {
      method: args.method,
      headers: args.headers ? safeJsonParse(args.headers as string, 'headers') : undefined,
      body: args.body ? safeJsonParse(args.body as string, 'request body') : undefined,
      schema: args.schema ? readJsonFile(args.schema as string, 'schema') : undefined,
    };

    const result = await fetchApi(args.url as string, options);

    if (args.out) {
      safeWriteFile(args.out as string, JSON.stringify(result.data, null, 2));
    }

    return { 
      data: result.data, 
      status: result.status, 
      validation: result.validation 
    };
  });
}
