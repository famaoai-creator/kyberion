import { logger, secretGuard, safeExec } from '@agent/core';
import { secureFetch } from '@agent/core/network';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Service-Actuator v1.0.0
 * Unified Reachability Layer for External SaaS/APIs.
 * Enforces Service-Aware Secret Injection (Least Privilege).
 */

interface ServiceAction {
  service_id: string; // e.g., 'slack', 'jira', 'box'
  mode: 'API' | 'CLI' | 'SDK';
  action: string;
  params: any;
  auth?: 'none' | 'secret-guard' | 'session';
}

async function handleAction(input: ServiceAction) {
  logger.info(`🔌 [SERVICE] Dispatching to ${input.service_id} (Mode: ${input.mode}, Action: ${input.action})`);

  // 1. Service-Aware Guard: Only allow access to requested service's secrets
  let token: string | null = null;
  if (input.auth === 'secret-guard') {
    const secretKey = `${input.service_id.toUpperCase()}_TOKEN`;
    token = secretGuard.getSecret(secretKey);
    if (!token) {
      throw new Error(`Access Denied: No secret found for service "${input.service_id}"`);
    }
    logger.info(`🔐 [AUTH] Securely injected credentials for ${input.service_id}`);
  }

  // 2. Multi-Mode Execution
  switch (input.mode) {
    case 'API':
      const baseUrl = input.service_id === 'moltbook' ? 'https://www.moltbook.com/api/v1' : `https://api.${input.service_id}.com/v1`;
      return await secureFetch({
        method: 'GET', // Dynamic or based on action
        url: `${baseUrl}/${input.action}`,
        headers: token ? { 'Authorization': `Bearer ${token}` } : {},
        data: input.params
      });

    case 'CLI':
      const cliBin = `${input.service_id}`; // e.g., 'gh', 'box'
      const args = [input.action, ...Object.values(input.params)];
      logger.info(`⌨️  [CLI] Executing: ${cliBin} ${args.join(' ')}`);
      return { output: safeExec(cliBin, args as string[]) };

    default:
      throw new Error(`Unsupported mode: ${input.mode}`);
  }
}

const main = async () => {
  const argv = await createStandardYargs()
    .option('input', { alias: 'i', type: 'string', required: true })
    .parseSync();

  const inputData = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), argv.input as string), 'utf8')) as ServiceAction;
  const result = await handleAction(inputData);
  
  console.log(JSON.stringify(result, null, 2));
};

if (require.main === module) {
  main().catch(err => {
    logger.error(err.message);
    process.exit(1);
  });
}
