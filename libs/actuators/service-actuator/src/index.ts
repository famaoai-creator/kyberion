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
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  params: any;
  auth?: 'none' | 'secret-guard' | 'session';
}

async function handleAction(input: ServiceAction) {
  logger.info(`🔌 [SERVICE] Dispatching to ${input.service_id} (Mode: ${input.mode}, Action: ${input.action})`);

  // 1. Service-Aware Guard: Only allow access to requested service's secrets
  let token: string | null = null;
  if (input.auth === 'secret-guard') {
    // Try both standard and service-specific keys
    const service = input.service_id.toUpperCase();
    token = secretGuard.getSecret(`${service}_BOT_TOKEN`, input.service_id) 
         || secretGuard.getSecret(`${service}_TOKEN`, input.service_id);
    
    if (!token) {
      throw new Error(`Access Denied: No secret found for service "${input.service_id}" (Keys tried: ${service}_BOT_TOKEN, ${service}_TOKEN)`);
    }
    logger.info(`🔐 [AUTH] Securely injected credentials for ${input.service_id}`);
  }

  // 2. Multi-Mode Execution
  switch (input.mode) {
    case 'API':
      let baseUrl: string;
      if (input.service_id === 'moltbook') {
        baseUrl = 'https://www.moltbook.com/api/v1';
      } else if (input.service_id === 'slack') {
        baseUrl = 'https://slack.com/api';
      } else {
        baseUrl = `https://api.${input.service_id}.com/v1`;
      }

      const httpMethod = input.method || (input.params ? 'POST' : 'GET');
      return await secureFetch({
        method: httpMethod,
        url: `${baseUrl}/${input.action}`,
        headers: token ? { 'Authorization': `Bearer ${token}` } : {},
        data: httpMethod !== 'GET' ? input.params : undefined,
        params: httpMethod === 'GET' ? input.params : undefined
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
